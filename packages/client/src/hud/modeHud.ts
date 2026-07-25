/**
 * Mode HUD.
 *
 * Reads the pure-data `ModeHud` a mode fills in, so no mode ever writes drawing
 * code and a new mode gets a working HUD for free. If a mode ever needs a widget
 * this cannot express, that is the moment to extend `ModeHud` -- not to let the
 * mode reach for a canvas.
 */

import {
  MatchPhase,
  TEAM_COLORS,
  TEAM_NONE,
  clamp01,
  formatClock,
  type ModeHud,
  type World,
} from '@snow/shared';
import type { Viewport } from '../render/projection.js';

export interface ModeHudOpts {
  vp: Viewport;
  model: ModeHud;
  world: World;
  viewer: number;
  /** Vertical offset so this sits below the health block. */
  top: number;
}

export function drawModeHud(ctx: CanvasRenderingContext2D, o: ModeHudOpts): void {
  const { vp, model, world: w } = o;
  if (!model.title) return;

  // Once the match is over the banner is the only thing worth reading, so the
  // live readouts stop. Leaving them up means "1 alive" and "You are out --
  // watching" arguing with "Bot 2 wins" on the same screen, and a player has to
  // work out which of the three is still true.
  if (w.match.phase === MatchPhase.Ended) {
    drawEndBanner(ctx, o);
    return;
  }

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const cx = vp.width / 2;
  let y = o.top;

  // ---- score / headline ---------------------------------------------------
  if (model.teamScores.length >= 2) {
    drawTeamScores(ctx, cx, y, model, w);
    y += 30;
  } else if (model.headline) {
    ctx.font = '700 20px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(model.headline, cx, y);
    y += 24;
  }

  // ---- supporting line ----------------------------------------------------
  if (model.sub) {
    ctx.font = '600 12px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(model.sub, cx, y);
  }

  ctx.restore();

  if (w.match.phase === MatchPhase.Warmup) drawWarmupBanner(ctx, o);
}

/** Two team chips with a dash between, tinted to match the team rings in-world. */
function drawTeamScores(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  model: ModeHud,
  w: World,
): void {
  const me = w.players[0];
  const myTeam = me?.team ?? TEAM_NONE;

  const chipW = 46;
  const chipH = 24;
  const gap = 16;

  for (let t = 0; t < 2; t++) {
    const x = t === 0 ? cx - gap / 2 - chipW : cx + gap / 2;
    const color = TEAM_COLORS[t] ?? '#8fa6c0';

    ctx.fillStyle = withAlpha(color, 0.85);
    roundRect(ctx, x, y, chipW, chipH, 6);
    ctx.fill();

    // Your own team gets an outline, so you never have to remember which you are.
    if (t === myTeam) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, chipW, chipH, 6);
      ctx.stroke();
    }

    ctx.font = '700 15px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#0e1b2a';
    ctx.textAlign = 'center';
    ctx.fillText(String(model.teamScores[t] ?? 0), x + chipW / 2, y + 4);
  }
}

/**
 * The warm-up banner.
 *
 * A mode may put its own text in `ModeHud.banner` -- Fort Defense says which team
 * is allowed to build -- and it replaces the generic countdown rather than
 * stacking with it. Two clocks a few pixels apart is worse than either alone.
 */
function drawWarmupBanner(ctx: CanvasRenderingContext2D, o: ModeHudOpts): void {
  const { vp, world: w } = o;
  const remaining = w.mode.config.warmupTicks - w.match.phaseTicks;
  if (remaining <= 0) return;

  const text = o.model.banner || `Get ready -- ${formatClock(remaining)}`;
  ctx.save();
  ctx.font = '700 16px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const wide = ctx.measureText(text).width + 30;
  // Kept below the top block rather than at a fixed fraction of the height. On a
  // 390px-tall landscape phone 0.3 lands exactly on the mode HUD's sub line.
  const y = Math.max(vp.height * 0.3, o.top + 56);
  ctx.fillStyle = 'rgba(15,27,42,0.62)';
  roundRect(ctx, vp.width / 2 - wide / 2, y - 17, wide, 34, 17);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(text, vp.width / 2, y);
  ctx.restore();
}

/**
 * The result banner.
 *
 * Names the winner AND the reason, because "Blue wins" alone leaves players
 * arguing about whether it was the score or the clock.
 */
function drawEndBanner(ctx: CanvasRenderingContext2D, o: ModeHudOpts): void {
  const { vp, world: w } = o;
  const m = w.match;

  let headline: string;
  let tint = '#e9f1fa';
  if (m.winnerTeam !== TEAM_NONE) {
    headline = `${['Blue', 'Red', 'Green', 'Yellow'][m.winnerTeam] ?? 'Team'} team wins`;
    tint = TEAM_COLORS[m.winnerTeam] ?? tint;
  } else if (m.winnerPlayer >= 0) {
    const p = w.players[m.winnerPlayer];
    headline = p?.id === o.viewer ? 'You win!' : `${p?.name ?? 'Someone'} wins`;
  } else {
    headline = 'Draw';
  }

  // Fade in, so the end of a match lands rather than snapping.
  const fade = clamp01(m.phaseTicks / 12);

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.textAlign = 'center';

  const cy = vp.height * 0.42;
  const boxW = Math.min(vp.width - 40, 420);
  ctx.fillStyle = 'rgba(11,22,36,0.82)';
  roundRect(ctx, vp.width / 2 - boxW / 2, cy - 52, boxW, 104, 14);
  ctx.fill();

  ctx.textBaseline = 'middle';
  ctx.font = '800 26px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = tint;
  ctx.fillText(headline, vp.width / 2, cy - 18);

  ctx.font = '500 13px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText(m.winReason, vp.width / 2, cy + 8);

  ctx.font = '600 12px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('Tap to play again', vp.width / 2, cy + 32);

  ctx.restore();
}

/** Spectator notice, shown when the viewer is out but the match continues. */
export function drawSpectatorNotice(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  watchingName: string,
): void {
  const text = `Watching ${watchingName}`;
  ctx.save();
  ctx.font = '600 12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const wide = ctx.measureText(text).width + 24;
  const y = vp.height * 0.22;
  ctx.fillStyle = 'rgba(15,27,42,0.6)';
  roundRect(ctx, vp.width / 2 - wide / 2, y - 13, wide, 26, 13);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(text, vp.width / 2, y);
  ctx.restore();
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

function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
