/**
 * The 3/4 top-down projection.
 *
 * ============================ READ THIS FIRST ============================
 * DEPTH-SORT BY GROUND Y, NEVER BY SCREEN Y.
 *
 * A snowball 40 units in the air at ground y=100 must sort as if it were at
 * y=100, so it draws in front of a wall at y=90 and behind one at y=110 -- while
 * still being DRAWN higher up the screen. Sort by screenY instead and airborne
 * objects randomly vanish behind scenery that they are visually above. This is
 * the single easiest bug to introduce in a game with this camera, and it looks
 * like a rendering glitch rather than a sorting mistake.
 * =========================================================================
 *
 * World space is a ground plane (x, y) plus a height z. Screen space compresses
 * y and subtracts z:
 *
 *   screenX = (x - camX) * zoom
 *   screenY = (y * Y_SQUASH - z * Z_SCALE - camY) * zoom
 *   sortKey = y                     <-- ground y, always
 */

import { Y_SQUASH, Z_SCALE } from '@snow/shared';

export interface Camera {
  /** Camera centre in world coordinates. */
  x: number;
  y: number;
  zoom: number;
}

export interface Viewport {
  /** CSS pixel size of the canvas. */
  width: number;
  height: number;
}

/** World ground position + height -> screen pixels. */
export function worldToScreenX(x: number, cam: Camera, vp: Viewport): number {
  return (x - cam.x) * cam.zoom + vp.width * 0.5;
}

export function worldToScreenY(y: number, z: number, cam: Camera, vp: Viewport): number {
  return (y * Y_SQUASH - z * Z_SCALE - cam.y * Y_SQUASH) * cam.zoom + vp.height * 0.5;
}

/** Screen pixels -> world ground position, assuming z = 0. */
export function screenToWorldX(sx: number, cam: Camera, vp: Viewport): number {
  return (sx - vp.width * 0.5) / cam.zoom + cam.x;
}

export function screenToWorldY(sy: number, cam: Camera, vp: Viewport): number {
  return (sy - vp.height * 0.5) / cam.zoom / Y_SQUASH + cam.y;
}

/**
 * Convert a SCREEN-space direction into a WORLD-space direction.
 *
 * This is what a flick gesture needs, and getting it wrong is subtle: because
 * screen y is compressed by Y_SQUASH, a flick that looks like 45 degrees on
 * glass is a much steeper angle in the world. Dividing the y component by
 * Y_SQUASH undoes the compression. Skip this and every upward or downward throw
 * lands short or long while sideways throws feel fine -- which reads as "the
 * aiming is just bad" rather than as a projection bug.
 *
 * Returns the angle in radians. `dx`/`dy` need not be normalized.
 */
export function screenDirToWorldAngle(dx: number, dy: number): number {
  return Math.atan2(dy / Y_SQUASH, dx);
}

/** The inverse: a world-space angle to a screen-space direction, normalized. */
export function worldAngleToScreenDir(angle: number, out: { x: number; y: number }): void {
  const x = Math.cos(angle);
  const y = Math.sin(angle) * Y_SQUASH;
  const m = Math.hypot(x, y) || 1;
  out.x = x / m;
  out.y = y / m;
}

/** Is this world position anywhere near the visible area? */
export function isVisible(
  x: number,
  y: number,
  cam: Camera,
  vp: Viewport,
  margin = 120,
): boolean {
  const halfW = vp.width / (2 * cam.zoom) + margin;
  const halfH = vp.height / (2 * cam.zoom * Y_SQUASH) + margin;
  return Math.abs(x - cam.x) <= halfW && Math.abs(y - cam.y) <= halfH;
}
