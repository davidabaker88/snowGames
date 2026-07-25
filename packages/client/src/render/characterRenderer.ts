/**
 * Draws a solved skeleton.
 *
 * The interesting part is per-bone depth sorting WITHIN the character. Once the
 * rig is turned to face a direction, some limbs are nearer the camera than
 * others, and which ones changes continuously as the character turns. Sorting
 * bones by their projected depth each frame is what makes the far arm go behind
 * the torso automatically, instead of needing eight hand-authored views.
 */

import {
  localToWorldOffset,
  Y_SQUASH,
  type SkinDef,
  type Skeleton,
  type SolvedPose,
} from '@snow/shared';
import { drawShape } from './shapes.js';

interface BoneDraw {
  bone: number;
  depth: number;
}

/** Reused across all characters in a frame; never allocated per draw. */
const drawBuf: BoneDraw[] = [];
const offA = { x: 0, y: 0 };
const offB = { x: 0, y: 0 };

export interface CharacterDrawOpts {
  /** Screen position of the character's ground origin. */
  screenX: number;
  screenY: number;
  facing: number;
  zoom: number;
  /** Multiplied into every bone's alpha, for fading out eliminated players. */
  alpha?: number;
  /** Flat colour override, used for the hit flash. */
  tint?: string;
  tintAmount?: number;
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  sk: Skeleton,
  solved: SolvedPose,
  opts: CharacterDrawOpts,
): void {
  const skin: SkinDef = sk.skin;
  const scale = skin.scale * opts.zoom;

  // Depth-sort bones for this facing. Insertion into a reused array plus a sort
  // on a small list beats allocating per frame.
  drawBuf.length = 0;
  for (const i of sk.drawOrder) {
    const b = sk.bones[i]!;
    if (b.shapes.length === 0) continue;
    const s = solved.bones[i]!;
    // Depth of the bone's midpoint, plus the authored bias.
    localToWorldOffset((s.ox + s.tx) * 0.5, (s.oz + s.tz) * 0.5, opts.facing, offA);
    drawBuf.push({ bone: i, depth: offA.y + b.zBias });
  }
  drawBuf.sort((p, q) => p.depth - q.depth);

  const globalAlpha = opts.alpha ?? 1;

  for (const entry of drawBuf) {
    const i = entry.bone;
    const b = sk.bones[i]!;
    const s = solved.bones[i]!;

    // Project the bone's origin and tip into screen space.
    localToWorldOffset(s.ox, s.oz, opts.facing, offA);
    localToWorldOffset(s.tx, s.tz, opts.facing, offB);

    const x0 = opts.screenX + offA.x * scale;
    const y0 = opts.screenY + (offA.y * Y_SQUASH - s.oy) * scale;
    const x1 = opts.screenX + offB.x * scale;
    const y1 = opts.screenY + (offB.y * Y_SQUASH - s.ty) * scale;

    // Rotate the bone's local frame so +y runs from origin toward tip, and
    // scale so the drawn length matches the PROJECTED length -- that is what
    // produces foreshortening as the character turns away from the camera.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const projLen = Math.hypot(dx, dy);
    const nominal = b.length * s.scale * scale;
    const foreshorten = nominal > 0.01 ? projLen / nominal : 1;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, s.alpha * globalAlpha));
    ctx.translate(x0, y0);
    // Shapes are authored along the bone's local +y, from origin toward tip, so
    // the rotation has to map local +y onto the screen-space delta (dx, dy).
    // Canvas `rotate(t)` sends the local +y unit to (-sin t, cos t), so solving
    // (-sin t, cos t) proportional-to (dx, dy) gives atan2(-dx, dy). Getting the
    // sign wrong here draws every bone backwards from its own origin, which reads
    // as a character turned inside out rather than as a rotation bug.
    ctx.rotate(Math.atan2(-dx, dy));

    const drawScale = s.scale * scale;
    // A zero-length bone (a pure attachment point that still has artwork, like a
    // head circle) must not be squashed to nothing.
    const lenScale = b.length > 0.01 ? foreshorten : 1;

    for (const shape of b.shapes) {
      // Foreshortening is passed down rather than applied as a transform here, so
      // each primitive decides what it means for its own geometry (see shapes.ts).
      drawShape(ctx, shape, b.length, drawScale, lenScale);
    }

    if (opts.tint && opts.tintAmount && b.length > 0.01) {
      // Flash: re-stroke the bone in the tint colour at partial alpha.
      ctx.globalAlpha = Math.min(1, opts.tintAmount) * 0.7;
      ctx.strokeStyle = opts.tint;
      ctx.lineWidth = Math.max(1, 3 * drawScale);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, b.length * drawScale * lenScale);
      ctx.stroke();
    }

    ctx.restore();
  }
}

/**
 * Where a held snowball rides, in screen pixels.
 *
 * Read from the skin's `hold` descriptor rather than hardcoded, so a chicken
 * holds a ball at the tip of a wing and a stick figure holds it in a hand
 * without the renderer knowing which is which.
 */
export function holdPointScreen(
  sk: Skeleton,
  solved: SolvedPose,
  opts: CharacterDrawOpts,
  out: { x: number; y: number },
): boolean {
  const hold = sk.skin.hold;
  const bi = sk.index.get(hold.bone);
  if (bi === undefined) return false;
  const s = solved.bones[bi]!;

  const along = hold.along;
  const lx = s.ox + (s.tx - s.ox) * along;
  const ly = s.oy + (s.ty - s.oy) * along;
  const lz = s.oz + (s.tz - s.oz) * along;

  localToWorldOffset(lx + (hold.across ?? 0), lz, opts.facing, offA);
  const scale = sk.skin.scale * opts.zoom;
  out.x = opts.screenX + offA.x * scale;
  out.y = opts.screenY + (offA.y * Y_SQUASH - ly) * scale;
  return true;
}
