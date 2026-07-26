/**
 * The full stack, in one process, with no sockets.
 *
 * A real `GameHost` and real `NetClient`s, talking through `createLocalPair()` --
 * which is asynchronous and can be told to lose, duplicate, reorder and delay
 * messages. That is what makes "does this hold up at 150ms with 3% loss" a
 * deterministic unit test instead of an afternoon with two phones and a throttling
 * proxy.
 *
 * Time is injected rather than real. Every test drives a virtual clock forward in
 * fixed steps and pumps the event loop between them, so a 60-second match runs in
 * milliseconds and a failure is reproducible rather than "flaky on CI".
 */

import { describe, expect, it } from 'vitest';
import { createWorld, spawnPlayer, type World } from '../sim/world.js';
import { MAP_ARENA01 } from '../map/arena01.js';
import { getMode } from '../modes/registry.js';
import { fillWallRect, WallTier } from '../sim/walls.js';
import { Button, createInputFrame, type InputFrame } from '../input/inputFrame.js';
import { MatchPhase, TEAM_NONE } from '../sim/types.js';
import { TICK_MS } from '../constants.js';
import { createLocalPair, type LinkConditions, type LinkScheduler } from './localTransport.js';
import { GameHost } from './host.js';
import { NetClient, createRemoteSample } from './client.js';
import {
  BUDGET_DOWN_BYTES_PER_SEC,
  BUDGET_UP_BYTES_PER_SEC,
  INTERP_DELAY_MAX_MS,
  Op,
  RECONCILE_SNAP_UNITS,
  SNAPSHOT_EVERY_TICKS,
  SNAPSHOT_HISTORY,
} from './protocol.js';
import { captureWorldSnap, createWorldSnap, type WorldSnap } from './snapshot.js';
import { PLAYER_SCHEMA, structEqual } from './schema.js';
import { encodeJson } from './codec.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A clock the test owns, plus a scheduler backed by it.
 *
 * Both halves are needed. With a virtual clock but real timers, the game would
 * measure a 150ms link as however long the event loop happened to take between
 * iterations -- when this suite was first written that read as a 1900ms round trip
 * on a 300ms link. Delivery has to be scheduled against the same clock the game
 * reads, or latency tests measure the harness rather than the netcode.
 */
class VirtualClock {
  ms = 1000;
  now = (): number => this.ms;
}

interface Task {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

class VirtualScheduler implements LinkScheduler {
  private tasks: Task[] = [];
  private seq = 0;

  constructor(private readonly clock: VirtualClock) {}

  after(delayMs: number, fn: () => void): () => void {
    const t: Task = { at: this.clock.ms + Math.max(0, delayMs), seq: this.seq++, fn, cancelled: false };
    this.tasks.push(t);
    return () => {
      t.cancelled = true;
    };
  }

  /**
   * Fire everything due at or before `t`, in time order.
   *
   * Ties broken by insertion order, so a run is reproducible down to the ordering
   * of two messages scheduled for the same millisecond. A callback may schedule
   * more work, which is why this loops rather than iterating a snapshot of the list.
   */
  drainTo(t: number): void {
    for (let guard = 0; guard < 100000; guard++) {
      let best = -1;
      for (let i = 0; i < this.tasks.length; i++) {
        const task = this.tasks[i]!;
        if (task.cancelled || task.at > t) continue;
        const cur = best >= 0 ? this.tasks[best]! : null;
        if (!cur || task.at < cur.at || (task.at === cur.at && task.seq < cur.seq)) best = i;
      }
      if (best < 0) break;
      const task = this.tasks[best]!;
      task.cancelled = true;
      task.fn();
    }
    this.tasks = this.tasks.filter((x) => !x.cancelled);
  }

