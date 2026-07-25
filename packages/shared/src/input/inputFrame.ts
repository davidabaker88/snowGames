/**
 * The client -> host input contract.
 *
 * The client sends INTENT, never state. No positions, no velocities, no "I hit
 * that player". Everything here is a small, bounded number that the host
 * validates before it touches the world.
 */

import { clamp, clamp01, wrapPi } from '../math/angle.js';
import { MAX_PACK_ROTATIONS_PER_SEC, TICK_DT } from '../constants.js';

export const enum Button {
  None = 0,
  Throw = 1 << 0,
  Place = 1 << 1,
  Pickup = 1 << 2,
  Build = 1 << 3,
  Ready = 1 << 4,
}

export interface InputFrame {
  /** Monotonic per-client sequence number, used for acks and replay. */
  seq: number;
  /** Movement intent in screen-relative space, each axis in [-1, 1]. */
  moveX: number;
  moveY: number;
  /** Aim direction in WORLD space, radians. The client has already undone the
   *  3/4 projection before this point. */
  aim: number;
  /** Bitfield of edge-triggered actions for this tick. */
  buttons: number;
  /** Throw power in [0, 1], derived from flick speed. Only read with Button.Throw. */
  throwPower: number;
  /**
   * Rotations of packing progress claimed for this tick.
   *
   * This is the ONLY field carrying raw gesture data into the simulation, which
   * makes it the one obvious cheat vector -- an unclamped client could claim
   * 1000 rotations and pack instantly. `validateInput` caps it.
   */
  packDelta: number;
}

export function createInputFrame(): InputFrame {
  return { seq: 0, moveX: 0, moveY: 0, aim: 0, buttons: 0, throwPower: 0, packDelta: 0 };
}

export function resetInputFrame(f: InputFrame): InputFrame {
  f.moveX = 0;
  f.moveY = 0;
  f.buttons = 0;
  f.throwPower = 0;
  f.packDelta = 0;
  return f;
}

export function copyInputFrame(dst: InputFrame, src: InputFrame): InputFrame {
  dst.seq = src.seq;
  dst.moveX = src.moveX;
  dst.moveY = src.moveY;
  dst.aim = src.aim;
  dst.buttons = src.buttons;
  dst.throwPower = src.throwPower;
  dst.packDelta = src.packDelta;
  return dst;
}

export function hasButton(f: InputFrame, b: Button): boolean {
  return (f.buttons & b) !== 0;
}

/**
 * Clamp an incoming frame into a legal range, in place.
 *
 * Note this CLAMPS rather than REJECTS. Rejecting a frame would desynchronise a
 * legitimate client whose clock has drifted slightly, which is a far more common
 * situation than cheating; clamping degrades gracefully for both.
 */
export function validateInput(f: InputFrame): InputFrame {
  // Clamp the movement vector's magnitude rather than each axis, or a diagonal
  // gets a free sqrt(2) speed bonus.
  const m2 = f.moveX * f.moveX + f.moveY * f.moveY;
  if (m2 > 1) {
    const s = 1 / Math.sqrt(m2);
    f.moveX *= s;
    f.moveY *= s;
  }
  if (!Number.isFinite(f.moveX)) f.moveX = 0;
  if (!Number.isFinite(f.moveY)) f.moveY = 0;

  f.aim = Number.isFinite(f.aim) ? wrapPi(f.aim) : 0;
  f.throwPower = Number.isFinite(f.throwPower) ? clamp01(f.throwPower) : 0;

  const maxPack = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
  f.packDelta = Number.isFinite(f.packDelta) ? clamp(f.packDelta, 0, maxPack) : 0;

  f.buttons |= 0;
  return f;
}
