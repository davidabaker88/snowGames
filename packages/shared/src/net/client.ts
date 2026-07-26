/**
 * The net client.
 *
 * Holds two worlds, and understanding why is the key to the whole file:
 *
 *  - `confirmed` is the last authoritative state the host sent. It is never
 *    predicted, never guessed at, and is what remote players are interpolated
 *    between.
 *  - `world` is what the player sees: `confirmed`, plus this client's own unacked
 *    inputs replayed forward. That replay is why your own character responds on the
 *    frame you move your thumb instead of one round trip later.
 *
 * **What is predicted is deliberately narrow**: this client's own movement and its
 * own action state machine. NOT damage, deaths, pickups, scores, or anybody else's
 * position. That restriction is the reason bit-exact determinism is never required
 * here -- only structural determinism -- and it is why prediction error stays small
 * enough to hide. Predicting hits is precisely where "why didn't my hit count"
 * comes from, so hits render only from host events.
 */

import { MAX_CATCHUP_TICKS, TICK_MS } from '../constants.js';
import {
  copyInputFrame,
  createInputFrame,
  type InputFrame,
} from '../input/inputFrame.js';
import { step } from '../sim/step.js';
import type { SimEvent } from '../sim/types.js';
import type { World } from '../sim/world.js';
import { Emitter, type Signal } from './signal.js';
import { Reader, Writer, decodeJson, encodeJson, opOf } from './codec.js';
import { INPUT_SCHEMA } from './schema.js';
import {
  EXTRAPOLATE_MAX_MS,
  HELLO_RETRY_TICKS,
  INPUT_REDUNDANCY,
  INTERP_AGE_SAMPLES,
  INTERP_DELAY_MAX_MS,
  INTERP_DELAY_MIN_MS,
  INTERP_JITTER_MARGIN_MS,
  Op,
  PING_FAST_COUNT,
  PING_INTERVAL_TICKS,
  PING_INTERVAL_TICKS_INITIAL,
  PROTOCOL_VERSION,
  RECONCILE_DECAY_HALF_LIFE,
  RECONCILE_IGNORE_UNITS,
  RECONCILE_SNAP_UNITS,
  SNAPSHOT_EVERY_TICKS,
  SNAPSHOT_HISTORY,
} from './protocol.js';
import {
  applySnapshot,
  captureWorldSnap,
  clearWorldForResync,
  createSnapshotHeader,
  createWorldSnap,
  decodeEvents,
  type SnapshotHeader,
  type WorldSnap,
} from './snapshot.js';
import {
  addClockSample,
  createClockSync,
  hostTimeMs,
  jitterMs,
  slewClock,
  type ClockSync,
} from './clock.js';
import type { Transport } from './transport.js';
import type { RosterEntry, WelcomeBody } from './host.js';

export interface NetClientOptions {
  transport: Transport;
  /** Builds an empty world to receive snapshots into. */
  createWorld(modeId: string, seed: number): World;
  name: string;
  skinId: string;
  /** Monotonic milliseconds. Injected, so `shared/` needs no DOM. */
  now(): number;
  /** Presented to reclaim a slot after a reconnect. */
  resume?: string;
}

/** One received snapshot, kept so remote entities can be interpolated. */
interface Frame {
  tick: number;
  hostTimeMs: number;
  snap: WorldSnap;
}

export interface NetDebugInfo {
  rttMs: number;
  minRttMs: number;
  jitterMs: number;
  interpDelayMs: number;
  /** Age of the newest snapshot, in ms of host time. */
  snapshotAgeMs: number;
  /** Distance between predicted and confirmed position, in world units. */
  reconcileErrorUnits: number;
  /** Corrections above RECONCILE_SNAP_UNITS since connecting. */
  snapCount: number;
  unackedInputs: number;
  bytesIn: number;
  bytesOut: number;
  clockOffsetMs: number;
}

export class NetClient {
  /** What the player sees: confirmed state plus replayed local input. */
  world: World;
  /** The last authoritative state, untouched by prediction. */
  confirmed: World;

  playerId = -1;
  roster: RosterEntry[] = [];
  modeId = '';
  joined = false;
  refusedReason = '';
  /**
   * Token that reclaims this slot after a disconnect.
   *
   * A property rather than only an `onWelcome` payload: the app needs to stash it
   * somewhere durable, and code that attaches its listener a moment too late would
   * otherwise miss the one and only time it was ever mentioned.
   */
  resumeToken = '';

