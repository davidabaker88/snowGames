/**
 * The practice arena.
 *
 * Deliberately small and readable: a clearing ringed with trees and a few rocks
 * for cover. Props have both a collision radius and a HEIGHT, so a lobbed
 * snowball can sail over a rock but not through a tree -- which is the same
 * height test the wall grid will use later.
 */

import type { Prop, WorldBounds } from '../sim/world.js';

export interface MapDef {
  id: string;
  label: string;
  bounds: WorldBounds;
  props: Prop[];
  spawns: { x: number; y: number }[];
  dummies: { x: number; y: number }[];
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
