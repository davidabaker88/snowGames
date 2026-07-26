/**
 * The authoritative host.
 *
 * Runs the simulation, owns the truth, and answers to nobody. Deliberately free of
 * both DOM and Node builtins -- `shared/tsconfig.json` supplies neither -- because
 * in the intended deployment the host is a **browser on somebody's phone**, running
 * inside a Web Worker, with the other players attached over WebRTC DataChannels.
 * The same file runs unchanged under Node for the headless tests, and would run
 * unchanged behind a WebSocket if a laptop ever hosts instead.
 *
 * Two rules keep it honest:
 *
 *  1. **Clients send intent, never state.** A connection can say "I am moving left
 *     and I flicked with this much power". It cannot say where it is, what it hit,
 *     or that it packed a snowball. Everything arriving is clamped into a legal
 *     range by `validateInput` rather than rejected, because a rejected frame
 *     desynchronises an honest client with a drifting clock -- far more common than
 *     a cheat.
 *  2. **The host never blocks on a client.** A silent connection contributes an
 *     empty input frame and the tick proceeds. A match must not stutter because one
 *     phone went behind a wall.
 */

import { MAX_CATCHUP_TICKS, TICK_MS } from '../constants.js';
import {
  copyInputFrame,
  createInputFrame,
  resetInputFrame,
  validateInput,
  type InputFrame,
} from '../input/inputFrame.js';
import { botInput, createBotBrain, type BotBrain } from '../sim/bot.js';
import {
  startMatch,
  step,
  type InputMap,
  type LagComp,
  type ThrowOrigin,
} from '../sim/step.js';
import type { PlayerId, SimEvent } from '../sim/types.js';
import { MAX_PLAYERS, spawnPlayer, type Player, type World } from '../sim/world.js';
import { Emitter, type Signal } from './signal.js';
import { Writer, decodeJson, encodeJson, opOf } from './codec.js';
import { INPUT_SCHEMA } from './schema.js';
import { Reader } from './codec.js';
import {
  CONNECTION_TIMEOUT_TICKS,
  INPUT_BUFFER_TARGET,
  INPUT_REDUNDANCY,
  LAGCOMP_ACK_BASELINE_TICKS,
  LAGCOMP_HISTORY_TICKS,
  LAGCOMP_MAX_REWIND_TICKS,
  Op,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY_TICKS,
  SNAPSHOT_HISTORY,
  SNOWMAN_GRACE_TICKS,
} from './protocol.js';
import {
  WALL_VERSION_NONE,
  captureWorldSnap,
  createWorldSnap,
  encodeEvents,
  encodeSnapshot,
  type EncodeResult,
  type WorldSnap,
} from './snapshot.js';
import type { Transport } from './transport.js';

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface HelloBody {
  v: number;
  name: string;
  skinId: string;
  /** Presented to reclaim a slot after a disconnect. */
  resume?: string;
}

export interface WelcomeBody {
  v: number;
  playerId: number;
  /** Opaque token to present in a future Hello to reclaim this slot. */
  resume: string;
  modeId: string;
  mapId: string;
  seed: number;
  tick: number;
  /** Everything the snapshot does not carry per-tick. */
  roster: RosterEntry[];
}

export interface RosterEntry {
  id: number;
  name: string;
  skinId: string;
  isBot: boolean;
}

interface Conn {
  transport: Transport;
  playerId: number;
  /** Null until Hello arrives; an unjoined connection gets no snapshots. */
  joined: boolean;
  /** Set once refused, so a client cannot retry its way into a slot. */
  refused: boolean;
  resumeToken: string;
  /** Highest input sequence consumed, in wrapping u16 space. */
  ackSeq: number;
  /** The queue of not-yet-applied frames, keyed by seq. */
  pending: Map<number, InputFrame>;
  /** The last frame applied, reused when nothing new arrived. */
  last: InputFrame;
  /** Reused buffer for the synthesised "nothing arrived" frame. */
  held: InputFrame;
  /** True while the jitter buffer is refilling and no input is being consumed. */
  warming: boolean;
  /** Snapshot tick this client has confirmed receiving. */
  ackedTick: number;
  /** Wall version this client has confirmed receiving. */
  ackedWallVersion: number;
  /** wallVersionSent, keyed by the snapshot tick that carried it. */
  wallSentAt: Map<number, number>;
  /** Ticks since anything arrived, for timeout. */
  idleTicks: number;
  bytesIn: number;
  bytesOut: number;
}