  private readonly clock: ClockSync = createClockSync();
  private readonly writer = new Writer();
  private readonly header: SnapshotHeader = createSnapshotHeader();
  private readonly inputMap = new Map<number, InputFrame>();

  /** Inputs sent but not yet confirmed applied by the host, oldest first. */
  private readonly unacked: InputFrame[] = [];
  private seq = 0;
  private lastAckSeq = -1;

  /** Received snapshots, newest last. */
  private readonly frames: Frame[] = [];
  private readonly framePool: WorldSnap[] = [];
  /** Our own capture of `confirmed`, to prove which baseline we hold. */
  private readonly heldBaseline: WorldSnap = createWorldSnap();
  private ackTick = -1;

  private interpDelayMs = INTERP_DELAY_MIN_MS;
  /** Observed snapshot ages, the input to the interpolation delay. */
  private readonly ageSamples: number[] = [];
  private pingsSent = 0;
  private ticksSincePing = 0;
  private helloTicks = 0;
  private readonly pingSentAt = new Map<number, number>();
  private nextPingStamp = 1;

  /** The visual offset that decays a mid-sized correction away. */
  private errX = 0;
  private errY = 0;
  private lastReconcileError = 0;
  private snapCount = 0;

  private accumulatorMs = 0;
  private lastNowMs: number;
  private bytesIn = 0;
  private bytesOut = 0;

  private readonly eventEmitter = new Emitter<readonly SimEvent[]>();
  /**
   * Events, straight from the host.
   *
   * The ONLY source of hits, eliminations, captures and scores as far as
   * presentation is concerned. The predicted world may believe it hit something;
   * that belief never reaches the player.
   */
  readonly onEvents: Signal<readonly SimEvent[]> = this.eventEmitter;

  private readonly welcomeEmitter = new Emitter<WelcomeBody>();
  readonly onWelcome: Signal<WelcomeBody> = this.welcomeEmitter;
  private readonly matchStartEmitter = new Emitter<string>();
  readonly onMatchStart: Signal<string> = this.matchStartEmitter;

  constructor(private readonly opts: NetClientOptions) {
    this.confirmed = opts.createWorld('sandbox', 0);
    this.world = opts.createWorld('sandbox', 0);
    clearWorldForResync(this.confirmed);
    clearWorldForResync(this.world);
    this.lastNowMs = opts.now();

    for (let i = 0; i < SNAPSHOT_HISTORY; i++) this.framePool.push(createWorldSnap());

    opts.transport.onMessage.on((data) => {
      this.bytesIn += data.byteLength;
      try {
        this.receive(data);
      } catch {
        // A bad message costs that message. The next snapshot re-states the world.
      }
    });
  }

  get debug(): NetDebugInfo {
    const newest = this.frames[this.frames.length - 1];
    return {
      rttMs: this.clock.lastRttMs,
      minRttMs: Number.isFinite(this.clock.minRttMs) ? this.clock.minRttMs : 0,
      jitterMs: jitterMs(this.clock),
      interpDelayMs: this.interpDelayMs,
      snapshotAgeMs: newest
        ? hostTimeMs(this.clock, this.opts.now()) - newest.hostTimeMs
        : 0,
      reconcileErrorUnits: this.lastReconcileError,
      snapCount: this.snapCount,
      unackedInputs: this.unacked.length,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      clockOffsetMs: this.clock.offsetMs,
    };
  }

  /** Visual offset applied to the local player, so corrections glide. */
  get renderOffset(): { x: number; y: number } {
    return { x: this.errX, y: this.errY };
  }

  // ---- handshake ---------------------------------------------------------

  async connect(): Promise<void> {
    await this.opts.transport.connect();
    this.sendHello();
  }

  private sendHello(): void {
    this.helloTicks = 0;
    this.sendJson(Op.Hello, {
      v: PROTOCOL_VERSION,
      name: this.opts.name,
      skinId: this.opts.skinId,
      resume: this.opts.resume,
    });
  }

