/**
 * Snow wall tiles.
 *
 * Each tile is drawn as a box: a bright top face at the wall's current height,
 * and a shaded front face dropping to the ground. Because height comes straight
 * from `wallHeightAt`, a damaged wall visibly sits lower -- the player can see how
 * close a wall is to being cleared by a lob without any HP bar.
 *
 * Seams are suppressed by checking neighbours. A run of tiles drawn naively shows
 * an outline between every pair, which turns a wall into a row of blocks; only
 * drawing edges that are actually exposed makes it read as one bank of snow.
 *
 * Drawn procedurally rather than from cached tile bitmaps. A cache would have to
 * be keyed on quantized height, which would make the shrink-as-you-damage effect
 * step rather than glide -- and the effect is the whole point. This is four fills
 * per visible tile; if profiling on a low-end phone ever demands it, the fix is
 * to cache per (tier, height bucket) and accept the stepping.
 */

import {
  TILE_SIZE,
  TIER_HEIGHT,
  TIER_MAX_HP,
  Y_SQUASH,
  indexOf,
  wallHeightAt,
  type WallGrid,
} from '@snow/shared';
import { worldToScreenX, worldToScreenY, type Camera, type Viewport } from './projection.js';

/**
 * Per-tier colours: packed snow, harder snow, then ice.
 *
 * The important thing here is CONTRAST BETWEEN FACES, not the hue. A snow wall on
 * a snow field is white-on-white: with a lightly shaded front face it renders as a
 * faint outline that players simply do not see, which is fatal for cover. A sunlit
 * near-white top against a distinctly darker front face is what makes the block
 * read as a solid object at a glance.
 */
const TOP = ['#ffffff', '#fdfeff', '#f7fbff', '#eaf6ff'];
const FACE = ['#ffffff', '#bccfe4', '#a6bed8', '#8fb4d6'];
const EDGE = ['#ffffff', '#7c93ac', '#6b84a0', '#5b8bab'];

export interface WallTileDraw {
  index: number;
  height: number;
}

/**
 * Collect the visible wall tiles into `out`, with their current heights.
 * Sorted by the caller as part of the single depth-sorted draw list.
 */
export function collectWallTiles(
  g: WallGrid,
  cam: Camera,
  vp: Viewport,
  out: WallTileDraw[],
): number {
  out.length = 0;

  // Only walk the tile range the camera can actually see.
  const halfW = vp.width / (2 * cam.zoom) + TILE_SIZE * 2;
  const halfH = vp.height / (2 * cam.zoom * Y_SQUASH) + TILE_SIZE * 4;

  const c0 = Math.max(0, Math.floor((cam.x - halfW - g.originX) / TILE_SIZE));
  const c1 = Math.min(g.cols - 1, Math.ceil((cam.x + halfW - g.originX) / TILE_SIZE));
  const r0 = Math.max(0, Math.floor((cam.y - halfH - g.originY) / TILE_SIZE));
  const r1 = Math.min(g.rows - 1, Math.ceil((cam.y + halfH - g.originY) / TILE_SIZE));

  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * g.cols + col;
      if (g.tier[i]! === 0) continue;
      out.push({ index: i, height: wallHeightAt(g, i) });
    }
  }
  return out.length;
}

/**
 * Sort key for a wall tile: the centre of its footprint in ground y.
 *
 * The centre rather than an edge, so a player standing in front of a wall sorts
 * ahead of it and a player behind sorts behind it -- which is what you want at
 * every approach angle.
 */
export function wallSortKey(g: WallGrid, i: number): number {
  return g.originY + Math.floor(i / g.cols) * TILE_SIZE + TILE_SIZE * 0.5;
}

