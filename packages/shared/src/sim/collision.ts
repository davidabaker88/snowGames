/**
 * Collision helpers.
 *
 * The important one is `sweptCircleHit`. At 30Hz a 900 u/s snowball travels
 * 30 units per tick against a 17-unit player radius, so a naive
 * "is the ball inside the player this tick" test tunnels straight through people
 * about half the time. Every projectile test must be swept.
 */

export interface SweepResult {
  hit: boolean;
  /** Fraction along this tick's motion at which contact occurs, in [0, 1]. */
  t: number;
}

const NO_HIT: SweepResult = { hit: false, t: 1 };

/**
 * Earliest contact between two circles moving at constant velocity over one
 * tick. Both deltas are per-tick displacements, not velocities.
 *
 * Solves |(P + t*D)| = r for the smaller root, where P is the initial relative
 * position and D the relative displacement.
 */
export function sweptCircleHit(
  ax: number,
  ay: number,
  adx: number,
  ady: number,
  ar: number,
  bx: number,
  by: number,
  bdx: number,
  bdy: number,
  br: number,
  out: SweepResult,
): SweepResult {
  const px = ax - bx;
  const py = ay - by;
  const dx = adx - bdx;
  const dy = ady - bdy;
  const r = ar + br;

  const a = dx * dx + dy * dy;
  const c = px * px + py * py - r * r;

  // Already overlapping at the start of the tick.
  if (c <= 0) {
    out.hit = true;
    out.t = 0;
    return out;
  }

  // No relative motion and not already touching.
  if (a < 1e-12) {
    out.hit = false;
    out.t = 1;
    return out;
  }

  const b = px * dx + py * dy;
  // Moving apart.
  if (b >= 0) {
    out.hit = false;
    out.t = 1;
    return out;
  }

  const disc = b * b - a * c;
  if (disc < 0) {
    out.hit = false;
    out.t = 1;
    return out;
  }

  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0 || t > 1) {
    out.hit = false;
    out.t = 1;
    return out;
  }

  out.hit = true;
  out.t = t;
  return out;
}

export function makeSweepResult(): SweepResult {
  return { hit: false, t: 1 };
}

export { NO_HIT };

/** Static circle overlap test. */
export function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Push a circle out of a static circle, writing the corrected position into
 * `out`. Positional correction only, no impulse -- players nudge past each other
 * rather than bouncing, which feels much better in a crowded snowball fight.
 */
export function resolveCircleOverlap(
  x: number,
  y: number,
  r: number,
  ox: number,
  oy: number,
  or_: number,
  out: { x: number; y: number },
): boolean {
  const dx = x - ox;
  const dy = y - oy;
  const minDist = r + or_;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minDist * minDist) return false;

  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    // Exactly coincident: pick a stable direction rather than dividing by zero.
    out.x = x + minDist;
    out.y = y;
    return true;
  }
  const s = minDist / d;
  out.x = ox + dx * s;
  out.y = oy + dy * s;
  return true;
}