  /**
   * Re-send Hello until the host answers.
   *
   * Rule 3 of the transport seam is that nothing may assume reliability, and the
   * handshake was the one place that quietly did. A single lost Hello -- or a lost
   * Welcome -- left the client connected, silent, and never joined, with no path out
   * of that state. Everything else in the protocol is either idempotent or covered
   * by redundancy; this needed a retry.
   *
   * Hello is idempotent on the host: an already-joined connection ignores it, and a
   * refused one stays refused, so a duplicate cannot claim a second slot.
   */
  private maybeRetryHello(): void {
    if (this.joined || this.refusedReason) return;
    this.helloTicks++;
    if (this.helloTicks < HELLO_RETRY_TICKS) return;
    this.sendHello();
  }

  // ---- inbound -----------------------------------------------------------

  private receive(data: Uint8Array): void {
    switch (opOf(data)) {
      case Op.Welcome:
        return this.onWelcomeMsg(decodeJson(data) as WelcomeBody);
      case Op.RoomState: {
        const body = decodeJson(data) as { roster: RosterEntry[]; modeId: string };
        this.roster = body.roster;
        this.modeId = body.modeId;
        return;
      }
      case Op.MatchStart: {
        const body = decodeJson(data) as { modeId: string; roster: RosterEntry[] };
        this.modeId = body.modeId;
        this.roster = body.roster;
        // A new match is a new world. Wipe both, drop every baseline, and wait for
        // the full snapshot the host is about to send.
        clearWorldForResync(this.confirmed);
        clearWorldForResync(this.world);
        this.frames.length = 0;
        this.ackTick = -1;
        this.heldBaseline.tick = -1;
        this.unacked.length = 0;
        this.errX = 0;
        this.errY = 0;
        this.matchStartEmitter.emit(body.modeId);
        return;
      }
      case Op.Refused: {
        const body = decodeJson(data) as { reason: string };
        this.refusedReason = body.reason;
        // We asked, we were told no, so we hang up. The host deliberately leaves
        // the connection open so the reason is guaranteed to arrive.
        this.opts.transport.close(1000, 'refused');
        return;
      }
      case Op.Snapshot:
        return this.onSnapshot(data);
      case Op.Events: {
        const evs: SimEvent[] = [];
        decodeEvents(data, evs);
        this.eventEmitter.emit(evs);
        return;
      }
      case Op.Pong: {
        const r = new Reader(data);
        r.u8();
        const stamp = r.u32();
        const hostTick = r.u32();
        const sentAt = this.pingSentAt.get(stamp);
        if (sentAt === undefined) return;
        this.pingSentAt.delete(stamp);
        addClockSample(this.clock, sentAt, this.opts.now(), hostTick);
        return;
      }
      default:
        return;
    }
  }

  private onWelcomeMsg(body: WelcomeBody): void {
    this.playerId = body.playerId;
    this.roster = body.roster;
    this.modeId = body.modeId;
    this.resumeToken = body.resume;
    this.joined = true;
    this.welcomeEmitter.emit(body);
  }

  private onSnapshot(data: Uint8Array): void {
    // Peek first. A delta is only meaningful against the baseline it names, and
    // applying one to the wrong state silently corrupts the world in a way that
    // looks like a physics bug three seconds later.
    const peek = applySnapshotIfSafe(
      this.confirmed,
      data,
      this.header,
      this.heldBaseline,
      this.frames,
      this.framePool,
    );
    if (!peek) return;

    this.ackTick = this.header.tick;
    captureWorldSnap(this.confirmed, this.heldBaseline);

    // Keep a copy for interpolating remote entities between snapshots.
    const snap = this.framePool.pop() ?? createWorldSnap();
    captureWorldSnap(this.confirmed, snap);
    this.frames.push({
      tick: this.header.tick,
      hostTimeMs: this.header.tick * TICK_MS,
      snap,
    });
    this.noteSnapshotAge(this.header.tick * TICK_MS);
    while (this.frames.length > SNAPSHOT_HISTORY) {
      const old = this.frames.shift()!;
      this.framePool.push(old.snap);
    }

    this.retireAckedInputs(this.header.ackSeq);
    this.reconcile();
  }

