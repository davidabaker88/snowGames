/**
 * The right-thumb gesture recognizer.
 *
 * Five gestures share one patch of glass:
 *   circle/scrub -> pack a snowball (continuous, while held)
 *   long press   -> put the held ball down (fires mid-gesture)
 *   double tap   -> put the held ball down
 *   single tap   -> pick up a ball from the ground
 *   flick        -> throw, direction and power from the flick
 *
 * Two design rules make that tractable:
 *
 * 1. A POINTER IS OWNED FOR LIFE. Once a pointer becomes a circle, it can never
 *    also produce a tap or a flick. Mid-gesture reassignment produces
 *    "I circled and it threw" bugs that are near-impossible to reproduce.
 *
 * 2. AMBIGUITY IS RESOLVED BY CONTEXT, NOT BY TIMING. Tap means "pick up" with
 *    empty hands and "place" while holding, because placing with empty hands is
 *    impossible. That lets pickup fire on the FIRST tap with no double-tap wait,
 *    which is the difference between the game feeling snappy and feeling laggy.
 */

import { clamp01, shortestArc } from '@snow/shared';
import {
  fitVelocity,
  makeCircleMeasure,
  measureCircle,
  PointerTrack,
  type CircleMeasure,
  type Sample,
} from './pointerSource.js';
import { scaledConfig, type GestureConfig } from './gestureConfig.js';

export const enum GestureState {
  Idle = 0,
  /** Down, but not yet committed to any interpretation. */
  Undecided = 1,
  /** Committed to circling. Locked -- cannot produce tap or flick. */
  Circling = 2,
  /** Long press already fired. Locked. */
  LongPressed = 3,
  /** Moved too far to be a tap; can still become a flick on release. */
  Moving = 4,
  /** Resolved to nothing. Silence is better than a wrong action. */
  Dead = 5,
}

export interface GestureOutput {
  /** Rotations of packing progress earned this frame. */
  packDelta: number;
  /** Set for one frame when the gesture fires. */
  tap: boolean;
  place: boolean;
  flick: boolean;
  /** Flick direction in SCREEN space; the caller inverse-projects it. */
  flickX: number;
  flickY: number;
  /** Flick power in [0, 1]. */
  flickPower: number;
}

export interface RecognizerContext {
  /** Whether the local player currently holds a snowball. */
  holdingBall: boolean;
  /** Whether there is a grounded ball within pickup range. */
  ballInReach: boolean;
}

function resetOutput(o: GestureOutput): void {
  o.packDelta = 0;
  o.tap = false;
  o.place = false;
  o.flick = false;
  o.flickX = 0;
  o.flickY = 0;
  o.flickPower = 0;
}

export class GestureRecognizer {
  state: GestureState = GestureState.Idle;

  private cfg: GestureConfig;
  private track: PointerTrack | null = null;
  private pointerId = -1;

  private windowBuf: Sample[] = [];
  private circle: CircleMeasure = makeCircleMeasure();
  private vel = { vx: 0, vy: 0 };

  /** Angle about the centroid last frame, so each frame banks only its own sweep. */
  private prevAngle = NaN;
  private lastScrubPath = 0;

  /** Pending single tap awaiting a possible second tap. */
  private pendingTapT = -1;
  private pendingTapX = 0;
  private pendingTapY = 0;

  readonly out: GestureOutput = {
    packDelta: 0,
    tap: false,
    place: false,
    flick: false,
    flickX: 0,
    flickY: 0,
    flickPower: 0,
  };

  /**
   * Discrete gestures resolved on pointer-up land here first.
   *
   * They cannot be written straight into `out`, because pointer events fire
   * between frames and `update()` clears `out` at the top of every frame -- so a
   * tap or flick written directly to `out` would be wiped before the game ever
   * read it. This buffer is drained by the next `update()`, which guarantees
   * exactly one frame of visibility for every gesture regardless of when the
   * finger happened to lift.
   */
  private pending: GestureOutput = {
    packDelta: 0,
    tap: false,
    place: false,
    flick: false,
    flickX: 0,
    flickY: 0,
    flickPower: 0,
  };

  /** Feedback for the HUD: circle progress ring and long-press pulse. */
  circleActive = false;
  circleTurns = 0;
  longPressProgress = 0;

  constructor(viewportMin: number) {
    this.cfg = scaledConfig(viewportMin);
  }

  setViewport(viewportMin: number): void {
    this.cfg = scaledConfig(viewportMin);
  }

  get activePointerId(): number {
    return this.pointerId;
  }

  get currentX(): number {
    return this.track?.x ?? 0;
  }

  get currentY(): number {
    return this.track?.y ?? 0;
  }

  down(pointerId: number, x: number, y: number, t: number): void {
    if (this.track) return; // already own a pointer; ignore extra fingers
    this.pointerId = pointerId;
    this.track = new PointerTrack(pointerId);
    this.track.begin(x, y, t);
    this.state = GestureState.Undecided;
    this.prevAngle = NaN;
    this.lastScrubPath = 0;
    this.circleActive = false;
    this.circleTurns = 0;
    this.longPressProgress = 0;
  }

