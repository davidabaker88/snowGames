/**
 * The character skin contract.
 *
 * This file is the whole reason "swap the stick figures for chickens or cats
 * later" is a data change rather than an engine change. Three mechanisms carry
 * that weight:
 *
 *  1. SWING AXES. A bone declares which plane it rotates in. A chicken's throw
 *     reads as a wing flap rather than an arm swing purely because its
 *     `throwLimb` is a `frontal` bone -- the animation keyframes are identical.
 *
 *  2. ROLES, NOT BONE NAMES. Animation clips target roles ('throwLimb', 'head',
 *     'leg.0'), and each skin maps roles onto whatever bones it happens to have.
 *     A clip never knows a bone name.
 *
 *  3. GRACEFUL DEGRADATION. A skin may omit any optional role. Clip tracks
 *     targeting a missing role are dropped when the clip is compiled, so a
 *     chicken with no tail simply does not animate one. This is what lets one
 *     set of clips drive bipeds and quadrupeds. It is load-bearing: if you ever
 *     make a missing role throw, adding a new creature stops being free.
 */

/**
 * Which plane a bone rotates in, expressed in the character's own local frame
 * where +x is the character's right, +y is up, and +z is forward.
 */
export type SwingAxis =
  /** Rotates in the (y, z) plane: legs striding, an arm throwing forward. */
  | 'sagittal'
  /** Rotates in the (x, y) plane: wings beating outward, arms raised sideways. */
  | 'frontal'
  /** Rotates the child frame about +y: a head turn, a torso twist. */
  | 'twist';

/**
 * The five drawing primitives. This list is CLOSED -- a new creature must be
 * expressible with these, because extending it means touching the renderer and
 * breaking the promise above. Between them they cover stick limbs, round heads,
 * egg-shaped bodies, beaks, combs, wings, ears and tails.
 */
export type ShapeDef =
  /** A thick line with rounded ends, optionally tapering toward the tip. */
  | { kind: 'capsule'; w: number; taper?: number; color: string; outline?: string }
  | { kind: 'circle'; r: number; cx?: number; cy?: number; color: string; outline?: string }
  | {
      kind: 'ellipse';
      rx: number;
      ry: number;
      cx?: number;
      cy?: number;
      rot?: number;
      color: string;
      outline?: string;
    }
  /** Points in bone-local space: x across, y along the bone from 0 to length. */
  | { kind: 'poly'; pts: readonly [number, number][]; color: string; outline?: string }
  | { kind: 'line'; w: number; color: string; cap?: 'round' | 'butt' };

export interface BoneDef {
  id: string;
  /** Parent bone id, or null for the root. Parents must appear before children. */
  parent: string | null;
  /** Attach offset in the parent's rotated local frame. */
  ax?: number;
  ay?: number;
  az?: number;
  /** Rest rotation in this bone's swing plane, radians. 0 points straight up. */
  restAngle?: number;
  /** Bone length in skin-local units. Drives shape extent and child attachment. */
  length: number;
  swing?: SwingAxis;
  /** Omit for a pure joint or attachment point that draws nothing. */
  shape?: ShapeDef | readonly ShapeDef[];
  /**
   * Nudges draw order within the character, in depth units. Use small values to
   * keep a limb reliably in front of or behind the torso instead of z-fighting.
   */
  zBias?: number;
}

export interface LegRole {
  hip: string;
  /** Optional second segment. Absent means a single-bone leg that just swings. */
  knee?: string;
  foot?: string;
  /**
   * Offset into the gait cycle, in [0, 1). This one number is how quadrupeds
   * work: a biped is [0, 0.5], a cat trot is [0, 0.5, 0.25, 0.75].
   */
  phase: number;
  /** Lateral sign, used to splay the legs apart so they never exactly overlap. */
  side: -1 | 1;
  /** Per-leg stride scaling: a chicken's or cat's front and back legs differ. */
  strideScale?: number;
}

export interface GaitParams {
  /** World distance covered by one full stride cycle. Prevents foot sliding. */
  cycleLengthWorld: number;
  /** Peak hip swing in radians at full speed. */
  strideAngle: number;
  /** Peak knee bend in radians during the swing phase. */
  liftAngle: number;
  /** Vertical body bob amplitude and its cycles per stride (2 biped, 4 trot). */
  bodyBobAmp: number;
  bodyBobFreq: number;
  /** Forward lean in radians at full speed. */
  leanPerSpeed: number;
  /** Lateral sway amplitude -- a waddle. Chickens want a lot, cats almost none. */
  swayAmp?: number;
}

export interface RoleMap {
  root: string;
  body: string;
  head?: string;
  /** Whatever the creature throws with: an arm, a wing, or a mouth. */
  throwLimb?: string;
  supportLimb?: string;
  /** Bone whose vertical offset produces a crouch -- usually the root or hips. */
  crouchDriver?: string;
  tail?: string;
  legs: readonly LegRole[];
  gait: GaitParams;
}

export interface SkinDef {
  id: string;
  /** Human-readable, for the skin picker and the rig lab. */
  label: string;
  bones: readonly BoneDef[];
  roles: RoleMap;
  /** Overall size multiplier applied at render time. */
  scale: number;
  /** Ground shadow ellipse radii, in skin-local units. */
  shadow: { rx: number; ry: number };
  /** Where a held snowball rides. Bone id plus an offset along/across it. */
  hold: { bone: string; along: number; across?: number };
  /** Named colours, so team tinting can recolour without editing shapes. */
  palette?: Record<string, string>;
}