export interface HostOptions {
  /** Builds a fresh world for a match. Called on start and on restart. */
  createWorld(modeId: string, seed: number): World;
  modeId: string;
  seed: number;
  mapId?: string;
  /** Bot slots to fill once the match begins. */
  bots?: number;
  /** Highest number of human connections accepted. */
  maxPlayers?: number;
  /**
   * Monotonic milliseconds. Injected rather than read from `performance`, because
   * `shared/` has no DOM and a test needs to drive time by hand.
   */
  now(): number;
}

export interface HostStats {
  tick: number;
  connections: number;
  bytesOut: number;
  bytesIn: number;
  snapshotBytesLast: number;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export class GameHost {
  world: World;
  private readonly conns: Conn[] = [];
  private readonly brains: BotBrain[] = [];
  /** Players whose connection dropped but whose body is still standing. */
  private readonly snowmen = new Map<number, number>();

  private readonly snapshots: WorldSnap[] = [];
  private readonly writer = new Writer();
  private readonly inputMap = new Map<number, InputFrame>();
  private readonly encodeRes: EncodeResult = { wallVersionSent: 0, tilesTruncated: false };
  private readonly scratchFrame = createInputFrame();
  private readonly framePool: InputFrame[] = [];
  /** Frames handed to `step` this tick, recycled once it has returned. */
  private readonly usedFrames: InputFrame[] = [];
  /** A separate writer for replies sent from a receive callback. */
  private readonly replyWriter = new Writer(32);

  private accumulatorMs = 0;
  private lastNowMs: number;
  private snapshotBytesLast = 0;
  private bytesOut = 0;
  private bytesIn = 0;

  private readonly eventEmitter = new Emitter<readonly SimEvent[]>();
  /** Fires every tick with that tick's events, for a host that also renders. */
  readonly onEvents: Signal<readonly SimEvent[]> = this.eventEmitter;

  private readonly history = new PositionHistory(MAX_PLAYERS, LAGCOMP_HISTORY_TICKS);

  /**
   * Lag compensation, measured HOST-SIDE.
   *
   * The rewind is derived from how far behind each client's snapshot acknowledgement
   * is: that gap is a round trip plus a little, so half of it approximates the
   * one-way delay. Deriving it here rather than letting the client state its own
   * latency costs nothing and removes a trust question entirely -- although it is
   * worth noting that lying would be self-defeating anyway, since a larger rewind
   * means throwing from a staler position.
   *
   * Bots and any connection whose lag is under a tick get no rewind, so a
   * single-device match behaves exactly as it did before this existed.
   */
  private readonly lagComp: LagComp = {
    rewindTicks: (playerId: PlayerId): number => {
      const c = this.connFor(playerId);
      if (!c || c.ackedTick < 0) return 0;
      const lag = this.world.tick - c.ackedTick - LAGCOMP_ACK_BASELINE_TICKS;
      if (lag <= 0) return 0;
      return Math.min(Math.round(lag / 2), LAGCOMP_MAX_REWIND_TICKS);
    },
    originAt: (playerId: PlayerId, ticksAgo: number, out: ThrowOrigin): boolean =>
      this.history.lookup(playerId, ticksAgo, out),
  };

  private connFor(playerId: PlayerId): Conn | undefined {
    for (const c of this.conns) if (c.joined && c.playerId === playerId) return c;
    return undefined;
  }

  constructor(private readonly opts: HostOptions) {
    this.world = opts.createWorld(opts.modeId, opts.seed);
    this.lastNowMs = opts.now();
    // Sized so a client on a bad connection can still be delta-encoded against.
    // Too small and a lagging client silently falls back to FULL snapshots -- about
    // a kilobyte at 15Hz, which blows the 8 KB/s budget on its own and shows up as
    // a bandwidth failure rather than as the history-size problem it is.
    for (let i = 0; i < SNAPSHOT_HISTORY; i++) this.snapshots.push(createWorldSnap());
  }

  get stats(): HostStats {
    return {
      tick: this.world.tick,
      connections: this.conns.length,
      bytesOut: this.bytesOut,
      bytesIn: this.bytesIn,
      snapshotBytesLast: this.snapshotBytesLast,
    };
  }

  // ---- connections -------------------------------------------------------

  /**
   * Attach a transport. The connection is anonymous until Hello arrives, which is
   * what keeps an unfinished handshake from consuming a player slot.
   */
  accept(t: Transport): void {
    const c: Conn = {
      transport: t,
      playerId: -1,
      joined: false,
      refused: false,
      resumeToken: '',
      ackSeq: -1,
      pending: new Map(),
      last: createInputFrame(),
      held: createInputFrame(),
      warming: true,
      ackedTick: -1,
      ackedWallVersion: WALL_VERSION_NONE,
      wallSentAt: new Map(),
      idleTicks: 0,
      bytesIn: 0,
      bytesOut: 0,
    };
    this.conns.push(c);

    t.onMessage.on((data) => {
      c.idleTicks = 0;
      c.bytesIn += data.byteLength;
      this.bytesIn += data.byteLength;
      try {
        this.receive(c, data);
      } catch {
        // A malformed message costs that message, not the connection and
        // certainly not the match. Everything here came off a network.
      }
    });
    t.onClose.on(() => this.drop(c));
  }

  private receive(c: Conn, data: Uint8Array): void {
    const op = opOf(data);
    switch (op) {
      case Op.Hello:
        return this.onHello(c, decodeJson(data) as HelloBody);
      case Op.Input:
        return this.onInput(c, data);
      case Op.Ping: {
        // Echo the client's stamp back untouched, plus our own tick. The client
        // does all the RTT maths; the host stays stateless about clocks.
        const r = new Reader(data);
        r.u8();
        const stamp = r.u32();
        // A dedicated writer: this runs from a transport callback, and reusing the
        // snapshot writer would mean a pong arriving mid-broadcast could scribble
        // over a snapshot that had been handed out as a view but not yet copied.
        this.replyWriter.reset();
        this.replyWriter.u8(Op.Pong);
        this.replyWriter.u32(stamp);
        this.replyWriter.u32(this.world.tick);
        this.send(c, this.replyWriter.view_(), false);
        return;
      }
      default:
        return;
    }
  }

  private onHello(c: Conn, body: HelloBody): void {
    if (c.refused) return;

    // Already joined, and asking again? Then our Welcome did not arrive. Re-send it.
    //
    // Ignoring the repeat was a genuine deadlock: the host had assigned the slot and
    // was happily streaming snapshots, while the client -- which never learned its
    // own player id -- retried Hello forever and never joined. Answering again is
    // idempotent, since the slot and the resume token are both already decided.
    if (c.joined) {
      this.sendWelcome(c);
      return;
    }
    if (body.v !== PROTOCOL_VERSION) {
      this.refuse(c, `protocol ${body.v} but this host speaks ${PROTOCOL_VERSION}`);
      return;
    }

    // Reclaim a slot if the token matches a body we are still holding.
    let playerId = -1;
    if (body.resume) {
      for (const id of this.snowmen.keys()) {
        const p = this.world.players[id];
        if (p && this.tokenFor(id) === body.resume) {
          playerId = id;
          break;
        }
      }
    }

    if (playerId < 0) {
      const p = this.claimSlot(body.name || 'Player', body.skinId || 'stick');
      if (!p) {
        this.refuse(c, 'match is full');
        return;
      }
      playerId = p.id;
    } else {
      // Reclaiming: the body stops being a snowman and starts taking input again.
      this.snowmen.delete(playerId);
    }

    c.playerId = playerId;
    c.joined = true;
    c.resumeToken = this.tokenFor(playerId);
    c.ackedTick = -1;
    c.ackedWallVersion = WALL_VERSION_NONE;

    this.sendWelcome(c);
    this.broadcastRoster();
  }

  private sendWelcome(c: Conn): void {
    const welcome: WelcomeBody = {
      v: PROTOCOL_VERSION,
      playerId: c.playerId,
      resume: c.resumeToken,
      modeId: this.world.mode.id,
      mapId: this.opts.mapId ?? 'arena01',
      seed: this.opts.seed,
      tick: this.world.tick,
      roster: this.roster(),
    };
    this.send(c, encodeJson(Op.Welcome, welcome));
  }

  /**
   * Refuse a connection, and do NOT close it.
   *
   * Closing immediately after sending loses the message. A transport is free to
   * drop anything still queued when it shuts down -- `LocalTransport` does exactly
   * that, deliberately -- so the client would be disconnected with no idea why, and
   * "match is full" would present as a mystery failure to connect. Sending the
   * reason and letting the client hang up is both more reliable and better
   * protocol design: the side that asked gets to decide what to do about the answer.
   *
   * The connection is marked so it cannot ask again, and the idle timeout collects
   * it if the client never closes.
   */
  private refuse(c: Conn, reason: string): void {
    c.refused = true;
    this.send(c, encodeJson(Op.Refused, { reason }));
  }

  /**
   * A slot's resume token is derived, not stored.
   *
   * It only has to be unguessable enough that another player on the same LAN
   * cannot trivially steal a slot, and it must survive the host forgetting about
   * the connection. Deriving it from the seed and the slot does both without any
   * per-connection storage to leak.
   */
  private tokenFor(playerId: number): string {
    let h = 0x811c9dc5 ^ (this.opts.seed | 0);
    h = Math.imul(h ^ playerId, 0x01000193) >>> 0;
    h = Math.imul(h ^ 0x5bf03635, 0x01000193) >>> 0;
    return `${playerId.toString(36)}-${h.toString(36)}`;
  }

  private claimSlot(name: string, skinId: string): Player | null {
    const max = this.opts.maxPlayers ?? 8;
    const humans = this.conns.filter((c) => c.joined).length;
    if (humans >= max) return null;
    // Spawn through the mode so a mid-match joiner lands somewhere legal rather
    // than at the origin.
    const p = spawnPlayer(this.world, { name, skinId, x: 0, y: 0 });
    if (!p) return null;
    p.team = this.world.mode.assignTeam(this.world, p);
    this.world.mode.spawnPoint(this.world, p, SPAWN_OUT);
    p.x = SPAWN_OUT.x;
    p.y = SPAWN_OUT.y;
    return p;
  }

  private onInput(c: Conn, data: Uint8Array): void {
    if (!c.joined) return;
    const r = new Reader(data);
    r.u8();
    const ackedTick = r.u32();
    // A client can only ever confirm a tick it actually saw, so moving the
    // acknowledged tick FORWARD only is not politeness -- a stale or malicious ack
    // would make the host encode against a baseline the client no longer holds and
    // silently corrupt its world.
    if (ackedTick > c.ackedTick) {
      c.ackedTick = ackedTick;
      const wall = c.wallSentAt.get(ackedTick);
      if (wall !== undefined && wall > c.ackedWallVersion) c.ackedWallVersion = wall;
      // Anything older than the confirmed tick will never be asked about again.
      for (const t of c.wallSentAt.keys()) {
        if (t < ackedTick) c.wallSentAt.delete(t);
      }
    }

    const count = r.u8();
    for (let i = 0; i < count && i < INPUT_REDUNDANCY + 2; i++) {
      const f = this.scratchFrame;
      r.struct(f as unknown as Record<string, number>, INPUT_SCHEMA);
      validateInput(f);
      // Frames at or before the last one we consumed are the redundant copies.
      if (!seqAfter(f.seq, c.ackSeq)) continue;
      if (c.pending.has(f.seq)) continue;
      c.pending.set(f.seq, copyInputFrame(this.takeFrame(), f));
    }

    // A client that stops being read from must not grow without bound. Dropping
    // the OLDEST is right: a backlog means those frames are already too stale to
    // apply, and the recent ones are what the player is actually doing.
    if (c.pending.size > MAX_PENDING_FRAMES) {
      const keys = [...c.pending.keys()].sort(cmpSeq);
      for (const k of keys.slice(0, c.pending.size - MAX_PENDING_FRAMES)) {
        this.freeFrame(c.pending.get(k)!);
        c.pending.delete(k);
      }
    }
  }

  /**
   * Input frames come from a pool.
   *
   * Eight clients at 30Hz is 240 short-lived objects a second, and the host may be
   * a phone that is also rendering the game. The project's rule is no allocation in
   * the per-frame path, and the receive path is the per-frame path.
   */
  private takeFrame(): InputFrame {
    return this.framePool.pop() ?? createInputFrame();
  }

  private freeFrame(f: InputFrame): void {
    if (this.framePool.length < 256) this.framePool.push(f);
  }

  private drop(c: Conn): void {
    const i = this.conns.indexOf(c);
    if (i >= 0) this.conns.splice(i, 1);
    if (!c.joined || c.playerId < 0) return;

    // Leave the body standing as a frozen snowman rather than deleting it mid-fight.
    const p = this.world.players[c.playerId];
    if (p?.active) {
      this.snowmen.set(c.playerId, this.world.tick);
      p.vx = 0;
      p.vy = 0;
    }
    this.broadcastRoster();
  }

  private roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const p of this.world.players) {
      if (!p.active || p.isDummy) continue;
      out.push({
        id: p.id,
        name: p.name,
        skinId: p.skinId,
        isBot: this.brains.some((b) => b.playerId === p.id),
      });
    }
    return out;
  }

  private broadcastRoster(): void {
    const msg = encodeJson(Op.RoomState, { roster: this.roster(), modeId: this.world.mode.id });
    for (const c of this.conns) if (c.joined) this.send(c, msg);
  }

  // ---- match lifecycle ---------------------------------------------------

  /** Fill the remaining slots with bots and start the match. */
  start(): void {
    const want = this.opts.bots ?? 0;
    for (let i = 0; i < want; i++) {
      const p = spawnPlayer(this.world, { name: `Bot ${i + 1}`, skinId: 'stick', x: 0, y: 0 });
      if (!p) break;
      this.brains.push(createBotBrain(p.id, this.opts.seed + i * 7919));
    }
    startMatch(this.world);
    const msg = encodeJson(Op.MatchStart, {
      modeId: this.world.mode.id,
      tick: this.world.tick,
      roster: this.roster(),
    });
    for (const c of this.conns) {
      if (!c.joined) continue;
      // A new match is a new world, so every client's baseline is void. Forcing
      // them back to "no baseline" makes the next snapshot a full one.
      c.ackedTick = -1;
      c.ackedWallVersion = WALL_VERSION_NONE;
      c.wallSentAt.clear();
      this.send(c, msg);
    }
  }

  // ---- the loop ----------------------------------------------------------

  /**
   * Advance real time. Call as often as you like; ticks are fixed at 30Hz.
   *
   * `MAX_CATCHUP_TICKS` matters more on the host than anywhere else: a phone that
   * hosts and then gets backgrounded would otherwise return with two seconds of
   * simulation to catch up on and fast-forward the match violently for everyone.
   */
  advance(): number {
    const now = this.opts.now();
    let dt = now - this.lastNowMs;
    this.lastNowMs = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    this.accumulatorMs += Math.min(dt, TICK_MS * MAX_CATCHUP_TICKS * 2);

    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= TICK_MS;
      this.tick();
      ticks++;
    }
    if (ticks >= MAX_CATCHUP_TICKS) this.accumulatorMs = 0;
    return ticks;
  }

  /** One authoritative tick. Exposed so tests can drive without a clock. */
  tick(): readonly SimEvent[] {
    // Record positions BEFORE stepping, so "N ticks ago" means the state the client
    // was actually looking at when it decided to throw, not the state after.
    this.history.record(this.world, this.world.tick);

    this.collectInputs();
    const events = step(this.world, this.inputMap, {
      mode: 'authoritative',
      lagComp: this.lagComp,
    });
    for (const f of this.usedFrames) this.freeFrame(f);
    this.usedFrames.length = 0;
    this.expireSnowmen();
    this.eventEmitter.emit(events);

    if (events.length > 0) this.broadcastEvents(events);
    if (this.world.tick % SNAPSHOT_EVERY_TICKS === 0) this.broadcastSnapshot();

    for (const c of this.conns) {
      c.idleTicks++;
      if (c.idleTicks > CONNECTION_TIMEOUT_TICKS) c.transport.close(1001, 'timeout');
    }
    return events;
  }

  private collectInputs(): void {
    this.inputMap.clear();

    for (const c of this.conns) {
      if (!c.joined || c.playerId < 0) continue;

      // Wait for the jitter buffer to fill before consuming anything.
      //
      // Once draining, keep draining while frames are available; only a genuine
      // starve re-arms the wait. Re-filling on every dip would stutter the player
      // constantly, while never re-filling would mean a single starve leaves the
      // connection permanently one frame from the edge.
      if (c.warming) {
        if (c.pending.size < INPUT_BUFFER_TARGET) {
          this.inputMap.set(c.playerId, resetInputFrame(c.held));
          continue;
        }
        c.warming = false;
      }

      // Take the oldest frame the client has not had applied yet. One frame per
      // tick, in order: applying two in one tick would let a client on a bad
      // connection move at double speed once its backlog arrived.
      let nextSeq = -1;
      for (const seq of c.pending.keys()) {
        if (nextSeq < 0 || cmpSeq(seq, nextSeq) < 0) nextSeq = seq;
      }

      if (nextSeq >= 0) {
        const f = c.pending.get(nextSeq)!;
        c.pending.delete(nextSeq);
        c.ackSeq = nextSeq;
        copyInputFrame(c.last, f);
        // Applied this tick, so it can go back to the pool afterwards -- but not
        // before `step` has read it, hence the deferred list.
        this.inputMap.set(c.playerId, f);
        this.usedFrames.push(f);
      } else {
        // Nothing arrived. Hold the movement axes but CLEAR the buttons: repeating
        // an edge-triggered action would throw a second snowball the player never
        // asked for every time a packet was late. Holding movement is the right
        // guess -- a thumb on a joystick is usually still there next tick.
        const held = resetInputFrame(c.held);
        held.seq = c.last.seq;
        held.moveX = c.last.moveX;
        held.moveY = c.last.moveY;
        held.aim = c.last.aim;
        this.inputMap.set(c.playerId, held);
        // Starved. Re-arm the buffer so the next few frames rebuild the cushion
        // rather than running on empty and starving again immediately.
        c.warming = true;
      }
    }

    for (const b of this.brains) {
      const p = this.world.players[b.playerId];
      if (!p?.active) continue;
      this.inputMap.set(b.playerId, botInput(this.world, b, this.world.tick));
    }

    // A snowman takes no input at all, so it stands where it fell.
    for (const id of this.snowmen.keys()) this.inputMap.delete(id);
  }

  private expireSnowmen(): void {
    for (const [id, since] of this.snowmen) {
      if (this.world.tick - since < SNOWMAN_GRACE_TICKS) continue;
      this.snowmen.delete(id);
      const p = this.world.players[id];
      if (p) p.active = false;
      this.broadcastRoster();
    }
  }

  // ---- outbound ----------------------------------------------------------

  private broadcastSnapshot(): void {
    const cur = this.snapshotFor(this.world.tick);
    captureWorldSnap(this.world, cur, new Set(this.snowmen.keys()));

    for (const c of this.conns) {
      if (!c.joined) continue;
      const baseline = c.ackedTick >= 0 ? this.findSnapshot(c.ackedTick) : null;
      encodeSnapshot(
        this.world,
        this.writer,
        cur,
        baseline,
        c.ackSeq < 0 ? 0 : c.ackSeq,
        // With no baseline the client wipes its world before applying, walls
        // included, so the grid has to be re-sent from scratch. Sending only the
        // tiles it had already acknowledged would leave it permanently missing
        // every wall built before the resync.
        baseline ? c.ackedWallVersion : WALL_VERSION_NONE,
        this.encodeRes,
      );
      c.wallSentAt.set(this.world.tick, this.encodeRes.wallVersionSent);
      this.snapshotBytesLast = this.writer.length;
      this.send(c, this.writer.view_(), false);
    }
  }

  private broadcastEvents(events: readonly SimEvent[]): void {
    encodeEvents(this.writer, this.world.tick, events);
    const bytes = this.writer.view_();
    for (const c of this.conns) if (c.joined) this.send(c, bytes);
  }

  /**
   * `reliable` defaults to true, so a new message type is safe until someone decides
   * otherwise. Snapshots and pongs opt out: a snapshot is re-stated by the next one
   * and a pong by the next probe, so retransmitting either would delay fresher data
   * behind information that is already stale.
   */
  private send(c: Conn, data: Uint8Array, reliable = true): void {
    if (!c.transport.isOpen) return;
    c.bytesOut += data.byteLength;
    this.bytesOut += data.byteLength;
    c.transport.send(data, reliable);
  }

  /**
   * Snapshot history, as a small ring.
   *
   * Sized to cover the worst acknowledged-tick lag we are willing to delta
   * against; past that a client gets a full snapshot instead, which is correct but
   * bigger. Keyed by tick so a client's ack maps straight to a baseline.
   */
  private snapshotFor(tick: number): WorldSnap {
    const slot = Math.floor(tick / SNAPSHOT_EVERY_TICKS) % this.snapshots.length;
    return this.snapshots[slot]!;
  }

  private findSnapshot(tick: number): WorldSnap | null {
    const s = this.snapshotFor(tick);
    return s.tick === tick ? s : null;
  }
}

