/**
 * Maps simulation state onto a pose.
 *
 * The contract with the simulation is deliberately narrow: the animator reads
 * `(action, actionTicks, speed, gaitDistance, aim, facing, staggerAmount)` and
 * NOTHING else. It never writes to world state, and the sim never reads from
 * here -- so the authoritative host runs the whole game without this file
 * existing in memory.
 *
 * Action clip time is `actionTicks / actionDurationTicks`, so animation and
 * simulation are locked together by construction rather than by two sets of
 * hand-matched durations that drift apart.
 */

import {
  BUILD_TICKS,
  PICKUP_TICKS,
  PLACE_TICKS,
  STAGGER_TICKS,
  THROW_TICKS,
  TICK_DT,
  WALK_SPEED,
  WINDUP_TICKS,
} from '../constants.js';
import { clamp01, wrapPi } from '../math/angle.js';
import { ActionState } from '../sim/types.js';
import type { Player } from '../sim/world.js';
import {
  ALL_CLIPS,
  CLIP_BUILD,
  CLIP_ELIMINATED,
  CLIP_IDLE,
  CLIP_PACK,
  CLIP_PICKUP,
  CLIP_PLACE,
  CLIP_STAGGER,
  CLIP_THROW,
  CLIP_WALK,
  CLIP_WINDUP,
} from './clips/common.js';
import { applyClip, compileClip, type CompiledClip } from './pose.js';
import { applyGait } from './gait.js';
import {
  POSE_ANGLE,
  POSE_STRIDE,
  createPoseBuffer,
  resetPose,
  type Skeleton,
} from './skeleton.js';

/** Clips compiled against one specific skeleton. */
export interface AnimSet {
  skeleton: Skeleton;
  byName: Map<string, CompiledClip>;
  /** Reusable pose buffer, one per animator instance. */
  pose: Float32Array;
}

export function createAnimSet(sk: Skeleton): AnimSet {
  const byName = new Map<string, CompiledClip>();
  for (const clip of ALL_CLIPS) {
    byName.set(clip.name, compileClip(sk, clip));
  }
  return { skeleton: sk, byName, pose: createPoseBuffer(sk) };
}

function actionClipAndDuration(
  a: ActionState,
): { name: string; ticks: number; loop: boolean } | null {
  switch (a) {
    case ActionState.Packing:
      return { name: CLIP_PACK.name, ticks: 0, loop: true };
    case ActionState.WindUp:
      return { name: CLIP_WINDUP.name, ticks: WINDUP_TICKS, loop: false };
    case ActionState.Throwing:
      return { name: CLIP_THROW.name, ticks: THROW_TICKS, loop: false };
    case ActionState.Placing:
      return { name: CLIP_PLACE.name, ticks: PLACE_TICKS, loop: false };
    case ActionState.PickingUp:
      return { name: CLIP_PICKUP.name, ticks: PICKUP_TICKS, loop: false };
    case ActionState.Building:
      return { name: CLIP_BUILD.name, ticks: 0, loop: true };
    case ActionState.Eliminated:
      return { name: CLIP_ELIMINATED.name, ticks: 27, loop: false };
    default:
      return null;
  }
}

export interface AnimateOpts {
  /** Seconds since start, for looping clips and idle breathing. */
  time: number;
  /** Interpolation alpha within the current tick, in [0, 1]. */
  alpha: number;
}

/**
 * Build the pose for one player. Returns the animator's internal buffer -- valid
 * until the next call for the same AnimSet, which is fine because the caller
 * solves and draws immediately.
 *
 * Layer order matters and is fixed:
 *   1. rest (implicit: the skeleton adds each bone's restAngle)
 *   2. procedural locomotion
 *   3. the action clip
 *   4. additive aim override on the throwing limb
 *   5. additive stagger
 */
export function animatePlayer(set: AnimSet, p: Player, opts: AnimateOpts): Float32Array {
  const sk = set.skeleton;
  const pose = set.pose;
  resetPose(pose, sk.bones.length);

  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  const isDown = p.action === ActionState.Eliminated;

  // ---- 2. locomotion ---------------------------------------------------------
  if (!isDown) {
    applyGait(sk, sk.skin.roles, pose, {
      distance: p.gaitDistance,
      speed,
      fullSpeed: WALK_SPEED,
      time: opts.time,
    });
  }

  // ---- 3. action clip --------------------------------------------------------
  const walkWeight = clamp01(speed / WALK_SPEED);
  const spec = actionClipAndDuration(p.action);

  if (spec) {
    const clip = set.byName.get(spec.name);
    if (clip) {
      // Looping clips run on wall time; timed actions run on sim ticks so the
      // animation can never disagree with the simulation about duration.
      const t =
        spec.ticks > 0
          ? clamp01((p.actionTicks - 1 + opts.alpha) / spec.ticks)
          : (opts.time / Math.max(0.01, clip.duration)) % 1;
      applyClip(clip, pose, t, 1);
    }
  } else {
    // Idle/walk arm swing, cross-faded by speed over the procedural leg gait.
    const idle = set.byName.get(CLIP_IDLE.name);
    const walk = set.byName.get(CLIP_WALK.name);
    if (idle && walkWeight < 1) {
      applyClip(idle, pose, (opts.time / idle.duration) % 1, 1 - walkWeight);
    }
    if (walk && walkWeight > 0) {
      // Phase the arm swing off distance too, so arms and legs stay in step.
      const cyc = p.gaitDistance / Math.max(1, sk.skin.roles.gait.cycleLengthWorld);
      applyClip(walk, pose, cyc % 1, walkWeight);
    }
  }

  // ---- 4. aim override -------------------------------------------------------
  // While winding up, bias the throwing limb by how far the aim differs from the
  // body's facing, so aiming behind you reads as a reach rather than a snap.
  if (p.action === ActionState.WindUp || p.action === ActionState.Throwing) {
    const limb = sk.roles.get('throwLimb');
    if (limb !== undefined) {
      const off = wrapPi(p.aim - p.facing);
      pose[limb * POSE_STRIDE + POSE_ANGLE]! += off * 0.35;
    }
  }

  // ---- 5. stagger ------------------------------------------------------------
  if (p.staggerAmount > 0.001 && !isDown) {
    const clip = set.byName.get(CLIP_STAGGER.name);
    if (clip) {
      // Play the clip's recovery curve positioned by how much stagger is left,
      // which makes repeated hits stack instead of restarting.
      const t = clamp01(1 - p.staggerAmount);
      applyClip(clip, pose, t, Math.min(1, p.staggerAmount));
    }
  }
  void STAGGER_TICKS;
  void BUILD_TICKS;
  void TICK_DT;

  return pose;
}