  get pendingCount(): number {
    return this.tasks.filter((x) => !x.cancelled).length;
  }
}

function makeWorldFactory(modeId: string, seed: number) {
  return (): World => {
    const w = createWorld(seed, MAP_ARENA01.bounds, getMode(modeId));
    w.props = MAP_ARENA01.props.map((p) => ({ ...p }));
    for (const r of MAP_ARENA01.walls) {
      fillWallRect(w.walls, r.x, r.y, r.w, r.h, r.tier as WallTier);
    }
    return w;
  };
}

interface HostRecord {
  snap: WorldSnap;
  tier: Uint8Array;
  hp: Uint16Array;
}

interface Rig {
  clock: VirtualClock;
  scheduler: VirtualScheduler;
  host: GameHost;
  clients: NetClient[];
  /**
   * What the host held at each snapshot tick.
   *
   * Convergence has to be checked TICK-FOR-TICK. A client's confirmed world is
   * always a snapshot or two behind the host by construction, so comparing it
   * against the host's present state can only pass if the world has stopped
   * changing -- which never happens with bots on the field. Comparing against what
   * the host actually held at the tick the client is holding asks the real question.
   */
  hostHistory: Map<number, HostRecord>;
  /** Deliver anything already due and let pending awaits resume. */
  pump(): Promise<void>;
  /** Advance the virtual clock and run both sides. */
  run(ms: number): Promise<void>;
  /** Advance one tick, calling `onTick` to supply this tick's input. */
  step(onTick: (t: number) => void, ticks: number): Promise<void>;
  factory(): World;
  addClient(name: string, resume?: string): Promise<NetClient>;
  /**
   * Change conditions on every live link.
   *
   * `LocalTransport` reads its conditions on every send, so this takes effect
   * immediately -- which is what makes recovery (rather than mere survival)
   * testable. Each link gets its own conditions object, so this mutates them all
   * rather than one shared copy.
   */
  setConditions(patch: Partial<LinkConditions>): void;
}

async function makeRig(opts: {
  modeId: string;
  humans: number;
  bots?: number;
  cond?: LinkConditions;
  seed?: number;
}): Promise<Rig> {
  const clock = new VirtualClock();
  const scheduler = new VirtualScheduler(clock);
  const seed = opts.seed ?? 4242;
  const factory = makeWorldFactory(opts.modeId, seed);

  const host = new GameHost({
    createWorld: factory,
    modeId: opts.modeId,
    seed,
    bots: opts.bots ?? 0,
    maxPlayers: 8,
    now: clock.now,
  });

  // Real timers only move `await` along; all delivery timing is virtual.
  const pump = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      scheduler.drainTo(clock.ms);
      await new Promise((r) => setTimeout(r, 0));
    }
    scheduler.drainTo(clock.ms);
  };

  const clients: NetClient[] = [];
  const liveConds: LinkConditions[] = [];
  const addClient = async (name: string, resume?: string): Promise<NetClient> => {
    // A per-client seed, or every link would lose exactly the same packets and the
    // test would be far gentler than it looks.
    const cond: LinkConditions = {
      ...(opts.cond ?? {}),
      seed: (opts.cond?.seed ?? 1) + clients.length * 977 + 1,
      scheduler,
    };
    liveConds.push(cond);
    const [clientSide, hostSide] = createLocalPair(cond);
    host.accept(hostSide);
    void hostSide.connect();
    const c = new NetClient({
      transport: clientSide,
      createWorld: factory,
      name,
      skinId: 'stick',
      now: clock.now,
      resume,
    });
    void c.connect();
    await pump();
    return c;
  };

  for (let i = 0; i < opts.humans; i++) {
    clients.push(await addClient(`P${i + 1}`));
  }

  const idle = clients.map(() => createInputFrame());
  const hostHistory = new Map<number, HostRecord>();
  const recordHost = (): void => {
    const tick = host.world.tick;
    if (tick % SNAPSHOT_EVERY_TICKS !== 0) return;
    hostHistory.set(tick, {
      snap: captureWorldSnap(host.world, createWorldSnap()),
      tier: host.world.walls.tier.slice(),
      hp: host.world.walls.hp.slice(),
    });
    // Keep only what a client could still be holding.
    const cutoff = tick - SNAPSHOT_HISTORY * SNAPSHOT_EVERY_TICKS * 4;
    for (const k of hostHistory.keys()) if (k < cutoff) hostHistory.delete(k);
  };

  const stepN = async (onTick: (t: number) => void, ticks: number): Promise<void> => {
    for (let t = 0; t < ticks; t++) {
      clock.ms += TICK_MS;
      scheduler.drainTo(clock.ms);
      host.advance();
      recordHost();
      onTick(t);
      await pump();
    }
  };

  const run = async (ms: number): Promise<void> => {
    const ticks = Math.round(ms / TICK_MS);
    await stepN(() => {
      for (let i = 0; i < clients.length; i++) {
        if (i >= idle.length) idle.push(createInputFrame());
        clients[i]!.advance(idle[i]!);
      }
    }, ticks);
  };

  await pump();
  const setConditions = (patch: Partial<LinkConditions>): void => {
    for (const c of liveConds) Object.assign(c, patch);
  };

  return {
    clock,
    scheduler,
    host,
    clients,
    hostHistory,
    pump,
    run,
    step: stepN,
    factory,
    addClient,
    setConditions,
  };
}