export function drawWallTile(
  ctx: CanvasRenderingContext2D,
  g: WallGrid,
  i: number,
  height: number,
  cam: Camera,
  vp: Viewport,
): void {
  const col = i % g.cols;
  const row = Math.floor(i / g.cols);
  const tier = g.tier[i]!;

  const wx = g.originX + col * TILE_SIZE;
  const wy = g.originY + row * TILE_SIZE;

  const left = worldToScreenX(wx, cam, vp);
  const right = worldToScreenX(wx + TILE_SIZE, cam, vp);
  const backGround = worldToScreenY(wy, 0, cam, vp);
  const frontGround = worldToScreenY(wy + TILE_SIZE, 0, cam, vp);

  const lift = height * cam.zoom;
  const w = right - left;
  const tileH = frontGround - backGround;

  // Neighbours, so only exposed edges get an outline.
  const nUp = indexOf(g, col, row - 1);
  const nDown = indexOf(g, col, row + 1);
  const nLeft = indexOf(g, col - 1, row);
  const nRight = indexOf(g, col + 1, row);
  const hUp = nUp >= 0 ? wallHeightAt(g, nUp) : 0;
  const hDown = nDown >= 0 ? wallHeightAt(g, nDown) : 0;
  const hLeft = nLeft >= 0 ? wallHeightAt(g, nLeft) : 0;
  const hRight = nRight >= 0 ? wallHeightAt(g, nRight) : 0;

  // Drawn slightly wider than the tile where a neighbour continues the run, to
  // hide subpixel seams between adjacent front faces.
  const bleedL = hLeft > 0 ? 0.5 : 0;
  const bleedR = hRight > 0 ? 0.5 : 0;

  /**
   * A tile whose FRONT neighbour is at least as tall has its front face
   * completely hidden behind that neighbour. Drawing it anyway is what turns a
   * wall two or more tiles deep into a stack of visible ledges instead of one
   * solid bank of snow.
   */
  const frontHidden = hDown >= height - 0.01;

  // ---- front face ---------------------------------------------------------
  if (!frontHidden) {
    ctx.fillStyle = FACE[tier]!;
    ctx.fillRect(left - bleedL, frontGround - lift, w + bleedL + bleedR, lift);
  }

  // ---- top face -----------------------------------------------------------
  ctx.fillStyle = TOP[tier]!;
  ctx.fillRect(left - bleedL, backGround - lift, w + bleedL + bleedR, tileH + 0.5);

  // A crisp line where the top meets the front reads as the wall's crest.
  if (!frontHidden) {
    ctx.strokeStyle = EDGE[tier]!;
    ctx.lineWidth = Math.max(0.7, 1.1 * cam.zoom);
    ctx.beginPath();
    ctx.moveTo(left - bleedL, frontGround - lift);
    ctx.lineTo(right + bleedR, frontGround - lift);
    ctx.stroke();
  }

  // ---- exposed outlines ----------------------------------------------------
  ctx.beginPath();
  if (hLeft <= 0) {
    ctx.moveTo(left, backGround - lift);
    ctx.lineTo(left, frontGround);
  }
  if (hRight <= 0) {
    ctx.moveTo(right, backGround - lift);
    ctx.lineTo(right, frontGround);
  }
  if (hUp <= 0) {
    ctx.moveTo(left, backGround - lift);
    ctx.lineTo(right, backGround - lift);
  }
  if (hDown <= 0) {
    ctx.moveTo(left, frontGround);
    ctx.lineTo(right, frontGround);
  }
  ctx.stroke();

  // ---- damage ------------------------------------------------------------
  // Cracks appear as the wall weakens. A second cue alongside the height drop,
  // because height alone is hard to judge on an isolated tile with nothing to
  // compare it against.
  const maxHp = TIER_MAX_HP[tier]!;
  const frac = maxHp > 0 ? g.hp[i]! / maxHp : 1;
  if (frac < 0.75 && lift > 3 && !frontHidden) {
    ctx.strokeStyle = `rgba(120,146,175,${(0.75 - frac) * 0.9})`;
    ctx.lineWidth = Math.max(0.6, 1 * cam.zoom);
    ctx.beginPath();
    const midX = left + w * 0.5;
    const top = frontGround - lift;
    ctx.moveTo(midX - w * 0.18, frontGround);
    ctx.lineTo(midX + w * 0.06, top + lift * 0.45);
    ctx.lineTo(midX - w * 0.05, top + lift * 0.2);
    if (frac < 0.4) {
      ctx.moveTo(midX + w * 0.3, frontGround);
      ctx.lineTo(midX + w * 0.16, top + lift * 0.55);
    }
    ctx.stroke();
  }
}

/**
 * The build ghost: where the wall would go, and how tall it would end up.
 *
 * Shown while carrying a snowball, because "build" is otherwise invisible until
 * it happens -- and a player needs to know which tile they are aiming at before
 * spending their only snowball on it.
 */
export function drawBuildGhost(
  ctx: CanvasRenderingContext2D,
  g: WallGrid,
  i: number,
  cam: Camera,
  vp: Viewport,
  ready: boolean,
): void {
  const col = i % g.cols;
  const row = Math.floor(i / g.cols);

  const wx = g.originX + col * TILE_SIZE;
  const wy = g.originY + row * TILE_SIZE;
  const left = worldToScreenX(wx, cam, vp);
  const right = worldToScreenX(wx + TILE_SIZE, cam, vp);
  const backGround = worldToScreenY(wy, 0, cam, vp);
  const frontGround = worldToScreenY(wy + TILE_SIZE, 0, cam, vp);

  // Preview the height it would REACH, not its current height, so the player can
  // see they are about to turn a low bank into full cover.
  const current = g.tier[i]!;
  const nextTier = Math.min(3, current === 0 ? 1 : current + (g.hp[i]! >= TIER_MAX_HP[current]! ? 1 : 0));
  const previewHeight = TIER_HEIGHT[Math.max(1, nextTier)]!;
  const lift = previewHeight * cam.zoom;
  const w = right - left;

  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = Math.max(1.2, 1.6 * cam.zoom);
  ctx.strokeStyle = ready ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)';
  ctx.fillStyle = ready ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)';

  // Footprint on the ground, so the target tile is unambiguous.
  ctx.fillRect(left, backGround, w, frontGround - backGround);
  ctx.strokeRect(left, backGround, w, frontGround - backGround);

  // And the outline of the resulting block.
  ctx.strokeRect(left, frontGround - lift, w, lift);
  ctx.restore();
}
