/**
 * Merges every input source into one `InputFrame` per tick.
 *
 * Pointer routing rule: on pointerdown, the LEFT half of the screen claims the
 * joystick if it is free, everything else goes to the gesture recognizer. A
 * pointer is then owned for life. Extra simultaneous fingers on the right are
 * ignored outright, which stops a resting palm from producing phantom taps.
 */

import {
  Button,
  createInputFrame,
  resetInputFrame,
  validateInput,
  type InputFrame,
} from '@snow/shared';
import { screenDirToWorldAngle, screenToWorldX, screenToWorldY } from '../render/projection.js';
import type { Camera, Viewport } from '../render/projection.js';
import {
  createJoystick,
  joystickDown,
  joystickMove,
  joystickRadius,
  joystickUp,
  type JoystickState,
} from './joystick.js';
import { GestureRecognizer, type RecognizerContext } from './gestureRecognizer.js';
import {
  attachKeyboard,
  consumeEdges,
  createKeyboardState,
  keyboardPackDelta,
  keyboardThrowPower,
  updateKeyboard,
  type KeyboardState,
} from './keyboardMouse.js';

export interface FrameContext extends RecognizerContext {
  cam: Camera;
  vp: Viewport;
  /** World position of the local player, for mouse aiming. */
  playerX: number;
  playerY: number;
  /** Fallback aim when no pointer or mouse has expressed one yet. */
  currentAim: number;
}

export class InputController {
  readonly joystick: JoystickState = createJoystick();
  readonly gestures: GestureRecognizer;
  readonly keyboard: KeyboardState = createKeyboardState();

  private frame: InputFrame = createInputFrame();
  private seq = 0;
  private detach: (() => void)[] = [];
  private vpMin = 390;

