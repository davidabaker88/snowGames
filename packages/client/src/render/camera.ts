/**
 * Camera follow.
 *
 * Dead-zone rectangle plus critically damped smoothing: the camera ignores small
 * movements entirely (so strafing and jitter do not swim the whole screen) and
 * eases toward the target once the player leaves the box.
 */

import {
  CAMERA_DEADZONE_X,
  CAMERA_DEADZONE_Y,
  CAMERA_HALF_LIFE,
  TARGET_WORLD_WIDTH,
  Y_SQUASH,
  ZOOM_MAX,
  ZOOM_MIN,
  clamp,
  decayFactor,
} from '@snow/shared';
import type { Camera, Viewport } from './projection.js';
import type { WorldBounds } from '@snow/shared';

export function createCamera(): Camera {
  return { x: 0, y: 0, zoom: 1 };
}

/**
 * Zoom so that every device sees a comparable slice of the arena. Without this a
 * phone in portrait sees a keyhole while a desktop sees the whole map, and the
 * two are effectively different games.
 */
export function updateZoom(cam: Camera, vp: Viewport): void {
  cam.zoom = clamp(vp.width / TARGET_WORLD_WIDTH, ZOOM_MIN, ZOOM_MAX);
}

export function snapCamera(cam: Camera, x: number, y: number): void {
  cam.x = x;
  cam.y = y;
}

export function followCamera(
  cam: Camera,
  targetX: number,
  targetY: number,
  dt: number,
  vp: Viewport,
  bounds: WorldBounds,
): void {
  // Only chase the part of the offset that exceeds the dead zone.
  const dx = targetX - cam.x;
  const dy = targetY - cam.y;
  let wantX = cam.x;
  let wantY = cam.y;
  if (Math.abs(dx) > CAMERA_DEADZONE_X) {
    wantX = targetX - Math.sign(dx) * CAMERA_DEADZONE_X;
  }
  if (Math.abs(dy) > CAMERA_DEADZONE_Y) {
    wantY = targetY - Math.sign(dy) * CAMERA_DEADZONE_Y;
  }

  const k = 1 - decayFactor(CAMERA_HALF_LIFE, dt);
  cam.x += (wantX - cam.x) * k;
  cam.y += (wantY - cam.y) * k;

  clampCameraToBounds(cam, vp, bounds);
}

/**
 * Keep the view inside the map. When the map is narrower than the viewport,
 * centre it rather than clamping to an edge -- otherwise a small arena sticks to
 * one side of the screen.
 */
export function clampCameraToBounds(cam: Camera, vp: Viewport, bounds: WorldBounds): void {
  const halfW = vp.width / (2 * cam.zoom);
  const halfH = vp.height / (2 * cam.zoom * Y_SQUASH);

  const worldW = bounds.maxX - bounds.minX;
  const worldH = bounds.maxY - bounds.minY;

  if (worldW <= halfW * 2) {
    cam.x = (bounds.minX + bounds.maxX) * 0.5;
  } else {
    cam.x = clamp(cam.x, bounds.minX + halfW, bounds.maxX - halfW);
  }

  if (worldH <= halfH * 2) {
    cam.y = (bounds.minY + bounds.maxY) * 0.5;
  } else {
    cam.y = clamp(cam.y, bounds.minY + halfH, bounds.maxY - halfH);
  }
}
