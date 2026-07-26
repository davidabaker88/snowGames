/**
 * Snapshot round-trip and delta tests.
 *
 * The comparison throughout is quantized-snap against quantized-snap, never
 * `hashWorld` against `hashWorld`. That is not a shortcut: positions travel at
 * 1/8-unit precision while `hashWorld` quantizes at 1/64, so a perfectly correct
 * round trip changes the world hash. Comparing captures asks the question that
 * actually matters -- "does the receiver hold the state the sender described" --
 * and asks it exactly rather than approximately.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, spawnPlayer, allocBall, type World } from '../sim/world.js';
import { step, startMatch } from '../sim/step.js';
import { MAP_ARENA01 } from '../map/arena01.js';
import { createInputFrame, validateInput, Button, type InputFrame } from '../input/inputFrame.js';
import { BallState, SimEventType, type SimEvent } from '../sim/types.js';
import { buildAt, wallHeightAt } from '../sim/walls.js';
import { getMode } from '../modes/registry.js';
import { Writer } from './codec.js';
import { MAX_MESSAGE_BYTES } from './transport.js';
import {
  applySnapshot,
  captureWorldSnap,
  clearWorldForResync,
  createSnapshotHeader,
  createWorldSnap,
  decodeEvents,
  encodeEvents,
  encodeSnapshot,
  WALL_VERSION_NONE,
  type EncodeResult,
  type WorldSnap,
} from './snapshot.js';
import {
  BALL_SCHEMA,
  FLAG_SCHEMA,
  MATCH_SCHEMA,
  PLAYER_SCHEMA,
  RING_SCHEMA,
  ZONE_SCHEMA,
  structEqual,
} from './schema.js';

function makeWorld(modeId = 'teamWar', players = 4): World {
  const w = createWorld(9876, MAP_ARENA01.bounds, getMode(modeId));
  w.props = MAP_ARENA01.props.map((p) => ({ ...p }));
  for (const r of MAP_ARENA01.walls) {
    // Reuse the map's own wall authoring so the grid starts realistically dirty.
    for (let y = r.y; y < r.y + r.h; y += 32) {
      for (let x = r.x; x < r.x + r.w; x += 32) {
        const col = Math.floor((x - w.bounds.minX) / 32);
        const row = Math.floor((y - w.bounds.minY) / 32);
        buildAt(w.walls, row * w.walls.cols + col, 100);
      }
    }
  }
  for (let i = 0; i < players; i++) {
    spawnPlayer(w, { name: `P${i}`, x: 200 + i * 60, y: 400 });
  }
  startMatch(w);
  return w;
}

/** Drive the world so there is real motion, balls in flight and wall damage. */
function churn(w: World, ticks: number): void {
  const f = createInputFrame();
  for (let t = 0; t < ticks; t++) {
    const m = new Map<number, InputFrame>();
    for (const p of w.players) {
      if (!p.active || p.isDummy) continue;
      f.moveX = Math.sin(t * 0.11 + p.id);
      f.moveY = Math.cos(t * 0.09 + p.id * 2);
      f.aim = t * 0.05 + p.id;
      f.packDelta = 0.06;
      f.buttons = (t + p.id * 7) % 25 === 0 ? Button.Throw : 0;
      f.throwPower = 0.85;
      validateInput(f);
      m.set(p.id, { ...f });
    }
    step(w, m, { mode: 'authoritative' });
  }
}

function emptyWorld(modeId = 'teamWar'): World {
  const w = createWorld(1, MAP_ARENA01.bounds, getMode(modeId));
  clearWorldForResync(w);
  return w;
}