  /**
   * Drop inputs the host has confirmed applying.
   *
   * Wrapping comparison, because `ackSeq` is 16 bits. Using `<=` would freeze the
   * unacked queue at the wrap and the client would replay 36 minutes of input.
   */
  private retireAckedInputs(ackSeq: number): void {
    this.lastAckSeq = ackSeq;
    while (this.unacked.length > 0 && seqLessOrEqual(this.unacked[0]!.seq, ackSeq)) {
      this.unacked.shift();
    }
  }

  // ---- reconciliation ----------------------------------------------------

  /**
   * Rebuild the predicted world from confirmed state plus unacked input.
   *
   * The three error bands are in `protocol.ts` with the reasoning. In short: tiny
   * errors are ignored so a stationary player does not jitter, mid-sized ones move
   * the simulation immediately but the RENDER offset decays, and large ones snap
   * because smoothing a teleport is a lie about where somebody is.
   */
  private reconcile(): void {
    const before = this.world.players[this.playerId];
    const prevX = before?.x ?? 0;
    const prevY = before?.y ?? 0;

    copyWorldInto(this.world, this.confirmed);

    // Replay every input the host has not yet acknowledged, in order.
    for (const f of this.unacked) {
      this.inputMap.clear();
      this.inputMap.set(this.playerId, f);
      step(this.world, this.inputMap, { mode: 'predict', localPlayerId: this.playerId });
    }

    const after = this.world.players[this.playerId];
    if (!after || !before) return;

    const dx = prevX - after.x;
    const dy = prevY - after.y;
    const err = Math.hypot(dx, dy);
    this.lastReconcileError = err;

    if (err < RECONCILE_IGNORE_UNITS) {
      // Float noise from replaying in a different order. Correcting it is visible
      // as jitter; ignoring it is not visible at all.
      return;
    }
    if (err > RECONCILE_SNAP_UNITS) {
      this.snapCount++;
      this.errX = 0;
      this.errY = 0;
      return;
    }
    // Carry the old visual position forward and let it decay into the new one.
    this.errX = dx;
    this.errY = dy;
  }

  // ---- the loop ----------------------------------------------------------

  /**
   * Advance local time: predict forward, send input, probe the clock.
   *
   * Returns the number of simulation ticks predicted.
   */
  advance(localInput: InputFrame): number {
    const now = this.opts.now();
    let dt = now - this.lastNowMs;
    this.lastNowMs = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;

    slewClock(this.clock, dt);
    this.decayError(dt);

    this.accumulatorMs += Math.min(dt, TICK_MS * MAX_CATCHUP_TICKS * 2);
    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= TICK_MS;
      this.predictTick(localInput);
      ticks++;
    }
    if (ticks >= MAX_CATCHUP_TICKS) this.accumulatorMs = 0;