  move(pointerId: number, x: number, y: number, t: number): void {
    if (!this.track || pointerId !== this.pointerId) return;
    this.track.push(x, y, t);
  }

  /** Returns the gesture output for this frame. Valid until the next update. */
  update(t: number, ctx: RecognizerContext): GestureOutput {
    resetOutput(this.out);

    // Drain anything resolved on pointer-up since the last frame.
    if (this.pending.tap || this.pending.place || this.pending.flick) {
      this.out.tap = this.pending.tap;
      this.out.place = this.pending.place;
      this.out.flick = this.pending.flick;
      this.out.flickX = this.pending.flickX;
      this.out.flickY = this.pending.flickY;
      this.out.flickPower = this.pending.flickPower;
      resetOutput(this.pending);
    }

    // A pending tap that nobody completed becomes a place-cancel or is discarded.
    if (this.pendingTapT >= 0 && t - this.pendingTapT > this.cfg.doubleTapWindowMs) {
      this.pendingTapT = -1;
    }

    const tr = this.track;
    if (!tr) {
      this.circleActive = false;
      this.longPressProgress = 0;
      return this.out;
    }

    const held = tr.t;
    void held;
    const duration = t - tr.startT;

    // ---- 1. circle gate ----------------------------------------------------
    // Checked first because it is the only gesture with continuous output while
    // held, and because a circling thumb would otherwise trip the flick test.
    //
    // Note that Moving is included, not just Undecided. Entering the circle gate
    // requires ~0.9 rad of accumulated sweep, which takes a few frames -- and a
    // circling thumb blows past the tap movement threshold long before that, so it
    // is already Moving by the time the gate could fire. Moving means only "this
    // can no longer be a tap or a long press"; a circle is a kind of moving.
    if (
      this.state === GestureState.Undecided ||
      this.state === GestureState.Moving ||
      this.state === GestureState.Circling
    ) {
      const credited = this.evaluateCircle(ctx);
      if (credited > 0) {
        this.out.packDelta += credited;
        this.state = GestureState.Circling;
        this.circleActive = true;
      }
    }

    if (this.state === GestureState.Circling) {
      this.longPressProgress = 0;
      return this.out;
    }

    // ---- 2. long press -----------------------------------------------------
    // Fires MID-GESTURE rather than on release: waiting for release to tell you a
    // long press happened makes it feel unresponsive, and the player has already
    // committed by then.
    if (this.state === GestureState.Undecided) {
      this.longPressProgress = clamp01(duration / this.cfg.longPressMs);
      if (duration >= this.cfg.longPressMs && tr.maxMove < this.cfg.longPressMaxMove) {
        this.state = GestureState.LongPressed;
        this.longPressProgress = 1;
        if (ctx.holdingBall) {
          this.out.place = true;
          vibrate(15);
        }
        return this.out;
      }
      // Moved too far to be a tap or a press -- still eligible to be a flick.
      if (tr.maxMove > this.cfg.tapMaxMove) {
        this.state = GestureState.Moving;
        this.longPressProgress = 0;
      }
    } else {
      this.longPressProgress = 0;
    }

    return this.out;
  }

  up(pointerId: number, x: number, y: number, t: number, ctx: RecognizerContext): void {
    if (!this.track || pointerId !== this.pointerId) return;
    const tr = this.track;
    tr.push(x, y, t);

    const state = this.state;
    this.track = null;
    this.pointerId = -1;
    this.state = GestureState.Idle;
    this.circleActive = false;
    this.longPressProgress = 0;

    // Locked states already did their work.
    if (state === GestureState.Circling || state === GestureState.LongPressed) return;
    if (state === GestureState.Dead) return;

    const duration = tr.durationMs;

    // ---- 3. tap ------------------------------------------------------------
    if (duration < this.cfg.tapMaxMs && tr.maxMove < this.cfg.tapMaxMove) {
      this.resolveTap(tr.x, tr.y, t, ctx);
      return;
    }

    // ---- 4. flick ----------------------------------------------------------
    tr.window(this.cfg.flickWindowMs, this.windowBuf);
    if (fitVelocity(this.windowBuf, this.vel)) {
      const speed = Math.hypot(this.vel.vx, this.vel.vy);
      const netDist = Math.hypot(tr.x - tr.startX, tr.y - tr.startY);
      const straightness = tr.pathLength > 1e-6 ? netDist / tr.pathLength : 0;

      if (
        speed >= this.cfg.flickMinSpeed &&
        netDist >= this.cfg.flickMinDist &&
        straightness >= this.cfg.flickStraightness
      ) {
        const m = speed || 1;
        this.pending.flick = true;
        this.pending.flickX = this.vel.vx / m;
        this.pending.flickY = this.vel.vy / m;
        this.pending.flickPower = clamp01(
          (speed - this.cfg.flickMinSpeed) / (this.cfg.flickMaxSpeed - this.cfg.flickMinSpeed),
        );
        return;
      }
    }

    // ---- 5. nothing --------------------------------------------------------
    // Deliberately no fallback action. A wrong throw is worse than no throw.
  }