/** Drive a client's local input, the way a thumb would. */
function drive(f: InputFrame, t: number, id: number, throwing = true): void {
  f.moveX = Math.sin(t * 0.07 + id * 1.3);
  f.moveY = Math.cos(t * 0.05 + id * 2.1);
  f.aim = t * 0.04 + id;
  f.packDelta = 0.07;
  f.buttons = throwing && (t + id * 5) % 30 === 0 ? Button.Throw : 0;
  f.throwPower = 0.8;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

describe('joining', () => {
  it('assigns every client a distinct player slot', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 4 });
    for (const c of rig.clients) {
      expect(c.joined).toBe(true);
      expect(c.playerId).toBeGreaterThanOrEqual(0);
    }
    const ids = rig.clients.map((c) => c.playerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a client speaking a different protocol version', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 0 });
    const [clientSide, hostSide] = createLocalPair({ scheduler: rig.scheduler });
    rig.host.accept(hostSide);
    void hostSide.connect();
    void clientSide.connect();
    await rig.pump();

    let refused = '';
    clientSide.onMessage.on((d) => {
      if (d[0] === Op.Refused) {
        refused = (JSON.parse(new TextDecoder().decode(d.subarray(1))) as { reason: string })
          .reason;
      }
    });
    // A hand-rolled Hello, because NetClient will only ever send the right version.
    clientSide.send(encodeJson(Op.Hello, { v: 999, name: 'x', skinId: 'stick' }));
    await rig.pump();

    expect(refused).toContain('protocol');
  });

  it('refuses a ninth player rather than overflowing the match', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 8 });
    const extra = await rig.addClient('ninth');

    expect(extra.joined).toBe(false);
    expect(extra.refusedReason).toContain('full');
  });

  it('tells every client about the roster', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 3 });
    rig.host.start();
    await rig.run(500);
    for (const c of rig.clients) {
      expect(c.roster.length).toBeGreaterThanOrEqual(3);
      expect(c.modeId).toBe('teamWar');
    }
  });
});

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

/**
 * Assert a client holds exactly what the host held at the tick the client is on.
 *
 * Checks players and walls. Anything that fails here is a genuine desync rather
 * than the client merely being a snapshot behind.
 */
function expectConverged(rig: Rig, c: NetClient, label: string): void {
  const tick = c.confirmed.tick;
  const rec = rig.hostHistory.get(tick);
  expect(rec, `${label}: no host record for tick ${tick}`).toBeTruthy();
  if (!rec) return;

  const got = captureWorldSnap(c.confirmed, createWorldSnap());
  for (let i = 0; i < rec.snap.players.length; i++) {
    expect(
      structEqual(rec.snap.players[i]!, got.players[i]!, PLAYER_SCHEMA),
      `${label}: player ${i} at tick ${tick}`,
    ).toBe(true);
  }
  expect(Array.from(c.confirmed.walls.tier), `${label}: wall tiers at tick ${tick}`).toEqual(
    Array.from(rec.tier),
  );
}

