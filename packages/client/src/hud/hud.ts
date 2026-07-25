/**
 * The HUD, drawn on the canvas above the world.
 *
 * Canvas rather than DOM for the parts that track a thumb (the joystick ring and
 * the pack progress ring): those update every frame and follow a moving finger,
 * where DOM would mean per-frame style writes and layout. Static text panels are
 * plain DOM in index.html territory.
 *
 * Safe-area insets matter here -- with `viewport-fit=cover` the canvas extends
 * under the notch and the home indicator, so anything anchored to an edge needs
 * padding or it ends up unreachable.
 */

import { PACK_ROTATIONS_REQUIRED, clamp01 } from '@snow/shared';
import { joystickRadius, type JoystickState } from '../input/joystick.js';
import type { GestureRecognizer } from '../input/gestureRecognizer.js';
import type { Viewport } from '../render/projection.js';

export interface HudModel {
  vp: Viewport;
  joystick: JoystickState;
  gestures: GestureRecognizer;
  /** Packing progress from the simulation, in rotations. */
  packProgress: number;
  holdingBall: boolean;
  ballInReach: boolean;
  hp: number;
  maxHp: number;
  alive: boolean;
  skinLabel: string;
  fps: number;
  showDebug: boolean;
  hint: string;
  /** Space reserved at the bottom of the screen, e.g. by the debug overlay. */
  bottomInset: number;
}

export function drawHud(ctx: CanvasRenderingContext2D, m: HudModel): void {
  drawJoystick(ctx, m);
  drawPackRing(ctx, m);
  drawStatus(ctx, m);
  if (m.hint) drawHint(ctx, m);
  // Only nag in portrait, and not while a hint is already occupying that spot.
  if (!m.hint && m.vp.height > m.vp.width * 1.15) drawRotatePrompt(ctx, m);
}

/**
 * Suggest landscape on a portrait phone.
 *
 * Not cosmetic pickiness. Because the 3/4 projection compresses world depth to
 * 0.6, a tall screen shows an enormous amount of ground depth for its width --
 * a portrait phone would need an arena roughly 1700 units deep to fill, against
 * 470 wide. Landscape both fills the view properly and puts the two thumbs in
 * the bottom corners where they belong. Play is still allowed in portrait; this
 * only nudges.
 */
