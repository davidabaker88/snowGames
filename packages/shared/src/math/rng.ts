/**
 * Seeded PRNG (mulberry32).
 *
 * `Math.random` is banned inside `sim/` -- the simulation must be a pure
 * function of (state, inputs), so every random draw has to come from state that
 * the server can seed and serialize. This RNG's entire state is one uint32,
 * which makes it trivially snapshot-able.
 *
 * Cosmetic randomness (snow particles, hit sparks) must use a SEPARATE
 * non-simulation RNG in the client, so that tweaking a particle effect can
 * never perturb gameplay.
 */

export interface RngState {
  s: number;
}

export function createRng(seed: number): RngState {
  // Avoid a zero state, which mulberry32 handles poorly.
  return { s: (seed | 0) === 0 ? 0x9e3779b9 : seed >>> 0 };
}

/** Uniform in [0, 1). */
export function nextFloat(r: RngState): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform in [lo, hi). */
export function nextRange(r: RngState, lo: number, hi: number): number {
  return lo + nextFloat(r) * (hi - lo);
}

/** Uniform integer in [0, n). */
export function nextInt(r: RngState, n: number): number {
  return Math.floor(nextFloat(r) * n) % Math.max(1, n);
}

/** Uniform in [-mag, +mag). */
export function nextSpread(r: RngState, mag: number): number {
  return (nextFloat(r) * 2 - 1) * mag;
}

export function cloneRng(r: RngState): RngState {
  return { s: r.s };
}