describe('convergence on a clean link', () => {
  it('brings every client to the host state', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 4, bots: 2 });
    rig.host.start();
    await rig.run(2000);

    for (const c of rig.clients) {
      expect(c.confirmed.tick).toBeGreaterThan(0);
      // The confirmed world lags the host by up to one snapshot interval, so
      // compare against the tick the client actually holds rather than the newest.
      expect(rig.host.world.tick - c.confirmed.tick).toBeLessThanOrEqual(4);
      expect(c.confirmed.players.filter((p) => p.active).length).toBe(6);
    }
  });

  it('agrees about walls', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 3, bots: 1 });
    rig.host.start();
    await rig.run(3000);
    for (const c of rig.clients) {
      expect(Array.from(c.confirmed.walls.tier)).toEqual(Array.from(rig.host.world.walls.tier));
    }
  });

  it('predicts local movement ahead of the confirmed state', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 1, cond: { latencyMs: 80 } });
    rig.host.start();
    await rig.run(400);

    const c = rig.clients[0]!;
    const f = createInputFrame();
    f.moveX = 1;
    // Hold a hard right for a second; the predicted world must be ahead of the
    // confirmed one, which is the entire point of prediction.
    await rig.step(() => c.advance(f), 30);

    const predicted = c.world.players[c.playerId]!;
    const confirmed = c.confirmed.players[c.playerId]!;
    expect(predicted.x).toBeGreaterThan(confirmed.x);
    expect(c.debug.unackedInputs).toBeGreaterThan(0);
  });

  it('keeps reconciliation error below the snap threshold', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 4, bots: 2, cond: { latencyMs: 60 } });
    rig.host.start();

    const frames = rig.clients.map(() => createInputFrame());
    const errors: number[] = [];
    // A respawn is a teleport, and a teleport SHOULD snap -- smoothing one would be
    // a lie about where a player is. So the sample excludes the ticks around a
    // death: what is being measured is the accuracy of ordinary prediction, not
    // whether anybody died.
    const deadUntil = rig.clients.map(() => 0);
    await rig.step((t) => {
      for (let i = 0; i < rig.clients.length; i++) {
        const c = rig.clients[i]!;
        drive(frames[i]!, t, i);
        c.advance(frames[i]!);
        const me = c.confirmed.players[c.playerId];
        if (!me?.alive) deadUntil[i] = t + 20;
        // Skip the first second too: the very first snapshot corrects a blank world
        // into a populated one, which is a legitimately enormous "error".
        if (t > 30 && t > deadUntil[i]!) errors.push(c.debug.reconcileErrorUnits);
      }
    }, 400);

    errors.sort((a, b) => a - b);
    const p90 = errors[Math.floor(errors.length * 0.9)]!;
    const median = errors[Math.floor(errors.length * 0.5)]!;
    expect(errors.length).toBeGreaterThan(1000);

    // Typical prediction has to be accurate: the client replays the same inputs the
    // host applied, starting from the host's own state, so the common case should
    // land within a fraction of a unit.
    expect(median, `median ${median.toFixed(3)}u`).toBeLessThan(0.25);

    // The tail is allowed to be larger, and it is worth being precise about why
    // rather than picking a number that passes. In predict mode the client steps
    // only its OWN player, so player-vs-player separation is resolved against
    // everyone else's last known positions rather than their current ones. Every
    // body-to-body collision therefore contributes a small, real disagreement. That
    // is a deliberate consequence of predicting narrowly, and it is exactly what the
    // decaying visual offset exists to absorb.
    expect(p90, `p90 ${p90.toFixed(3)}u`).toBeLessThan(2);

    // What the player must not see is repeated teleporting. This is the plan's CI
    // rule: no more than three snaps per five seconds.
    const seconds = 400 / 30;
    for (const c of rig.clients) {
      const rate = c.debug.snapCount / (seconds / 5);
      expect(rate, `${c.debug.snapCount} snaps in ${seconds.toFixed(1)}s`).toBeLessThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Degraded links
// ---------------------------------------------------------------------------

const DEGRADED: LinkConditions = {
  latencyMs: 150,
  jitterMs: 40,
  lossPct: 3,
  reorderPct: 1,
  seed: 0x51e161,
};

describe('convergence on a degraded link', () => {
  it('still converges at 150ms, 40ms jitter, 3% loss, 1% reorder', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 4, bots: 2, cond: DEGRADED });
    rig.host.start();

    const frames = rig.clients.map(() => createInputFrame());
    await rig.step((t) => {
      for (let i = 0; i < rig.clients.length; i++) {
        drive(frames[i]!, t, i);
        rig.clients[i]!.advance(frames[i]!);
      }
    }, 400);

    // Settle: stop moving and let the last snapshots land.
    await rig.run(2500);

    for (const c of rig.clients) {
      expect(c.joined).toBe(true);
      expect(c.confirmed.tick).toBeGreaterThan(300);
      expectConverged(rig, c, 'degraded');
    }
  });

  it('measures the round trip and adapts the interpolation delay', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 2, cond: DEGRADED });
    rig.host.start();
    await rig.run(4000);

    for (const c of rig.clients) {
      const d = c.debug;
      // One-way latency is 150ms, so the round trip is about 300ms.
      expect(d.minRttMs).toBeGreaterThan(250);
      expect(d.minRttMs).toBeLessThan(420);
      // It must have climbed well above the floor, or it is not adapting at all,
      // and must respect the ceiling, or a bad link becomes unplayably sluggish.
      expect(d.interpDelayMs).toBeGreaterThan(200);
      expect(d.interpDelayMs).toBeLessThanOrEqual(INTERP_DELAY_MAX_MS);
    }
  });

  /**
   * The user-visible question, asked directly.
   *
   * Comparing the delay against the reported snapshot age arithmetically is
   * tempting but measures the harness as much as the netcode: this rig can only
   * deliver messages on tick boundaries, which inflates both the apparent round trip
   * and the apparent snapshot age by up to two ticks. What actually matters is
   * whether remote players keep moving, so that is what this counts.
   */
  it('keeps remote players interpolating on a bad link', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 2, bots: 1, cond: DEGRADED });
    rig.host.start();
    await rig.run(3000);

    const viewer = rig.clients[0]!;
    const other = rig.clients[1]!.playerId;
    const sample = createRemoteSample();
    const frames = rig.clients.map(() => createInputFrame());
    frames[1]!.moveX = 1;

    let live = 0;
    let stale = 0;
    await rig.step(() => {
      for (let i = 0; i < rig.clients.length; i++) rig.clients[i]!.advance(frames[i]!);
      const s = viewer.sampleRemote(other, sample);
      if (!s) return;
      if (s.stale) stale++;
      else live++;
    }, 300);

    const rate = live / (live + stale);
    expect(live + stale).toBeGreaterThan(250);
    // Occasional freezes on a 150ms link with 3% loss are the designed behaviour;
    // freezing most of the time would mean the buffer is chronically starved.
    expect(rate, `${(rate * 100).toFixed(1)}% live samples`).toBeGreaterThan(0.9);
  });

  it('recovers when a link that was dropping everything heals', async () => {
    // 80% loss is far past anything a real connection should do, including through
    // the handshake -- which is the interesting part, because the handshake is the
    // one exchange with no natural redundancy. The client must retry its way in
    // rather than sitting silent forever.
    //
    // `LocalTransport` reads its conditions on every send, so the link can be healed
    // mid-test. That makes this a recovery test rather than a survival test.
    const rig = await makeRig({
      modeId: 'teamWar',
      humans: 2,
      bots: 2,
      cond: { latencyMs: 60, lossPct: 80, seed: 0x50412 },
    });
    rig.host.start();
    await rig.run(2000);

    rig.setConditions({ lossPct: 0 });
    await rig.run(3000);

    for (const c of rig.clients) {
      expect(c.joined, 'never completed the handshake').toBe(true);
      expect(c.confirmed.tick).toBeGreaterThan(100);
      expectConverged(rig, c, 'after the link healed');
    }
  });
});

