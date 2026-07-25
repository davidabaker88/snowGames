/**
 * Every gesture threshold, in one file.
 *
 * All distances are authored against a 390px reference viewport (an iPhone 13
 * in portrait) and scaled at runtime by `min(vw, vh) / 390`. Without that, a
 * flick threshold tuned on a phone is trivially easy on a tablet and a
 * long-press-vs-drag distinction tuned on a tablet is impossible on a phone.
 *
 * Timings are NOT scaled -- thumbs move at the same speed on every device.
 */

export const REFERENCE_VIEWPORT = 390;

export interface GestureConfig {
  // ---- tap -----------------------------------------------------------------
  tapMaxMs: number;
  tapMaxMove: number;

  // ---- double tap ----------------------------------------------------------
  doubleTapWindowMs: number;
  doubleTapMaxDist: number;

  // ---- long press ----------------------------------------------------------
  longPressMs: number;
  longPressMaxMove: number;

  // ---- flick ---------------------------------------------------------------
  /** Window over which the release velocity is least-squares fitted. */
  flickWindowMs: number;
  flickMinSpeed: number;
  flickMinDist: number;
  /**
   * Net displacement / path length. This is the ONLY thing that reliably
   * separates a flick from a fast circle: both are fast, but a circle doubles
   * back on itself so its net displacement is small relative to distance
   * travelled.
   */
  flickStraightness: number;
  /** Speed mapped to power 1.0. */
  flickMaxSpeed: number;

  // ---- circling (pack) -----------------------------------------------------
  /** Sample window used to compute the running centroid. */
  circleWindowMs: number;
  /** Accumulated signed angle needed to enter the circling state. */
  circleEnterAngle: number;
  /** |signed angle| / total angle. Rejects jittery back-and-forth as circling. */
  circleConsistency: number;
  /** Samples closer than this to the centroid are ignored as noise. */
  circleMinRadius: number;

  /**
   * Scrub fallback. The brief said "quick circle motions", but people naturally
   * scrub back and forth instead, and refusing to reward that feels broken. So
   * motion that fails the consistency test still earns progress from raw path
   * length, at a deliberately worse rate -- clean circles stay the best way.
   */
  scrubMinPathPerSec: number;
  scrubUnitsPerRotation: number;
  scrubEfficiency: number;
  /**
   * A scrub must DOUBLE BACK on itself, so its net displacement has to be small
   * relative to the distance travelled. Without this, a single fast straight
   * swipe -- i.e. a flick -- would also earn packing progress, and the three
   * gestures would stop being cleanly separable.
   */
  scrubMaxStraightness: number;
}

const BASE: GestureConfig = {
  tapMaxMs: 200,
  tapMaxMove: 12,

  doubleTapWindowMs: 280,
  doubleTapMaxDist: 40,

  longPressMs: 450,
  longPressMaxMove: 14,

  flickWindowMs: 90,
  flickMinSpeed: 600,
  flickMinDist: 30,
  flickStraightness: 0.7,
  flickMaxSpeed: 2200,

  circleWindowMs: 500,
  circleEnterAngle: 0.9,
  circleConsistency: 0.7,
  circleMinRadius: 14,

  scrubMinPathPerSec: 450,
  scrubUnitsPerRotation: 250,
  scrubEfficiency: 0.3,
  scrubMaxStraightness: 0.7,
};

/** Scale the distance-based thresholds for the current viewport. */
export function scaledConfig(viewportMin: number): GestureConfig {
  const s = Math.max(0.6, Math.min(2.2, viewportMin / REFERENCE_VIEWPORT));
  return {
    ...BASE,
    tapMaxMove: BASE.tapMaxMove * s,
    doubleTapMaxDist: BASE.doubleTapMaxDist * s,
    longPressMaxMove: BASE.longPressMaxMove * s,
    flickMinSpeed: BASE.flickMinSpeed * s,
    flickMinDist: BASE.flickMinDist * s,
    flickMaxSpeed: BASE.flickMaxSpeed * s,
    circleMinRadius: BASE.circleMinRadius * s,
    scrubMinPathPerSec: BASE.scrubMinPathPerSec * s,
    scrubUnitsPerRotation: BASE.scrubUnitsPerRotation * s,
  };
}

export const DEFAULT_CONFIG = BASE;
