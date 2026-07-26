/**
 * Clock synchronisation.
 *
 * Two decisions carry this file, and both are about resisting bad samples rather
 * than about being clever.
 *
 * **Estimate from the MINIMUM round trip, not the average.** Network delay is
 * asymmetric noise: it can be arbitrarily worse than the true path delay and never
 * better. So the smallest RTT observed is the closest thing to a clean measurement
 * available, and averaging deliberately mixes clean samples with dirty ones. A
 * median would be defensible; a mean is not.
 *
 * **SLEW the offset, never step it.** A single unlucky sample -- one GC pause on
 * either end is enough -- would otherwise shift the whole world's render time and
 * make every remote player visibly stutter. Correcting at a bounded rate means a
 * bad sample costs a slow drift rather than a jump.
 */

import { CLOCK_SAMPLES, CLOCK_SLEW_RATE } from './protocol.js';
import { TICK_MS } from '../constants.js';

export interface ClockSync {
  /** Best estimate of (host clock - our clock), in ms. */
  offsetMs: number;
  /** Where the offset is heading, before slewing gets there. */
  targetOffsetMs: number;
  /** Smallest round trip seen, in ms. */
  minRttMs: number;
  /** Most recent round trip, for display. */
  lastRttMs: number;
  /** Recent RTTs, for the jitter estimate. */
  samples: number[];
  /** True once at least one sample has landed. */
  synced: boolean;
}

export function createClockSync(): ClockSync {
  return {
    offsetMs: 0,
    targetOffsetMs: 0,
    minRttMs: Infinity,
    lastRttMs: 0,
    samples: [],
    synced: false,
  };
}

/**
 * Fold in one completed probe.
 *
 * `hostTick` is the tick the host was on when it replied. Assuming the reply took
 * half the round trip, the host is now that far further along -- which is the
 * standard estimate and is exactly right when the path is symmetric.
 */
export function addClockSample(
  c: ClockSync,
  sentAtMs: number,
  receivedAtMs: number,
  hostTick: number,
): void {
  const rtt = receivedAtMs - sentAtMs;
  if (!Number.isFinite(rtt) || rtt < 0) return;

  c.lastRttMs = rtt;
  c.samples.push(rtt);
  if (c.samples.length > CLOCK_SAMPLES) c.samples.shift();
  if (rtt < c.minRttMs) c.minRttMs = rtt;

  const hostTimeAtReply = hostTick * TICK_MS;
  const hostTimeNow = hostTimeAtReply + rtt / 2;
  c.targetOffsetMs = hostTimeNow - receivedAtMs;

  if (!c.synced) {
    // The first sample has nothing to slew from, so take it whole. Slewing from
    // zero would leave the first few seconds of a match rendering the world at
    // completely the wrong time.
    c.offsetMs = c.targetOffsetMs;
    c.synced = true;
  }
}

/** Move the offset toward its target at no more than CLOCK_SLEW_RATE. */
export function slewClock(c: ClockSync, dtMs: number): void {
  if (!c.synced) return;
  const maxStep = dtMs * CLOCK_SLEW_RATE;
  const err = c.targetOffsetMs - c.offsetMs;
  c.offsetMs += Math.abs(err) <= maxStep ? err : Math.sign(err) * maxStep;
}

/** Our best guess at the host's clock, in ms. */
export function hostTimeMs(c: ClockSync, localNowMs: number): number {
  return localNowMs + c.offsetMs;
}

/**
 * Jitter, as the spread between the smallest and the 95th-percentile RTT.
 *
 * Measured against the MINIMUM rather than the mean for the same reason the offset
 * is: the minimum is the baseline the connection is capable of, so the gap above it
 * is exactly the delay the interpolation buffer has to absorb.
 */
export function jitterMs(c: ClockSync): number {
  if (c.samples.length < 3) return 0;
  const sorted = c.samples.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
  return Math.max(0, p95 - (sorted[0] ?? 0));
}