// ---------------------------------------------------------------------------
// Bandwidth
// ---------------------------------------------------------------------------

describe('bandwidth budget', () => {
  it('stays inside 8 KB/s down and 1.2 KB/s up per client', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 8, bots: 0 });
    rig.host.start();

    // Warm up so the initial full snapshots are not counted against steady state.
    await rig.run(1000);
    const before = rig.clients.map((c) => ({ ...c.debug }));

    const frames = rig.clients.map(() => createInputFrame());
    const seconds = 10;
    await rig.step((t) => {
      for (let i = 0; i < rig.clients.length; i++) {
        drive(frames[i]!, t, i);
        rig.clients[i]!.advance(frames[i]!);
      }
    }, seconds * 30);

    for (let i = 0; i < rig.clients.length; i++) {
      const d = rig.clients[i]!.debug;
      const down = (d.bytesIn - before[i]!.bytesIn) / seconds;
      const up = (d.bytesOut - before[i]!.bytesOut) / seconds;
      expect(down, `client ${i} down ${Math.round(down)} B/s`).toBeLessThan(
        BUDGET_DOWN_BYTES_PER_SEC,
      );
      expect(up, `client ${i} up ${Math.round(up)} B/s`).toBeLessThan(BUDGET_UP_BYTES_PER_SEC);
    }
  });

  /**
   * The real claim of delta compression is not an absolute byte count -- it is that
   * an idle PLAYER costs nothing. So measure the same idle scene at two player
   * counts: if unchanged entities are genuinely free, doubling the roster must not
   * meaningfully change the traffic.
   *
   * An absolute assertion here would only be measuring the match clock, which
   * legitimately changes every single tick and dominates an idle snapshot.
   */
  const measureIdle = async (humans: number): Promise<number> => {
    const rig = await makeRig({ modeId: 'teamWar', humans });
    rig.host.start();
    await rig.run(2000);
    const before = rig.clients.map((c) => c.debug.bytesIn);
    await rig.run(3000);
    let worst = 0;
    for (let i = 0; i < rig.clients.length; i++) {
      worst = Math.max(worst, (rig.clients[i]!.debug.bytesIn - before[i]!) / 3);
    }
    return worst;
  };

  it('does not charge for players who are standing still', async () => {
    const four = await measureIdle(4);
    const eight = await measureIdle(8);

    // Twice the players, within a snapshot header of the same cost. If delta
    // compression regresses, this ratio is what moves.
    expect(eight, `4 players ${Math.round(four)} B/s, 8 players ${Math.round(eight)} B/s`).toBeLessThan(
      four * 1.35,
    );
    // And a ceiling, so an idle lobby can never creep toward the play budget. The
    // floor is the match clock: 15 snapshots a second, each restating a countdown.
    expect(eight, `idle ${Math.round(eight)} B/s`).toBeLessThan(1200);
  });
});

