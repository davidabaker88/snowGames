/**
 * The wire schema, as data.
 *
 * Every serialized struct is described ONCE here, as a table of fields with their
 * quantization. Both the binary codec and the JSON codec are driven by these
 * tables, which buys two things that hand-written codecs do not:
 *
 *  1. The two encodings cannot drift. `?netjson=1` gives readable traffic in a
 *     log without being a second implementation to keep in step.
 *  2. Quantization is applied by BOTH paths. This is the subtle one: if the JSON
 *     codec sent raw floats while the binary one rounded to 1/8th of a unit, then
 *     turning on the debug switch would change the game -- and the bug you were
 *     chasing would move. A debug flag that alters behaviour is worse than no
 *     debug flag.
 *
 * Adding a field is one line here and nothing else. Note the ORDER of fields is
 * the wire order, so appending is safe and reordering is not.
 */

// ---------------------------------------------------------------------------
// Field kinds
// ---------------------------------------------------------------------------

/**
 * `q` is fixed-point: the value is multiplied by `scale`, rounded, and stored in
 * `bytes`. Positions use scale 8 (1/8 unit precision, ~2mm at our scale) in 2
 * bytes, which covers +/-4096 units against an arena 1000 wide.
 *
 * `angle` is one byte for 256 directions: 1.4 degrees, well below what a player
 * can perceive on a stick figure, and it makes a facing free.
 */
export type FieldKind =
  | { t: 'u8' }
  | { t: 'i8' }
  | { t: 'u16' }
  | { t: 'i16' }
  | { t: 'u32' }
  | { t: 'i32' }
  | { t: 'f32' }
  | { t: 'q'; bytes: 1 | 2 | 4; scale: number; signed: boolean }
  | { t: 'angle' };

export interface Field {
  key: string;
  kind: FieldKind;
}

export type StructSchema = readonly Field[];

export function fieldBytes(k: FieldKind): number {
  switch (k.t) {
    case 'u8':
    case 'i8':
    case 'angle':
      return 1;
    case 'u16':
    case 'i16':
      return 2;
    case 'u32':
    case 'i32':
    case 'f32':
      return 4;
    case 'q':
      return k.bytes;
  }
}

/** Widest value a quantized field of this width can hold. */
function qLimit(k: { bytes: 1 | 2 | 4; signed: boolean }): number {
  if (k.bytes === 1) return k.signed ? 0x7f : 0xff;
  if (k.bytes === 2) return k.signed ? 0x7fff : 0xffff;
  return k.signed ? 0x7fffffff : 0xffffffff;
}

export function structBytes(s: StructSchema): number {
  let n = 0;
  for (const f of s) n += fieldBytes(f.kind);
  return n;
}

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/**
 * Round a value to exactly what the wire can carry.
 *
 * Both codecs call this, and so does the host when it builds a delta baseline.
 * That last one matters: a delta says "this field is unchanged", and unchanged has
 * to mean "unchanged AFTER quantization", or a player standing still whose x
 * wobbles by 1/100 of a unit is re-sent every single snapshot forever.
 */