function expectSameState(a: World, b: World, label: string): void {
  const sa = captureWorldSnap(a, createWorldSnap());
  const sb = captureWorldSnap(b, createWorldSnap());
  expect(sb.tick, `${label}: tick`).toBe(sa.tick);
  for (let i = 0; i < sa.players.length; i++) {
    expect(structEqual(sa.players[i]!, sb.players[i]!, PLAYER_SCHEMA), `${label}: player ${i}`).toBe(
      true,
    );
  }
  for (let i = 0; i < sa.balls.length; i++) {
    expect(structEqual(sa.balls[i]!, sb.balls[i]!, BALL_SCHEMA), `${label}: ball ${i}`).toBe(true);
  }
  expect(structEqual(sa.match, sb.match, MATCH_SCHEMA), `${label}: match`).toBe(true);
  for (let i = 0; i < sa.flags.length; i++) {
    expect(structEqual(sa.flags[i]!, sb.flags[i]!, FLAG_SCHEMA), `${label}: flag ${i}`).toBe(true);
  }
  for (let i = 0; i < sa.zones.length; i++) {
    expect(structEqual(sa.zones[i]!, sb.zones[i]!, ZONE_SCHEMA), `${label}: zone ${i}`).toBe(true);
  }
  expect(structEqual(sa.ring, sb.ring, RING_SCHEMA), `${label}: ring`).toBe(true);
  expect(Array.from(b.walls.tier), `${label}: wall tiers`).toEqual(Array.from(a.walls.tier));
  expect(Array.from(b.walls.hp), `${label}: wall hp`).toEqual(Array.from(a.walls.hp));
}

const res: EncodeResult = { wallVersionSent: 0, tilesTruncated: false };

/** Send everything, looping until the wall grid has fully drained. */
function fullSync(host: World, client: World): number {
  const w = new Writer();
  const cur = createWorldSnap();
  const hdr = createSnapshotHeader();
  let acked = WALL_VERSION_NONE;
  let messages = 0;
  for (let guard = 0; guard < 40; guard++) {
    captureWorldSnap(host, cur);
    encodeSnapshot(host, w, cur, null, 0, acked, res);
    applySnapshot(client, w.view_(), hdr);
    messages++;
    acked = res.wallVersionSent;
    if (!res.tilesTruncated) break;
  }
  return messages;
}