  cancel(pointerId: number): void {
    if (pointerId !== this.pointerId) return;
    this.track = null;
    this.pointerId = -1;
    this.state = GestureState.Idle;
    this.circleActive = false;
    this.longPressProgress = 0;
  }

  /**
   * Tap means different things depending on what is in your hands, and that is
   * what removes the ambiguity: you cannot "place" with nothing, so an
   * empty-handed tap is unambiguously a pickup and can fire immediately.
   */
  private resolveTap(x: number, y: number, t: number, ctx: RecognizerContext): void {
    if (!ctx.holdingBall) {
      // Empty hands: unambiguously a pickup, so fire on the FIRST tap with no
      // double-tap wait. Making the player wait 280ms here to find out whether a
      // second tap is coming is what would make pickup feel laggy.
      this.pending.tap = true;
      this.pendingTapT = -1;
      return;
    }

    // Holding: look for a second tap to place.
    if (
      this.pendingTapT >= 0 &&
      t - this.pendingTapT <= this.cfg.doubleTapWindowMs &&
      Math.hypot(x - this.pendingTapX, y - this.pendingTapY) <= this.cfg.doubleTapMaxDist
    ) {
      this.pending.place = true;
      this.pendingTapT = -1;
      return;
    }

    this.pendingTapT = t;
    this.pendingTapX = x;
    this.pendingTapY = y;
  }

  private evaluateCircle(ctx: RecognizerContext): number {
    // Circling only makes sense with empty hands: you cannot roll a new ball
    // while carrying one, so leave the pointer free for tap and flick instead.
    if (ctx.holdingBall) return 0;

    const tr = this.track;
    if (!tr) return 0;

    const n = tr.window(this.cfg.circleWindowMs, this.windowBuf);
    if (n < 3) return 0;

    measureCircle(this.windowBuf, this.cfg.circleMinRadius, this.circle);

    // The windowed measurement is used ONLY as a gate -- "does this motion look
    // like circling right now?". It must not be used as progress: it is a rolling
    // total over the last ~500ms, so it plateaus rather than accumulating, and
    // treating it as progress stalls packing partway through, forever.
    const isCircling =
      Math.abs(this.circle.signed) >= this.cfg.circleEnterAngle &&
      this.circle.consistency >= this.cfg.circleConsistency;

    // Progress comes from the sweep since the previous frame, about the current
    // centroid. At 30Hz a fast circle sweeps well under half a turn per frame, so
    // there is no aliasing risk in sampling it this coarsely.
    const dx = tr.x - this.circle.cx;
    const dy = tr.y - this.circle.cy;
    const radius = Math.hypot(dx, dy);
    const angleNow = Math.atan2(dy, dx);

    let sweep = 0;
    if (radius >= this.cfg.circleMinRadius) {
      if (Number.isFinite(this.prevAngle)) sweep = shortestArc(this.prevAngle, angleNow);
      this.prevAngle = angleNow;
    } else {
      // Too near the centre for the angle to be meaningful; drop the baseline
      // rather than banking a wild value on the next frame.
      this.prevAngle = NaN;
    }

    if (isCircling) {
      const rotations = Math.abs(sweep) / (Math.PI * 2);
      this.circleTurns += rotations;
      this.lastScrubPath = tr.pathLength;
      return rotations;
    }

    // Scrub fallback: reward frantic back-and-forth, just less generously.
    // It must actually double back -- a single fast straight swipe is a flick, and
    // crediting it here would blur the two gestures together.
    const dt = Math.max(1, tr.durationMs) / 1000;
    const pathRate = tr.pathLength / dt;
    const netDist = Math.hypot(tr.x - tr.startX, tr.y - tr.startY);
    const straightness = tr.pathLength > 1e-6 ? netDist / tr.pathLength : 1;

    if (
      pathRate >= this.cfg.scrubMinPathPerSec &&
      straightness <= this.cfg.scrubMaxStraightness
    ) {
      const newPath = tr.pathLength - this.lastScrubPath;
      if (newPath > 0) {
        this.lastScrubPath = tr.pathLength;
        const rotations =
          (newPath / this.cfg.scrubUnitsPerRotation) * this.cfg.scrubEfficiency;
        this.circleTurns += rotations;
        return rotations;
      }
    }

    return 0;
  }
}

function vibrate(ms: number): void {
  // Not available everywhere, blocked on iOS Safari, and absent entirely under
  // Node -- where this class is unit-tested. Purely additive either way.
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { vibrate?: (p: number) => boolean };
  try {
    nav.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}
