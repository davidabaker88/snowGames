/**
 * World state.
 *
 * Deliberately plain structs in fixed-length arrays rather than an ECS. Entity
 * counts here are tiny (at most 16 players and ~160 balls), and the dominant
 * requirement is cheap exact serialization plus replay for prediction -- both of
 * which a generic ECS makes harder, not easier.
 *
 * Three invariants matter for netcode:
 *  - Slots are stable. A player keeps their index and a ball keeps its slot for
 *    its whole life. Indices are the wire identity.
 *  - Iteration order is insertion order over plain arrays. NEVER iterate a Map
 *    or Set for anything that affects the simulation: the host's long-lived map
 *    and a client's snapshot-rebuilt map will have different orders, producing
 *    drift that is essentially untraceable.
 *  - EVERY FIELD THE SIMULATION READS IS RECONSTRUCTIBLE FROM A SNAPSHOT. There
 *    is no hidden bookkeeping. This is why ball allocation scans for the lowest
 *    free slot instead of popping a LIFO free list: a free list's order depends
 *    on the entire history of allocations, so a client that rebuilt its world
 *    from a snapshot would allocate different ids from the host on the very next
 *    throw, and every predicted snowball would be a mispredicted one.
 */

import { MAX_BALLS, MAX_HP } from '../constants.js';
import { createRng, type RngState } from '../math/rng.js';
import { createWallGrid, type WallGrid } from './walls.js';
import { SANDBOX } from '../modes/sandbox.js';
import type { GameMode } from '../modes/types.js';
import {
  ActionState,
  BallSize,
  BallState,
  FlagState,
  MatchPhase,
  TEAM_NONE,
  type EntityId,
  type PlayerId,
  type SimEvent,
  type TeamId,
} from './types.js';

export const MAX_PLAYERS = 16;

export interface Player {
  id: PlayerId;
  active: boolean;
  /** A training dummy is a Player that ignores input. Reused for bots later. */
  isDummy: boolean;
  name: string;
  skinId: string;
  team: TeamId;

  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  /** Where the character is aiming, which can differ from body facing. */
  aim: number;

  action: ActionState;
  actionTicks: number;
  /** Distance travelled, used to advance the gait so feet never slide. */
  gaitDistance: number;

  hp: number;
  alive: boolean;
  respawnTicks: number;

  /** Packing progress in rotations, and ticks since progress last increased. */
  packProgress: number;
  packIdleTicks: number;

  /** Ball currently in hand, or -1. */
  heldBall: EntityId;
  throwCooldown: number;
  /** Ball this player has committed to throwing when the release tick arrives. */
  pendingThrowPower: number;

  /** Visual-only stagger accumulator, driven by hits. Decays. */
  staggerAmount: number;

  /** Per-player score, for free-for-all modes and the scoreboard. */
  score: number;
  /** Walls this player may still build; -1 means unlimited. */
  buildsRemaining: number;
  /** Flag being carried, or -1. */
  carryingFlag: EntityId;
}

export interface Ball {
  id: EntityId;
  alive: boolean;
  state: BallState;
  size: BallSize;
  owner: PlayerId;
  team: TeamId;

  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;

