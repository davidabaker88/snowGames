export const TAU = Math.PI * 2;

/** Wrap an angle into (-PI, PI]. */
export function wrapPi(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/**
 * Shortest signed rotation from `from` to `to`.
 * Always use this to interpolate facing, or a character turning past 180deg
 * will spin the long way round.
 */
export function shortestArc(from: number, to: number): number {
  return wrapPi(to - from);
}

/** Interpolate along the shortest arc. */
export function lerpAngle(from: number, to: number, t: number): number {
  return wrapPi(from + shortestArc(from, to) * t);
}

/**
 * Rotate `from` toward `to` by at most `maxStep` radians.
 * Used for turn-rate-limited facing so characters pivot rather than snap.
 */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = shortestArc(from, to);
  if (Math.abs(d) <= maxStep) return wrapPi(to);
  return wrapPi(from + Math.sign(d) * maxStep);
}

/**
 * Snap an angle to one of `steps` evenly spaced directions.
 * Gameplay facing stays continuous; only *rendering* quantizes, which keeps
 * the pose cache small and stops sub-degree jitter from flickering artwork.
 */
export function quantizeAngle(a: number, steps: number): number {
  const step = TAU / steps;
  return wrapPi(Math.round(a / step) * step);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Fraction of the way from a to b, clamped to [0,1]. Inverse of lerp. */
export function invLerp(a: number, b: number, v: number): number {
  if (Math.abs(b - a) < 1e-12) return 0;
  return clamp01((v - a) / (b - a));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential decay toward zero.
 * `halfLife` is the time for the value to halve. Prefer this over a raw
 * `v *= 0.9` per frame, which silently changes behaviour with frame rate.
 */
export function decayFactor(halfLife: number, dt: number): number {
  if (halfLife <= 0) return 0;
  return Math.pow(0.5, dt / halfLife);
}