    this.maybePing();
    this.maybeRetryHello();
    return ticks;
  }

  private predictTick(localInput: InputFrame): void {
    if (!this.joined || this.playerId < 0) return;

    const f = createInputFrame();
    copyInputFrame(f, localInput);
    f.seq = this.seq++ & 0xffff;
    this.unacked.push(f);
    // Bound the queue. Past this the connection is not lagging, it is gone, and
    // replaying two seconds of input every snapshot would be a frame-rate problem
    // on top of a network one.
    if (this.unacked.length > 90) this.unacked.shift();

    this.inputMap.clear();
    this.inputMap.set(this.playerId, f);
    step(this.world, this.inputMap, { mode: 'predict', localPlayerId: this.playerId });

    this.sendInput();
  }

  /**
   * Send the last few frames, not just the newest one.
   *
   * A single lost packet is then invisible: the next message already carries the
   * frame that went missing. Retransmitting on detection would cost a full round
   * trip to notice, by which point the input is far too stale to apply.
   */
  private sendInput(): void {
    const n = Math.min(INPUT_REDUNDANCY, this.unacked.length);
    if (n === 0) return;

    this.writer.reset();
    this.writer.u8(Op.Input);
    this.writer.u32(Math.max(0, this.ackTick));
    this.writer.u8(n);
    for (let i = this.unacked.length - n; i < this.unacked.length; i++) {
      this.writer.struct(
        this.unacked[i]! as unknown as Record<string, number>,
        INPUT_SCHEMA,
      );
    }
    this.send(this.writer.view_());
  }

  private maybePing(): void {
    this.ticksSincePing++;
    const interval =
      this.pingsSent < PING_FAST_COUNT ? PING_INTERVAL_TICKS_INITIAL : PING_INTERVAL_TICKS;
    if (this.ticksSincePing < interval) return;
    this.ticksSincePing = 0;
    this.pingsSent++;

    const stamp = this.nextPingStamp++ >>> 0;
    this.pingSentAt.set(stamp, this.opts.now());
    // Unanswered probes must not accumulate; a lossy link would leak one per probe.
    if (this.pingSentAt.size > 32) {
      const oldest = this.pingSentAt.keys().next().value;
      if (oldest !== undefined) this.pingSentAt.delete(oldest);
    }

    this.writer.reset();
    this.writer.u8(Op.Ping);
    this.writer.u32(stamp);
    this.send(this.writer.view_());
  }

  private decayError(dtMs: number): void {
    if (this.errX === 0 && this.errY === 0) return;
    // Exponential decay by half-life, so the correction is frame-rate independent.
    const k = Math.pow(0.5, dtMs / 1000 / RECONCILE_DECAY_HALF_LIFE);
    this.errX *= k;
    this.errY *= k;
    if (Math.abs(this.errX) < 0.01) this.errX = 0;
    if (Math.abs(this.errY) < 0.01) this.errY = 0;
  }

  /**
   * Adapt how far behind the host remote entities are rendered.
   *
   * Driven by the measured AGE of arriving snapshots -- see the constants for why
   * jitter alone is the wrong input. The p95 rather than the max, so one stalled
   * snapshot does not permanently inflate the delay, and a margin on top so ordinary
   * variance never leaves the buffer empty.
   *
   * Eased rather than snapped, because the delay is part of the render clock: moving
   * it abruptly is itself a time discontinuity, which is the exact artefact this is
   * meant to prevent.
   */
  private retuneInterpDelay(): void {
    const sorted = this.ageSamples.slice().sort((a, b) => a - b);
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
      : 0;

    // A floor derived from what the connection cannot do better than, rather than
    // from observation alone. The newest snapshot a client can possibly hold is one
    // one-way trip old, plus up to a full snapshot interval of cadence -- and the
    // ages measured in the first second are unreliable anyway, because the clock
    // offset is still slewing while they are taken. Without this floor the delay
    // starts at its minimum and the first second of every match is extrapolated.
    const oneWay = Number.isFinite(this.clock.minRttMs) ? this.clock.minRttMs / 2 : 0;
    const floor = oneWay + SNAPSHOT_EVERY_TICKS * TICK_MS * 2;

    const want = Math.max(p95, floor) + INTERP_JITTER_MARGIN_MS;
    const target = Math.max(INTERP_DELAY_MIN_MS, Math.min(INTERP_DELAY_MAX_MS, want));

    // Seed rather than ease for the first few samples: easing from the minimum means
    // deliberately rendering ahead of the buffer while it converges.
    if (this.ageSamples.length <= 3) {
      this.interpDelayMs = target;
      return;
    }
    this.interpDelayMs += (target - this.interpDelayMs) * 0.15;
  }

  /** Record how old a snapshot was when it arrived. */
  private noteSnapshotAge(hostTimeOfSnapshot: number): void {
    // Retune even before the clock has a sample, so the latency floor applies from
    // the first snapshot rather than after the first successful ping.
    if (!this.clock.synced) {
      this.retuneInterpDelay();
      return;
    }
    const age = hostTimeMs(this.clock, this.opts.now()) - hostTimeOfSnapshot;
    if (!Number.isFinite(age) || age < 0) return;
    this.ageSamples.push(age);
    if (this.ageSamples.length > INTERP_AGE_SAMPLES) this.ageSamples.shift();
    this.retuneInterpDelay();
  }

  // ---- interpolation -----------------------------------------------------

  /**
   * Sample a remote player's rendered position.
   *
   * Returns `null` for the local player, who is predicted rather than interpolated,
   * and for anyone with no usable snapshots. `stale` is set once extrapolation has
   * run out, so the renderer can fade the entity: freezing a lagging player is
   * honest, whereas extrapolating one for a second sends them sprinting through a
   * wall and then snapping back.
   */
  sampleRemote(playerId: number, out: RemoteSample): RemoteSample | null {
    out.stale = false;
    if (this.frames.length === 0) return null;

    const renderTime = hostTimeMs(this.clock, this.opts.now()) - this.interpDelayMs;

    let older: Frame | null = null;
    let newer: Frame | null = null;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const fr = this.frames[i]!;
      if (fr.hostTimeMs <= renderTime) {
        older = fr;
        newer = this.frames[i + 1] ?? null;
        break;
      }
    }

    if (!older) {
      // Render time is before everything we hold, which happens for the first few
      // frames after joining. Show the oldest rather than nothing.
      older = this.frames[0]!;
      newer = this.frames[1] ?? null;
    }

    const a = older.snap.players[playerId];
    if (!a || (a['flags']! & 1) === 0) return null;

    if (!newer) {
      const ageMs = renderTime - older.hostTimeMs;
      if (ageMs > EXTRAPOLATE_MAX_MS) {
        // Freeze and let the caller fade it.
        out.x = a['x']!;
        out.y = a['y']!;
        out.facing = a['facing']!;
        out.stale = true;
        return out;
      }
      // Short gap: carry the last known velocity forward.
      const s = ageMs / 1000;
      out.x = a['x']! + a['vx']! * s;
      out.y = a['y']! + a['vy']! * s;
      out.facing = a['facing']!;
      return out;
    }

    const b = newer.snap.players[playerId];
    if (!b || (b['flags']! & 1) === 0) {
      out.x = a['x']!;
      out.y = a['y']!;
      out.facing = a['facing']!;
      return out;
    }

    const span = newer.hostTimeMs - older.hostTimeMs;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - older.hostTimeMs) / span)) : 0;
    out.x = a['x']! + (b['x']! - a['x']!) * t;
    out.y = a['y']! + (b['y']! - a['y']!) * t;
    out.facing = lerpAngle(a['facing']!, b['facing']!, t);
    return out;
  }

  // ---- outbound ----------------------------------------------------------

  private sendJson(op: number, body: unknown): void {
    this.send(encodeJson(op, body));
  }

  private send(data: Uint8Array): void {
    if (!this.opts.transport.isOpen) return;
    this.bytesOut += data.byteLength;
    this.opts.transport.send(data);
  }

  close(): void {
    this.opts.transport.close(1000, 'bye');
  }
}

