/**
 * Recognizer tests.
 *
 * These feed synthetic pointer traces through the real recognizer at a realistic
 * sample rate, and drive `update()` at the real 30Hz tick rate -- because the
 * interaction between "pointer events arrive at 60Hz" and "the game reads gestures
 * at 30Hz" is itself a source of bugs, not an implementation detail.
 *
 * The near-miss cases matter as much as the happy paths: a recognizer that fires
 * a throw when the player meant to pack is far worse than one that occasionally
 * does nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GestureRecognizer, GestureState, type RecognizerContext } from './gestureRecognizer.js';
import { PACK_ROTATIONS_REQUIRED } from '@snow/shared';

const VIEWPORT = 390;
const EMPTY: RecognizerContext = { holdingBall: false, ballInReach: false };
const HOLDING: RecognizerContext = { holdingBall: true, ballInReach: false };

/** Accumulates everything the recognizer emits over a scripted trace. */
interface Result {
  packDelta: number;
  taps: number;
  places: number;
  flicks: number;
  lastFlick: { x: number; y: number; power: number };
  endState: GestureState;
  turns: number;
}

/**
 * Run a trace. `points` are sampled at `sampleMs`; `update()` is pumped whenever
 * enough time has passed for a 30Hz tick, mirroring the real game loop.
 */
function runTrace(
  points: { x: number; y: number }[],
  opts: {
    ctx?: RecognizerContext;
    sampleMs?: number;
    holdAfterMs?: number;
    release?: boolean;
    startT?: number;
    rec?: GestureRecognizer;
  } = {},
): Result {
  const rec = opts.rec ?? new GestureRecognizer(VIEWPORT);
  const ctx = opts.ctx ?? EMPTY;
  const sampleMs = opts.sampleMs ?? 16;
  const TICK = 1000 / 30;

  const res: Result = {
    packDelta: 0,
    taps: 0,
    places: 0,
    flicks: 0,
    lastFlick: { x: 0, y: 0, power: 0 },
    endState: GestureState.Idle,
    turns: 0,
  };

  let t = opts.startT ?? 1000;
  let nextTick = t;
  const id = 7;

  const pump = (now: number): void => {
    while (now >= nextTick) {
      const out = rec.update(nextTick, ctx);
      res.packDelta += out.packDelta;
      if (out.tap) res.taps++;
      if (out.place) res.places++;
      if (out.flick) {
        res.flicks++;
        res.lastFlick = { x: out.flickX, y: out.flickY, power: out.flickPower };
      }
      nextTick += TICK;
    }
  };

  const first = points[0]!;
  rec.down(id, first.x, first.y, t);
  pump(t);

  for (let i = 1; i < points.length; i++) {
    t += sampleMs;
    const p = points[i]!;
    rec.move(id, p.x, p.y, t);
    pump(t);
  }

  if (opts.holdAfterMs) {
    const end = t + opts.holdAfterMs;
    while (t < end) {
      t += sampleMs;
      const last = points[points.length - 1]!;
      rec.move(id, last.x, last.y, t);
      pump(t);
    }
  }

  res.endState = rec.state;
  res.turns = rec.circleTurns;

  if (opts.release !== false) {
    const last = points[points.length - 1]!;
    rec.up(id, last.x, last.y, t, ctx);
    // One more tick so the pending gesture is drained, exactly as the game does.
    pump(t + TICK);
  }

  return res;
}

/** Points along a circle. */
function circlePoints(turns: number, radius: number, samples: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const a = (i / samples) * turns * Math.PI * 2;
    pts.push({ x: 250 + Math.cos(a) * radius, y: 500 + Math.sin(a) * radius });
  }
  return pts;
}

/** Points along a straight line. */
function linePoints(dx: number, dy: number, samples: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    pts.push({ x: 250 + (dx * i) / samples, y: 500 + (dy * i) / samples });
  }
  return pts;
}

