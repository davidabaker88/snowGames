/**
 * Pointer sampling.
 *
 * Pointer Events only -- no separate touch and mouse paths. That is not just
 * tidiness: it means every gesture, including the circle recognizer, can be
 * driven by a synthetic mouse in headless Chromium, so the trickiest code in the
 * project is actually testable without a phone in hand.
 *
 * Each pointer gets a ring buffer of recent samples. The recognizer needs
 * history, not just the latest position: a flick's velocity comes from a fit over
 * the last ~90ms, and circle detection integrates angle over ~500ms.
 */

export interface Sample {
  x: number;
  y: number;
  t: number;
}

const RING = 64;
/** Older than this and a sample cannot matter to any gesture. */
const MAX_AGE_MS = 700;

export class PointerTrack {
  readonly samples: Sample[] = [];
  private head = 0;
  private filled = 0;

  startX = 0;
  startY = 0;
  startT = 0;
  x = 0;
  y = 0;
  t = 0;
  /** Furthest the pointer has been from where it went down. */
  maxMove = 0;
  /** Total path length travelled, which is what separates a scrub from a hold. */
  pathLength = 0;

  constructor(readonly id: number) {
    for (let i = 0; i < RING; i++) this.samples.push({ x: 0, y: 0, t: 0 });
  }

  begin(x: number, y: number, t: number): void {
    this.head = 0;
    this.filled = 0;
    this.startX = x;
    this.startY = y;
    this.startT = t;
    this.maxMove = 0;
    this.pathLength = 0;
    this.push(x, y, t);
  }

  push(x: number, y: number, t: number): void {
    if (this.filled > 0) {
      const prev = this.samples[(this.head - 1 + RING) % RING]!;
      this.pathLength += Math.hypot(x - prev.x, y - prev.y);
    }
    const s = this.samples[this.head]!;
    s.x = x;
    s.y = y;
    s.t = t;
    this.head = (this.head + 1) % RING;
    if (this.filled < RING) this.filled++;

    this.x = x;
    this.y = y;
    this.t = t;
    this.maxMove = Math.max(this.maxMove, Math.hypot(x - this.startX, y - this.startY));
  }

  get count(): number {
    return this.filled;
  }

  get durationMs(): number {
    return this.t - this.startT;
  }

  /** Iterate samples oldest-first, newest last. */
  forEach(fn: (s: Sample, i: number) => void): void {
    for (let i = 0; i < this.filled; i++) {
      const idx = (this.head - this.filled + i + RING) % RING;
      fn(this.samples[idx]!, i);
    }
  }

  /** Collect samples newer than `t - windowMs` into `out`, oldest-first. */
  window(windowMs: number, out: Sample[]): number {
    out.length = 0;
    const cutoff = this.t - windowMs;
    for (let i = 0; i < this.filled; i++) {
      const idx = (this.head - this.filled + i + RING) % RING;
      const s = this.samples[idx]!;
      if (s.t >= cutoff && this.t - s.t <= MAX_AGE_MS) out.push(s);
    }
    return out.length;
  }
}

/**
 * Least-squares velocity fit over a sample window, in px/sec.
 *
 * A plain last-minus-previous delta is extremely noisy on real touch hardware --
 * a single 4ms frame gap produces an absurd velocity, and that value would map
 * straight onto throw power. Fitting a line over ~90ms is the difference between
 * "power feels random" and "power feels like how hard I flicked".
 *
 * Returns false if there is not enough data to be trustworthy.
 */
export function fitVelocity(
  samples: readonly Sample[],
  out: { vx: number; vy: number },
): boolean {
  const n = samples.length;
  if (n < 3) return false;

  const t0 = samples[0]!.t;
  let sumT = 0;
  let sumT2 = 0;
  let sumX = 0;
  let sumY = 0;
  let sumTX = 0;
  let sumTY = 0;

  for (const s of samples) {
    const t = (s.t - t0) / 1000;
    sumT += t;
    sumT2 += t * t;
    sumX += s.x;
    sumY += s.y;
    sumTX += t * s.x;
    sumTY += t * s.y;
  }

  const denom = n * sumT2 - sumT * sumT;
  if (Math.abs(denom) < 1e-9) return false;

  out.vx = (n * sumTX - sumT * sumX) / denom;
  out.vy = (n * sumTY - sumT * sumY) / denom;
  return Number.isFinite(out.vx) && Number.isFinite(out.vy);
}

/**
 * Accumulated signed angle about the window's centroid, plus a consistency ratio.
 *
 * `signed` is how far around the centroid the pointer has gone, with sign giving
 * direction. `total` is the same without cancellation. Their ratio distinguishes
 * a genuine circle (ratio near 1) from jitter or a scrub (ratio near 0).
 *
 * Samples very close to the centroid are skipped: near the centre, tiny
 * movements subtend huge angles, and including them makes a stationary shaky
 * thumb look like frantic circling.
 */
export interface CircleMeasure {
  signed: number;
  total: number;
  consistency: number;
  radius: number;
  /** Centroid of the window, which the caller needs to measure its own sweep. */
  cx: number;
  cy: number;
}

export function makeCircleMeasure(): CircleMeasure {
  return { signed: 0, total: 0, consistency: 0, radius: 0, cx: 0, cy: 0 };
}

/**
 * Largest plausible angle swept between two consecutive samples of a real circle.
 *
 * This guard is not paranoia, it fixes a specific and nasty false positive: for a
 * STRAIGHT drag, the centroid lies on the line, so the vectors to samples either
 * side of it point in opposite directions. Their cross product is ~0 and their dot
 * product is negative, which makes atan2 return +/-PI -- a phantom half-rotation
 * that sails past the circling gate with perfect consistency. A thumb circling at
 * even 5 turns per second only sweeps ~0.5 rad between 60Hz samples, so anything
 * approaching PI is geometry, not motion.
 */
const MAX_STEP_ANGLE = 1;

export function measureCircle(
  samples: readonly Sample[],
  minRadius: number,
  out: CircleMeasure,
): boolean {
  const n = samples.length;
  out.signed = 0;
  out.total = 0;
  out.consistency = 0;
  out.radius = 0;
  if (n < 3) return false;

  let cx = 0;
  let cy = 0;
  for (const s of samples) {
    cx += s.x;
    cy += s.y;
  }
  cx /= n;
  cy /= n;
  out.cx = cx;
  out.cy = cy;

  let radiusSum = 0;
  let counted = 0;

  for (let i = 0; i < n - 1; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const ax = a.x - cx;
    const ay = a.y - cy;
    const bx = b.x - cx;
    const by = b.y - cy;

    const ra = Math.hypot(ax, ay);
    const rb = Math.hypot(bx, by);
    radiusSum += ra;
    counted++;
    if (ra < minRadius || rb < minRadius) continue;

    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    const d = Math.atan2(cross, dot);
    if (Math.abs(d) > MAX_STEP_ANGLE) continue;
    out.signed += d;
    out.total += Math.abs(d);
  }

  out.radius = counted > 0 ? radiusSum / counted : 0;
  out.consistency = out.total > 1e-6 ? Math.abs(out.signed) / out.total : 0;
  return true;
}