// ---------------------------------------------------------------------------
// Matches played to completion
// ---------------------------------------------------------------------------

describe('a match played over the network', () => {
  it('reaches a winner and every client agrees who it is', async () => {
    const rig = await makeRig({
      modeId: 'lastOneStanding',
      humans: 2,
      bots: 4,
      cond: { latencyMs: 50, jitterMs: 15, lossPct: 1, seed: 7 },
    });
    rig.host.start();

    const frames = rig.clients.map(() => createInputFrame());
    let ticks = 0;
    while (rig.host.world.match.phase !== MatchPhase.Ended && ticks < 4000) {
      await rig.step((t) => {
        for (let i = 0; i < rig.clients.length; i++) {
          drive(frames[i]!, ticks + t, i);
          rig.clients[i]!.advance(frames[i]!);
        }
      }, 30);
      ticks += 30;
    }

    expect(rig.host.world.match.phase).toBe(MatchPhase.Ended);
    // Let the result reach everybody.
    await rig.run(600);
    for (const c of rig.clients) {
      expect(c.confirmed.match.phase).toBe(MatchPhase.Ended);
      expect(c.confirmed.match.winnerPlayer).toBe(rig.host.world.match.winnerPlayer);
    }
  });

  it('runs every mode without diverging', async () => {
    for (const modeId of ['teamWar', 'captureTheFlag', 'kingOfTheHill', 'fortDefense']) {
      const rig = await makeRig({
        modeId,
        humans: 3,
        bots: 3,
        cond: { latencyMs: 90, jitterMs: 25, lossPct: 2, seed: 31 },
      });
      rig.host.start();

      const frames = rig.clients.map(() => createInputFrame());
      await rig.step((t) => {
        for (let i = 0; i < rig.clients.length; i++) {
          drive(frames[i]!, t, i);
          rig.clients[i]!.advance(frames[i]!);
        }
      }, 600);
      await rig.run(2000);

      for (const c of rig.clients) {
        expectConverged(rig, c, modeId);
      }
    }
  });

  it('assigns teams that every client sees the same way', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 4, bots: 2 });
    rig.host.start();
    await rig.run(1000);

    for (const c of rig.clients) {
      for (const p of rig.host.world.players) {
        if (!p.active || p.isDummy) continue;
        expect(c.confirmed.players[p.id]!.team, `client ${c.playerId} on player ${p.id}`).toBe(
          p.team,
        );
      }
      expect(c.confirmed.players[c.playerId]!.team).not.toBe(TEAM_NONE);
    }
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('events', () => {
  it('delivers host events to clients', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 2, bots: 4 });
    const seen: number[][] = rig.clients.map(() => []);
    rig.clients.forEach((c, i) => {
      c.onEvents.on((evs) => {
        for (const e of evs) seen[i]!.push(e.type);
      });
    });

    rig.host.start();
    const frames = rig.clients.map(() => createInputFrame());
    await rig.step((t) => {
      for (let i = 0; i < rig.clients.length; i++) {
        drive(frames[i]!, t, i);
        rig.clients[i]!.advance(frames[i]!);
      }
    }, 600);

    for (let i = 0; i < seen.length; i++) {
      expect(seen[i]!.length, `client ${i} saw no events`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe('interpolation', () => {
  it('samples remote players smoothly, without teleporting', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 2, bots: 2, cond: { latencyMs: 70 } });
    rig.host.start();
    await rig.run(1500);

    const viewer = rig.clients[0]!;
    const other = rig.clients[1]!.playerId;
    const sample = createRemoteSample();

    const frames = rig.clients.map(() => createInputFrame());
    frames[1]!.moveX = 1;

    let prevX: number | null = null;
    let worstJump = 0;
    let samples = 0;
    await rig.step(() => {
      for (let i = 0; i < rig.clients.length; i++) rig.clients[i]!.advance(frames[i]!);
      const s = viewer.sampleRemote(other, sample);
      if (!s || s.stale) return;
      samples++;
      if (prevX !== null) worstJump = Math.max(worstJump, Math.abs(s.x - prevX));
      prevX = s.x;
    }, 200);

    expect(samples).toBeGreaterThan(100);
    // A player walks at 168 units/s, so one tick is ~5.6 units. Anything much
    // above that is a discontinuity the player would see as a stutter.
    expect(worstJump).toBeLessThan(12);
  });

  it('returns nothing for a player who does not exist', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 1 });
    rig.host.start();
    await rig.run(500);
    expect(rig.clients[0]!.sampleRemote(15, createRemoteSample())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Disconnect and reconnect
// ---------------------------------------------------------------------------

describe('disconnects', () => {
  it('leaves a snowman standing rather than deleting the body', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 3, bots: 1 });
    rig.host.start();
    await rig.run(1000);

    const leaver = rig.clients[2]!;
    const leaverId = leaver.playerId;
    const before = rig.host.world.players.filter((p) => p.active).length;
    leaver.close();
    await rig.run(1000);

    // Still there, and still active, but no longer taking input.
    expect(rig.host.world.players[leaverId]!.active).toBe(true);
    expect(rig.host.world.players.filter((p) => p.active).length).toBe(before);
    expect(rig.host.world.players[leaverId]!.vx).toBe(0);
  });

  it('keeps the match running for everyone else', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 3, bots: 2 });
    rig.host.start();
    await rig.run(600);
    rig.clients[0]!.close();
    const tickAfterDrop = rig.host.world.tick;
    await rig.run(1500);

    expect(rig.host.world.tick).toBeGreaterThan(tickAfterDrop + 30);
    for (const c of rig.clients.slice(1)) {
      expect(c.confirmed.tick).toBeGreaterThan(tickAfterDrop);
    }
  });

  it('lets a player reclaim their slot with a resume token', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 2, bots: 1 });
    rig.host.start();
    await rig.run(800);

    // Read the token off the client rather than from the onWelcome event: the
    // handshake completed during makeRig, so a listener attached here would be too
    // late to ever see it.
    const token = rig.clients[1]!.resumeToken;
    expect(token).not.toBe('');

    const oldId = rig.clients[1]!.playerId;
    rig.clients[1]!.close();
    await rig.run(500);

    const back = await rig.addClient('P2', token);
    await rig.run(500);

    expect(back.joined).toBe(true);
    expect(back.playerId).toBe(oldId);
  });

  it('gives a reconnecting stranger a different slot', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 2, bots: 1 });
    rig.host.start();
    await rig.run(600);
    const oldId = rig.clients[1]!.playerId;
    rig.clients[1]!.close();
    await rig.run(300);

    const stranger = await rig.addClient('stranger', 'not-a-real-token');

    expect(stranger.joined).toBe(true);
    expect(stranger.playerId).not.toBe(oldId);
  });
});

