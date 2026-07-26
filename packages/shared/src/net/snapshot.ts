/**
 * Snapshots: World -> bytes -> World.
 *
 * Three ideas do the work here.
 *
 * **Capture quantizes.** A captured snapshot holds exactly the values the wire can
 * carry, not the simulation's f64s. Everything downstream compares quantized
 * against quantized, so "unchanged" means the bytes would be identical -- without
 * that, a player standing still whose x drifts by 1/1000 of a unit is re-sent on
 * every single snapshot and delta compression silently does nothing.
 *
 * **One history, N encodings.** The captured state is identical for every client;
 * only the baseline they are behind differs. So the host captures once per snapshot
 * tick into a ring buffer and encodes per connection against whatever that client
 * last acknowledged. Capture cost is O(world), not O(world x clients).
 *
 * **The baseline is what the client ACKED, never what was last sent.** Sent is not
 * received. If a snapshot is lost, the client keeps acknowledging the older tick,
 * the host keeps encoding against that older baseline, and the state that went
 * missing is naturally included again. No retransmit logic, no nacks, and loss
 * recovery costs exactly one extra delta.
 */

import { MAX_BALLS } from '../constants.js';
import {
  ActionState,
  BallSize,
  BallState,
  FlagState,
  MatchPhase,
  TEAM_NONE,
  type SimEvent,
} from '../sim/types.js';
import { MAX_FLAGS, MAX_PLAYERS, MAX_ZONES, type World } from '../sim/world.js';
import { touchTile } from '../sim/walls.js';
import { Reader, Writer, CodecError } from './codec.js';
import {
  BALL_FLAG_ALIVE,
  BALL_SCHEMA,
  EVENT_SCHEMA,
  FLAG_SCHEMA,
  MATCH_SCHEMA,
  PLAYER_FLAG_ACTIVE,
  PLAYER_FLAG_ALIVE,
  PLAYER_FLAG_DUMMY,
  PLAYER_FLAG_SNOWMAN,
  PLAYER_SCHEMA,
  RING_SCHEMA,
  TILE_SCHEMA,
  ZONE_SCHEMA,
  quantizeStruct,
  structBytes,
  structEqual,
} from './schema.js';
import { Op } from './protocol.js';

type Row = Record<string, number>;

/**
 * The wall version a client is assumed to hold before it has been told anything.
 *
 * Zero, matching a freshly created or freshly resynced grid, where every tile is
 * empty and untouched.
 */
export const WALL_VERSION_NONE = 0;

/**
 * `actionTicks` SATURATES on the wire instead of counting up forever.
 *
 * This is a bandwidth fix with a real bite. An idle player's `actionTicks`
 * increments every single tick, so without a ceiling every player differs from
 * every baseline on every snapshot, and delta compression achieves nothing at all:
 * eight players standing in a lobby cost the same as eight players in a firefight.
 *
 * 63 is safe because the longest thing the simulation compares `actionTicks`
 * against is `BUILD_TICKS`, which is 24. Only Idle, Walking and Eliminated ever run
 * past the ceiling, and none of them is timed by this field -- respawn has its own
 * counter. The animator likewise only needs the early part of a clip.
 */
export const ACTION_TICKS_WIRE_MAX = 63;

/** A quantized copy of everything the wire carries. */
export interface WorldSnap {
  tick: number;
  players: Row[];
  balls: Row[];
  match: Row;
  flags: Row[];
  zones: Row[];
  ring: Row;
  /** The wall grid's version at capture time. */
  wallVersion: number;
}