  spin: number;
  /** Tick the ball entered its current state; drives melt and owner immunity. */
  stateTick: number;
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Prop {
  x: number;
  y: number;
  /** Collision radius; 0 means decorative only. */
  radius: number;
  height: number;
  kind: 'tree' | 'rock' | 'lamp' | 'crate';
}

/**
 * Objective entities.
 *
 * These live on the World rather than inside a mode, so the renderer can draw them
 * generically and modes just activate and drive the ones they need. A mode keeping
 * its own private entities would mean new drawing code for every new mode, which is
 * exactly what the mode framework exists to avoid.
 */
export interface Flag {
  id: number;
  active: boolean;
  /** The team this flag belongs to (and that must bring it home to score). */
  team: TeamId;
  state: FlagState;
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  carrier: PlayerId;
  /** Ticks until a dropped flag returns itself to base. */
  returnTicks: number;
}

export interface Zone {
  id: number;
  active: boolean;
  x: number;
  y: number;
  radius: number;
  label: string;
  /** Team currently holding it, or TEAM_NONE. */
  owner: TeamId;
  /** Capture progress toward `contender`, 0..1. */
  progress: number;
  contender: TeamId;
}

/** The closing blizzard in Last One Standing. */
export interface Ring {
  active: boolean;
  x: number;
  y: number;
  radius: number;
  targetRadius: number;
  shrinkPerTick: number;
  /** Ticks before the ring starts closing. */
  delayTicks: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** Ticks spent in the current phase. */
  phaseTicks: number;
  /** Counts down while playing; 0 means no limit. */
  timeRemainingTicks: number;
  teamScores: number[];
  winnerTeam: TeamId;
  winnerPlayer: PlayerId;
  winReason: string;
}

export interface World {
  tick: number;
  rng: RngState;
  bounds: WorldBounds;
  players: Player[];
  balls: Ball[];
  props: Prop[];
  walls: WallGrid;
  flags: Flag[];
  zones: Zone[];
  ring: Ring;
  match: MatchState;
  /**
   * The active rules.
   *
   * A strategy object, not state: every mode is stateless and keeps all of its
   * mutable data in the World above, so holding a reference here does not break
   * replay or make the World impure. It lives on the World rather than being
   * threaded through every call because deep code -- projectile impacts, for
   * instance -- has to ask the mode whether a hit is even allowed.
   */
  mode: GameMode;
  /** Cleared at the start of every tick. Never read back by the simulation. */
  events: SimEvent[];
}

function createPlayer(id: PlayerId): Player {
  return {
    id,
    active: false,
    isDummy: false,
    name: '',
    skinId: 'stick',
    team: TEAM_NONE,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: 0,
    aim: 0,
    action: ActionState.Idle,
    actionTicks: 0,
    gaitDistance: 0,
    hp: MAX_HP,
    alive: true,
    respawnTicks: 0,
    packProgress: 0,
    packIdleTicks: 0,
    heldBall: -1,
    throwCooldown: 0,
    pendingThrowPower: 0,
    staggerAmount: 0,
    score: 0,
    buildsRemaining: -1,
    carryingFlag: -1,
  };
}

function createFlag(id: EntityId): Flag {
  return {
    id,
    active: false,
    team: TEAM_NONE,
    state: FlagState.AtBase,
    x: 0,
    y: 0,
    baseX: 0,
    baseY: 0,
    carrier: -1,
    returnTicks: 0,
  };
}

function createZone(id: number): Zone {
  return {
    id,
    active: false,
    x: 0,
    y: 0,
    radius: 0,
    label: '',
    owner: TEAM_NONE,
    progress: 0,
    contender: TEAM_NONE,
  };
}

function createBall(id: EntityId): Ball {
  return {
    id,
    alive: false,
    state: BallState.Grounded,
    size: BallSize.Normal,
    owner: -1,
    team: TEAM_NONE,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    spin: 0,
    stateTick: 0,
  };
}

export const MAX_FLAGS = 4;
export const MAX_ZONES = 4;

export function createWorld(seed: number, bounds: WorldBounds, mode: GameMode = SANDBOX): World {
  const players: Player[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) players.push(createPlayer(i));

  const balls: Ball[] = [];
  for (let i = 0; i < MAX_BALLS; i++) balls.push(createBall(i));

  const flags: Flag[] = [];
  for (let i = 0; i < MAX_FLAGS; i++) flags.push(createFlag(i));
  const zones: Zone[] = [];
  for (let i = 0; i < MAX_ZONES; i++) zones.push(createZone(i));

  return {
    tick: 0,
    rng: createRng(seed),
    bounds,
    players,
    balls,
    props: [],
    walls: createWallGrid(bounds),
    flags,
    zones,
    ring: {
      active: false,
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      radius: 0,
      targetRadius: 0,
      shrinkPerTick: 0,
      delayTicks: 0,
    },
    match: {
      phase: MatchPhase.Warmup,
      phaseTicks: 0,
      timeRemainingTicks: 0,
      teamScores: [0, 0, 0, 0],
      winnerTeam: TEAM_NONE,
      winnerPlayer: -1,
      winReason: '',
    },
    mode,
    events: [],
  };
}

export function spawnPlayer(
  w: World,
  opts: {
    name?: string;
    skinId?: string;
    x: number;
    y: number;
    isDummy?: boolean;
    hp?: number;
    team?: TeamId;
  },
): Player | null {
  for (const p of w.players) {
    if (p.active) continue;
    p.active = true;
    p.isDummy = opts.isDummy ?? false;
    p.name = opts.name ?? (p.isDummy ? 'Dummy' : `Player ${p.id + 1}`);
    p.skinId = opts.skinId ?? 'stick';
    p.x = opts.x;
    p.y = opts.y;
    p.vx = 0;
    p.vy = 0;
    p.facing = 0;
    p.aim = 0;
    p.action = ActionState.Idle;
    p.actionTicks = 0;
    p.gaitDistance = 0;
    p.hp = opts.hp ?? MAX_HP;
    p.alive = true;
    p.respawnTicks = 0;
    p.packProgress = 0;
    p.packIdleTicks = 0;
    p.heldBall = -1;
    p.throwCooldown = 0;
    p.pendingThrowPower = 0;
    p.staggerAmount = 0;
    p.score = 0;
    p.buildsRemaining = -1;
    p.carryingFlag = -1;
    p.team = opts.team ?? TEAM_NONE;
    return p;
  }
  return null;
}

/**
 * Take the LOWEST free ball slot.
 *
 * A linear scan over 160 slots, a handful of times a second, in exchange for the
 * allocation order being a pure function of which slots are currently alive. That
 * trade is what lets a client rebuild its world from a snapshot and still agree
 * with the host about which slot the next snowball lands in. A LIFO free list is
 * O(1) but its order encodes the whole allocation history, which a snapshot does
 * not carry and could not carry cheaply.
 */
export function allocBall(w: World): Ball | null {
  for (const b of w.balls) {
    if (b.alive) continue;
    b.alive = true;
    b.spin = 0;
    b.stateTick = w.tick;
    return b;
  }
  return null;
}

export function freeBall(w: World, b: Ball): void {
  if (!b.alive) return;
  b.alive = false;
  b.owner = -1;
  b.state = BallState.Grounded;
}

export function pushEvent(
  w: World,
  type: SimEvent['type'],
  id: EntityId,
  x: number,
  y: number,
  z = 0,
  amount = 0,
  other: EntityId = -1,
): void {
  w.events.push({ type, id, other, x, y, z, amount });
}

/** Deterministic hash of the gameplay-relevant world state, for desync tests. */
export function hashWorld(w: World): number {
  // FNV-1a over quantized state. Quantizing before hashing means the hash is
  // stable against the last bits of float noise, which is exactly the tolerance
  // the netcode itself has.
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(w.tick);
  for (const p of w.players) {
    if (!p.active) continue;
    mix(p.id);
    mix(Math.round(p.x * 64));
    mix(Math.round(p.y * 64));
    mix(Math.round(p.facing * 512));
    mix(p.action);
    mix(p.actionTicks);
    mix(Math.round(p.hp));
    mix(p.heldBall);
    mix(Math.round(p.packProgress * 256));
  }
  for (const b of w.balls) {
    if (!b.alive) continue;
    mix(b.id);
    mix(b.state);
    mix(Math.round(b.x * 64));
    mix(Math.round(b.y * 64));
    mix(Math.round(b.z * 64));
  }
  // Walls are part of gameplay state, so a desync in the grid has to show up in
  // the hash. Only non-empty tiles, so the cost tracks what is actually built.
  const wg = w.walls;
  for (let i = 0; i < wg.tier.length; i++) {
    const t = wg.tier[i]!;
    if (t === 0) continue;
    mix(i);
    mix(t);
    mix(wg.hp[i]!);
  }
  return h >>> 0;
}
