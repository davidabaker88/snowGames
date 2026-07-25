/**
 * Mutating 2D vector helpers.
 *
 * Everything here writes into an existing object rather than returning a fresh
 * one. That looks less pretty than a functional API, and it is deliberate: this
 * code runs 30x/second per entity on mid-range Android phones, where allocating
 * a `{x, y}` literal per operation is the difference between 60fps and 35fps.
 * Use the `tmp*` scratch vectors for intermediates.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy(out: Vec2, a: Vec2): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

export function addTo(out: Vec2, a: Vec2): Vec2 {
  out.x += a.x;
  out.y += a.y;
  return out;
}

export function subTo(out: Vec2, a: Vec2): Vec2 {
  out.x -= a.x;
  out.y -= a.y;
  return out;
}

export function scaleTo(out: Vec2, s: number): Vec2 {
  out.x *= s;
  out.y *= s;
  return out;
}

/** out += a * s  -- the single most common operation in an integrator. */
export function addScaledTo(out: Vec2, a: Vec2, s: number): Vec2 {
  out.x += a.x * s;
  out.y += a.y * s;
  return out;
}

export function lenSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function len(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt(distSq(a, b));
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product (the z component of the 3D cross). Signed area. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

/** Normalize in place. A zero vector is left at zero rather than becoming NaN. */
export function normalizeTo(out: Vec2): Vec2 {
  const l = len(out);
  if (l > 1e-9) {
    out.x /= l;
    out.y /= l;
  }
  return out;
}

/** Clamp magnitude to `max`. Used to stop diagonal joystick input exceeding 1. */
export function clampLenTo(out: Vec2, max: number): Vec2 {
  const l2 = lenSq(out);
  if (l2 > max * max && l2 > 1e-18) {
    const s = max / Math.sqrt(l2);
    out.x *= s;
    out.y *= s;
  }
  return out;
}

export function lerpTo(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return out;
}

export function equalsApprox(a: Vec2, b: Vec2, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

// Scratch vectors for intermediate results inside a single function body.
// Never hold a reference to these across a function boundary.
export const tmpA: Vec2 = vec2();
export const tmpB: Vec2 = vec2();
export const tmpC: Vec2 = vec2();
