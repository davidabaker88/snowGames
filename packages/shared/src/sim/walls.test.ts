import { describe, expect, it } from 'vitest';
import {
  buildAt,
  colOf,
  countWalls,
  createWallGrid,
  damageWall,
  fillWallRect,
  indexOf,
  isSolid,
  makeCircleResolve,
  makeWallDamageResult,
  resolveCircleAgainstWalls,
  rowOf,
  tileAtWorld,
  wallHeightAt,
  WallTier,
} from './walls.js';
import {
  BUILD_HP_PER_BALL,
  BUILD_TICKS,
  MAX_PACK_ROTATIONS_PER_SEC,
  PACK_ROTATIONS_REQUIRED,
  PLAYER_RADIUS,
  THROW_MAX_SPEED,
  TIER_HEIGHT,
  TIER_MAX_HP,
  TILE_SIZE,
  WALL_MIN_HEIGHT_FRAC,
  TICK_DT,
} from '../constants.js';
import { allocBall, createWorld, spawnPlayer, type World } from './world.js';
import { step, type InputMap } from './step.js';
import { Button, createInputFrame, validateInput, type InputFrame } from '../input/inputFrame.js';
import { ActionState, BallSize, BallState, SimEventType, TEAM_NONE } from './types.js';
import { buildTargetTile } from './player.js';

const BOUNDS = { minX: 0, minY: 0, maxX: 640, maxY: 480 };

function grid() {
  return createWallGrid(BOUNDS);
}

function makeWorld(): World {
  return createWorld(99, BOUNDS);
}

function inputs(map: Record<number, InputFrame>): InputMap {
  return new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
}

function runTicks(w: World, n: number, m: InputMap): void {
  for (let i = 0; i < n; i++) step(w, m, { mode: 'authoritative' });
}

describe('grid indexing', () => {
  it('maps world positions to tiles and back', () => {
    const g = grid();
    expect(g.cols).toBe(640 / TILE_SIZE);
    expect(g.rows).toBe(480 / TILE_SIZE);

    expect(colOf(g, 0)).toBe(0);
    expect(colOf(g, TILE_SIZE - 0.01)).toBe(0);
    expect(colOf(g, TILE_SIZE)).toBe(1);
    expect(rowOf(g, TILE_SIZE * 3 + 5)).toBe(3);

    expect(tileAtWorld(g, 5, 5)).toBe(0);
    expect(tileAtWorld(g, -5, 5)).toBe(-1);
    expect(tileAtWorld(g, 5, 5000)).toBe(-1);
  });
});

describe('the height model', () => {
  it('is zero for an empty tile', () => {
    const g = grid();
    expect(wallHeightAt(g, 0)).toBe(0);
  });

  it('is full tier height at full HP', () => {
    const g = grid();
    fillWallRect(g, 0, 0, TILE_SIZE, TILE_SIZE, WallTier.Full);
    expect(wallHeightAt(g, 0)).toBeCloseTo(TIER_HEIGHT[WallTier.Full]!, 5);
  });

  it('interpolates down to a floor rather than to zero as HP drops', () => {
    // A wall at 1 HP is a knee-high lump, not 1% of a wall. Interpolating to zero
    // would make cover vanish visually long before it is actually gone.
    const g = grid();
    fillWallRect(g, 0, 0, TILE_SIZE, TILE_SIZE, WallTier.Full);
    g.hp[0] = 1;
    const h = wallHeightAt(g, 0);
    const full = TIER_HEIGHT[WallTier.Full]!;
    expect(h).toBeGreaterThan(full * WALL_MIN_HEIGHT_FRAC * 0.99);
    expect(h).toBeLessThan(full * 0.45);
  });

  it('shrinks monotonically as damage accumulates', () => {
    const g = grid();
    fillWallRect(g, 0, 0, TILE_SIZE, TILE_SIZE, WallTier.Reinforced);
    const res = makeWallDamageResult();
    let last = wallHeightAt(g, 0);
    let guard = 0;
    while (g.tier[0]! > 0 && guard++ < 200) {
      damageWall(g, 0, 15, res);
      const h = wallHeightAt(g, 0);
      expect(h).toBeLessThanOrEqual(last + 1e-9);
      last = h;
    }
    expect(g.tier[0]).toBe(0);
    expect(wallHeightAt(g, 0)).toBe(0);
  });
});

