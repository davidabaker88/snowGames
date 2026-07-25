/**
 * The five drawing primitives, implemented exactly once.
 *
 * This file must not grow when a new creature is added -- that is the deal made
 * in skinTypes.ts. Each primitive draws in BONE-LOCAL 2D space: the caller has
 * already translated to the bone's origin and rotated so that +y runs along the
 * bone toward its tip.
 */

import type { ShapeDef } from '@snow/shared';

/**
 * Draw one primitive in bone-local space.
 *
 * `foreshorten` compresses distances ALONG the bone as it rotates away from the
 * camera. It is applied per-primitive rather than as a blanket `ctx.scale`,
 * because those are not the same thing: squashing the whole local space also
 * squashes a head into an egg every time the character turns to face away. A
 * circle's POSITION along the bone should foreshorten; its radius should not.
 */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: ShapeDef,
  length: number,
  scale: number,
  foreshorten = 1,
): void {
  switch (shape.kind) {
    case 'line':
      drawLine(ctx, shape, length, scale, foreshorten);
      break;
    case 'capsule':
      drawCapsule(ctx, shape, length, scale, foreshorten);
      break;
    case 'circle':
      drawCircle(ctx, shape, scale, foreshorten);
      break;
    case 'ellipse':
      drawEllipse(ctx, shape, scale, foreshorten);
      break;
    case 'poly':
      drawPoly(ctx, shape, scale, foreshorten);
      break;
  }
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  s: Extract<ShapeDef, { kind: 'line' }>,
  length: number,
  scale: number,
  fs: number,
): void {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, length * scale * fs);
  ctx.strokeStyle = s.color;
  // Width is across the bone, so it must NOT foreshorten -- a limb seen
  // end-on gets shorter, not thinner.
  ctx.lineWidth = Math.max(0.6, s.w * scale);
  ctx.lineCap = s.cap ?? 'round';
  ctx.stroke();
}

/**
 * A tapering rounded bar. Drawn as an explicit outline rather than a thick line
 * so the taper is possible at all -- canvas line widths are constant.
 */
function drawCapsule(
  ctx: CanvasRenderingContext2D,
  s: Extract<ShapeDef, { kind: 'capsule' }>,
  length: number,
  scale: number,
  fs: number,
): void {
  const L = length * scale * fs;
  const w0 = (s.w * scale) / 2;
  const w1 = w0 * (s.taper ?? 1);

  ctx.beginPath();
  ctx.arc(0, 0, w0, 0, Math.PI * 2);
  ctx.moveTo(-w0, 0);
  ctx.lineTo(-w1, L);
  ctx.lineTo(w1, L);
  ctx.lineTo(w0, 0);
  ctx.closePath();
  ctx.moveTo(w1, L);
  ctx.arc(0, L, w1, 0, Math.PI * 2);

  ctx.fillStyle = s.color;
  ctx.fill();
  if (s.outline) {
    ctx.strokeStyle = s.outline;
    ctx.lineWidth = Math.max(0.5, 0.9 * scale);
    ctx.stroke();
  }
}

function drawCircle(
  ctx: CanvasRenderingContext2D,
  s: Extract<ShapeDef, { kind: 'circle' }>,
  scale: number,
  fs: number,
): void {
  // Position foreshortens, radius does not: a head stays round at every facing.
  ctx.beginPath();
  ctx.arc(
    (s.cx ?? 0) * scale,
    (s.cy ?? 0) * scale * fs,
    Math.max(0.5, s.r * scale),
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = s.color;
  ctx.fill();
  if (s.outline) {
    ctx.strokeStyle = s.outline;
    ctx.lineWidth = Math.max(0.5, 1 * scale);
    ctx.stroke();
  }
}

function drawEllipse(
  ctx: CanvasRenderingContext2D,
  s: Extract<ShapeDef, { kind: 'ellipse' }>,
  scale: number,
  fs: number,
): void {
  // A body ellipse squashes along the bone as it turns, which is correct -- but
  // only partly, or a chicken viewed head-on becomes a pancake. Half-strength
  // reads as volume rather than as a flat cutout.
  const half = 0.5 + 0.5 * fs;
  ctx.beginPath();
  ctx.ellipse(
    (s.cx ?? 0) * scale,
    (s.cy ?? 0) * scale * fs,
    Math.max(0.5, s.rx * scale),
    Math.max(0.5, s.ry * scale * half),
    s.rot ?? 0,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = s.color;
  ctx.fill();
  if (s.outline) {
    ctx.strokeStyle = s.outline;
    ctx.lineWidth = Math.max(0.5, 1 * scale);
    ctx.stroke();
  }
}

function drawPoly(
  ctx: CanvasRenderingContext2D,
  s: Extract<ShapeDef, { kind: 'poly' }>,
  scale: number,
  fs: number,
): void {
  if (s.pts.length < 2) return;
  ctx.beginPath();
  const first = s.pts[0]!;
  ctx.moveTo(first[0] * scale, first[1] * scale * fs);
  for (let i = 1; i < s.pts.length; i++) {
    const p = s.pts[i]!;
    ctx.lineTo(p[0] * scale, p[1] * scale * fs);
  }
  ctx.closePath();
  ctx.fillStyle = s.color;
  ctx.fill();
  if (s.outline) {
    ctx.strokeStyle = s.outline;
    ctx.lineWidth = Math.max(0.5, 1 * scale);
    ctx.stroke();
  }
}
