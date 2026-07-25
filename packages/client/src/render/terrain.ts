/**
 * Snowy ground, baked once into an offscreen canvas and blitted with a camera
 * offset. Regenerating this per frame would be pointless work -- it never
 * changes -- and drawing hundreds of individual snow speckles every frame is a
 * real cost on a phone.
 *
 * Footprints live in a separate decal layer that IS mutated, but by stamping
 * into it rather than redrawing a list, so the cost is per new footprint rather
 * than per footprint per frame.
 */

import { createRng, nextFloat, nextRange, Y_SQUASH, type WorldBounds } from '@snow/shared';

export interface Terrain {
  ground: HTMLCanvasElement;
  decals: HTMLCanvasElement;
  /** Pixels per world unit that the layers were baked at. */
  res: number;
  bounds: WorldBounds;
  width: number;
  height: number;
}

/**
 * Bake the ground. `res` is deliberately below 1 device pixel per world unit:
 * snow has no fine detail worth preserving, and a smaller backing store keeps
 * memory and blit cost down on phones.
 */
export function createTerrain(bounds: WorldBounds, res = 1): Terrain {
  const worldW = bounds.maxX - bounds.minX;
  const worldH = bounds.maxY - bounds.minY;
  // The ground is drawn in SQUASHED space, so its pixel height matches what the
  // projection will ask for and no per-frame vertical scaling is needed.
  const width = Math.ceil(worldW * res);
  const height = Math.ceil(worldH * Y_SQUASH * res);

  const ground = document.createElement('canvas');
  ground.width = width;
  ground.height = height;
  paintGround(ground, width, height, res);

  const decals = document.createElement('canvas');
  decals.width = width;
  decals.height = height;

  return { ground, decals, res, bounds, width, height };
}

function paintGround(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  res: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, '#e9f1fa');
  g.addColorStop(0.55, '#f4f8fd');
  g.addColorStop(1, '#e3ecf7');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // A seeded RNG so the ground is identical on every device and every reload --
  // handy when comparing screenshots.
  const rng = createRng(0x50412);

  // Soft drifts.
  for (let i = 0; i < 90; i++) {
    const x = nextFloat(rng) * width;
    const y = nextFloat(rng) * height;
    const rx = nextRange(rng, 40, 150) * res;
    const ry = rx * nextRange(rng, 0.28, 0.5);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = nextFloat(rng) > 0.5 ? 'rgba(255,255,255,0.55)' : 'rgba(203,220,238,0.4)';
    ctx.fill();
  }

  // Sparkle speckles.
  for (let i = 0; i < 1600; i++) {
    const x = nextFloat(rng) * width;
    const y = nextFloat(rng) * height;
    const r = nextRange(rng, 0.4, 1.5) * res;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = nextFloat(rng) > 0.35 ? 'rgba(255,255,255,0.9)' : 'rgba(180,201,224,0.55)';
    ctx.fill();
  }
}

/** Stamp a footprint into the decal layer at a world position. */
export function stampFootprint(t: Terrain, wx: number, wy: number, facing: number): void {
  const ctx = t.decals.getContext('2d');
  if (!ctx) return;
  const x = (wx - t.bounds.minX) * t.res;
  const y = (wy - t.bounds.minY) * Y_SQUASH * t.res;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(facing);
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#8fa6c0';
  ctx.beginPath();
  ctx.ellipse(0, 0, 3.4 * t.res, 2.1 * t.res, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Fade the decal layer slightly, so tracks melt away over time. */
export function fadeDecals(t: Terrain, amount: number): void {
  const ctx = t.decals.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${amount})`;
  ctx.fillRect(0, 0, t.width, t.height);
  ctx.restore();
}