describe('circling to pack', () => {
  it('earns roughly one rotation of progress per circle traced', () => {
    const r = runTrace(circlePoints(3, 46, 90));
    expect(r.endState).toBe(GestureState.Circling);
    // Should be close to 3 -- the point is that it ACCUMULATES rather than
    // plateauing at whatever fits in the measurement window.
    expect(r.packDelta).toBeGreaterThan(2.4);
    expect(r.packDelta).toBeLessThan(3.6);
  });

  it('accumulates enough progress to finish a snowball', () => {
    const r = runTrace(circlePoints(4, 46, 120));
    expect(r.packDelta).toBeGreaterThanOrEqual(PACK_ROTATIONS_REQUIRED);
  });

  it('keeps accumulating over a long circle rather than plateauing', () => {
    // Regression guard: an earlier version credited the rolling windowed angle,
    // which stalls partway through and can never complete a ball no matter how
    // long the player circles.
    const short = runTrace(circlePoints(2, 46, 60));
    const long = runTrace(circlePoints(8, 46, 240));
    expect(long.packDelta).toBeGreaterThan(short.packDelta * 2.5);
  });

  it('works in both directions', () => {
    const cw = runTrace(circlePoints(3, 46, 90));
    const ccw = runTrace(circlePoints(-3, 46, 90));
    expect(ccw.packDelta).toBeGreaterThan(2.4);
    expect(Math.abs(ccw.packDelta - cw.packDelta)).toBeLessThan(0.4);
  });

  it('locks the pointer, so a circle can never also throw', () => {
    const r = runTrace(circlePoints(3, 46, 90));
    expect(r.flicks).toBe(0);
    expect(r.taps).toBe(0);
    expect(r.places).toBe(0);
  });

  it('does not pack while the player is already holding a ball', () => {
    const r = runTrace(circlePoints(4, 46, 120), { ctx: HOLDING });
    expect(r.packDelta).toBe(0);
  });

  it('ignores a stationary but jittery thumb', () => {
    // A resting thumb wobbling a few pixels must not pack. Near the centroid tiny
    // movements subtend huge angles, which is exactly the false positive the
    // minimum-radius guard exists to reject.
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 120; i++) {
      pts.push({ x: 250 + Math.sin(i * 1.7) * 3, y: 500 + Math.cos(i * 2.3) * 3 });
    }
    const r = runTrace(pts);
    expect(r.packDelta).toBeLessThan(0.2);
  });

  it('gives a scrub partial credit, but well below a clean circle', () => {
    // Deliberate design choice: people scrub instead of circling, and refusing to
    // reward it at all feels broken -- but circling must stay clearly better.
    //
    // The comparison has to be made at MATCHED THUMB TRAVEL, not matched duration.
    // A frantic scrub can cover twice the distance of a lazy circle and so earn
    // more in absolute terms while still being far less efficient; the design
    // claim is about reward per unit of effort. Both traces below cover ~1150px.
    const circleTravel = 4 * 2 * Math.PI * 46;
    const amplitude = 60;
    const samples = 120;
    // Mean |derivative| of a sinusoid is 2/PI of its peak, hence the 0.6366.
    const k = circleTravel / (amplitude * samples * (2 / Math.PI));

    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= samples; i++) {
      pts.push({ x: 250 + Math.sin(i * k) * amplitude, y: 500 });
    }

    const scrub = runTrace(pts);
    const circle = runTrace(circlePoints(4, 46, samples));

    expect(scrub.packDelta).toBeGreaterThan(0.15);
    expect(scrub.packDelta).toBeLessThan(circle.packDelta * 0.6);
  });
});

describe('flick to throw', () => {
  it('recognizes a fast straight drag as a flick', () => {
    const r = runTrace(linePoints(150, -20, 6), { sampleMs: 12, ctx: HOLDING });
    expect(r.flicks).toBe(1);
    expect(r.lastFlick.x).toBeGreaterThan(0.9);
    expect(r.lastFlick.power).toBeGreaterThan(0);
  });

  it('never mistakes a straight flick for circling', () => {
    // Regression guard for a specific geometric trap: for a straight drag the
    // centroid lies ON the path, so samples either side of it are 180 degrees
    // apart and produce a phantom half-rotation with perfect consistency.
    const r = runTrace(linePoints(150, -20, 6), { sampleMs: 12, ctx: EMPTY });
    expect(r.packDelta).toBeLessThan(0.05);
    expect(r.endState).not.toBe(GestureState.Circling);
  });

  it('reports direction for flicks at various angles', () => {
    const right = runTrace(linePoints(160, 0, 6), { sampleMs: 12, ctx: HOLDING });
    expect(right.lastFlick.x).toBeGreaterThan(0.95);

    const down = runTrace(linePoints(0, 160, 6), { sampleMs: 12, ctx: HOLDING });
    expect(down.lastFlick.y).toBeGreaterThan(0.95);

    const upLeft = runTrace(linePoints(-120, -120, 6), { sampleMs: 12, ctx: HOLDING });
    expect(upLeft.lastFlick.x).toBeLessThan(-0.5);
    expect(upLeft.lastFlick.y).toBeLessThan(-0.5);
  });

  it('scales power with flick speed', () => {
    const slow = runTrace(linePoints(70, 0, 6), { sampleMs: 26, ctx: HOLDING });
    const fast = runTrace(linePoints(300, 0, 6), { sampleMs: 8, ctx: HOLDING });
    expect(fast.lastFlick.power).toBeGreaterThan(slow.lastFlick.power);
  });

  it('rejects a slow drag', () => {
    const r = runTrace(linePoints(120, 0, 20), { sampleMs: 40, ctx: HOLDING });
    expect(r.flicks).toBe(0);
  });

  it('rejects a fast but curved drag, which is a circle not a flick', () => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 1.4;
      pts.push({ x: 250 + Math.cos(a) * 70, y: 500 + Math.sin(a) * 70 });
    }
    const r = runTrace(pts, { sampleMs: 10, ctx: HOLDING });
    expect(r.flicks).toBe(0);
  });
});

