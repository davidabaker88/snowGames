/**
 * Objective rendering: flags, capture zones, and the closing blizzard.
 *
 * Drawn generically from the World's objective arrays rather than per mode, which
 * is what lets a new mode ship without touching any drawing code -- a mode just
 * activates the objectives it wants.
 */

import {
  FlagState,
  TEAM_COLORS,
  TEAM_NONE,
  Y_SQUASH,
  clamp01,
  type Flag,
  type Ring,
  type World,
  type Zone,
} from '@snow/shared';
import { worldToScreenX, worldToScreenY, type Camera, type Viewport } from './projection.js';

function teamColor(team: number): string {
  return TEAM_COLORS[team] ?? '#c8d6e6';
}

/**
 * The blizzard, drawn as everything OUTSIDE the safe circle.
 *
 * Filling the outside rather than outlining the inside is deliberate: the danger
 * is the region you must not be in, and a thin outline reads as decoration whereas
 * a wall of white weather reads as "do not go there".
 */
export function drawRing(
  ctx: CanvasRenderingContext2D,
  ring: Ring,
  cam: Camera,
  vp: Viewport,
  time: number,
): void {
  if (!ring.active || ring.radius <= 0) return;

  const cx = worldToScreenX(ring.x, cam, vp);
  const cy = worldToScreenY(ring.y, 0, cam, vp);
  const rx = ring.radius * cam.zoom;
  const ry = ring.radius * cam.zoom * Y_SQUASH;

  ctx.save();

  // Everything outside the ellipse, via an even-odd fill.
  ctx.beginPath();
  ctx.rect(0, 0, vp.width, vp.height);
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(196,214,235,0.42)';
  ctx.fill('evenodd');

  // A pulsing edge, brighter while the ring is still closing, so the player can
  // tell "closing now" from "already closed" without reading the HUD.
  const closing = ring.radius > ring.targetRadius + 0.5;
  const pulse = closing ? 0.55 + 0.25 * Math.sin(time * 4) : 0.4;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
  ctx.lineWidth = Math.max(2, 4 * cam.zoom);
  ctx.stroke();

  if (closing) {
    // A dashed preview of where it is heading.
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy,
      ring.targetRadius * cam.zoom,
      ring.targetRadius * cam.zoom * Y_SQUASH,
      0,
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = Math.max(1, 2 * cam.zoom);
    ctx.stroke();
  }

  ctx.restore();
}

