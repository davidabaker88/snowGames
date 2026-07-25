/**
 * The trajectory preview.
 *
 * This is the main teaching tool for the arc: because power is derived from flick
 * speed, players need to see what a given power will do before they commit. It
 * simulates the ball's path with the same constants the simulation uses -- if
 * these ever drift apart the preview becomes a lie, so both read constants.ts.
 *
 * It also marks where the path is blocked, which is how a player learns that a
 * hard flat throw hits the tree instead of the person behind it.
 */

import {
  GRAVITY,
  AIR_DRAG,
  LOB_RATIO,
  PLAYER_RADIUS,
  THROW_MAX_SPEED,
  THROW_MIN_SPEED,
  THROW_RELEASE_HEIGHT,
  TICK_DT,
  Y_SQUASH,
  clamp01,
  lerp,
  tileAtWorld,
  wallHeightAt,
  type Player,
  type World,
} from '@snow/shared';
import { worldToScreenX, worldToScreenY, type Camera, type Viewport } from './projection.js';

const MAX_STEPS = 90;

export function drawAimPreview(
  ctx: CanvasRenderingContext2D,
  w: World,
  p: Player,
  aim: number,
  power: number,
  cam: Camera,
  vp: Viewport,
): void {
  const speed = lerp(THROW_MIN_SPEED, THROW_MAX_SPEED, clamp01(power));

  const off = PLAYER_RADIUS + 9;
  let x = p.x + Math.cos(aim) * off;
  let y = p.y + Math.sin(aim) * off * Y_SQUASH;
  let z = THROW_RELEASE_HEIGHT;
  let vx = Math.cos(aim) * speed;
  let vy = Math.sin(aim) * speed * Y_SQUASH;
  let vz = speed * LOB_RATIO;

  let blockedX = 0;
  let blockedY = 0;
  let blocked = false;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(40,70,105,0.4)';
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(worldToScreenX(x, cam, vp), worldToScreenY(y, z, cam, vp));

  for (let i = 0; i < MAX_STEPS; i++) {
    const drag = 1 - AIR_DRAG * TICK_DT;
    vx *= drag;
    vy *= drag;
    vz = vz * drag - GRAVITY * TICK_DT;
    x += vx * TICK_DT;
    y += vy * TICK_DT;
    z += vz * TICK_DT;

    if (z <= 0) {
      z = 0;
      ctx.lineTo(worldToScreenX(x, cam, vp), worldToScreenY(y, 0, cam, vp));
      break;
    }

    // The same height test the simulation uses, for walls and props alike. It has
    // to be the same test or the preview becomes a lie: a dotted line that sails
    // over a wall the real throw smacks into is worse than no preview.
    const tile = tileAtWorld(w.walls, x, y);
    const blockedByWall =
      tile >= 0 && w.walls.tier[tile]! > 0 && z < wallHeightAt(w.walls, tile);

    let hitProp = false;
    if (!blockedByWall) {
      for (const prop of w.props) {
        if (prop.radius <= 0 || z > prop.height) continue;
        const dx = x - prop.x;
        const dy = y - prop.y;
        const rr = prop.radius + 7;
        if (dx * dx + dy * dy <= rr * rr) {
          hitProp = true;
          break;
        }
      }
    }

    if (blockedByWall || hitProp) {
      blocked = true;
      blockedX = worldToScreenX(x, cam, vp);
      blockedY = worldToScreenY(y, z, cam, vp);
      ctx.lineTo(blockedX, blockedY);
      break;
    }

    // Out of the arena.
    if (x < w.bounds.minX || x > w.bounds.maxX || y < w.bounds.minY || y > w.bounds.maxY) {
      ctx.lineTo(worldToScreenX(x, cam, vp), worldToScreenY(y, z, cam, vp));
      break;
    }

    if (i % 2 === 0) {
      ctx.lineTo(worldToScreenX(x, cam, vp), worldToScreenY(y, z, cam, vp));
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Landing marker, or a blocked marker.
  const mx = blocked ? blockedX : worldToScreenX(x, cam, vp);
  const my = blocked ? blockedY : worldToScreenY(y, 0, cam, vp);

  if (blocked) {
    ctx.strokeStyle = '#e2603f';
    ctx.lineWidth = 2.5;
    const s = 6 * cam.zoom;
    ctx.beginPath();
    ctx.moveTo(mx - s, my - s);
    ctx.lineTo(mx + s, my + s);
    ctx.moveTo(mx + s, my - s);
    ctx.lineTo(mx - s, my + s);
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(40,70,105,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(mx, my, 9 * cam.zoom, 9 * cam.zoom * Y_SQUASH, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}