describe('building', () => {
  it('climbs tiers as snow accumulates', () => {
    const g = grid();
    // One ball -> low, two -> full, and more -> reinforced. This progression is
    // what makes "add snow" legible without a wall-type picker.
    expect(buildAt(g, 0, BUILD_HP_PER_BALL)).toBe(WallTier.Low);
    expect(buildAt(g, 0, BUILD_HP_PER_BALL)).toBe(WallTier.Full);
    expect(buildAt(g, 0, BUILD_HP_PER_BALL)).toBe(WallTier.Reinforced);
  });

  it('caps at reinforced and never exceeds that tier max', () => {
    const g = grid();
    for (let i = 0; i < 20; i++) buildAt(g, 0, BUILD_HP_PER_BALL);
    expect(g.tier[0]).toBe(WallTier.Reinforced);
    expect(g.hp[0]).toBe(TIER_MAX_HP[WallTier.Reinforced]);
  });

  it('refuses an off-grid tile', () => {
    const g = grid();
    expect(buildAt(g, -1, BUILD_HP_PER_BALL)).toBe(-1);
  });

  it('makes each successive tier taller', () => {
    const g = grid();
    buildAt(g, 0, BUILD_HP_PER_BALL);
    const low = wallHeightAt(g, 0);
    buildAt(g, 0, BUILD_HP_PER_BALL);
    const full = wallHeightAt(g, 0);
    buildAt(g, 0, BUILD_HP_PER_BALL);
    const ice = wallHeightAt(g, 0);
    expect(full).toBeGreaterThan(low);
    expect(ice).toBeGreaterThan(full);
  });
});

describe('player collision', () => {
  const out = makeCircleResolve();

  it('pushes a player out of a wall tile', () => {
    const g = grid();
    fillWallRect(g, 128, 128, TILE_SIZE, TILE_SIZE, WallTier.Full);
    // Standing dead centre of the tile.
    const hit = resolveCircleAgainstWalls(g, 144, 144, PLAYER_RADIUS, out);
    expect(hit).toBe(true);
    expect(isSolid(g, tileAtWorld(g, out.x, out.y))).toBe(false);
  });

  it('leaves a player in open ground alone', () => {
    const g = grid();
    fillWallRect(g, 128, 128, TILE_SIZE, TILE_SIZE, WallTier.Full);
    const hit = resolveCircleAgainstWalls(g, 400, 400, PLAYER_RADIUS, out);
    expect(hit).toBe(false);
    expect(out.x).toBe(400);
    expect(out.y).toBe(400);
  });

  it('corrects only the axis that was blocked, so walls are not sticky', () => {
    const g = grid();
    // A horizontal run; approach it from above.
    fillWallRect(g, 0, 160, 320, TILE_SIZE, WallTier.Full);
    resolveCircleAgainstWalls(g, 100, 160 - PLAYER_RADIUS + 4, PLAYER_RADIUS, out);
    expect(out.hitY).toBe(true);
    expect(out.hitX).toBe(false);
    // Pushed straight up, not sideways.
    expect(out.x).toBeCloseTo(100, 5);
  });

  it('never leaves a player inside a wall, from any approach', () => {
    const g = grid();
    fillWallRect(g, 128, 128, TILE_SIZE * 2, TILE_SIZE * 2, WallTier.Full);
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2;
      // Start just inside the block from every direction.
      const x = 160 + Math.cos(ang) * 10;
      const y = 160 + Math.sin(ang) * 10;
      resolveCircleAgainstWalls(g, x, y, PLAYER_RADIUS, out);
      expect(isSolid(g, tileAtWorld(g, out.x, out.y)), `angle ${a}`).toBe(false);
    }
  });

  it('blocks a walking player in the simulation', () => {
    const w = makeWorld();
    // A wall directly to the player's right.
    fillWallRect(w.walls, 200, 96, TILE_SIZE, TILE_SIZE * 3, WallTier.Full);
    const p = spawnPlayer(w, { x: 150, y: 144 })!;

    const f = createInputFrame();
    f.moveX = 1;
    runTicks(w, 90, inputs({ 0: f }));

    // Stopped short of the wall's left face rather than walking through it.
    expect(p.x).toBeLessThan(200);
    expect(p.x).toBeGreaterThan(150);
    expect(isSolid(w.walls, tileAtWorld(w.walls, p.x, p.y))).toBe(false);
  });
});

