/**
 * Left-thumb virtual joystick.
 *
 * Floating origin: the stick centres wherever the thumb lands rather than at a
 * fixed spot on screen. Fixed-position sticks require the player to look at
 * their thumb to find it, which in a game where the other thumb is doing precise
 * gesture work is a real cost.
 *
 * The knob is also allowed to drag its own centre when the thumb travels beyond
 * the ring, so sliding a thumb across the screen keeps steering instead of
 * saturating.
 */

export interface JoystickState {
  active: boolean;
  /** Origin in CSS pixels. */
  originX: number;
  originY: number;
  /** Current thumb position. */
  x: number;
  y: number;
  /** Output vector, each component in [-1, 1], magnitude <= 1. */
  outX: number;
  outY: number;
  pointerId: number;
}

/** Ring radius in CSS pixels, scaled for the viewport. */
export function joystickRadius(viewportMin: number): number {
  return Math.max(46, Math.min(96, viewportMin * 0.17));
}

/** Below this fraction of the radius, output is zero. Stops drift. */
const DEADZONE = 0.14;

export function createJoystick(): JoystickState {
  return {
    active: false,
    originX: 0,
    originY: 0,
    x: 0,
    y: 0,
    outX: 0,
    outY: 0,
    pointerId: -1,
  };
}

export function joystickDown(j: JoystickState, id: number, x: number, y: number): void {
  j.active = true;
  j.pointerId = id;
  j.originX = x;
  j.originY = y;
  j.x = x;
  j.y = y;
  j.outX = 0;
  j.outY = 0;
}

export function joystickMove(
  j: JoystickState,
  id: number,
  x: number,
  y: number,
  radius: number,
): void {
  if (!j.active || j.pointerId !== id) return;
  j.x = x;
  j.y = y;

  let dx = x - j.originX;
  let dy = y - j.originY;
  const dist = Math.hypot(dx, dy);

  // Drag the origin along once the thumb passes the ring, so long slides keep
  // producing full-tilt input in the new direction rather than pinning.
  if (dist > radius) {
    const pull = dist - radius;
    j.originX += (dx / dist) * pull;
    j.originY += (dy / dist) * pull;
    dx = x - j.originX;
    dy = y - j.originY;
  }

  const mag = Math.hypot(dx, dy) / radius;
  if (mag < DEADZONE) {
    j.outX = 0;
    j.outY = 0;
    return;
  }

  // Rescale so the output ramps from 0 at the deadzone edge to 1 at the ring,
  // instead of jumping to DEADZONE the instant you leave the centre.
  const scaled = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
  const m = Math.hypot(dx, dy) || 1;
  j.outX = (dx / m) * scaled;
  j.outY = (dy / m) * scaled;
}

export function joystickUp(j: JoystickState, id: number): void {
  if (j.pointerId !== id) return;
  j.active = false;
  j.pointerId = -1;
  j.outX = 0;
  j.outY = 0;
}
