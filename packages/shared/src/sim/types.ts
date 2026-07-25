export type PlayerId = number;
export type EntityId = number;
export type TeamId = number;

export const TEAM_NONE = -1;

/**
 * The character action state machine.
 *
 * The animator reads `(action, actionTicks)` and NOTHING else. That is the
 * firewall between simulation and presentation: the authoritative host runs this
 * machine with no canvas and no animation clips in memory.
 */
export const enum ActionState {
  Idle = 0,
  Walking = 1,
  Packing = 2,
  WindUp = 3,
  Throwing = 4,
  Placing = 5,
  PickingUp = 6,
  Building = 7,
  Stagger = 8,
  Eliminated = 9,
}

export const ACTION_NAMES: Record<ActionState, string> = {
  [ActionState.Idle]: 'idle',
  [ActionState.Walking]: 'walk',
  [ActionState.Packing]: 'pack',
  [ActionState.WindUp]: 'windup',
  [ActionState.Throwing]: 'throw',
  [ActionState.Placing]: 'place',
  [ActionState.PickingUp]: 'pickup',
  [ActionState.Building]: 'build',
  [ActionState.Stagger]: 'stagger',
  [ActionState.Eliminated]: 'eliminated',
};

export const enum BallState {
  Held = 0,
  Flight = 1,
  Grounded = 2,
}

export const enum BallSize {
  Small = 0,
  Normal = 1,
  Big = 2,
}

export const enum SimEventType {
  Packed = 0,
  Thrown = 1,
  Hit = 2,
  WallHit = 3,
  Placed = 4,
  PickedUp = 5,
  Eliminated = 6,
  Melted = 7,
  Bounced = 8,
  WallBuilt = 9,
  WallDestroyed = 10,
  Scored = 11,
  Respawned = 12,
  RoundStart = 13,
  RoundEnd = 14,
  FlagTaken = 15,
  FlagDropped = 16,
  FlagReturned = 17,
  FlagCaptured = 18,
  ZoneCaptured = 19,
  RingDamage = 20,
}

/** Where a capture-the-flag flag currently is. */
export const enum FlagState {
  AtBase = 0,
  Carried = 1,
  Dropped = 2,
}

export const enum MatchPhase {
  /** Pre-match: no damage, used by Fort Defense for its build window. */
  Warmup = 0,
  Playing = 1,
  Ended = 2,
}

/**
 * Simulation events are the sim's only outward channel. The renderer, audio and
 * HUD consume them; nothing in the sim reads them back. Cleared every tick.
 */
export interface SimEvent {
  type: SimEventType;
  /** Player or ball id, depending on event type. */
  id: EntityId;
  /** Secondary id -- e.g. the attacker on a Hit. */
  other: EntityId;
  x: number;
  y: number;
  z: number;
  /** Magnitude: damage for Hit, impact speed for WallHit, power for Thrown. */
  amount: number;
}