describe('projectiles versus walls', () => {
  /**
   * Launch a flat ball just short of the wall.
   *
   * Deliberately short-range and fast: gravity acts on these balls exactly as it
   * does in the game, so a long approach means the ball has visibly dropped (or
   * landed) by the time it arrives, and the test would be measuring the arc
   * rather than the height gate it claims to test.
   */
  function flyBallAt(w: World, x: number, y: number, z: number, speed: number) {
    const b = allocBall(w)!;
    b.state = BallState.Flight;
    b.size = BallSize.Normal;
    b.owner = 99;
    b.team = TEAM_NONE;
    b.x = x;
    b.y = y;
    b.z = z;
    b.vx = speed;
    b.vy = 0;
    b.vz = 0;
    b.stateTick = w.tick;
    return b;
  }

  /** A single wall tile at (256..288, 128..160), with the ball starting at x=250. */
  function oneTileWall(tier: WallTier): { w: World; tile: number } {
    const w = makeWorld();
    fillWallRect(w.walls, 256, 128, TILE_SIZE, TILE_SIZE, tier);
    return { w, tile: tileAtWorld(w.walls, 260, 140) };
  }

  it('stops a ball flying below the wall height and damages it', () => {
    const { w, tile } = oneTileWall(WallTier.Full);
    const hpBefore = w.walls.hp[tile]!;

    flyBallAt(w, 250, 140, 20, 600);
    let wallHits = 0;
    for (let i = 0; i < 8; i++) {
      const evs = step(w, inputs({}), { mode: 'authoritative' });
      wallHits += evs.filter((e) => e.type === SimEventType.WallHit && e.id === tile).length;
    }

    expect(wallHits).toBe(1);
    expect(w.walls.hp[tile]!).toBeLessThan(hpBefore);
  });

  it('lets a ball pass over a wall it is flying above', () => {
    // The whole "throw over a low wall" feature, with no special case for it.
    const { w, tile } = oneTileWall(WallTier.Low);
    const hpBefore = w.walls.hp[tile]!;

    // Comfortably above the low wall's 20-unit crest.
    flyBallAt(w, 250, 140, 36, 600);
    for (let i = 0; i < 8; i++) step(w, inputs({}), { mode: 'authoritative' });

    expect(w.walls.hp[tile]!).toBe(hpBefore);
  });

  it('blocks a throw, then lets the same throw through once the wall is chipped', () => {
    // This is the emergent tactic the height model exists to enable, and the pair
    // of assertions is the point: identical throw, different outcome, purely
    // because the wall got shorter.
    const throwHeight = 34;

    const healthy = oneTileWall(WallTier.Full);
    const hpBefore = healthy.w.walls.hp[healthy.tile]!;
    expect(wallHeightAt(healthy.w.walls, healthy.tile)).toBeGreaterThan(throwHeight);
    flyBallAt(healthy.w, 250, 140, throwHeight, 600);
    for (let i = 0; i < 8; i++) step(healthy.w, inputs({}), { mode: 'authoritative' });
    expect(healthy.w.walls.hp[healthy.tile]!, 'blocked by a healthy wall').toBeLessThan(hpBefore);

    const chipped = oneTileWall(WallTier.Full);
    const res = makeWallDamageResult();
    while (
      wallHeightAt(chipped.w.walls, chipped.tile) > throwHeight - 4 &&
      chipped.w.walls.tier[chipped.tile]! > 0
    ) {
      damageWall(chipped.w.walls, chipped.tile, 4, res);
    }
    // Still standing, just shorter.
    expect(chipped.w.walls.tier[chipped.tile]!).toBeGreaterThan(0);
    const chippedHp = chipped.w.walls.hp[chipped.tile]!;

    flyBallAt(chipped.w, 250, 140, throwHeight, 600);
    for (let i = 0; i < 8; i++) step(chipped.w, inputs({}), { mode: 'authoritative' });
    expect(chipped.w.walls.hp[chipped.tile]!, 'clears a chipped wall').toBe(chippedHp);
  });

  it('does not let a max-speed ball tunnel through a one-tile wall', () => {
    // A full-power ball travels ~30 units per tick against a 32-unit tile, so a
    // single position test per tick misses about as often as it hits.
    const trials = 40;
    let stopped = 0;
    for (let i = 0; i < trials; i++) {
      const w = makeWorld();
      fillWallRect(w.walls, 320, 128, TILE_SIZE, TILE_SIZE, WallTier.Reinforced);
      const tile = tileAtWorld(w.walls, 324, 140);

      // Vary the sub-tick phase across a full tick of travel at max speed.
      flyBallAt(w, 250 + i * (30 / trials), 140, 22, THROW_MAX_SPEED);
      let hit = false;
      for (let k = 0; k < 8 && !hit; k++) {
        const evs = step(w, inputs({}), { mode: 'authoritative' });
        if (evs.some((e) => e.type === SimEventType.WallHit && e.id === tile)) hit = true;
      }
      if (hit) stopped++;
    }
    expect(stopped).toBe(trials);
  });

  it('emits WallDestroyed exactly once when a wall finally falls', () => {
    const w = makeWorld();
    fillWallRect(w.walls, 256, 128, TILE_SIZE, TILE_SIZE, WallTier.Low);
    const tile = tileAtWorld(w.walls, 260, 140);

    let destroyed = 0;
    for (let shot = 0; shot < 12 && w.walls.tier[tile]! > 0; shot++) {
      flyBallAt(w, 250, 140, 8, 600);
      for (let i = 0; i < 8; i++) {
        const evs = step(w, inputs({}), { mode: 'authoritative' });
        destroyed += evs.filter((e) => e.type === SimEventType.WallDestroyed).length;
      }
    }
    expect(w.walls.tier[tile]).toBe(0);
    expect(destroyed).toBe(1);
  });
});