export function createWorldSnap(): WorldSnap {
  const row = (): Row => ({});
  return {
    tick: -1,
    players: Array.from({ length: MAX_PLAYERS }, row),
    balls: Array.from({ length: MAX_BALLS }, row),
    match: row(),
    flags: Array.from({ length: MAX_FLAGS }, row),
    zones: Array.from({ length: MAX_ZONES }, row),
    ring: row(),
    wallVersion: -1,
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Players carry a `snowman` flag that lives outside the simulation.
 *
 * The sim has no concept of a disconnected body -- it is a netcode concern -- so
 * the host keeps the set here and stamps it into the snapshot. Keeping it out of
 * `Player` means `step()` stays a pure function of gameplay state.
 */
export type SnowmanSet = ReadonlySet<number>;

const NO_SNOWMEN: SnowmanSet = new Set<number>();

/** Fill `snap` from `w`, quantizing as we go. Allocates nothing after warm-up. */
export function captureWorldSnap(
  w: World,
  snap: WorldSnap,
  snowmen: SnowmanSet = NO_SNOWMEN,
): WorldSnap {
  snap.tick = w.tick;
  snap.wallVersion = w.walls.version;

  const scratch: Row = SCRATCH;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const p = w.players[i]!;
    // An unused slot is canonically all-zero on the wire.
    //
    // Without this, "unused" means whatever happened to be left in the struct --
    // a never-spawned slot still carries `alive: true` and `hp: 100` from
    // `createPlayer`, while a resynced client's slot carries zeros. Neither is
    // wrong, but they differ, so a delta would report the slot as changed on every
    // snapshot for the whole match and any state comparison between the two
    // machines would fail on entities that do not exist.
    if (!p.active) {
      zeroRow(snap.players[i]!, PLAYER_SCHEMA);
      continue;
    }
    scratch['flags'] =
      (p.active ? PLAYER_FLAG_ACTIVE : 0) |
      (p.alive ? PLAYER_FLAG_ALIVE : 0) |
      (p.isDummy ? PLAYER_FLAG_DUMMY : 0) |
      (snowmen.has(p.id) ? PLAYER_FLAG_SNOWMAN : 0);
    scratch['x'] = p.x;
    scratch['y'] = p.y;
    scratch['vx'] = p.vx;
    scratch['vy'] = p.vy;
    scratch['facing'] = p.facing;
    scratch['aim'] = p.aim;
    scratch['action'] = p.action;
    scratch['actionTicks'] = Math.min(ACTION_TICKS_WIRE_MAX, p.actionTicks);
    scratch['hp'] = p.hp;
    scratch['respawnTicks'] = Math.max(0, p.respawnTicks);
    scratch['packProgress'] = p.packProgress;
    scratch['heldBall'] = p.heldBall;
    scratch['score'] = p.score;
    scratch['buildsRemaining'] = p.buildsRemaining;
    scratch['carryingFlag'] = p.carryingFlag;
    scratch['team'] = p.team;
    quantizeStruct(snap.players[i]!, scratch, PLAYER_SCHEMA);
  }

  for (let i = 0; i < MAX_BALLS; i++) {
    const b = w.balls[i]!;
    if (!b.alive) {
      zeroRow(snap.balls[i]!, BALL_SCHEMA);
      continue;
    }
    scratch['flags'] = BALL_FLAG_ALIVE;
    scratch['state'] = b.state;
    scratch['size'] = b.size;
    scratch['owner'] = b.owner;
    scratch['team'] = b.team;
    scratch['x'] = b.x;
    scratch['y'] = b.y;
    scratch['z'] = Math.max(0, b.z);
    scratch['vx'] = b.vx;
    scratch['vy'] = b.vy;
    scratch['vz'] = b.vz;
    scratch['spin'] = b.spin;
    quantizeStruct(snap.balls[i]!, scratch, BALL_SCHEMA);
  }

  const m = w.match;
  scratch['phase'] = m.phase;
  scratch['phaseTicks'] = Math.min(0xffff, m.phaseTicks);
  scratch['timeRemainingTicks'] = Math.max(0, m.timeRemainingTicks);
  scratch['score0'] = m.teamScores[0] ?? 0;
  scratch['score1'] = m.teamScores[1] ?? 0;
  scratch['score2'] = m.teamScores[2] ?? 0;
  scratch['score3'] = m.teamScores[3] ?? 0;
  scratch['winnerTeam'] = m.winnerTeam;
  scratch['winnerPlayer'] = m.winnerPlayer;
  quantizeStruct(snap.match, scratch, MATCH_SCHEMA);

  for (let i = 0; i < MAX_FLAGS; i++) {
    const fl = w.flags[i]!;
    if (!fl.active) {
      zeroRow(snap.flags[i]!, FLAG_SCHEMA);
      continue;
    }
    scratch['flags'] = 1;
    scratch['team'] = fl.team;
    scratch['state'] = fl.state;
    scratch['x'] = fl.x;
    scratch['y'] = fl.y;
    scratch['carrier'] = fl.carrier;
    scratch['returnTicks'] = Math.max(0, fl.returnTicks);
    quantizeStruct(snap.flags[i]!, scratch, FLAG_SCHEMA);
  }

  for (let i = 0; i < MAX_ZONES; i++) {
    const z = w.zones[i]!;
    if (!z.active) {
      zeroRow(snap.zones[i]!, ZONE_SCHEMA);
      continue;
    }
    scratch['flags'] = 1;
    scratch['x'] = z.x;
    scratch['y'] = z.y;
    scratch['radius'] = z.radius;
    scratch['owner'] = z.owner;
    scratch['contender'] = z.contender;
    scratch['progress'] = z.progress;
    quantizeStruct(snap.zones[i]!, scratch, ZONE_SCHEMA);
  }

  const r = w.ring;
  if (r.active) {
    scratch['flags'] = 1;
    scratch['x'] = r.x;
    scratch['y'] = r.y;
    scratch['radius'] = r.radius;
    scratch['targetRadius'] = r.targetRadius;
    scratch['delayTicks'] = Math.max(0, r.delayTicks);
    quantizeStruct(snap.ring, scratch, RING_SCHEMA);
  } else {
    zeroRow(snap.ring, RING_SCHEMA);
  }

  return snap;
}

/** One shared scratch row. Capture is never re-entrant. */
const SCRATCH: Row = {};

function zeroRow(row: Row, s: typeof PLAYER_SCHEMA): void {
  for (const f of s) row[f.key] = 0;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export interface EncodeResult {
  /** Highest wall-grid version whose tiles all fit in this message. */
  wallVersionSent: number;
  /** True when tiles had to be left for the next snapshot. */
  tilesTruncated: boolean;
}

const BALL_BYTES = structBytes(BALL_SCHEMA);
const TILE_BYTES = structBytes(TILE_SCHEMA);

/**
 * Encode one snapshot for one connection.
 *
 * `baseline` is the last snapshot this client acknowledged, or null for a full
 * send. Fields are compared quantized-against-quantized (see `structEqual`), so a
 * value that would encode to the same bytes costs nothing.
 */
export function encodeSnapshot(
  w: World,
  out: Writer,
  cur: WorldSnap,
  baseline: WorldSnap | null,
  ackSeq: number,
  ackedWallVersion: number,
  res: EncodeResult,
): Writer {
  out.reset();
  out.u8(Op.Snapshot);
  out.u32(cur.tick);
  out.u16(ackSeq & 0xffff);
  // Tick 0 is a legal simulation tick, so "no baseline" is signalled by a flag
  // byte rather than by a magic tick value.
  out.u8(baseline ? 1 : 0);
  out.u32(baseline ? baseline.tick : 0);

  // ---- players: a bitmask, then only the changed rows ----------------------
  let changedMask = 0;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const row = cur.players[i]!;
    const base = baseline?.players[i];
    // An inactive player that was already inactive is the common case and must
    // cost zero bits beyond its mask bit.
    if (!base) {
      if ((row['flags']! & PLAYER_FLAG_ACTIVE) !== 0) changedMask |= 1 << i;
    } else if (!structEqual(row, base, PLAYER_SCHEMA)) {
      changedMask |= 1 << i;
    }
  }
  out.u16(changedMask);
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if ((changedMask & (1 << i)) === 0) continue;
    out.struct(cur.players[i]!, PLAYER_SCHEMA);
  }

  // ---- balls: a count, then id + row --------------------------------------
  // A count rather than a 160-bit mask: at most a dozen balls change per snapshot,
  // so 1 byte plus 1 byte per change beats 20 bytes of mask every time.
  const ballIds: number[] = BALL_SCRATCH;
  ballIds.length = 0;
  for (let i = 0; i < MAX_BALLS; i++) {
    const row = cur.balls[i]!;
    const base = baseline?.balls[i];
    if (!base) {
      if ((row['flags']! & BALL_FLAG_ALIVE) !== 0) ballIds.push(i);
    } else if (!structEqual(row, base, BALL_SCHEMA)) {
      ballIds.push(i);
    }
  }
  // Reserve room for the tail (match/flags/zones/ring headers) before spending the
  // rest on balls, or a busy tick can push the objective state off the end.
  const TAIL_RESERVE = 96;
  const maxBalls = Math.max(0, Math.floor((out.remaining - TAIL_RESERVE) / (1 + BALL_BYTES)));
  const ballCount = Math.min(ballIds.length, maxBalls, 255);
  out.u8(ballCount);
  for (let n = 0; n < ballCount; n++) {
    const id = ballIds[n]!;
    out.u8(id);
    out.struct(cur.balls[id]!, BALL_SCHEMA);
  }

  // ---- match / flags / zones / ring ---------------------------------------
  const matchChanged = !baseline || !structEqual(cur.match, baseline.match, MATCH_SCHEMA);
  out.u8(matchChanged ? 1 : 0);
  if (matchChanged) out.struct(cur.match, MATCH_SCHEMA);

  let flagMask = 0;
  for (let i = 0; i < MAX_FLAGS; i++) {
    const base = baseline?.flags[i];
    if (!base ? cur.flags[i]!['flags'] !== 0 : !structEqual(cur.flags[i]!, base, FLAG_SCHEMA)) {
      flagMask |= 1 << i;
    }
  }
  out.u8(flagMask);
  for (let i = 0; i < MAX_FLAGS; i++) {
    if (flagMask & (1 << i)) out.struct(cur.flags[i]!, FLAG_SCHEMA);
  }

  let zoneMask = 0;
  for (let i = 0; i < MAX_ZONES; i++) {
    const base = baseline?.zones[i];
    if (!base ? cur.zones[i]!['flags'] !== 0 : !structEqual(cur.zones[i]!, base, ZONE_SCHEMA)) {
      zoneMask |= 1 << i;
    }
  }
  out.u8(zoneMask);
  for (let i = 0; i < MAX_ZONES; i++) {
    if (zoneMask & (1 << i)) out.struct(cur.zones[i]!, ZONE_SCHEMA);
  }

  const ringChanged = !baseline || !structEqual(cur.ring, baseline.ring, RING_SCHEMA);
  out.u8(ringChanged ? 1 : 0);
  if (ringChanged) out.struct(cur.ring, RING_SCHEMA);

  // ---- wall tiles ---------------------------------------------------------
  // Ascending by version, so "everything up to V has been sent" is a single
  // number the connection can remember and the client can acknowledge.
  const g = w.walls;
  const pending: number[] = TILE_SCRATCH;
  pending.length = 0;
  // Floor at WALL_VERSION_NONE. A tile that has never been touched sits at
  // version 0 and is empty, which is exactly what a fresh or resynced client grid
  // already holds -- so it needs no bytes. This is not just an optimisation: every
  // untouched tile shares version 0, so they cannot be acknowledged individually,
  // and including them would mean the ack could never advance past the first
  // truncated chunk. The sync would resend the same 220 tiles forever.
  const from = Math.max(ackedWallVersion, WALL_VERSION_NONE);
  for (let i = 0; i < g.tileVersion.length; i++) {
    if (g.tileVersion[i]! > from) pending.push(i);
  }
  // Ascending version. `touchTile` increments before assigning, so versions are
  // unique, which is what makes "everything up to V" a sound thing to acknowledge.
  pending.sort((a, b) => g.tileVersion[a]! - g.tileVersion[b]!);

  const room = Math.max(0, Math.floor((out.remaining - 2) / TILE_BYTES));
  const tileCount = Math.min(pending.length, room, 255);
  out.u8(tileCount);
  for (let n = 0; n < tileCount; n++) {
    const i = pending[n]!;
    SCRATCH['index'] = i;
    SCRATCH['tier'] = g.tier[i]!;
    SCRATCH['hp'] = g.hp[i]!;
    out.struct(SCRATCH, TILE_SCHEMA);
  }

  res.tilesTruncated = tileCount < pending.length;
  res.wallVersionSent = res.tilesTruncated
    ? // Stop short of the first tile we could not fit, so nothing is skipped.
      g.tileVersion[pending[tileCount]!]! - 1
    : g.version;

  return out;
}

