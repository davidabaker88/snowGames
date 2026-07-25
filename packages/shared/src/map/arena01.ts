/**
 * The practice arena.
 *
 * Deliberately small and readable: a clearing ringed with trees and a few rocks
 * for cover. Props have both a collision radius and a HEIGHT, so a lobbed
 * snowball can sail over a rock but not through a tree -- which is the same
 * height test the wall grid will use later.
 */

import type { Prop, World, WorldBounds } from '../sim/world.js';
import { fillWallRect, WallTier } from '../sim/walls.js';

/**
 * A pre-built wall run, in world units.
 *
 * Coordinates and sizes should be MULTIPLES OF TILE_SIZE. They are snapped to the
 * grid when applied, so a rect that straddles a boundary fills every tile it
 * touches -- a "32 tall" wall starting at y=616 quietly becomes two rows deep,
 * which renders as a slab twice the intended thickness.
 */
export interface WallRect {
  x: number;
  y: number;
  w: number;
  h: number;
  tier: WallTier;
}

export interface MapDef {
  id: string;
  label: string;
  bounds: WorldBounds;
  props: Prop[];
  walls: WallRect[];
  spawns: { x: number; y: number }[];
  dummies: { x: number; y: number }[];
}

/**
 * Stamp a map's props and walls into a freshly created world.
 *
 * Lives here rather than in the game so that tests, the headless harness and the
 * client all build the same world from the same source -- a test running against
 * a subtly different arena than the game is worse than no test.
 */
export function applyMap(w: World, map: MapDef): void {
  w.props = map.props.map((p) => ({ ...p }));
  for (const r of map.walls) fillWallRect(w.walls, r.x, r.y, r.w, r.h, r.tier);
}

export const MAP_ARENA01: MapDef = {
  id: 'arena01',
  label: 'Practice Clearing',
  bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 720 },
  spawns: [
    { x: 200, y: 520 },
    { x: 800, y: 520 },
    { x: 200, y: 200 },
    { x: 800, y: 200 },
    { x: 500, y: 620 },
    { x: 500, y: 110 },
  ],
  dummies: [
    { x: 420, y: 240 },
    { x: 560, y: 200 },
    { x: 700, y: 330 },
  ],
  /**
   * A few pre-built walls so the mechanic is visible the moment you spawn, and
   * so there is something to knock down before you have learned to build.
   *
   * One of each tier, deliberately: the low wall can be thrown over from the
   * start, the full wall cannot until you have chipped it down, and the ice block
   * takes real commitment. That contrast is the tutorial.
   */
  walls: [
    // Deliberately clustered around and BELOW the spawn, leaving the corridor up
    // toward the dummies clear. A wall across the tutorial firing line would have
    // players failing to hit anything before they had learned to throw, and
    // blaming the throwing.
    //
    // One of each tier, so the contrast teaches the mechanic on sight: the low
    // bank can be lobbed over from the start, the full wall cannot until it has
    // been chipped down, and the ice block takes real commitment.
    // All tile-aligned (multiples of 32), and one tile deep unless a wall is
    // meant to run away from the camera.
    { x: 160, y: 608, w: 128, h: 32, tier: WallTier.Full },
    { x: 64, y: 448, w: 96, h: 32, tier: WallTier.Low },
    { x: 352, y: 576, w: 96, h: 32, tier: WallTier.Reinforced },
    // A short run out on the right, so walls are visible from mid-arena too. Two
    // deep on purpose, to show a wall running into the screen rather than across.
    { x: 736, y: 416, w: 32, h: 64, tier: WallTier.Full },
  ],

  props: [
    // Trees: tall, so they block throws at any sensible arc.
    { x: 120, y: 120, radius: 16, height: 150, kind: 'tree' },
    { x: 880, y: 130, radius: 16, height: 150, kind: 'tree' },
    { x: 90, y: 640, radius: 16, height: 150, kind: 'tree' },
    { x: 910, y: 620, radius: 16, height: 150, kind: 'tree' },
    { x: 300, y: 90, radius: 14, height: 140, kind: 'tree' },
    { x: 690, y: 640, radius: 14, height: 140, kind: 'tree' },

    // Rocks: low cover. Crouch behind one and a flat throw is blocked, but a
    // high lob still gets you.
    { x: 500, y: 380, radius: 26, height: 26, kind: 'rock' },
    { x: 330, y: 470, radius: 20, height: 22, kind: 'rock' },
    { x: 670, y: 470, radius: 20, height: 22, kind: 'rock' },
    { x: 430, y: 150, radius: 18, height: 20, kind: 'rock' },

    // Crates: mid-height cover.
    { x: 250, y: 320, radius: 19, height: 38, kind: 'crate' },
    { x: 760, y: 250, radius: 19, height: 38, kind: 'crate' },

    // Lamps are decorative: radius 0 means no collision at all.
    { x: 500, y: 660, radius: 0, height: 90, kind: 'lamp' },
    { x: 500, y: 60, radius: 0, height: 90, kind: 'lamp' },
  ],
};
