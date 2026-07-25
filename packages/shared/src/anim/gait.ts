/**
 * Procedural locomotion.
 *
 * Two decisions worth stating:
 *
 *  1. The gait phase advances by DISTANCE TRAVELLED, not by elapsed time. That is
 *     what stops feet sliding when a character accelerates, gets knocked back, or
 *     walks slowly while carrying a snowball -- the stride always matches the
 *     ground speed because it is derived from it.
 *
 *  2. It is procedural rather than keyframed, so a quadruped needs no new
 *     artwork: four legs at phases [0, 0.5, 0.25, 0.75] with bodyBobFreq 4
 *     produces a trot from the same code that produces a biped walk.
 */

import { TAU } from '../math/angle.js';
import type { RoleMap } from './skinTypes.js';
import { POSE_ANGLE, POSE_OX, POSE_OY, POSE_STRIDE, type Skeleton } from './skeleton.js';

export interface GaitInput {
  /** Cumulative distance walked, in world units. */
  distance: number;
  /** Current ground speed, world units per second. */
  speed: number;
  /** Reference speed treated as "full stride", normally WALK_SPEED. */
  fullSpeed: number;
  /** Monotonic seconds, used only for the idle breathing cycle. */
  time: number;
}

/**
 * Write locomotion into a pose buffer.
 *
 * Assumes the buffer has already been reset. Blends between an idle breathing
 * pose and a full-speed stride according to speed, so slowing to a stop eases
 * out of the walk rather than snapping.
 */
export function applyGait(sk: Skeleton, roles: RoleMap, pose: Float32Array, gi: GaitInput): void {
  const g = roles.gait;
  const walkWeight = Math.min(1, gi.speed / Math.max(1, gi.fullSpeed));
  const cycle = gi.distance / Math.max(1, g.cycleLengthWorld);

  // ---- legs ------------------------------------------------------------------
  roles.legs.forEach((leg, i) => {
    const hip = sk.roles.get(`leg.${i}.hip`);
    if (hip === undefined) return;

    const phase = (cycle + leg.phase) % 1;
    const a = phase * TAU;
    const strideScale = leg.strideScale ?? 1;

    // Hip swings fore and aft through the cycle.
    const hipAngle = Math.sin(a) * g.strideAngle * strideScale * walkWeight;
    pose[hip * POSE_STRIDE + POSE_ANGLE]! += hipAngle;

    // Splay legs laterally so they never occupy exactly the same plane. Without
    // this, a character seen head-on has its legs perfectly overlap and the walk
    // stops reading at all. This needs to be worth a couple of world units to be
    // visible at gameplay zoom -- a fraction of a unit is invisible and does
    // nothing but make you think the mitigation is in place when it is not.
    pose[hip * POSE_STRIDE + POSE_OX]! += leg.side * 2.2;

    // Knee bends only while the foot is off the ground (the swing half).
    const knee = sk.roles.get(`leg.${i}.knee`);
    if (knee !== undefined) {
      const lift = Math.max(0, Math.sin(a + Math.PI * 0.5));
      pose[knee * POSE_STRIDE + POSE_ANGLE]! -= lift * g.liftAngle * strideScale * walkWeight;
    }
  });

  // ---- body -------------------------------------------------------------------
  const bodyIdx = sk.roles.get('body');
  const rootIdx = sk.roles.get('root');

  if (rootIdx !== undefined) {
    const bob = Math.sin(cycle * TAU * g.bodyBobFreq) * g.bodyBobAmp * walkWeight;
    pose[rootIdx * POSE_STRIDE + POSE_OY]! += bob;

    if (g.swayAmp) {
      // Lateral waddle, at stride frequency so it alternates with the legs.
      pose[rootIdx * POSE_STRIDE + POSE_OX]! +=
        Math.sin(cycle * TAU) * g.swayAmp * walkWeight;
    }
  }

  if (bodyIdx !== undefined) {
    // Lean into the direction of travel.
    pose[bodyIdx * POSE_STRIDE + POSE_ANGLE]! += g.leanPerSpeed * walkWeight;

    // Idle breathing, faded out as the walk takes over so the two never fight.
    const idleWeight = 1 - walkWeight;
    if (idleWeight > 0.001) {
      pose[bodyIdx * POSE_STRIDE + POSE_ANGLE]! +=
        Math.sin(gi.time * 1.9) * 0.022 * idleWeight;
      const head = sk.roles.get('head');
      if (head !== undefined) {
        pose[head * POSE_STRIDE + POSE_ANGLE]! +=
          Math.sin(gi.time * 1.9 + 0.6) * 0.035 * idleWeight;
      }
    }
  }

  // ---- tail --------------------------------------------------------------------
  // Present only on skins that declare it; a stick figure and a chicken skip this
  // entirely, which is the graceful-degradation contract in action.
  const tail = sk.roles.get('tail');
  if (tail !== undefined) {
    pose[tail * POSE_STRIDE + POSE_ANGLE]! +=
      Math.sin(cycle * TAU * 2) * 0.18 * walkWeight + Math.sin(gi.time * 1.3) * 0.12;
  }
}