/** A capture zone: a tinted disc on the ground with a progress arc. */
export function drawZone(
  ctx: CanvasRenderingContext2D,
  z: Zone,
  cam: Camera,
  vp: Viewport,
  time: number,
): void {
  if (!z.active) return;

  const cx = worldToScreenX(z.x, cam, vp);
  const cy = worldToScreenY(z.y, 0, cam, vp);
  const rx = z.radius * cam.zoom;
  const ry = z.radius * cam.zoom * Y_SQUASH;

  ctx.save();

  const owned = z.owner !== TEAM_NONE;
  const base = owned ? teamColor(z.owner) : '#9fb3c8';

  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(base, owned ? 0.22 : 0.13);
  ctx.fill();
  ctx.strokeStyle = withAlpha(base, 0.75);
  ctx.lineWidth = Math.max(2, 3 * cam.zoom);
  ctx.stroke();

  // Capture progress as an arc in the contender's colour, so a zone being taken
  // is legible from across the arena without looking at the HUD.
  if (z.contender !== TEAM_NONE && z.progress > 0.01) {
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy,
      rx * 0.86,
      ry * 0.86,
      0,
      -Math.PI / 2,
      -Math.PI / 2 + clamp01(z.progress) * Math.PI * 2,
    );
    ctx.strokeStyle = teamColor(z.contender);
    ctx.lineWidth = Math.max(3, 5 * cam.zoom);
    ctx.stroke();
  }

  // Label on the ground.
  if (z.label) {
    ctx.font = `600 ${Math.round(11 * Math.max(1, cam.zoom))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = withAlpha(base, 0.9);
    ctx.fillText(z.label.toUpperCase(), cx, cy + ry * 0.55);
    ctx.textAlign = 'left';
  }

  void time;
  ctx.restore();
}

/**
 * A flag: pole, cloth, and a base ring when it is home.
 *
 * A dropped flag bobs and shows a countdown ring, because "this will return to
 * base soon" is information players act on -- it is the difference between chasing
 * it and giving up on it.
 */
export function drawFlag(
  ctx: CanvasRenderingContext2D,
  f: Flag,
  cam: Camera,
  vp: Viewport,
  time: number,
  totalReturnTicks: number,
): void {
  if (!f.active) return;
  if (f.state === FlagState.Carried) return; // drawn by the carrier

  const cx = worldToScreenX(f.x, cam, vp);
  const cy = worldToScreenY(f.y, 0, cam, vp);
  const color = teamColor(f.team);
  const z = cam.zoom;

  ctx.save();

  // Base ring, only at home, marking where a capture has to be delivered.
  if (f.state === FlagState.AtBase) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, 26 * z, 26 * z * Y_SQUASH, 0, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(color, 0.5);
    ctx.lineWidth = Math.max(1.5, 2 * z);
    ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const bob = f.state === FlagState.Dropped ? Math.sin(time * 3) * 2 * z : 0;
  drawPole(ctx, cx, cy + bob, z, color, time);

  if (f.state === FlagState.Dropped && totalReturnTicks > 0) {
    const frac = clamp01(f.returnTicks / totalReturnTicks);
    ctx.beginPath();
    ctx.arc(cx, cy - 2 * z, 13 * z, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = withAlpha(color, 0.85);
    ctx.lineWidth = Math.max(1.5, 2.5 * z);
    ctx.stroke();
  }

  ctx.restore();
}

/** A flag riding on its carrier's back. */
export function drawCarriedFlag(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  team: number,
  zoom: number,
  time: number,
): void {
  ctx.save();
  drawPole(ctx, screenX, screenY, zoom, teamColor(team), time);
  ctx.restore();
}

function drawPole(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  z: number,
  color: string,
  time: number,
): void {
  const h = 42 * z;
  ctx.strokeStyle = '#5b6a7c';
  ctx.lineWidth = Math.max(1.4, 2.2 * z);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - h);
  ctx.stroke();

  // Cloth, with a wave so it reads as fabric rather than a sign.
  const w = 20 * z;
  const wave = Math.sin(time * 5) * 2.2 * z;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h);
  ctx.quadraticCurveTo(cx + w * 0.55, cy - h + 3 * z + wave, cx + w, cy - h + 6 * z);
  ctx.lineTo(cx + w, cy - h + 17 * z);
  ctx.quadraticCurveTo(cx + w * 0.55, cy - h + 15 * z - wave, cx, cy - h + 13 * z);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,32,48,0.35)';
  ctx.lineWidth = Math.max(0.6, 1 * z);
  ctx.stroke();
}

/** Hex colour plus alpha, without needing a colour library. */
function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Off-screen objective arrows.
 *
 * Without these, "someone is running off with your flag" is invisible the moment
 * they leave the viewport, which in a mode built around chasing a carrier is most
 * of the time.
 */
export function drawObjectiveMarkers(
  ctx: CanvasRenderingContext2D,
  w: World,
  cam: Camera,
  vp: Viewport,
): void {
  const margin = 34;

  for (const f of w.flags) {
    if (!f.active) continue;
    const sx = worldToScreenX(f.x, cam, vp);
    const sy = worldToScreenY(f.y, 0, cam, vp);
    if (sx > margin && sx < vp.width - margin && sy > margin && sy < vp.height - margin) continue;

    const cx = Math.max(margin, Math.min(vp.width - margin, sx));
    const cy = Math.max(margin, Math.min(vp.height - margin, sy));
    const angle = Math.atan2(sy - vp.height / 2, sx - vp.width / 2);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-7, 7);
    ctx.lineTo(-7, -7);
    ctx.closePath();
    ctx.fillStyle = teamColor(f.team);
    ctx.fill();
    ctx.strokeStyle = 'rgba(15,27,42,0.5)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }
}