describe('full snapshots', () => {
  it('reproduces the host world on a blank client', () => {
    const host = makeWorld();
    churn(host, 90);
    const client = emptyWorld();
    fullSync(host, client);
    expectSameState(host, client, 'full sync');
  });

  it('reproduces every mode, including its objectives', () => {
    for (const mode of [
      'sandbox',
      'lastOneStanding',
      'teamWar',
      'captureTheFlag',
      'kingOfTheHill',
      'fortDefense',
    ]) {
      const host = makeWorld(mode, 4);
      churn(host, 120);
      const client = emptyWorld(mode);
      fullSync(host, client);
      expectSameState(host, client, mode);
    }
  });

  it('never exceeds the transport message limit', () => {
    // 16 players and a wall of balls: the worst case the protocol has to survive
    // without fragmenting, since rule 4 of the transport seam promises it will not.
    const host = makeWorld('teamWar', 16);
    churn(host, 200);
    for (const b of host.balls) {
      if (b.alive) continue;
      const nb = allocBall(host);
      if (!nb) break;
      nb.state = BallState.Grounded;
      nb.x = 100 + (nb.id % 30) * 25;
      nb.y = 100 + Math.floor(nb.id / 30) * 25;
    }
    const alive = host.balls.filter((b) => b.alive).length;
    expect(alive).toBeGreaterThan(140);

    const w = new Writer();
    const cur = createWorldSnap();
    captureWorldSnap(host, cur);
    encodeSnapshot(host, w, cur, null, 0, WALL_VERSION_NONE, res);
    expect(w.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it('converges even when the first messages are truncated', () => {
    // A full grid of walls plus 16 players cannot fit in one message, so this is
    // the resumption path: each snapshot picks up where the last one stopped.
    const host = makeWorld('teamWar', 16);
    for (let i = 0; i < host.walls.tier.length; i++) buildAt(host.walls, i, 100);
    churn(host, 60);

    const client = emptyWorld();
    const messages = fullSync(host, client);
    expect(messages).toBeGreaterThan(1);
    expect(Array.from(client.walls.tier)).toEqual(Array.from(host.walls.tier));
  });
});

describe('delta snapshots', () => {
  it('costs almost nothing when nothing changed', () => {
    const host = makeWorld();
    churn(host, 60);

    const w = new Writer();
    const base = createWorldSnap();
    const cur = createWorldSnap();
    captureWorldSnap(host, base);
    // Same tick, same everything: this is the idle-lobby case.
    captureWorldSnap(host, cur);
    encodeSnapshot(host, w, cur, base, 0, host.walls.version, res);

    // Header plus five empty masks. If this ever grows, quantization has stopped
    // being idempotent somewhere and every field is being re-sent.
    expect(w.length).toBeLessThan(30);
  });

  it('applies onto a client that already holds the baseline', () => {
    const host = makeWorld();
    churn(host, 45);

    const client = emptyWorld();
    let ackedWall = WALL_VERSION_NONE;
    const w = new Writer();
    const hdr = createSnapshotHeader();
    const base = createWorldSnap();
    const cur = createWorldSnap();

    // Prime with a full sync, then run 200 ticks of deltas.
    for (let guard = 0; guard < 40; guard++) {
      captureWorldSnap(host, cur);
      encodeSnapshot(host, w, cur, null, 0, ackedWall, res);
      applySnapshot(client, w.view_(), hdr);
      ackedWall = res.wallVersionSent;
      if (!res.tilesTruncated) break;
    }
    captureWorldSnap(host, base);

    for (let round = 0; round < 100; round++) {
      churn(host, 2);
      captureWorldSnap(host, cur);
      encodeSnapshot(host, w, cur, base, 0, ackedWall, res);
      expect(w.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      applySnapshot(client, w.view_(), hdr);
      ackedWall = res.wallVersionSent;
      // The client acknowledged it, so it becomes the next baseline.
      captureWorldSnap(host, base);
    }

    expectSameState(host, client, 'delta chain');
  });

  it('recovers when snapshots are dropped and the baseline goes stale', () => {
    // The loss-recovery claim in the header comment, tested: the client keeps
    // acknowledging an old tick, so the host keeps encoding against it, and the
    // state that went missing is included again with no retransmit logic.
    const host = makeWorld();
    churn(host, 30);

    const client = emptyWorld();
    const w = new Writer();
    const hdr = createSnapshotHeader();
    const cur = createWorldSnap();
    let ackedWall = WALL_VERSION_NONE;
    for (let guard = 0; guard < 40; guard++) {
      captureWorldSnap(host, cur);
      encodeSnapshot(host, w, cur, null, 0, ackedWall, res);
      applySnapshot(client, w.view_(), hdr);
      ackedWall = res.wallVersionSent;
      if (!res.tilesTruncated) break;
    }

    // Baseline the client actually holds, and will keep acking.
    const heldBaseline = createWorldSnap();
    captureWorldSnap(host, heldBaseline);
    const heldWall = ackedWall;

    // Now drop four snapshots in a row: encode against the stale baseline and
    // throw the bytes away.
    for (let i = 0; i < 4; i++) {
      churn(host, 2);
      captureWorldSnap(host, cur);
      encodeSnapshot(host, w, cur, heldBaseline, 0, heldWall, res);
    }

    // The fifth arrives, still encoded against the baseline the client holds.
    churn(host, 2);
    captureWorldSnap(host, cur);
    encodeSnapshot(host, w, cur, heldBaseline, 0, heldWall, res);
    applySnapshot(client, w.view_(), hdr);
    // Wall tiles may need another round if the burst produced many of them.
    let guard = 0;
    let wall = res.wallVersionSent;
    while (res.tilesTruncated && guard++ < 40) {
      captureWorldSnap(host, cur);
      encodeSnapshot(host, w, cur, heldBaseline, 0, wall, res);
      applySnapshot(client, w.view_(), hdr);
      wall = res.wallVersionSent;
    }

    expectSameState(host, client, 'after 4 dropped snapshots');
  });

  it('removes a player who left rather than leaving a ghost', () => {
    const host = makeWorld('teamWar', 4);
    churn(host, 20);
    const client = emptyWorld();
    fullSync(host, client);
    expect(client.players.filter((p) => p.active).length).toBe(4);

    const base = createWorldSnap();
    captureWorldSnap(host, base);
    host.players[2]!.active = false;

    const w = new Writer();
    const hdr = createSnapshotHeader();
    const cur = createWorldSnap();
    captureWorldSnap(host, cur);
    encodeSnapshot(host, w, cur, base, 0, host.walls.version, res);
    applySnapshot(client, w.view_(), hdr);

    expect(client.players[2]!.active).toBe(false);
    expect(client.players.filter((p) => p.active).length).toBe(3);
  });

  it('carries wall damage as it happens', () => {
    const host = makeWorld();
    const client = emptyWorld();
    fullSync(host, client);

    // Find a standing tile and knock it down.
    const tile = host.walls.tier.findIndex((t) => t > 0);
    expect(tile).toBeGreaterThanOrEqual(0);
    expect(wallHeightAt(client.walls, tile)).toBeGreaterThan(0);

    const base = createWorldSnap();
    captureWorldSnap(host, base);
    const ackedWall = host.walls.version;
    host.walls.tier[tile] = 0;
    host.walls.hp[tile] = 0;
    host.walls.version++;
    host.walls.tileVersion[tile] = host.walls.version;

    const w = new Writer();
    const hdr = createSnapshotHeader();
    const cur = createWorldSnap();
    captureWorldSnap(host, cur);
    encodeSnapshot(host, w, cur, base, 0, ackedWall, res);
    applySnapshot(client, w.view_(), hdr);

    expect(wallHeightAt(client.walls, tile)).toBe(0);
  });
});

describe('the snapshot header', () => {
  it('distinguishes a full snapshot from a delta based at tick 0', () => {
    // Tick 0 is a real tick, so "no baseline" cannot be encoded as baselineTick 0.
    // This is the test that would have caught using a magic value.
    const host = makeWorld();
    const w = new Writer();
    const cur = createWorldSnap();
    const base = createWorldSnap();
    captureWorldSnap(host, cur);
    captureWorldSnap(host, base);
    base.tick = 0;

    encodeSnapshot(host, w, cur, null, 0, WALL_VERSION_NONE, res);
    const full = createSnapshotHeader();
    applySnapshot(emptyWorld(), w.view_(), full);
    expect(full.hasBaseline).toBe(false);

    encodeSnapshot(host, w, cur, base, 0, host.walls.version, res);
    const delta = createSnapshotHeader();
    applySnapshot(emptyWorld(), w.view_(), delta);
    expect(delta.hasBaseline).toBe(true);
    expect(delta.baselineTick).toBe(0);
  });

  it('round-trips the input acknowledgement', () => {
    const host = makeWorld();
    const w = new Writer();
    const cur = createWorldSnap();
    captureWorldSnap(host, cur);
    // A sequence number near the u16 wrap, since that is where an ack would break.
    encodeSnapshot(host, w, cur, null, 65535, WALL_VERSION_NONE, res);
    const hdr = createSnapshotHeader();
    applySnapshot(emptyWorld(), w.view_(), hdr);
    expect(hdr.ackSeq).toBe(65535);
  });
});

describe('events', () => {
  it('round-trips a burst of events', () => {
    const src: SimEvent[] = [
      { type: SimEventType.Hit, id: 3, other: 1, x: 412.5, y: 388.25, z: 41.5, amount: 12.5 },
      { type: SimEventType.WallBuilt, id: 700, other: 2, x: 96, y: 320, z: 0, amount: 2 },
      { type: SimEventType.FlagCaptured, id: 1, other: -1, x: 0, y: 0, z: 0, amount: 0 },
    ];
    const w = new Writer();
    const n = encodeEvents(w, 1234, src);
    expect(n).toBe(3);

    const out: SimEvent[] = [];
    expect(decodeEvents(w.view_(), out)).toBe(1234);
    expect(out.length).toBe(3);
    expect(out[0]!.type).toBe(SimEventType.Hit);
    expect(out[0]!.amount).toBeCloseTo(12.5, 3);
    expect(out[1]!.id).toBe(700);
    expect(out[2]!.type).toBe(SimEventType.FlagCaptured);
  });

  it('truncates a flood rather than overflowing the buffer', () => {
    const many: SimEvent[] = [];
    for (let i = 0; i < 400; i++) {
      many.push({ type: SimEventType.Bounced, id: i & 0x7f, other: -1, x: i, y: i, z: 0, amount: 1 });
    }
    const w = new Writer();
    const n = encodeEvents(w, 5, many);
    expect(n).toBeLessThan(400);
    expect(w.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);

    const out: SimEvent[] = [];
    decodeEvents(w.view_(), out);
    expect(out.length).toBe(n);
  });
});

describe('clearWorldForResync', () => {
  it('leaves no entity behind for a full snapshot to collide with', () => {
    const w = makeWorld('captureTheFlag', 6);
    churn(w, 60);
    expect(w.players.some((p) => p.active)).toBe(true);
    expect(w.flags.some((f) => f.active)).toBe(true);

    clearWorldForResync(w);
    expect(w.players.some((p) => p.active)).toBe(false);
    expect(w.balls.some((b) => b.alive)).toBe(false);
    expect(w.flags.some((f) => f.active)).toBe(false);
    expect(w.zones.some((z) => z.active)).toBe(false);
    expect(w.ring.active).toBe(false);
    expect(w.walls.tier.some((t) => t > 0)).toBe(false);
    // And the version floor must be reset, or the next match's walls are never
    // sent because the client's acked version is still ahead of them.
    expect(w.walls.version).toBe(0);
  });

  it('lets a second match reuse the same world object', () => {
    const host = makeWorld('teamWar', 4);
    churn(host, 40);
    const client = emptyWorld();
    fullSync(host, client);

    // New match on the client's world: clear, then take a fresh full sync.
    const host2 = makeWorld('captureTheFlag', 6);
    churn(host2, 40);
    clearWorldForResync(client);
    fullSync(host2, client);
    expectSameState(host2, client, 'second match');
    expect(client.players.filter((p) => p.active).length).toBe(6);
  });
});

describe('quantization loss stays inside its budget', () => {
  it('keeps positions within 1/8 of a unit through a round trip', () => {
    const host = makeWorld();
    churn(host, 77);
    const client = emptyWorld();
    fullSync(host, client);

    for (const p of host.players) {
      if (!p.active) continue;
      const c = client.players[p.id]!;
      expect(Math.abs(c.x - p.x)).toBeLessThanOrEqual(1 / 8);
      expect(Math.abs(c.y - p.y)).toBeLessThanOrEqual(1 / 8);
      // A facing byte is 1.4 degrees, so allow a shade over half a step.
      const dF = Math.atan2(Math.sin(c.facing - p.facing), Math.cos(c.facing - p.facing));
      expect(Math.abs(dF)).toBeLessThan(0.014);
    }
  });

  it('does not accumulate drift over a long delta chain', () => {
    // Re-quantizing an already-quantized value must be a no-op, or a player who
    // stands still slides a fraction of a unit per snapshot for the whole match.
    const host = makeWorld();
    const client = emptyWorld();
    fullSync(host, client);

    const p = host.players[0]!;
    p.x = 301.3;
    p.y = 402.7;
    p.vx = 0;
    p.vy = 0;

    const w = new Writer();
    const hdr = createSnapshotHeader();
    let base: WorldSnap | null = null;
    const cur = createWorldSnap();
    let firstX = 0;
    for (let i = 0; i < 60; i++) {
      captureWorldSnap(host, cur);
      encodeSnapshot(host, w, cur, base, 0, host.walls.version, res);
      applySnapshot(client, w.view_(), hdr);
      if (i === 0) firstX = client.players[0]!.x;
      base = createWorldSnap();
      captureWorldSnap(host, base);
    }
    expect(client.players[0]!.x).toBe(firstX);
  });
});
