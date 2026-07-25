/**
 * Animation clip format.
 *
 * Clips address ROLES, never bone ids (see skinTypes.ts). They are compiled
 * against a skin exactly once, at load, into bone-index-addressed tracks -- so
 * there are no string lookups per frame, and tracks whose role the skin does not
 * provide are simply dropped.
 *
 * Clip `duration` is advisory. The animator stretches action clips to whatever
 * the simulation says the action lasts (see constants.ts), because the
 * authoritative host has no clips in memory and must not be able to disagree
 * with the client about how long a throw takes.
 */

import type { EaseName } from '../math/ease.js';

/** Which channel of a bone's pose a track drives. */
export type PoseProp = 'angle' | 'scale' | 'ox' | 'oy' | 'oz' | 'alpha';

export interface Keyframe {
  /** Normalized time in [0, 1] across the clip. */
  t: number;
  v: number;
  /** Easing from this key to the next. */
  ease?: EaseName;
}

export interface Track {
  /**
   * A role name ('head', 'throwLimb'), a leg address ('leg.0', 'leg.1.knee'),
   * or -- as an escape hatch for skin-specific flourishes -- a raw bone id.
   */
  target: string;
  prop: PoseProp;
  /**
   * Additive tracks are summed on top of the procedural gait and rest pose;
   * absolute tracks replace it. Stagger and aim offsets must be additive so they
   * can layer over a walk cycle.
   */
  additive?: boolean;
  keys: readonly Keyframe[];
}

export interface ClipEvent {
  t: number;
  name: string;
}

export interface ClipDef {
  name: string;
  /** Nominal duration in seconds, used only when the sim does not dictate one. */
  duration: number;
  loop?: boolean;
  tracks: readonly Track[];
  /**
   * PURELY COSMETIC hooks -- dust puffs, snow spray, audio. The simulation must
   * never read these: the host has no clips, so anything gated on a clip event
   * would exist on the client and not on the server.
   */
  events?: readonly ClipEvent[];
}
