/**
 * The snow wall grid.
 *
 * Walls are a tilemap, not entities. At 32-unit tiles a 1000x720 arena is ~700
 * cells held in two typed arrays, which is cheaper to simulate, cheaper to
 * serialize, and far cheaper to query per projectile than 700 objects would be.
 *
 * THE CENTRAL IDEA: partial destruction is HEIGHT REDUCTION.
 *
 * `wallHeightAt` is a pure function of tier and HP, and it is the single place
 * that couples visuals, projectile blocking, and line of sight. A battered wall
 * physically shrinks, so:
 *
 *   - destruction is visible as it happens rather than only when the tile pops,
 *   - "throw over a low wall" needs no special case at all -- it is just
 *     `ball.z < wallHeightAt(tile)`,
 *   - and chipping a wall down until snowballs start clearing it is an emergent
 *     tactic rather than a scripted feature.
 *
 * Get this function right and the whole mechanic follows from it.
 */

import {
  TIER_HEIGHT,
  TIER_MAX_HP,
  TILE_SIZE,
  WALL_MIN_HEIGHT_FRAC,
} from '../constants.js';

export const enum WallTier {
  None = 0,
  Low = 1,
  Full = 2,
  Reinforced = 3,
}

export interface WallGrid {
  cols: number;
  rows: number;
  /** World coordinate of the grid's top-left corner. */
  originX: number;
  originY: number;
  tier: Uint8Array;
  hp: Uint16Array;
  /** Bumped on any change. Lets a renderer or netcode layer skip unchanged state. */
  version: number;
}