const SPAWN_OUT = { x: 0, y: 0 };

/**
 * A short ring of where each player has been, for lag compensation.
 *
 * Flat typed arrays indexed by `(playerId * depth + slot)`: this is written every
 * tick for every player and read on every throw, so it is worth keeping free of
 * per-tick object churn.
 */
class PositionHistory {
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly aim: Float32Array;
  private readonly stamped: Int32Array;
  private tick = -1;

  constructor(
    private readonly players: number,
    private readonly depth: number,
  ) {
    const n = players * depth;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.aim = new Float32Array(n);
    this.stamped = new Int32Array(n).fill(-1);
  }

  record(w: World, tick: number): void {
    this.tick = tick;
    const slot = ((tick % this.depth) + this.depth) % this.depth;
    for (let i = 0; i < this.players; i++) {
      const p = w.players[i];
      if (!p) continue;
      const at = i * this.depth + slot;
      this.x[at] = p.x;
      this.y[at] = p.y;
      this.aim[at] = p.aim;
      this.stamped[at] = p.active ? tick : -1;
    }
  }

  lookup(playerId: number, ticksAgo: number, out: ThrowOrigin): boolean {
    if (playerId < 0 || playerId >= this.players) return false;
    if (ticksAgo < 0 || ticksAgo >= this.depth) return false;
    const want = this.tick - ticksAgo;
    const slot = ((want % this.depth) + this.depth) % this.depth;
    const at = playerId * this.depth + slot;
    // The stamp check is what makes a stale ring entry unusable rather than
    // silently wrong: early in a match, or just after a join, the slot holds
    // whatever a previous match left in it.
    if (this.stamped[at] !== want) return false;
    out.x = this.x[at]!;
    out.y = this.y[at]!;
    out.aim = this.aim[at]!;
    return true;
  }
}

/** Beyond this a client's backlog is stale rather than useful. Two seconds. */
const MAX_PENDING_FRAMES = 60;

// ---------------------------------------------------------------------------
// Wrapping sequence arithmetic
// ---------------------------------------------------------------------------

/**
 * Sequence numbers are 16 bits and wrap every ~36 minutes at 30Hz.
 *
 * Comparing them with `>` works right up until the wrap, and then a client is
 * frozen out for the rest of the match because every new frame looks ancient.
 * These two treat the space as circular, which is the only correct reading of a
 * wrapping counter.
 */
export function cmpSeq(a: number, b: number): number {
  const d = ((a - b) << 16) >> 16;
  return d;
}

export function seqAfter(a: number, b: number): boolean {
  if (b < 0) return true;
  return cmpSeq(a, b) > 0;
}