export function quantize(v: number, k: FieldKind): number {
  if (!Number.isFinite(v)) v = 0;
  switch (k.t) {
    case 'u8':
      return clampInt(Math.round(v), 0, 0xff);
    case 'i8':
      return clampInt(Math.round(v), -0x80, 0x7f);
    case 'u16':
      return clampInt(Math.round(v), 0, 0xffff);
    case 'i16':
      return clampInt(Math.round(v), -0x8000, 0x7fff);
    case 'u32':
      return clampInt(Math.round(v), 0, 0xffffffff);
    case 'i32':
      return clampInt(Math.round(v), -0x80000000, 0x7fffffff);
    case 'f32':
      // Round-trip through a Float32 so the quantized value is exactly what a
      // DataView would store, rather than the f64 the caller handed us.
      return Math.fround(v);
    case 'q': {
      const raw = Math.round(v * k.scale);
      const lim = qLimit(k);
      const lo = k.signed ? -lim - 1 : 0;
      return clampInt(raw, lo, lim) / k.scale;
    }
    case 'angle': {
      // Normalize into [0, TAU) first, so -pi and +pi land on the same byte.
      let a = v % TAU;
      if (a < 0) a += TAU;
      const step = Math.round((a / TAU) * 256) & 0xff;
      const back = (step / 256) * TAU;
      // Return in (-pi, pi] to match how the simulation stores angles.
      return back > Math.PI ? back - TAU : back;
    }
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Quantize every field of `src` into `dst`, leaving unlisted keys untouched. */
export function quantizeStruct(
  dst: Record<string, number>,
  src: Record<string, number>,
  s: StructSchema,
): void {
  for (const f of s) dst[f.key] = quantize(src[f.key] ?? 0, f.kind);
}

/** True when every field in the schema is bit-identical after quantization. */
export function structEqual(
  a: Record<string, number>,
  b: Record<string, number>,
  s: StructSchema,
): boolean {
  for (const f of s) {
    if (quantize(a[f.key] ?? 0, f.kind) !== quantize(b[f.key] ?? 0, f.kind)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shorthand
// ---------------------------------------------------------------------------

/** Position: 1/8 unit in 2 bytes, so +/-4096 units. The arena is 1000 x 720. */
const POS: FieldKind = { t: 'q', bytes: 2, scale: 8, signed: true };
/** Velocity: 1/4 unit/s in 2 bytes, so +/-8192. Max throw speed is 900. */
const VEL: FieldKind = { t: 'q', bytes: 2, scale: 4, signed: true };
/** Height above ground: unsigned, 1/8 unit. Apex is ~75. */
const HEIGHT: FieldKind = { t: 'q', bytes: 2, scale: 8, signed: false };
/** A 0..1 fraction in one byte. */
const UNIT: FieldKind = { t: 'q', bytes: 2, scale: 1000, signed: false };
const ANGLE: FieldKind = { t: 'angle' };

function f(key: string, kind: FieldKind): Field {
  return { key, kind };
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

/**
 * Player state on the wire.
 *
 * Note what is NOT here: `name`, `skinId`, `isDummy` and `team` are sent once in
 * the roster (they change on join or match start, not per tick), and derived
 * visual state like `staggerAmount` is left for the client to decay locally --
 * re-sending a number that only ever decays is pure waste.
 *
 * `flags` packs the booleans. One byte for three bits is not tight, but it leaves
 * room for the next five without a format change.
 */
export const PLAYER_FLAG_ACTIVE = 1 << 0;
export const PLAYER_FLAG_ALIVE = 1 << 1;
export const PLAYER_FLAG_DUMMY = 1 << 2;
/** Set on a body left behind by a disconnect. Cannot act, cannot score. */
export const PLAYER_FLAG_SNOWMAN = 1 << 3;

export const PLAYER_SCHEMA: StructSchema = [
  f('flags', { t: 'u8' }),
  f('x', POS),
  f('y', POS),
  f('vx', VEL),
  f('vy', VEL),
  f('facing', ANGLE),
  f('aim', ANGLE),
  f('action', { t: 'u8' }),
  f('actionTicks', { t: 'u8' }),
  f('hp', { t: 'i16' }),
  f('respawnTicks', { t: 'u16' }),
  f('packProgress', UNIT),
  f('heldBall', { t: 'i16' }),
  f('score', { t: 'i16' }),
  f('buildsRemaining', { t: 'i16' }),
  f('carryingFlag', { t: 'i8' }),
  f('team', { t: 'i8' }),
];

export const BALL_FLAG_ALIVE = 1 << 0;

export const BALL_SCHEMA: StructSchema = [
  f('flags', { t: 'u8' }),
  f('state', { t: 'u8' }),
  f('size', { t: 'u8' }),
  f('owner', { t: 'i8' }),
  f('team', { t: 'i8' }),
  f('x', POS),
  f('y', POS),
  f('z', HEIGHT),
  f('vx', VEL),
  f('vy', VEL),
  f('vz', VEL),
  f('spin', ANGLE),
];

export const MATCH_SCHEMA: StructSchema = [
  f('phase', { t: 'u8' }),
  f('phaseTicks', { t: 'u16' }),
  f('timeRemainingTicks', { t: 'u16' }),
  f('score0', { t: 'i16' }),
  f('score1', { t: 'i16' }),
  f('score2', { t: 'i16' }),
  f('score3', { t: 'i16' }),
  f('winnerTeam', { t: 'i8' }),
  f('winnerPlayer', { t: 'i8' }),
];

export const FLAG_SCHEMA: StructSchema = [
  f('flags', { t: 'u8' }),
  f('team', { t: 'i8' }),
  f('state', { t: 'u8' }),
  f('x', POS),
  f('y', POS),
  f('carrier', { t: 'i8' }),
  f('returnTicks', { t: 'u16' }),
];

export const ZONE_SCHEMA: StructSchema = [
  f('flags', { t: 'u8' }),
  f('x', POS),
  f('y', POS),
  f('radius', POS),
  f('owner', { t: 'i8' }),
  f('contender', { t: 'i8' }),
  f('progress', UNIT),
];

export const RING_SCHEMA: StructSchema = [
  f('flags', { t: 'u8' }),
  f('x', POS),
  f('y', POS),
  f('radius', POS),
  f('targetRadius', POS),
  f('delayTicks', { t: 'u16' }),
];

/** One changed wall tile. */
export const TILE_SCHEMA: StructSchema = [
  f('index', { t: 'u16' }),
  f('tier', { t: 'u8' }),
  f('hp', { t: 'u16' }),
];

/**
 * One input frame: 8 bytes.
 *
 * This is the most frequently sent message in the protocol -- 30 a second, and each
 * message carries three of them for redundancy -- so every byte here costs 90 B/s
 * upstream per player. At 2 bytes per axis the input stream alone came to 1260 B/s
 * and broke the 1.2 KB/s upstream budget on its own.
 *
 * So the axes are ONE byte each. A joystick quantized to 1/127 is far finer than a
 * thumb can hold, and the movement vector is renormalized by `validateInput`
 * anyway. Same reasoning for throw power and pack delta: both feed continuous
 * mechanics where 1/255 of the range is imperceptible.
 *
 * `seq` stays 2 bytes and wraps every ~36 minutes at 30Hz. The comparison helpers
 * treat sequence space as circular, so a wrap is a non-event; spending 2 more bytes
 * to dodge arithmetic we need regardless would be the wrong trade.
 */
export const INPUT_SCHEMA: StructSchema = [
  f('seq', { t: 'u16' }),
  f('moveX', { t: 'q', bytes: 1, scale: 127, signed: true }),
  f('moveY', { t: 'q', bytes: 1, scale: 127, signed: true }),
  f('aim', ANGLE),
  f('buttons', { t: 'u8' }),
  f('throwPower', { t: 'q', bytes: 1, scale: 200, signed: false }),
  // Capped by MAX_PACK_ROTATIONS_PER_SEC * TICK_DT, about 0.133 rotations a tick,
  // so this scale covers the legal range with room to spare above it.
  f('packDelta', { t: 'q', bytes: 1, scale: 1200, signed: false }),
];

/** One simulation event. */
export const EVENT_SCHEMA: StructSchema = [
  f('type', { t: 'u8' }),
  f('id', { t: 'i16' }),
  f('other', { t: 'i16' }),
  f('x', POS),
  f('y', POS),
  f('z', HEIGHT),
  f('amount', { t: 'q', bytes: 2, scale: 8, signed: true }),
];
