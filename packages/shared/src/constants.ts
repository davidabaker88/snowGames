/**
 * Every gameplay tunable lives here.
 *
 * Two rules:
 *  1. The simulation reads durations from this file, NEVER from animation clips.
 *     The authoritative server has no canvas and no clips; clips are stretched
 *     to fit these numbers, not the other way around.
 *  2. If you are tempted to hardcode a number in a system, put it here instead.
 *     Tuning game feel means editing one file.
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * 30Hz, not 60. Snowballs are slow lobbed projectiles, not bullets, so 30Hz is
 * visually indistinguishable while halving CPU and battery on phones. Rendering
 * still runs at display rate and interpolates between ticks.
 */
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;
export const TICK_MS = 1000 / TICK_HZ;

/** Cap on ticks simulated in one frame, so a backgrounded tab does not
 *  fast-forward violently on resume. */
export const MAX_CATCHUP_TICKS = 5;

export function secondsToTicks(s: number): number {
  return Math.max(1, Math.round(s * TICK_HZ));
}

// ---------------------------------------------------------------------------
// World / units
// ---------------------------------------------------------------------------

/** World units are roughly centimetres-ish; a player is ~34 units wide. */
export const PLAYER_RADIUS = 17;
export const PLAYER_HEIGHT = 58;

export const WALK_SPEED = 168;
export const CARRY_SPEED_MUL = 0.85;
export const PACKING_SPEED_MUL = 0.45;
export const BUILD_SPEED_MUL = 0;
export const ACCEL = 1400;
export const FRICTION = 1900;

/** Radians per second the character body can pivot. */
export const TURN_RATE = 12;

// ---------------------------------------------------------------------------
// Projection (3/4 top-down)
// ---------------------------------------------------------------------------

/**
 * How much the world's Y axis is compressed on screen. 1.0 would be a pure
 * top-down view; 0.0 would be a side view. 0.60 reads as "looking down at
 * maybe 55 degrees".
 */
export const Y_SQUASH = 0.6;

/** Screen pixels per world unit of height. */
export const Z_SCALE = 1;

/**
 * Because Y is compressed, pushing "up" on the joystick covers less screen
 * distance per world unit and feels sluggish. Partially compensate. Full
 * compensation (1/Y_SQUASH) overshoots and feels wrong in world terms.
 */
export const MOVE_Y_BIAS = 1 + (1 / Y_SQUASH - 1) * 0.75;

// ---------------------------------------------------------------------------
// Snowballs
// ---------------------------------------------------------------------------

export const GRAVITY = 900;
export const AIR_DRAG = 0.06;

/**
 * These four constants define the entire combat feel and must be tuned together.
 * Vertical launch speed is LOB_RATIO * horizontal speed, so a harder throw is
 * both faster AND higher -- which is what makes the arc predictable by eye.
 *
 * The resulting geometry, against a body height of 58 and wall heights of 20/48:
 *
 *   power  speed  apex  range   flies over a standing player
 *   0.00    380    46    167u   never
 *   0.35    562    54    293u   never
 *   0.70    744    64    453u   never
 *   1.00    900    75    620u   from 116u to 388u
 *
 * So power is mostly about RANGE, and only a near-max flick lobs over someone at
 * mid distance. That ordering matters: an earlier value of 0.35 here made even a
 * 70% throw sail harmlessly over anyone between 90 and 340 units, which is most
 * of useful combat range -- it felt broken rather than tactical.
 *
 * Wall interaction falls out of the same numbers: a soft throw (apex 46) is
 * stopped by a full 48-high wall, a medium one just clears it, and a battered
 * wall shrinks until anything clears it.
 */
export const THROW_MIN_SPEED = 380;
export const THROW_MAX_SPEED = 900;
export const LOB_RATIO = 0.28;
export const THROW_RELEASE_HEIGHT = 40;

export const BALL_RADIUS_SMALL = 5;
export const BALL_RADIUS_NORMAL = 7;
export const BALL_RADIUS_BIG = 10;

export const BALL_DAMAGE_SMALL = 6;
export const BALL_DAMAGE_NORMAL = 10;
export const BALL_DAMAGE_BIG = 16;

/** Damage scales with impact speed between these bounds. */
export const IMPACT_SPEED_MIN = 260;
export const IMPACT_SPEED_MAX = 900;

/** Ticks after release during which a ball cannot hit its own thrower. */
export const OWNER_IMMUNE_TICKS = 6;

/** Grounded snowballs melt away after this long, so arenas do not silt up. */
export const GROUND_LIFETIME_TICKS = secondsToTicks(45);

export const BALL_BOUNCE_DAMPING = 0.32;
export const BALL_GROUND_FRICTION = 6;
export const BALL_REST_SPEED = 18;

export const MAX_BALLS = 160;

// ---------------------------------------------------------------------------
// Packing / carrying
// ---------------------------------------------------------------------------

/** Full circles of the right thumb needed to finish one snowball. */
export const PACK_ROTATIONS_REQUIRED = 2.5;

/**
 * Hard server-side ceiling on how fast packing can progress, regardless of what
 * the client claims. Without this clamp a modified client packs instantly --
 * `packDelta` is the one field where raw gesture data crosses into the sim.
 */
export const MAX_PACK_ROTATIONS_PER_SEC = 4;

/** Rate used by the desktop "hold J" fallback. Fixed, so tests are deterministic. */
export const DEBUG_PACK_ROTATIONS_PER_SEC = 1.6;

/** Idle time before packing progress starts draining, and the drain rate. */
export const PACK_DECAY_DELAY_TICKS = secondsToTicks(0.4);
export const PACK_DECAY_PER_SEC = 0.6;

export const PICKUP_RADIUS = 34;

// ---------------------------------------------------------------------------
// Walls (grid is built in phase 4; heights are referenced by the arc maths now)
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const WALL_HEIGHT_LOW = 20;
export const WALL_HEIGHT_FULL = 48;
export const WALL_HEIGHT_REINFORCED = 56;

// ---------------------------------------------------------------------------
// Action durations (ticks). The animator stretches clips to match these.
// ---------------------------------------------------------------------------

export const WINDUP_TICKS = secondsToTicks(0.22);
export const THROW_TICKS = secondsToTicks(0.3);
/** Point within THROW_TICKS at which the ball actually leaves the hand. */
export const THROW_RELEASE_TICK = 3;
export const PLACE_TICKS = secondsToTicks(0.36);
export const PICKUP_TICKS = secondsToTicks(0.3);
/** Tick within PICKUP/PLACE at which the ball changes hands. */
export const PICKUP_TRANSFER_TICK = 4;
export const PLACE_TRANSFER_TICK = 5;
export const BUILD_TICKS = secondsToTicks(0.8);
export const STAGGER_TICKS = secondsToTicks(0.4);
export const THROW_COOLDOWN_TICKS = secondsToTicks(0.18);

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const MAX_HP = 100;
export const DUMMY_HP = 60;
export const DUMMY_RESET_TICKS = secondsToTicks(3);

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/**
 * Target world width visible on screen, before clamping. Keeps a phone and a
 * desktop seeing a comparable slice of the arena.
 *
 * Tuned against a 390px-wide phone: at 620 a character was only ~36px tall,
 * which is too small to read a wind-up or a stagger -- and the animation is the
 * point. 470 puts it near 50px while still showing a useful amount of ground.
 */
export const TARGET_WORLD_WIDTH = 470;
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2;
export const CAMERA_DEADZONE_X = 40;
export const CAMERA_DEADZONE_Y = 28;
export const CAMERA_HALF_LIFE = 0.12;