const BALL_SCRATCH: number[] = [];
const TILE_SCRATCH: number[] = [];

// ---------------------------------------------------------------------------
// Decode / apply
// ---------------------------------------------------------------------------

export interface SnapshotHeader {
  tick: number;
  ackSeq: number;
  hasBaseline: boolean;
  baselineTick: number;
}

/** Peek at the header without applying anything. */
export function readSnapshotHeader(data: Uint8Array, out: SnapshotHeader): SnapshotHeader {
  const r = new Reader(data);
  if (r.u8() !== Op.Snapshot) throw new CodecError('not a snapshot');
  out.tick = r.u32();
  out.ackSeq = r.u16();
  out.hasBaseline = r.u8() !== 0;
  out.baselineTick = r.u32();
  return out;
}

export function createSnapshotHeader(): SnapshotHeader {
  return { tick: 0, ackSeq: 0, hasBaseline: false, baselineTick: 0 };
}

/**
 * Apply a snapshot to a world in place.
 *
 * Everything the message does not mention is left exactly as it was, which is what
 * makes a delta a delta. The caller is responsible for having verified that its
 * world is actually at `baselineTick` -- see `NetClient`, which drops a delta whose
 * baseline it does not hold rather than applying it to the wrong state.
 */
export function applySnapshot(w: World, data: Uint8Array, out: SnapshotHeader): SnapshotHeader {
  const r = new Reader(data);
  if (r.u8() !== Op.Snapshot) throw new CodecError('not a snapshot');
  out.tick = r.u32();
  out.ackSeq = r.u16();
  out.hasBaseline = r.u8() !== 0;
  out.baselineTick = r.u32();

  w.tick = out.tick;

  const row: Row = APPLY_SCRATCH;

  const changedMask = r.u16();
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if ((changedMask & (1 << i)) === 0) continue;
    r.struct(row, PLAYER_SCHEMA);
    const p = w.players[i]!;
    const fl = row['flags']!;
    // A slot the host says is unused arrives as a canonical zero row. Deactivate
    // and stop: writing the zeros in would set `heldBall` to 0 rather than -1,
    // which reads as "holding ball zero" to anything that forgets to check
    // `active` first. Leaving the fields alone cannot mislead anyone.
    if ((fl & PLAYER_FLAG_ACTIVE) === 0) {
      p.active = false;
      p.alive = false;
      continue;
    }
    p.active = true;
    p.alive = (fl & PLAYER_FLAG_ALIVE) !== 0;
    p.isDummy = (fl & PLAYER_FLAG_DUMMY) !== 0;
    p.x = row['x']!;
    p.y = row['y']!;
    p.vx = row['vx']!;
    p.vy = row['vy']!;
    p.facing = row['facing']!;
    p.aim = row['aim']!;
    p.action = row['action']! as ActionState;
    p.actionTicks = row['actionTicks']!;
    p.hp = row['hp']!;
    p.respawnTicks = row['respawnTicks']!;
    p.packProgress = row['packProgress']!;
    p.heldBall = row['heldBall']!;
    p.score = row['score']!;
    p.buildsRemaining = row['buildsRemaining']!;
    p.carryingFlag = row['carryingFlag']!;
    p.team = row['team']!;
  }

  const ballCount = r.u8();
  for (let n = 0; n < ballCount; n++) {
    const id = r.u8();
    r.struct(row, BALL_SCHEMA);
    const b = w.balls[id];
    if (!b) throw new CodecError(`ball id ${id} out of range`);
    // Release it exactly the way `freeBall` does, rather than writing zeros in.
    // `allocBall` takes the lowest non-alive slot, so the client's idea of a freed
    // ball has to match the host's or the two disagree about which slot the next
    // snowball lands in -- the one invariant the whole prediction path rests on.
    if ((row['flags']! & BALL_FLAG_ALIVE) === 0) {
      b.alive = false;
      b.owner = -1;
      b.state = BallState.Grounded;
      continue;
    }
    b.alive = true;
    b.state = row['state']! as BallState;
    b.size = row['size']! as BallSize;
    b.owner = row['owner']!;
    b.team = row['team']!;
    b.x = row['x']!;
    b.y = row['y']!;
    b.z = row['z']!;
    b.vx = row['vx']!;
    b.vy = row['vy']!;
    b.vz = row['vz']!;
    b.spin = row['spin']!;
  }

  if (r.u8() !== 0) {
    r.struct(row, MATCH_SCHEMA);
    const m = w.match;
    m.phase = row['phase']! as MatchPhase;
    m.phaseTicks = row['phaseTicks']!;
    m.timeRemainingTicks = row['timeRemainingTicks']!;
    m.teamScores[0] = row['score0']!;
    m.teamScores[1] = row['score1']!;
    m.teamScores[2] = row['score2']!;
    m.teamScores[3] = row['score3']!;
    m.winnerTeam = row['winnerTeam']!;
    m.winnerPlayer = row['winnerPlayer']!;
  }

  const flagMask = r.u8();
  for (let i = 0; i < MAX_FLAGS; i++) {
    if ((flagMask & (1 << i)) === 0) continue;
    r.struct(row, FLAG_SCHEMA);
    const fl = w.flags[i]!;
    if (row['flags']! === 0) {
      fl.active = false;
      continue;
    }
    fl.active = true;
    fl.team = row['team']!;
    fl.state = row['state']! as FlagState;
    fl.x = row['x']!;
    fl.y = row['y']!;
    fl.carrier = row['carrier']!;
    fl.returnTicks = row['returnTicks']!;
  }

  const zoneMask = r.u8();
  for (let i = 0; i < MAX_ZONES; i++) {
    if ((zoneMask & (1 << i)) === 0) continue;
    r.struct(row, ZONE_SCHEMA);
    const z = w.zones[i]!;
    if (row['flags']! === 0) {
      z.active = false;
      continue;
    }
    z.active = true;
    z.x = row['x']!;
    z.y = row['y']!;
    z.radius = row['radius']!;
    z.owner = row['owner']!;
    z.contender = row['contender']!;
    z.progress = row['progress']!;
  }

  if (r.u8() !== 0) {
    r.struct(row, RING_SCHEMA);
    const rg = w.ring;
    // No early return here: the tile section still follows. Bailing out of the
    // whole function because the ring happens to be inactive would silently stop
    // applying wall updates for every mode that has no blizzard, which is five of
    // the six.
    if (row['flags']! === 0) {
      rg.active = false;
    } else {
      rg.active = true;
      rg.x = row['x']!;
      rg.y = row['y']!;
      rg.radius = row['radius']!;
      rg.targetRadius = row['targetRadius']!;
      rg.delayTicks = row['delayTicks']!;
    }
  }

  const tileCount = r.u8();
  for (let n = 0; n < tileCount; n++) {
    r.struct(row, TILE_SCHEMA);
    const i = row['index']!;
    if (i < 0 || i >= w.walls.tier.length) throw new CodecError(`tile ${i} out of range`);
    w.walls.tier[i] = row['tier']!;
    w.walls.hp[i] = row['hp']!;
    // Keep the client's own version bookkeeping coherent so a renderer watching
    // `version` for cache invalidation still sees the change.
    touchTile(w.walls, i);
  }

  return out;
}