export interface RemoteSample {
  x: number;
  y: number;
  facing: number;
  /** True when the entity has run out of snapshots and is frozen. */
  stale: boolean;
}

export function createRemoteSample(): RemoteSample {
  return { x: 0, y: 0, facing: 0, stale: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a snapshot only if we actually hold the baseline it claims.
 *
 * A delta describes a change FROM a specific state. Applying one to anything else
 * produces a world that is subtly, permanently wrong -- and it will not look like a
 * netcode bug, it will look like physics misbehaving later. Dropping the message
 * costs nothing: the client keeps acknowledging its older tick, so the host keeps
 * encoding against that same baseline and the next snapshot is applicable.
 */
function applySnapshotIfSafe(
  w: World,
  data: Uint8Array,
  header: SnapshotHeader,
  held: WorldSnap,
  frames: Frame[],
  pool: WorldSnap[],
): boolean {
  const r = new Reader(data);
  r.u8();
  const tick = r.u32();
  r.u16();
  const hasBaseline = r.u8() !== 0;
  const baselineTick = r.u32();

  if (hasBaseline && baselineTick !== held.tick) return false;
  // Out-of-order arrival: an older snapshot than one already applied would drag
  // the world backwards. Transports promise nothing about ordering.
  if (tick <= header.tick && held.tick >= 0) return false;

  if (!hasBaseline) {
    // A full snapshot lists only what EXISTS, so anything we are still holding
    // that the host has since forgotten -- a player who left during the gap, a
    // snowball that melted -- would survive as a ghost that never moves and never
    // goes away. Clearing first makes "full" mean full.
    //
    // The host pairs this by re-sending the wall grid from scratch whenever it
    // sends a full snapshot, so wiping the tiles here does not lose anything.
    clearWorldForResync(w);
    // Snapshots captured before the wipe describe a world that no longer exists;
    // interpolating between them and the new state would drag entities across the
    // arena.
    for (const fr of frames) pool.push(fr.snap);
    frames.length = 0;
  }

  applySnapshot(w, data, header);
  return true;
}

/**
 * Copy confirmed state into the predicted world.
 *
 * Field-by-field rather than a structured clone: this runs on every snapshot, and
 * the whole reason the world is plain structs in fixed arrays is that copying it is
 * cheap and allocation-free.
 */
function copyWorldInto(dst: World, src: World): void {
  dst.tick = src.tick;
  dst.rng.s = src.rng.s;

  for (let i = 0; i < src.players.length; i++) {
    const a = src.players[i]!;
    const b = dst.players[i]!;
    b.active = a.active;
    b.isDummy = a.isDummy;
    b.name = a.name;
    b.skinId = a.skinId;
    b.team = a.team;
    b.x = a.x;
    b.y = a.y;
    b.vx = a.vx;
    b.vy = a.vy;
    b.facing = a.facing;
    b.aim = a.aim;
    b.action = a.action;
    b.actionTicks = a.actionTicks;
    b.gaitDistance = a.gaitDistance;
    b.hp = a.hp;
    b.alive = a.alive;
    b.respawnTicks = a.respawnTicks;
    b.packProgress = a.packProgress;
    b.packIdleTicks = a.packIdleTicks;
    b.heldBall = a.heldBall;
    b.throwCooldown = a.throwCooldown;
    b.pendingThrowPower = a.pendingThrowPower;
    b.staggerAmount = a.staggerAmount;
    b.score = a.score;
    b.buildsRemaining = a.buildsRemaining;
    b.carryingFlag = a.carryingFlag;
  }

  for (let i = 0; i < src.balls.length; i++) {
    const a = src.balls[i]!;
    const b = dst.balls[i]!;
    b.alive = a.alive;
    b.state = a.state;
    b.size = a.size;
    b.owner = a.owner;
    b.team = a.team;
    b.x = a.x;
    b.y = a.y;
    b.z = a.z;
    b.vx = a.vx;
    b.vy = a.vy;
    b.vz = a.vz;
    b.spin = a.spin;
    b.stateTick = a.stateTick;
  }

  const m = dst.match;
  m.phase = src.match.phase;
  m.phaseTicks = src.match.phaseTicks;
  m.timeRemainingTicks = src.match.timeRemainingTicks;
  for (let i = 0; i < 4; i++) m.teamScores[i] = src.match.teamScores[i] ?? 0;
  m.winnerTeam = src.match.winnerTeam;
  m.winnerPlayer = src.match.winnerPlayer;
  m.winReason = src.match.winReason;

  for (let i = 0; i < src.flags.length; i++) {
    const a = src.flags[i]!;
    const b = dst.flags[i]!;
    b.active = a.active;
    b.team = a.team;
    b.state = a.state;
    b.x = a.x;
    b.y = a.y;
    b.baseX = a.baseX;
    b.baseY = a.baseY;
    b.carrier = a.carrier;
    b.returnTicks = a.returnTicks;
  }

  for (let i = 0; i < src.zones.length; i++) {
    const a = src.zones[i]!;
    const b = dst.zones[i]!;
    b.active = a.active;
    b.x = a.x;
    b.y = a.y;
    b.radius = a.radius;
    b.label = a.label;
    b.owner = a.owner;
    b.progress = a.progress;
    b.contender = a.contender;
  }

  dst.ring.active = src.ring.active;
  dst.ring.x = src.ring.x;
  dst.ring.y = src.ring.y;
  dst.ring.radius = src.ring.radius;
  dst.ring.targetRadius = src.ring.targetRadius;
  dst.ring.shrinkPerTick = src.ring.shrinkPerTick;
  dst.ring.delayTicks = src.ring.delayTicks;

  dst.walls.tier.set(src.walls.tier);
  dst.walls.hp.set(src.walls.hp);
  dst.walls.tileVersion.set(src.walls.tileVersion);
  dst.walls.version = src.walls.version;

  dst.mode = src.mode;
  dst.props = src.props;
  dst.events.length = 0;
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

/** Wrapping `a <= b` over 16-bit sequence numbers. */
function seqLessOrEqual(a: number, b: number): boolean {
  if (b < 0) return false;
  return (((a - b) << 16) >> 16) <= 0;
}