describe('tap, double tap and long press', () => {
  it('fires a tap immediately with empty hands (pickup must feel instant)', () => {
    const r = runTrace([{ x: 250, y: 500 }], { holdAfterMs: 60, ctx: EMPTY });
    expect(r.taps).toBe(1);
    expect(r.places).toBe(0);
  });

  it('does not place on a single tap while holding', () => {
    const r = runTrace([{ x: 250, y: 500 }], { holdAfterMs: 60, ctx: HOLDING });
    expect(r.places).toBe(0);
    expect(r.taps).toBe(0);
  });

  it('places on a double tap while holding', () => {
    // Shared recognizer instance, because the double-tap buffer lives across
    // gestures by design.
    const rec = new GestureRecognizer(VIEWPORT);
    runTrace([{ x: 250, y: 500 }], { holdAfterMs: 60, ctx: HOLDING, rec, startT: 1000 });
    const second = runTrace([{ x: 252, y: 502 }], {
      holdAfterMs: 60,
      ctx: HOLDING,
      rec,
      startT: 1160,
    });
    expect(second.places).toBe(1);
  });

  it('does not place when the two taps are too far apart in time', () => {
    const rec = new GestureRecognizer(VIEWPORT);
    runTrace([{ x: 250, y: 500 }], { holdAfterMs: 60, ctx: HOLDING, rec, startT: 1000 });
    const second = runTrace([{ x: 250, y: 500 }], {
      holdAfterMs: 60,
      ctx: HOLDING,
      rec,
      startT: 2000,
    });
    expect(second.places).toBe(0);
  });

  it('does not place when the two taps are too far apart on screen', () => {
    const rec = new GestureRecognizer(VIEWPORT);
    runTrace([{ x: 250, y: 500 }], { holdAfterMs: 60, ctx: HOLDING, rec, startT: 1000 });
    const second = runTrace([{ x: 250, y: 640 }], {
      holdAfterMs: 60,
      ctx: HOLDING,
      rec,
      startT: 1160,
    });
    expect(second.places).toBe(0);
  });

  it('places on a long press while holding, mid-gesture', () => {
    const r = runTrace([{ x: 250, y: 500 }], {
      holdAfterMs: 620,
      ctx: HOLDING,
      release: false,
    });
    // Fires before the finger lifts -- waiting for release would feel unresponsive.
    expect(r.places).toBe(1);
    expect(r.endState).toBe(GestureState.LongPressed);
  });

  it('does not long-press if the finger drifts too far', () => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: 250 + i * 2, y: 500 });
    const r = runTrace(pts, { sampleMs: 16, ctx: HOLDING });
    expect(r.places).toBe(0);
  });

  it('does nothing at all for an ambiguous slow short drag', () => {
    // Explicitly asserting silence: a wrong throw is worse than no throw.
    const r = runTrace(linePoints(26, 8, 10), { sampleMs: 30, ctx: HOLDING });
    expect(r.flicks).toBe(0);
    expect(r.taps).toBe(0);
    expect(r.places).toBe(0);
  });
});

describe('viewport scaling', () => {
  it('scales distance thresholds so a flick is comparable on a tablet', () => {
    const phone = new GestureRecognizer(390);
    const tablet = new GestureRecognizer(820);
    // The same physical-feeling gesture, expressed in proportionally more pixels
    // on the larger screen, must classify the same way.
    const phoneRes = runTrace(linePoints(150, 0, 6), { sampleMs: 12, ctx: HOLDING, rec: phone });
    const tabletRes = runTrace(linePoints(150 * (820 / 390), 0, 6), {
      sampleMs: 12,
      ctx: HOLDING,
      rec: tablet,
    });
    expect(phoneRes.flicks).toBe(1);
    expect(tabletRes.flicks).toBe(1);
    expect(Math.abs(phoneRes.lastFlick.power - tabletRes.lastFlick.power)).toBeLessThan(0.15);
  });
});

describe('lifecycle', () => {
  let rec: GestureRecognizer;
  beforeEach(() => {
    rec = new GestureRecognizer(VIEWPORT);
  });

  it('ignores extra simultaneous pointers', () => {
    rec.down(1, 250, 500, 1000);
    rec.down(2, 300, 520, 1005);
    expect(rec.activePointerId).toBe(1);
    // The second pointer must not be able to steal or cancel the first.
    rec.up(2, 300, 520, 1050, EMPTY);
    expect(rec.activePointerId).toBe(1);
  });

  it('clears state on pointercancel', () => {
    rec.down(1, 250, 500, 1000);
    rec.cancel(1);
    expect(rec.activePointerId).toBe(-1);
    expect(rec.state).toBe(GestureState.Idle);
  });

  it('surfaces a gesture for exactly one frame', () => {
    // The game reads gestures once per tick; a gesture that is visible for two
    // ticks would fire its action twice.
    const rec2 = new GestureRecognizer(VIEWPORT);
    rec2.down(1, 250, 500, 1000);
    rec2.up(1, 250, 500, 1060, EMPTY);
    const a = rec2.update(1100, EMPTY);
    expect(a.tap).toBe(true);
    const b = rec2.update(1133, EMPTY);
    expect(b.tap).toBe(false);
  });
});