const APPLY_SCRATCH: Row = {};

// ---------------------------------------------------------------------------
// Baselines the client keeps
// ---------------------------------------------------------------------------

/**
 * Restore the flag/state fields the schema flattens, for the client's own copy.
 *
 * The client needs its OWN quantized capture of the world to answer "am I at the
 * baseline the host thinks I am at". It reuses `captureWorldSnap`, so the answer is
 * computed by the same code the host used -- which is the only way the two can be
 * relied on to agree.
 */
export function snapMatchesTick(snap: WorldSnap, tick: number): boolean {
  return snap.tick === tick;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_BYTES = structBytes(EVENT_SCHEMA);

/**
 * Events go out the moment they happen, not on the snapshot cadence.
 *
 * A hit that took 66ms to be acknowledged feels like a hit that did not land.
 * They are also idempotent by construction (they only ever trigger presentation),
 * so a duplicate from a lossy transport is harmless and needs no sequence number.
 */
export function encodeEvents(out: Writer, tick: number, events: readonly SimEvent[]): number {
  out.reset();
  out.u8(Op.Events);
  out.u32(tick);
  const room = Math.max(0, Math.floor((out.remaining - 1) / EVENT_BYTES));
  const n = Math.min(events.length, room, 255);
  out.u8(n);
  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    SCRATCH['type'] = e.type;
    SCRATCH['id'] = e.id;
    SCRATCH['other'] = e.other;
    SCRATCH['x'] = e.x;
    SCRATCH['y'] = e.y;
    SCRATCH['z'] = Math.max(0, e.z);
    SCRATCH['amount'] = e.amount;
    out.struct(SCRATCH, EVENT_SCHEMA);
  }
  return n;
}