function drawRotatePrompt(ctx: CanvasRenderingContext2D, m: HudModel): void {
  const text = 'Turn your phone sideways to play';
  ctx.save();
  ctx.font = '600 12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 26;
  const x = m.vp.width / 2;
  const y = m.vp.height - 26 - safeAreaBottom() - m.bottomInset;
  ctx.fillStyle = 'rgba(15,27,42,0.66)';
  roundRect(ctx, x - w / 2, y - 13, w, 26, 13);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawJoystick(ctx: CanvasRenderingContext2D, m: HudModel): void {
  const j = m.joystick;
  if (!j.active) return;
  const r = joystickRadius(Math.min(m.vp.width, m.vp.height));

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.fillStyle = 'rgba(30,50,75,0.16)';
  ctx.beginPath();
  ctx.arc(j.originX, j.originY, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Knob at the clamped output position, not the raw thumb position, so the
  // visual matches what the game is actually being told.
  const kx = j.originX + j.outX * r;
  const ky = j.originY + j.outY * r;
  ctx.beginPath();
  ctx.arc(kx, ky, r * 0.36, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,70,105,0.55)';
  ctx.stroke();
  ctx.restore();
}

/**
 * The pack progress ring, drawn around the circling thumb.
 *
 * Feedback here is not decoration: circling is an unusual verb and a player needs
 * to see that the motion is registering, and how much more is needed. Without it
 * the mechanic feels broken even when it works.
 */
function drawPackRing(ctx: CanvasRenderingContext2D, m: HudModel): void {
  const g = m.gestures;
  const progress = clamp01(m.packProgress / PACK_ROTATIONS_REQUIRED);
  const showAtThumb = g.circleActive || g.longPressProgress > 0.02;

  if (!showAtThumb && progress <= 0.001) return;

  const vpMin = Math.min(m.vp.width, m.vp.height);
  const r = Math.max(34, vpMin * 0.11);
  const cx = showAtThumb ? g.currentX : m.vp.width * 0.78;
  const cy = showAtThumb ? g.currentY : m.vp.height * 0.62;

  ctx.save();
  ctx.lineWidth = Math.max(4, r * 0.16);
  ctx.lineCap = 'round';

  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  if (progress > 0.001) {
    ctx.strokeStyle = progress >= 1 ? '#7ee08f' : '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
  }

  // Long-press ring, drawn inside, filling toward the place action.
  if (g.longPressProgress > 0.02) {
    ctx.strokeStyle = 'rgba(255,205,120,0.9)';
    ctx.lineWidth = Math.max(3, r * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.66, -Math.PI / 2, -Math.PI / 2 + g.longPressProgress * Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawStatus(ctx: CanvasRenderingContext2D, m: HudModel): void {
  const pad = 14;
  // Respect the notch / status bar.
  const top = pad + safeAreaTop();

  ctx.save();
  ctx.font = '600 13px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'top';

  // Scrim behind the HUD. The world is bright snow, so white text on it is close
  // to invisible -- this is legibility, not decoration. A soft gradient rather
  // than a hard panel so it does not read as a letterboxed bar.
  const scrimH = top + 92;
  const scrim = ctx.createLinearGradient(0, 0, 0, scrimH);
  scrim.addColorStop(0, 'rgba(11,22,36,0.55)');
  scrim.addColorStop(0.65, 'rgba(11,22,36,0.22)');
  scrim.addColorStop(1, 'rgba(11,22,36,0)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, m.vp.width, scrimH);

  // Health bar.
  const bw = Math.min(190, m.vp.width * 0.42);
  const bh = 11;
  ctx.fillStyle = 'rgba(15,27,42,0.5)';
  roundRect(ctx, pad, top, bw, bh, 5);
  ctx.fill();
  const frac = clamp01(m.hp / m.maxHp);
  ctx.fillStyle = frac > 0.5 ? '#6ddf8f' : frac > 0.22 ? '#ffcd6f' : '#ef6a52';
  roundRect(ctx, pad, top, Math.max(2, bw * frac), bh, 5);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(m.alive ? `${Math.ceil(m.hp)} HP` : 'OUT', pad, top + bh + 6);

  // Held-ball indicator.
  const iconY = top + bh + 26;
  if (m.holdingBall) {
    ctx.beginPath();
    ctx.arc(pad + 9, iconY + 9, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,150,185,0.9)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('flick to throw', pad + 24, iconY + 2);
  } else if (m.ballInReach) {
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(pad + 9, iconY + 9, 9, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('tap to pick up', pad + 24, iconY + 2);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText('circle to pack a snowball', pad, iconY + 2);
  }

  // Top-right corner info.
  ctx.textAlign = 'right';
  const rx = m.vp.width - pad;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(m.skinLabel, rx, top);
  if (m.showDebug) {
    ctx.fillText(`${Math.round(m.fps)} fps`, rx, top + 18);
  }
  ctx.textAlign = 'left';
  ctx.restore();
}

/**
 * The instructional hint.
 *
 * Placed at the TOP, under the status block, rather than at the bottom: the
 * bottom of the screen is where both thumbs live and where the debug overlay
 * sits, so a hint down there is simultaneously covered by a hand and overlapping
 * other text. Long hints wrap rather than running off both edges.
 */
function drawHint(ctx: CanvasRenderingContext2D, m: HudModel): void {
  ctx.save();
  ctx.font = '500 13px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const maxW = m.vp.width - 40;
  const lines = wrapText(ctx, m.hint, maxW);
  const lineH = 17;
  const boxW = Math.min(
    maxW + 20,
    Math.max(...lines.map((l) => ctx.measureText(l).width)) + 22,
  );
  const boxH = lines.length * lineH + 10;
  const x = m.vp.width / 2;
  // Bottom centre: clear of both thumbs, and clear of the player, who is at the
  // middle of the screen. Lifted by `bottomInset` so the debug overlay can claim
  // the very bottom without the two stacking on top of each other.
  const y = m.vp.height - boxH - 16 - safeAreaBottom() - m.bottomInset;

  ctx.fillStyle = 'rgba(15,27,42,0.62)';
  roundRect(ctx, x - boxW / 2, y, boxW, boxH, 9);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  lines.forEach((l, i) => ctx.fillText(l, x, y + 6 + i * lineH));
  ctx.restore();
}

/** Greedy word wrap. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Safe-area insets. Read from a CSS variable set on the body, because
 * `env(safe-area-inset-*)` is not readable from JS directly.
 */
function cssPx(name: string): number {
  const v = getComputedStyle(document.body).getPropertyValue(name);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function safeAreaTop(): number {
  return cssPx('--sat');
}

function safeAreaBottom(): number {
  return cssPx('--sab');
}
