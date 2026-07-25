/**
 * Skeleton compilation and forward kinematics.
 *
 * A SkinDef is authored as readable nested data; a Skeleton is the flat,
 * topologically sorted, index-addressed form used at runtime. Compile once at
 * load, then never touch a string again.
 *
 * FK runs in the character's own local 3D frame (+x right, +y up, +z forward)
 * and produces one origin and one tip per bone. Turning the character to face a
 * direction is done at projection time, NOT by authoring eight sets of artwork.
 */

import type { BoneDef, ShapeDef, SkinDef, SwingAxis } from './skinTypes.js';

/** Pose channels per bone. */
export const POSE_ANGLE = 0;
export const POSE_SCALE = 1;
export const POSE_OX = 2;
export const POSE_OY = 3;
export const POSE_OZ = 4;
export const POSE_ALPHA = 5;
export const POSE_STRIDE = 6;

export interface Bone {
  id: string;
  parent: number;
  ax: number;
  ay: number;
  az: number;
  /**
   * True when the author omitted `ay`, meaning "attach at the parent's tip".
   * A flag rather than a sentinel, so an explicit `ay: 0` still means "attach at
   * the parent's origin" -- which is exactly what a head or a wing wants.
   */
  attachAtTip: boolean;
  restAngle: number;
  length: number;
  swing: SwingAxis;
  shapes: readonly ShapeDef[];
  zBias: number;
}

export interface Skeleton {
  skin: SkinDef;
  bones: Bone[];
  /** Bone id -> index. Used only at compile time and by the rig lab. */
  index: Map<string, number>;
  /** Resolved role -> bone index, with missing optional roles left out. */
  roles: Map<string, number>;
  /** Draw order, ascending zBias, so ties render deterministically. */
  drawOrder: number[];
}

/** Per-bone FK output, in the character's local frame. */
export interface SolvedBone {
  ox: number;
  oy: number;
  oz: number;
  tx: number;
  ty: number;
  tz: number;
  /** Accumulated rotations, needed to place shapes on the bone. */
  pitch: number;
  roll: number;
  yaw: number;
  scale: number;
  alpha: number;
}

export interface SolvedPose {
  bones: SolvedBone[];
}

export function createPoseBuffer(sk: Skeleton): Float32Array {
  return new Float32Array(sk.bones.length * POSE_STRIDE);
}

export function createSolvedPose(sk: Skeleton): SolvedPose {
  const bones: SolvedBone[] = [];
  for (let i = 0; i < sk.bones.length; i++) {
    bones.push({
      ox: 0,
      oy: 0,
      oz: 0,
      tx: 0,
      ty: 0,
      tz: 0,
      pitch: 0,
      roll: 0,
      yaw: 0,
      scale: 1,
      alpha: 1,
    });
  }
  return { bones };
}

/** Reset a pose buffer to the identity (rest) pose. */
export function resetPose(pose: Float32Array, boneCount: number): void {
  pose.fill(0);
  for (let i = 0; i < boneCount; i++) {
    pose[i * POSE_STRIDE + POSE_SCALE] = 1;
    pose[i * POSE_STRIDE + POSE_ALPHA] = 1;
  }
}

export function compileSkin(skin: SkinDef): Skeleton {
  const index = new Map<string, number>();
  const bones: Bone[] = [];

  for (const def of skin.bones) {
    if (index.has(def.id)) {
      throw new Error(`skin "${skin.id}": duplicate bone id "${def.id}"`);
    }
    let parent = -1;
    if (def.parent !== null && def.parent !== undefined) {
      const pi = index.get(def.parent);
      if (pi === undefined) {
        // Enforced rather than sorted for the author: a bone list you can read
        // top-to-bottom is worth more than tolerating arbitrary order.
        throw new Error(
          `skin "${skin.id}": bone "${def.id}" references parent "${def.parent}" ` +
            `which is not defined before it. Parents must precede children.`,
        );
      }
      parent = pi;
    }
    index.set(def.id, bones.length);
    bones.push(toBone(def, parent));
  }

  const roles = resolveRoles(skin, index);

  const drawOrder = bones.map((_, i) => i);
  drawOrder.sort((a, b) => {
    const d = (bones[a]?.zBias ?? 0) - (bones[b]?.zBias ?? 0);
    return d !== 0 ? d : a - b;
  });

  return { skin, bones, index, roles, drawOrder };
}

function toBone(def: BoneDef, parent: number): Bone {
  const shapes: readonly ShapeDef[] = def.shape
    ? Array.isArray(def.shape)
      ? def.shape
      : [def.shape as ShapeDef]
    : [];
  return {
    id: def.id,
    parent,
    ax: def.ax ?? 0,
    ay: def.ay ?? 0,
    az: def.az ?? 0,
    attachAtTip: def.ay === undefined && parent >= 0,
    restAngle: def.restAngle ?? 0,
    length: def.length,
    swing: def.swing ?? 'sagittal',
    shapes,
    zBias: def.zBias ?? 0,
  };
}

/**
 * Build the role -> bone index table.
 *
 * A missing OPTIONAL role is fine and silently omitted -- that is the graceful
 * degradation that lets one clip set drive a stick figure, a chicken and a cat.
 * A missing REQUIRED role, or a role pointing at a bone that does not exist, is
 * an authoring bug and throws loudly at load.
 */
