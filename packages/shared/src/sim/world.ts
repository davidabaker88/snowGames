/**
 * World state.
 *
 * Deliberately plain structs in fixed-length arrays rather than an ECS. Entity
 * counts here are tiny (at most 16 players and ~160 balls), and the dominant
 * requirement is cheap exact serialization plus replay for prediction -- both of
 * which a generic ECS makes harder, not easier.
 *
 * Two invariants matter for netcode:
 *  - Slots are stable. A player keeps their index; a freed ball slot is reused
 *    from a free list. Indices are the wire identity.
 *  - Iteration order is insertion order over plain arrays. NEVER iterate a Map
 *    or Set for anything that affects the simulation: the host's long-lived map
 *    and a client's snapshot-rebuilt map will have different orders, producing
 *    drift that is essentially untraceable.
 */

import { MAX_BALLS, MAX_HP } from '../constants.js';
import { createRng, type RngState } from '../math/rng.js';
import { createWallGrid, type WallGrid } from './walls.js';
import {
  ActionState,
  BallSize,
  BallState,
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

export interface World {
  tick: number;
  rng: RngState;
  bounds: WorldBounds;
  players: Player[];
  balls: Ball[];
  freeBalls: number[];
  props: Prop[];
  walls: WallGrid;
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

export function createWorld(seed: number, bounds: WorldBounds): World {
  const players: Player[] = [];
  for (let i = 0; i < MAX_PLAYERS; i++) players.push(createPlayer(i));

  const balls: Ball[] = [];
  const freeBalls: number[] = [];
  for (let i = 0; i < MAX_BALLS; i++) balls.push(createBall(i));
  // Push in reverse so the free list pops ascending ids, which keeps snapshots
  // and debug output readable.
  for (let i = MAX_BALLS - 1; i >= 0; i--) freeBalls.push(i);

  return {
    tick: 0,
    rng: createRng(seed),
    bounds,
    players,
    balls,
    freeBalls,
    props: [],
    walls: createWallGrid(bounds),
    events: [],
  };
}

export function spawnPlayer(
  w: World,
  opts: { name?: string; skinId?: string; x: number; y: number; isDummy?: boolean; hp?: number },
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
    return p;
  }
  return null;
}

export function allocBall(w: World): Ball | null {
  const id = w.freeBalls.pop();
  if (id === undefined) return null;
  const b = w.balls[id];
  if (!b) return null;
  b.alive = true;
  b.spin = 0;
  b.stateTick = w.tick;
  return b;
}

export function freeBall(w: World, b: Ball): void {
  if (!b.alive) return;
  b.alive = false;
  b.owner = -1;
  b.state = BallState.Grounded;
  w.freeBalls.push(b.id);
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
