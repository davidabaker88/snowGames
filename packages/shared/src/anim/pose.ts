/**
 * Clip compilation and evaluation.
 *
 * `compileClip` is where the role indirection is paid off exactly once: string
 * targets become bone indices, and any track whose role this skin does not
 * provide is dropped. After that, sampling a clip is pure array arithmetic.
 */

import { ease } from '../math/ease.js';
import type { ClipDef, PoseProp, Track } from './clipTypes.js';
import {
  POSE_ALPHA,
  POSE_ANGLE,
  POSE_OX,
  POSE_OY,
  POSE_OZ,
  POSE_SCALE,
  POSE_STRIDE,
  resolveTarget,
  type Skeleton,
} from './skeleton.js';

function propChannel(p: PoseProp): number {
  switch (p) {
    case 'angle':
      return POSE_ANGLE;
    case 'scale':
      return POSE_SCALE;
    case 'ox':
      return POSE_OX;
    case 'oy':
      return POSE_OY;
    case 'oz':
      return POSE_OZ;
    case 'alpha':
      return POSE_ALPHA;
  }
}

interface CompiledTrack {
  /** Flat index into the pose buffer: bone * POSE_STRIDE + channel. */
  slot: number;
  additive: boolean;
  /** Absolute tracks on the scale/alpha channels multiply instead of replacing. */
  multiplicative: boolean;
  times: Float32Array;
  values: Float32Array;
  eases: (string | undefined)[];
}

export interface CompiledClip {
  name: string;
  duration: number;
  loop: boolean;
  tracks: CompiledTrack[];
  events: readonly { t: number; name: string }[];
  /** Tracks dropped because this skin lacks the role. Surfaced in the rig lab. */
  droppedTargets: string[];
}

export function compileClip(sk: Skeleton, clip: ClipDef): CompiledClip {
  const tracks: CompiledTrack[] = [];
  const droppedTargets: string[] = [];

  for (const t of clip.tracks) {
    const bone = resolveTarget(sk, t.target);
    if (bone < 0) {
      // Not an error. A chicken has no tail; a cat has no throwing arm. The clip
      // still plays, just without that track.
      droppedTargets.push(t.target);
      continue;
    }
    if (t.keys.length === 0) continue;
    tracks.push(compileTrack(t, bone));
  }

  return {
    name: clip.name,
    duration: clip.duration,
    loop: clip.loop ?? false,
    tracks,
    events: clip.events ?? [],
    droppedTargets,
  };
}

function compileTrack(t: Track, bone: number): CompiledTrack {
  const n = t.keys.length;
  const times = new Float32Array(n);
  const values = new Float32Array(n);
  const eases: (string | undefined)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = t.keys[i]!;
    times[i] = k.t;
    values[i] = k.v;
    eases[i] = k.ease;
  }
  const ch = propChannel(t.prop);
  return {
    slot: bone * POSE_STRIDE + ch,
    additive: t.additive ?? false,
    multiplicative: !(t.additive ?? false) && (ch === POSE_SCALE || ch === POSE_ALPHA),
    times,
    values,
    eases,
  };
}

/** Sample one track at normalized time `t` in [0, 1]. */
function sampleTrack(tr: CompiledTrack, t: number): number {
  const n = tr.times.length;
  if (n === 1) return tr.values[0]!;
  if (t <= tr.times[0]!) return tr.values[0]!;
  if (t >= tr.times[n - 1]!) return tr.values[n - 1]!;

  // Linear scan. Clip tracks have a handful of keys, so a binary search would be
  // slower in practice and harder to read.
  let i = 0;
  while (i < n - 1 && tr.times[i + 1]! < t) i++;

  const t0 = tr.times[i]!;
  const t1 = tr.times[i + 1]!;
  const span = t1 - t0;
  const local = span > 1e-9 ? (t - t0) / span : 0;
  const e = ease(tr.eases[i] as never, local);
  const v0 = tr.values[i]!;
  const v1 = tr.values[i + 1]!;
  return v0 + (v1 - v0) * e;
}

/**
 * Apply a clip to a pose buffer.
 *
 * `weight` lets a clip fade in or out over a procedural base pose, which is how
 * a stagger blends over a walk cycle instead of replacing it.
 */
export function applyClip(
  clip: CompiledClip,
  pose: Float32Array,
  t: number,
  weight = 1,
): void {
  if (weight <= 0) return;
  const tt = clip.loop ? t - Math.floor(t) : t < 0 ? 0 : t > 1 ? 1 : t;

  for (const tr of clip.tracks) {
    const v = sampleTrack(tr, tt);
    if (tr.additive) {
      pose[tr.slot]! += v * weight;
    } else if (tr.multiplicative) {
      // Blend toward the target multiplier rather than toward zero.
      pose[tr.slot]! *= 1 + (v - 1) * weight;
    } else {
      const cur = pose[tr.slot]!;
      pose[tr.slot] = cur + (v - cur) * weight;
    }
  }
}

/** Clip events crossed between two normalized times. Cosmetic use only. */
export function collectClipEvents(
  clip: CompiledClip,
  prevT: number,
  t: number,
  out: string[],
): void {
  if (clip.events.length === 0) return;
  if (t < prevT) {
    // Wrapped a looping clip: take the tail then the head.
    for (const e of clip.events) if (e.t > prevT) out.push(e.name);
    for (const e of clip.events) if (e.t <= t) out.push(e.name);
    return;
  }
  for (const e of clip.events) {
    if (e.t > prevT && e.t <= t) out.push(e.name);
  }
}