describe('the build action end to end', () => {
  function packOneBall(w: World, id: number): void {
    const p = w.players[id]!;
    const f = createInputFrame();
    f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
    validateInput(f);
    let guard = 0;
    while (p.heldBall < 0 && guard++ < 600) {
      step(w, inputs({ [id]: f }), { mode: 'authoritative' });
    }
    expect(p.heldBall, 'packing a ball for the build test').toBeGreaterThanOrEqual(0);
    void PACK_ROTATIONS_REQUIRED;
  }

  it('turns a held snowball into a wall in front of the player', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 300, y: 240 })!;
    packOneBall(w, 0);

    p.aim = 0; // facing +x
    const target = buildTargetTile(w, p);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(countWalls(w.walls)).toBe(0);

    const f = createInputFrame();
    f.aim = 0;
    f.buttons = Button.Build;
    step(w, inputs({ 0: f }), { mode: 'authoritative' });
    expect(p.action).toBe(ActionState.Building);

    const idle = createInputFrame();
    idle.aim = 0;
    let built = 0;
    for (let i = 0; i < BUILD_TICKS + 4; i++) {
      const evs = step(w, inputs({ 0: idle }), { mode: 'authoritative' });
      built += evs.filter((e) => e.type === SimEventType.WallBuilt).length;
    }

    expect(built).toBe(1);
    expect(p.heldBall).toBe(-1);
    expect(countWalls(w.walls)).toBe(1);
    expect(w.walls.tier[target]).toBe(WallTier.Low);
  });

  it('refuses to build on a tile a player is standing in', () => {
    // Otherwise you could box someone in -- or, more often, box yourself in.
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 300, y: 240 })!;
    p.aim = 0;
    const target = buildTargetTile(w, p);
    expect(target).toBeGreaterThanOrEqual(0);

    // Put someone in the target tile.
    const other = spawnPlayer(w, {
      x: 300 + TILE_SIZE,
      y: 240,
    })!;
    other.x = (target % w.walls.cols) * TILE_SIZE + TILE_SIZE / 2;
    other.y = Math.floor(target / w.walls.cols) * TILE_SIZE + TILE_SIZE / 2;

    expect(buildTargetTile(w, p)).toBe(-1);
  });

  it('will not build when already fully reinforced', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 300, y: 240 })!;
    p.aim = 0;
    const target = buildTargetTile(w, p);
    w.walls.tier[target] = WallTier.Reinforced;
    w.walls.hp[target] = TIER_MAX_HP[WallTier.Reinforced]!;
    expect(buildTargetTile(w, p)).toBe(-1);
  });

  it('spends the snowball, so packing feeds offence and defence from one pool', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 300, y: 240 })!;
    packOneBall(w, 0);
    const aliveBefore = w.balls.filter((b) => b.alive).length;

    p.aim = 0;
    const f = createInputFrame();
    f.aim = 0;
    f.buttons = Button.Build;
    step(w, inputs({ 0: f }), { mode: 'authoritative' });
    const idle = createInputFrame();
    idle.aim = 0;
    runTicks(w, BUILD_TICKS + 4, inputs({ 0: idle }));

    expect(w.balls.filter((b) => b.alive).length).toBe(aliveBefore - 1);
    // And the slot went back to the free list rather than leaking.
    expect(new Set(w.freeBalls).size).toBe(w.freeBalls.length);
  });
});

describe('wall state is part of the simulation hash', () => {
  it('changes the world hash when a wall is built', async () => {
    const { hashWorld } = await import('./world.js');
    const w = makeWorld();
    const before = hashWorld(w);
    fillWallRect(w.walls, 64, 64, TILE_SIZE, TILE_SIZE, WallTier.Full);
    expect(hashWorld(w)).not.toBe(before);
  });

  it('keeps indexOf and fillWallRect consistent', () => {
    const g = grid();
    fillWallRect(g, 64, 96, TILE_SIZE * 2, TILE_SIZE, WallTier.Low);
    expect(isSolid(g, indexOf(g, 2, 3))).toBe(true);
    expect(isSolid(g, indexOf(g, 3, 3))).toBe(true);
    expect(isSolid(g, indexOf(g, 4, 3))).toBe(false);
    expect(countWalls(g)).toBe(2);
  });
});