  /** Latest aim, retained between frames so it does not snap back to zero. */
  private aim = 0;
  /** Power from the most recent flick, consumed by the next frame. */
  private pendingThrowPower = 0;
  /** True when the local player wants an aim preview drawn. */
  lastFlickPower = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.gestures = new GestureRecognizer(390);
  }

  attach(): void {
    const c = this.canvas;

    // These four are all required on iOS Safari, and each fixes a different
    // thing: touch-action stops scroll/zoom stealing the gesture, preventDefault
    // on pointerdown stops the synthetic-click and double-tap-zoom paths, and
    // contextmenu suppression stops long-press bringing up a menu -- which would
    // otherwise fire exactly when the long-press gesture does.
    c.style.touchAction = 'none';

    const onDown = (e: PointerEvent): void => {
      e.preventDefault();
      // Capture keeps a gesture alive if the finger slides off the canvas, but it
      // throws for a pointer the browser does not consider active -- which
      // happens for synthetic events, and in odd real states too. It must never
      // abort the handler, or no input gets assigned at all.
      try {
        c.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is an optimisation, not a requirement */
      }
      const { x, y } = this.local(e);
      const leftHalf = x < this.canvas.clientWidth * 0.5;

      if (leftHalf && !this.joystick.active) {
        joystickDown(this.joystick, e.pointerId, x, y);
      } else if (this.gestures.activePointerId < 0) {
        this.gestures.down(e.pointerId, x, y, e.timeStamp);
      }
      // Any further pointer is deliberately dropped.
    };

    const onMove = (e: PointerEvent): void => {
      const { x, y } = this.local(e);
      if (e.pointerId === this.joystick.pointerId) {
        joystickMove(this.joystick, e.pointerId, x, y, joystickRadius(this.vpMin));
      } else if (e.pointerId === this.gestures.activePointerId) {
        this.gestures.move(e.pointerId, x, y, e.timeStamp);
      }
    };

    const onUp = (e: PointerEvent): void => {
      const { x, y } = this.local(e);
      if (e.pointerId === this.joystick.pointerId) {
        joystickUp(this.joystick, e.pointerId);
      } else if (e.pointerId === this.gestures.activePointerId) {
        // Context is captured now, before any action this frame mutates it.
        this.gestures.up(e.pointerId, x, y, e.timeStamp, this.lastCtx);
      }
    };

    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId === this.joystick.pointerId) joystickUp(this.joystick, e.pointerId);
      else this.gestures.cancel(e.pointerId);
    };

    const onContextMenu = (e: Event): void => e.preventDefault();

    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onCancel);
    c.addEventListener('contextmenu', onContextMenu);

    this.detach.push(() => {
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('pointercancel', onCancel);
      c.removeEventListener('contextmenu', onContextMenu);
    });
    this.detach.push(attachKeyboard(this.keyboard, c));
  }

  dispose(): void {
    for (const fn of this.detach) fn();
    this.detach = [];
  }

  setViewport(vp: Viewport): void {
    this.vpMin = Math.min(vp.width, vp.height);
    this.gestures.setViewport(this.vpMin);
  }

  private lastCtx: RecognizerContext = { holdingBall: false, ballInReach: false };

  private local(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /**
   * Produce the input frame for this tick.
   * `dtMs` is the wall time since the previous call.
   */
  buildFrame(now: number, dtMs: number, ctx: FrameContext): InputFrame {
    this.lastCtx = { holdingBall: ctx.holdingBall, ballInReach: ctx.ballInReach };

    const f = resetInputFrame(this.frame);
    f.seq = ++this.seq;

    updateKeyboard(this.keyboard, dtMs);
    const g = this.gestures.update(now, this.lastCtx);

    // ---- movement ------------------------------------------------------------
    if (this.joystick.active) {
      f.moveX = this.joystick.outX;
      f.moveY = this.joystick.outY;
    } else {
      f.moveX = this.keyboard.moveX;
      f.moveY = this.keyboard.moveY;
    }

    // ---- aim -----------------------------------------------------------------
    // Mouse position wins on desktop; otherwise the last flick or movement
    // direction is retained, so the character does not snap to facing east.
    if (this.keyboard.mouseX !== null && this.keyboard.mouseY !== null) {
      const wx = screenToWorldX(this.keyboard.mouseX, ctx.cam, ctx.vp);
      const wy = screenToWorldY(this.keyboard.mouseY, ctx.cam, ctx.vp);
      this.aim = Math.atan2(wy - ctx.playerY, wx - ctx.playerX);
    } else if (f.moveX !== 0 || f.moveY !== 0) {
      this.aim = screenDirToWorldAngle(f.moveX, f.moveY);
    }
    f.aim = this.aim;

    // ---- packing -------------------------------------------------------------
    f.packDelta = g.packDelta + keyboardPackDelta(this.keyboard, dtMs / 1000);

    // ---- discrete actions ----------------------------------------------------
    if (g.flick) {
      // The flick is in SCREEN space; the world is compressed vertically, so it
      // must be inverse-projected or every up/down throw lands wrong.
      this.aim = screenDirToWorldAngle(g.flickX, g.flickY);
      f.aim = this.aim;
      f.buttons |= Button.Throw;
      f.throwPower = g.flickPower;
      this.lastFlickPower = g.flickPower;
    } else if (this.keyboard.throwPressed) {
      f.buttons |= Button.Throw;
      f.throwPower = keyboardThrowPower(this.keyboard.throwHeldMs);
      this.lastFlickPower = f.throwPower;
    }

    if (g.place || this.keyboard.placePressed) f.buttons |= Button.Place;
    if (g.tap || this.keyboard.pickupPressed) f.buttons |= Button.Pickup;
    if (this.keyboard.buildPressed) f.buttons |= Button.Build;

    consumeEdges(this.keyboard);
    this.pendingThrowPower = 0;
    void this.pendingThrowPower;

    // The client validates its own frame too, so local prediction sees exactly
    // the numbers the host will see rather than a slightly different input.
    return validateInput(f);
  }

  /** Live power estimate for the aim preview while charging on desktop. */
  previewPower(): number {
    if (this.keyboard.throwDown) return keyboardThrowPower(this.keyboard.throwHeldMs);
    return 0.6;
  }
}