export function createWallGrid(bounds: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): WallGrid {
  const cols = Math.ceil((bounds.maxX - bounds.minX) / TILE_SIZE);
  const rows = Math.ceil((bounds.maxY - bounds.minY) / TILE_SIZE);
  return {
    cols,
    rows,
    originX: bounds.minX,
    originY: bounds.minY,
    tier: new Uint8Array(cols * rows),
    hp: new Uint16Array(cols * rows),
    version: 0,
  };
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export function colOf(g: WallGrid, worldX: number): number {
  return Math.floor((worldX - g.originX) / TILE_SIZE);
}

export function rowOf(g: WallGrid, worldY: number): number {
  return Math.floor((worldY - g.originY) / TILE_SIZE);
}

export function inGrid(g: WallGrid, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < g.cols && row < g.rows;
}

export function indexOf(g: WallGrid, col: number, row: number): number {
  return inGrid(g, col, row) ? row * g.cols + col : -1;
}

/** Tile index at a world position, or -1 if outside the grid. */
export function tileAtWorld(g: WallGrid, worldX: number, worldY: number): number {
  return indexOf(g, colOf(g, worldX), rowOf(g, worldY));
}

export function tileMinX(g: WallGrid, i: number): number {
  return g.originX + (i % g.cols) * TILE_SIZE;
}

export function tileMinY(g: WallGrid, i: number): number {
  return g.originY + Math.floor(i / g.cols) * TILE_SIZE;
}

export function tileCenterX(g: WallGrid, i: number): number {
  return tileMinX(g, i) + TILE_SIZE / 2;
}

export function tileCenterY(g: WallGrid, i: number): number {
  return tileMinY(g, i) + TILE_SIZE / 2;
}

// ---------------------------------------------------------------------------
// The height model
// ---------------------------------------------------------------------------

/**
 * Current height of a tile's wall, in world units. Zero for empty tiles.
 *
 * See the file header: this is the function the whole mechanic rests on.
 */
export function wallHeightAt(g: WallGrid, i: number): number {
  if (i < 0) return 0;
  const tier = g.tier[i]!;
  if (tier === 0) return 0;
  const maxHp = TIER_MAX_HP[tier]!;
  const frac = maxHp > 0 ? Math.min(1, g.hp[i]! / maxHp) : 0;
  return TIER_HEIGHT[tier]! * (WALL_MIN_HEIGHT_FRAC + (1 - WALL_MIN_HEIGHT_FRAC) * frac);
}

export function wallHeightAtWorld(g: WallGrid, worldX: number, worldY: number): number {
  return wallHeightAt(g, tileAtWorld(g, worldX, worldY));
}

/** Does this tile block movement? All tiers do -- low walls are cover, not steps. */
export function isSolid(g: WallGrid, i: number): boolean {
  return i >= 0 && g.tier[i]! > 0;
}

export function isSolidAtWorld(g: WallGrid, worldX: number, worldY: number): boolean {
  return isSolid(g, tileAtWorld(g, worldX, worldY));
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Pack snow into a tile.
 *
 * HP accumulates and the tier rises as it crosses each tier's ceiling, so the
 * player is not choosing a wall type -- they are just adding snow, and the wall
 * grows. Returns the new tier, or -1 if the tile cannot be built on.
 */
export function buildAt(g: WallGrid, i: number, hpToAdd: number): number {
  if (i < 0) return -1;

  const nextHp = g.hp[i]! + hpToAdd;
  let tier = g.tier[i]!;

  // Climb tiers while the accumulated snow exceeds the current tier's ceiling.
  while (tier < WallTier.Reinforced && nextHp > TIER_MAX_HP[tier]!) {
    tier++;
  }

  g.tier[i] = tier;
  g.hp[i] = Math.min(nextHp, TIER_MAX_HP[tier]!);
  g.version++;
  return tier;
}

export interface WallDamageResult {
  /** True when the tile went from solid to empty. */
  destroyed: boolean;
  /** Height before and after, so callers can report how much was knocked off. */
  heightBefore: number;
  heightAfter: number;
}

/**
 * Knock snow off a tile.
 *
 * Note there is deliberately no tier DOWNGRADE: a reinforced wall reduced to
 * 30 HP stays reinforced-tier and simply shrinks, rather than reverting to a
 * "low" wall. Downgrading would make height jump around non-monotonically as a
 * wall is chipped, which is exactly the legibility the height model exists to
 * provide.
 */
export function damageWall(
  g: WallGrid,
  i: number,
  amount: number,
  out: WallDamageResult,
): WallDamageResult {
  out.destroyed = false;
  out.heightBefore = 0;
  out.heightAfter = 0;
  if (i < 0 || g.tier[i] === 0) return out;

  out.heightBefore = wallHeightAt(g, i);
  const hp = g.hp[i]! - amount;

  if (hp <= 0) {
    g.tier[i] = 0;
    g.hp[i] = 0;
    out.destroyed = true;
  } else {
    g.hp[i] = hp;
  }

  out.heightAfter = wallHeightAt(g, i);
  g.version++;
  return out;
}

export function makeWallDamageResult(): WallDamageResult {
  return { destroyed: false, heightBefore: 0, heightAfter: 0 };
}

/** Fill a rectangular world-space region, for map authoring. */
export function fillWallRect(
  g: WallGrid,
  x: number,
  y: number,
  w: number,
  h: number,
  tier: WallTier,
): void {
  const c0 = colOf(g, x);
  const r0 = rowOf(g, y);
  const c1 = colOf(g, x + w - 1);
  const r1 = rowOf(g, y + h - 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = indexOf(g, c, r);
      if (i < 0) continue;
      g.tier[i] = tier;
      g.hp[i] = TIER_MAX_HP[tier]!;
    }
  }
  g.version++;
}

export function clearWalls(g: WallGrid): void {
  g.tier.fill(0);
  g.hp.fill(0);
  g.version++;
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

export interface CircleResolve {
  x: number;
  y: number;
  /** Which axes were corrected, so the caller can zero the matching velocity. */
  hitX: boolean;
  hitY: boolean;
}

export function makeCircleResolve(): CircleResolve {
  return { x: 0, y: 0, hitX: false, hitY: false };
}

/**
 * Number of correction passes.
 *
 * One is not enough, because pushing out of one tile can push into a neighbour.
 * Four rather than two so that a circle which somehow ends up BURIED -- deep
 * inside a 2x2 or larger block of wall -- still walks its way out: each pass
 * ejects along the shallowest face, so it converges toward the nearest opening,
 * but a body two tiles deep needs a pass per tile. Being stuck inside geometry is
 * the worst failure mode a game has, and the extra passes are almost free since
 * they stop as soon as nothing moves.
 */
const MAX_RESOLVE_PASSES = 4;

/**
 * Push a circle out of every solid tile it overlaps.
 *
 * Corrects along a single axis for flat contacts, which is what keeps walls
 * pleasant to walk along: a player sliding past keeps their tangential speed and
 * is only nudged perpendicular to the surface.
 */
export function resolveCircleAgainstWalls(
  g: WallGrid,
  x: number,
  y: number,
  r: number,
  out: CircleResolve,
): boolean {
  out.x = x;
  out.y = y;
  out.hitX = false;
  out.hitY = false;

  for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
    let moved = false;

    const c0 = colOf(g, out.x - r);
    const c1 = colOf(g, out.x + r);
    const r0 = rowOf(g, out.y - r);
    const r1 = rowOf(g, out.y + r);

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = indexOf(g, col, row);
        if (i < 0 || g.tier[i] === 0) continue;

        const minX = g.originX + col * TILE_SIZE;
        const minY = g.originY + row * TILE_SIZE;
        const maxX = minX + TILE_SIZE;
        const maxY = minY + TILE_SIZE;

        const withinX = out.x >= minX && out.x <= maxX;
        const withinY = out.y >= minY && out.y <= maxY;

        if (withinX && withinY) {
          // Centre is INSIDE the tile -- eject along the shallowest face, or a
          // deeply overlapping player gets flung clean through the wall.
          const left = out.x - minX;
          const right = maxX - out.x;
          const up = out.y - minY;
          const down = maxY - out.y;
          const min = Math.min(left, right, up, down);
          if (min === left) {
            out.x = minX - r;
            out.hitX = true;
          } else if (min === right) {
            out.x = maxX + r;
            out.hitX = true;
          } else if (min === up) {
            out.y = minY - r;
            out.hitY = true;
          } else {
            out.y = maxY + r;
            out.hitY = true;
          }
          moved = true;
        } else if (withinX) {
          // Flat contact against the top or bottom face: correct on Y only.
          const above = out.y < minY;
          // A face buried against a solid neighbour is INTERNAL and must not push.
          // Skipping this check is what makes walking along a wall feel like
          // dragging across a cheese grater: every tile boundary is an internal
          // corner, and each one nudges the player sideways.
          if (isSolid(g, indexOf(g, col, above ? row - 1 : row + 1))) continue;
          const dist = above ? minY - out.y : out.y - maxY;
          if (dist >= r) continue;
          out.y = above ? minY - r : maxY + r;
          out.hitY = true;
          moved = true;
        } else if (withinY) {
          // Flat contact against the left or right face: correct on X only.
          const leftSide = out.x < minX;
          if (isSolid(g, indexOf(g, leftSide ? col - 1 : col + 1, row))) continue;
          const dist = leftSide ? minX - out.x : out.x - maxX;
          if (dist >= r) continue;
          out.x = leftSide ? minX - r : maxX + r;
          out.hitX = true;
          moved = true;
        } else {
          // Corner contact. Only resolve it if BOTH adjoining faces are exposed:
          // otherwise a neighbouring tile owns this contact and will handle it as
          // a flat face, and resolving here too would push diagonally.
          const cornerX = out.x < minX ? minX : maxX;
          const cornerY = out.y < minY ? minY : maxY;
          const dx = out.x - cornerX;
          const dy = out.y - cornerY;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r || d2 < 1e-12) continue;
          if (
            isSolid(g, indexOf(g, out.x < minX ? col - 1 : col + 1, row)) ||
            isSolid(g, indexOf(g, col, out.y < minY ? row - 1 : row + 1))
          ) {
            continue;
          }
          const d = Math.sqrt(d2);
          const push = r - d;
          out.x += (dx / d) * push;
          out.y += (dy / d) * push;
          if (Math.abs(dx) > Math.abs(dy)) out.hitX = true;
          else out.hitY = true;
          moved = true;
        }
      }
    }

    if (!moved) break;
  }

  return out.hitX || out.hitY;
}

/** Total standing walls, for tests and debug readouts. */
export function countWalls(g: WallGrid): number {
  let n = 0;
  for (let i = 0; i < g.tier.length; i++) if (g.tier[i]! > 0) n++;
  return n;
}