export function decodeEvents(data: Uint8Array, out: SimEvent[]): number {
  const r = new Reader(data);
  if (r.u8() !== Op.Events) throw new CodecError('not an events message');
  const tick = r.u32();
  const n = r.u8();
  out.length = 0;
  for (let i = 0; i < n; i++) {
    const row = r.struct(APPLY_SCRATCH, EVENT_SCHEMA);
    out.push({
      type: row['type']!,
      id: row['id']!,
      other: row['other']!,
      x: row['x']!,
      y: row['y']!,
      z: row['z']!,
      amount: row['amount']!,
    });
  }
  return tick;
}

// ---------------------------------------------------------------------------
// Reset helpers
// ---------------------------------------------------------------------------

/**
 * Wipe a world back to "nothing here", so a full snapshot lands on a clean slate.
 *
 * Needed because a full snapshot only carries what EXISTS. Applying one onto a
 * world that still holds a previous match's players would leave those players in
 * place, unmentioned and therefore untouched -- ghosts that never move and never
 * go away. Explicitly clearing first is the cheap fix.
 */
export function clearWorldForResync(w: World): void {
  for (const p of w.players) {
    p.active = false;
    p.alive = false;
    p.isDummy = false;
    p.heldBall = -1;
    p.carryingFlag = -1;
    p.team = TEAM_NONE;
    p.action = ActionState.Idle;
    p.actionTicks = 0;
    p.staggerAmount = 0;
  }
  for (const b of w.balls) {
    b.alive = false;
    b.owner = -1;
    b.state = BallState.Grounded;
  }
  for (const f of w.flags) f.active = false;
  for (const z of w.zones) z.active = false;
  w.ring.active = false;
  w.walls.tier.fill(0);
  w.walls.hp.fill(0);
  // Reset the version floor too, or the client's acked-version bookkeeping would
  // still be ahead of a freshly zeroed grid and the new match's walls would never
  // be sent.
  w.walls.tileVersion.fill(0);
  w.walls.version = 0;
  w.events.length = 0;
}
