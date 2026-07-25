/**
 * Desktop controls.
 *
 * Not an afterthought: this is how the game gets tested in headless Chromium, and
 * how anyone plays it on a laptop. Two deliberate choices:
 *
 *  - Packing with `J` uses a FIXED rate rather than reading a gesture, so tests
 *    are deterministic.
 *  - A circular MOUSE DRAG on the right half still feeds the real gesture
 *    recognizer, so the circle-detection maths itself is exercised on desktop
 *    rather than being bypassed by a shortcut.
 */

import { DEBUG_PACK_ROTATIONS_PER_SEC } from '@snow/shared';

export interface KeyboardState {
  moveX: number;
  moveY: number;
  packing: boolean;
  /** Edge-triggered, consumed once read. */
  throwPressed: boolean;
  placePressed: boolean;
  pickupPressed: boolean;
  buildPressed: boolean;
  cycleSkinPressed: boolean;
  /** How long the throw key has been held, for hold-to-charge power. */
  throwHeldMs: number;
  throwDown: boolean;
  /** Mouse position in CSS pixels, or null if the mouse has not moved yet. */
  mouseX: number | null;
  mouseY: number | null;
}

const HELD = new Set<string>();

export function createKeyboardState(): KeyboardState {
  return {
    moveX: 0,
    moveY: 0,
    packing: false,
    throwPressed: false,
    placePressed: false,
    pickupPressed: false,
    buildPressed: false,
    cycleSkinPressed: false,
    throwHeldMs: 0,
    throwDown: false,
    mouseX: null,
    mouseY: null,
  };
}

/** Hold duration mapped to throw power: a tap is a lob, half a second is max. */
export const THROW_CHARGE_MIN_POWER = 0.35;
export const THROW_CHARGE_FULL_MS = 500;

export function keyboardThrowPower(heldMs: number): number {
  const t = Math.min(1, heldMs / THROW_CHARGE_FULL_MS);
  return THROW_CHARGE_MIN_POWER + (1 - THROW_CHARGE_MIN_POWER) * t;
}

export function attachKeyboard(state: KeyboardState, target: HTMLElement): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) {
      // Still track held-ness, but do not re-fire edge actions.
      HELD.add(e.code);
      return;
    }
    HELD.add(e.code);
    switch (e.code) {
      case 'Space':
        state.throwDown = true;
        state.throwHeldMs = 0;
        e.preventDefault();
        break;
      case 'KeyQ':
        state.placePressed = true;
        break;
      case 'KeyE':
        state.pickupPressed = true;
        break;
      case 'KeyB':
        state.buildPressed = true;
        break;
      case 'KeyK':
        state.cycleSkinPressed = true;
        break;
      default:
        break;
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    HELD.delete(e.code);
    if (e.code === 'Space' && state.throwDown) {
      state.throwDown = false;
      state.throwPressed = true;
    }
  };

  const onMouseMove = (e: MouseEvent): void => {
    const rect = target.getBoundingClientRect();
    state.mouseX = e.clientX - rect.left;
    state.mouseY = e.clientY - rect.top;
  };

  const onBlur = (): void => {
    HELD.clear();
    state.throwDown = false;
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  target.addEventListener('mousemove', onMouseMove);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    target.removeEventListener('mousemove', onMouseMove);
  };
}

/** Fold held keys into the movement vector and packing flag. */
export function updateKeyboard(state: KeyboardState, dtMs: number): void {
  let x = 0;
  let y = 0;
  if (HELD.has('KeyA') || HELD.has('ArrowLeft')) x -= 1;
  if (HELD.has('KeyD') || HELD.has('ArrowRight')) x += 1;
  if (HELD.has('KeyW') || HELD.has('ArrowUp')) y -= 1;
  if (HELD.has('KeyS') || HELD.has('ArrowDown')) y += 1;

  // Normalize so diagonals are not faster.
  const m = Math.hypot(x, y);
  state.moveX = m > 0 ? x / m : 0;
  state.moveY = m > 0 ? y / m : 0;

  state.packing = HELD.has('KeyJ');
  if (state.throwDown) state.throwHeldMs += dtMs;
}

export function keyboardPackDelta(state: KeyboardState, dtSec: number): number {
  return state.packing ? DEBUG_PACK_ROTATIONS_PER_SEC * dtSec : 0;
}

export function consumeEdges(state: KeyboardState): void {
  state.throwPressed = false;
  state.placePressed = false;
  state.pickupPressed = false;
  state.buildPressed = false;
  state.cycleSkinPressed = false;
}

export function isKeyHeld(code: string): boolean {
  return HELD.has(code);
}