// ---------------------------------------------------------------------------
// The client sends intent, never state
// ---------------------------------------------------------------------------

describe('the host does not trust the client', () => {
  it('clamps an absurd packDelta from a modified client', async () => {
    const rig = await makeRig({ modeId: 'teamWar', humans: 1 });
    rig.host.start();
    await rig.run(300);

    const c = rig.clients[0]!;
    const cheat = createInputFrame();
    // A modified client claiming a thousand rotations a tick would pack instantly.
    cheat.packDelta = 1000;

    await rig.step(() => c.advance(cheat), 10);

    const hostSide = rig.host.world.players[c.playerId]!;
    expect(hostSide.heldBall).toBe(-1);
    expect(hostSide.packProgress).toBeLessThan(2.5);
  });

  it('ignores a stale acknowledgement instead of corrupting the baseline', async () => {
    // A client that acks a tick it never received would make the host encode
    // against a baseline it does not hold. The host only ever moves an ack forward,
    // so replaying an old ack must be a no-op rather than a corruption.
    const rig = await makeRig({ modeId: 'teamWar', humans: 1, bots: 2 });
    rig.host.start();
    await rig.run(1500);

    const c = rig.clients[0]!;
    const { Writer } = await import('./codec.js');
    const w = new Writer();
    w.u8(Op.Input);
    w.u32(2); // an ancient tick
    w.u8(0);
    // Reach the transport directly, bypassing the client's own bookkeeping.
    (c as unknown as { opts: { transport: { send(d: Uint8Array): void } } }).opts.transport.send(
      w.view_(),
    );
    await rig.run(1000);

    expectConverged(rig, c, 'after a stale ack');
  });
});