function resolveRoles(skin: SkinDef, index: Map<string, number>): Map<string, number> {
  const roles = new Map<string, number>();
  const r = skin.roles;

  const put = (name: string, boneId: string | undefined, required: boolean): void => {
    if (boneId === undefined) {
      if (required) throw new Error(`skin "${skin.id}": required role "${name}" is missing`);
      return;
    }
    const i = index.get(boneId);
    if (i === undefined) {
      throw new Error(
        `skin "${skin.id}": role "${name}" points at bone "${boneId}", which does not exist`,
      );
    }
    roles.set(name, i);
  };

  put('root', r.root, true);
  put('body', r.body, true);
  put('head', r.head, false);
  put('throwLimb', r.throwLimb, false);
  put('supportLimb', r.supportLimb, false);
  put('crouchDriver', r.crouchDriver ?? r.root, false);
  put('tail', r.tail, false);

  r.legs.forEach((leg, i) => {
    put(`leg.${i}`, leg.hip, true);
    put(`leg.${i}.hip`, leg.hip, true);
    put(`leg.${i}.knee`, leg.knee, false);
    put(`leg.${i}.foot`, leg.foot, false);
  });

  return roles;
}

/**
 * Resolve a clip track target to a bone index, or -1 if this skin has no such
 * role. Accepts a role name, a leg address, or a raw bone id as an escape hatch.
 */
export function resolveTarget(sk: Skeleton, target: string): number {
  const role = sk.roles.get(target);
  if (role !== undefined) return role;
  const raw = sk.index.get(target);
  return raw !== undefined ? raw : -1;
}

/**
 * Rotate a vector by the accumulated (pitch, roll, yaw) of a bone frame.
 * Order is pitch (about x), then roll (about z), then yaw (about y).
 */
function rotate(
  pitch: number,
  roll: number,
  yaw: number,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
): void {
  // pitch about x: (y, z) plane
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  let y1 = y * cp - z * sp;
  const z1 = y * sp + z * cp;
  let x1 = x;

  // roll about z: (x, y) plane
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const x2 = x1 * cr - y1 * sr;
  const y2 = x1 * sr + y1 * cr;
  x1 = x2;
  y1 = y2;

  // yaw about y: (x, z) plane
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  out.x = x1 * cy + z1 * sy;
  out.y = y1;
  out.z = -x1 * sy + z1 * cy;
}

const rv = { x: 0, y: 0, z: 0 };

/**
 * Solve forward kinematics for the whole skeleton.
 *
 * One forward pass over a flat, topologically sorted array: no recursion, no
 * allocation, no map lookups. Called once per character per rendered frame.
 */
export function solve(sk: Skeleton, pose: Float32Array, out: SolvedPose): SolvedPose {
  const bones = sk.bones;
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i]!;
    const o = out.bones[i]!;
    const base = i * POSE_STRIDE;

    const angle = b.restAngle + pose[base + POSE_ANGLE]!;
    const scaleCh = pose[base + POSE_SCALE]!;
    const ox = pose[base + POSE_OX]!;
    const oy = pose[base + POSE_OY]!;
    const oz = pose[base + POSE_OZ]!;

    const p = bones[b.parent];
    const po = b.parent >= 0 ? out.bones[b.parent]! : null;

    const parentPitch = po ? po.pitch : 0;
    const parentRoll = po ? po.roll : 0;
    const parentYaw = po ? po.yaw : 0;
    const parentScale = po ? po.scale : 1;

    const ay = b.attachAtTip && p ? p.length : b.ay;

    rotate(
      parentPitch,
      parentRoll,
      parentYaw,
      (b.ax + ox) * parentScale,
      (ay + oy) * parentScale,
      (b.az + oz) * parentScale,
      rv,
    );

    o.ox = (po ? po.ox : 0) + rv.x;
    o.oy = (po ? po.oy : 0) + rv.y;
    o.oz = (po ? po.oz : 0) + rv.z;

    o.pitch = parentPitch + (b.swing === 'sagittal' ? angle : 0);
    o.roll = parentRoll + (b.swing === 'frontal' ? angle : 0);
    o.yaw = parentYaw + (b.swing === 'twist' ? angle : 0);
    o.scale = parentScale * scaleCh;
    o.alpha = (po ? po.alpha : 1) * pose[base + POSE_ALPHA]!;

    // Bone direction: local "up" rotated into the bone's frame.
    rotate(o.pitch, o.roll, o.yaw, 0, 1, 0, rv);
    const len = b.length * o.scale;
    o.tx = o.ox + rv.x * len;
    o.ty = o.oy + rv.y * len;
    o.tz = o.oz + rv.z * len;
  }
  return out;
}

/**
 * Project a point from the character's local frame into world offsets, applying
 * the character's facing.
 *
 * This is the "turntable": one rig covers all 360 degrees of facing, because the
 * character's local forward axis is rotated into the world at render time.
 *
 *   forward (local +z) -> world (cos f, sin f)
 *   right   (local +x) -> world (-sin f, cos f)
 *
 * Worth noting why this convention and not another: the local forward axis maps
 * onto a blend of screen-x and (compressed) screen-y, so a stride never
 * projects to zero screen motion at any facing. The naive convention -- where
 * forward maps purely to the compressed axis when facing toward or away from the
 * camera -- makes legs visibly freeze at those angles, and then needs a fudge
 * factor to hide it. Here the worst case is a 0.6x compression, which reads fine.
 */
export function localToWorldOffset(
  lx: number,
  lz: number,
  facing: number,
  out: { x: number; y: number },
): void {
  const cf = Math.cos(facing);
  const sf = Math.sin(facing);
  out.x = -lx * sf + lz * cf;
  out.y = lx * cf + lz * sf;
}
