import { describe, expect, it } from 'vitest';
import { allocBall, createWorld, hashWorld, spawnPlayer, type World } from './world.js';
import { step, type InputMap } from './step.js';
import { ActionState, BallSize, BallState, SimEventType, TEAM_NONE } from './types.js';
import {
  createInputFrame,
  validateInput,
  Button,
  type InputFrame,
} from '../input/inputFrame.js';
import {
  MAX_PACK_ROTATIONS_PER_SEC,
  PACK_ROTATIONS_REQUIRED,
  PICKUP_TICKS,
  PLACE_TICKS,
  THROW_MAX_SPEED,
  THROW_TICKS,
  TICK_DT,
  WINDUP_TICKS,
} from '../constants.js';
import { MAP_ARENA01 } from '../map/arena01.js';

function makeWorld(): World {
  const w = createWorld(1234, MAP_ARENA01.bounds);
  w.props = MAP_ARENA01.props.map((p) => ({ ...p }));
  return w;
}

/** No props, so movement tests measure movement and not prop push-out. */
function makeEmptyWorld(): World {
  return createWorld(1234, MAP_ARENA01.bounds);
}

function inputs(map: Record<number, InputFrame>): InputMap {
  return new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
}

function runTicks(w: World, n: number, m: InputMap): void {
  for (let i = 0; i < n; i++) step(w, m, { mode: 'authoritative' });
}

describe('movement', () => {
  it('moves a player in the direction of input', () => {
    const w = makeEmptyWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    const f = createInputFrame();
    f.moveX = 1;
    const startX = p.x;
    runTicks(w, 15, inputs({ 0: f }));
    expect(p.x).toBeGreaterThan(startX + 20);
    expect(p.action).toBe(ActionState.Walking);
  });

  it('does not let diagonal input exceed straight-line speed', () => {
    const w1 = makeEmptyWorld();
    const straight = spawnPlayer(w1, { x: 500, y: 400 })!;
    const f1 = createInputFrame();
    f1.moveX = 1;
    runTicks(w1, 30, inputs({ 0: f1 }));
    const dStraight = Math.hypot(straight.x - 500, straight.y - 400);

    const w2 = makeEmptyWorld();
    const diag = spawnPlayer(w2, { x: 500, y: 400 })!;
    const f2 = createInputFrame();
    // A naive client sending 1,1 must be clamped, not rewarded.
    f2.moveX = 1;
    f2.moveY = 1;
    validateInput(f2);
    runTicks(w2, 30, inputs({ 0: f2 }));
    const dDiag = Math.hypot(diag.x - 500, diag.y - 400);

    expect(dDiag).toBeLessThanOrEqual(dStraight * 1.02);
  });

  it('keeps players inside the arena bounds', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    const f = createInputFrame();
    f.moveX = -1;
    f.moveY = -1;
    validateInput(f);
    runTicks(w, 400, inputs({ 0: f }));
    expect(p.x).toBeGreaterThanOrEqual(w.bounds.minX);
    expect(p.y).toBeGreaterThanOrEqual(w.bounds.minY);
  });
});

describe('packing', () => {
  it('produces a held ball after the required rotations', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    const f = createInputFrame();
    f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
    validateInput(f);

    let packedEvents = 0;
    for (let i = 0; i < 200 && p.heldBall < 0; i++) {
      const evs = step(w, inputs({ 0: f }), { mode: 'authoritative' });
      packedEvents += evs.filter((e) => e.type === SimEventType.Packed).length;
    }

    expect(p.heldBall).toBeGreaterThanOrEqual(0);
    expect(packedEvents).toBe(1);
    expect(w.balls[p.heldBall]!.state).toBe(BallState.Held);
  });

  it('clamps an absurd packDelta so a modified client cannot pack instantly', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    const f = createInputFrame();
    // A cheating client claims a thousand rotations in one tick.
    f.packDelta = 1000;

    step(w, inputs({ 0: f }), { mode: 'authoritative' });

    expect(p.heldBall).toBe(-1);
    expect(p.packProgress).toBeLessThanOrEqual(MAX_PACK_ROTATIONS_PER_SEC * TICK_DT + 1e-6);
    expect(p.packProgress).toBeLessThan(PACK_ROTATIONS_REQUIRED);
  });

  it('drains progress when the player stops circling', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    const packing = createInputFrame();
    packing.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
    validateInput(packing);
    runTicks(w, 10, inputs({ 0: packing }));
    const peak = p.packProgress;
    expect(peak).toBeGreaterThan(0);

    const idle = createInputFrame();
    runTicks(w, 60, inputs({ 0: idle }));
    expect(p.packProgress).toBeLessThan(peak);
  });

  it('refuses to pack while already holding a ball', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    const f = createInputFrame();
    f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
    validateInput(f);
    while (p.heldBall < 0) step(w, inputs({ 0: f }), { mode: 'authoritative' });

    const held = p.heldBall;
    runTicks(w, 120, inputs({ 0: f }));
    expect(p.heldBall).toBe(held);
    expect(p.packProgress).toBe(0);
  });
});

describe('throw, place and pickup', () => {
  function giveBall(w: World, id: number): void {
    const p = w.players[id]!;
    const f = createInputFrame();
    f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
    validateInput(f);
    let guard = 0;
    while (p.heldBall < 0 && guard++ < 500) {
      step(w, inputs({ [id]: f }), { mode: 'authoritative' });
    }
  }

  it('launches the ball into flight after the wind-up and release', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 300, y: 400 })!;
    giveBall(w, 0);
    const ballId = p.heldBall;

    const f = createInputFrame();
    f.buttons = Button.Throw;
    f.throwPower = 1;
    f.aim = 0;
    step(w, inputs({ 0: f }), { mode: 'authoritative' });
    expect(p.action).toBe(ActionState.WindUp);

    const idle = createInputFrame();
    runTicks(w, WINDUP_TICKS + THROW_TICKS + 2, inputs({ 0: idle }));

    expect(p.heldBall).toBe(-1);
    const b = w.balls[ballId]!;
    // Either still flying, or already consumed by a hit/prop -- but not held.
    expect(b.state).not.toBe(BallState.Held);
  });

  it('sets a ball on the ground and picks it back up', () => {
    const w = makeWorld();
    // An open spot away from props so the ball is not eaten on the way down.
    const p = spawnPlayer(w, { x: 500, y: 600 })!;
    giveBall(w, 0);
    const ballId = p.heldBall;

    const place = createInputFrame();
    place.buttons = Button.Place;
    step(w, inputs({ 0: place }), { mode: 'authoritative' });
    expect(p.action).toBe(ActionState.Placing);

    const idle = createInputFrame();
    runTicks(w, PLACE_TICKS + 2, inputs({ 0: idle }));
    expect(p.heldBall).toBe(-1);
    expect(w.balls[ballId]!.state).toBe(BallState.Grounded);

    const pick = createInputFrame();
    step(w, inputs({ 0: pick }), { mode: 'authoritative' });
    pick.buttons = Button.Pickup;
    step(w, inputs({ 0: pick }), { mode: 'authoritative' });
    expect(p.action).toBe(ActionState.PickingUp);

    runTicks(w, PICKUP_TICKS + 2, inputs({ 0: idle }));
    expect(p.heldBall).toBe(ballId);
  });

  it('will not pick up a ball that is out of reach', () => {
    const w = makeWorld();
    const thrower = spawnPlayer(w, { x: 500, y: 600 })!;
    giveBall(w, 0);
    const place = createInputFrame();
    place.buttons = Button.Place;
    step(w, inputs({ 0: place }), { mode: 'authoritative' });
    runTicks(w, PLACE_TICKS + 2, inputs({ 0: createInputFrame() }));

    // Walk well away, then try to pick up.
    const away = createInputFrame();
    away.moveX = 1;
    runTicks(w, 60, inputs({ 0: away }));

    const pick = createInputFrame();
    pick.buttons = Button.Pickup;
    step(w, inputs({ 0: pick }), { mode: 'authoritative' });
    expect(thrower.action).not.toBe(ActionState.PickingUp);
    expect(thrower.heldBall).toBe(-1);
  });
});

describe('hits', () => {
  it('damages and staggers a target hit by a thrown ball', () => {
    const w = makeWorld();
    const thrower = spawnPlayer(w, { x: 300, y: 600 })!;
    const target = spawnPlayer(w, { x: 500, y: 600, isDummy: true })!;
    const startHp = target.hp;

    // Hand the thrower a ball directly rather than packing, to keep the test
    // focused on the collision path.
    const f = createInputFrame();
    f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
    validateInput(f);
    while (thrower.heldBall < 0) step(w, inputs({ 0: f }), { mode: 'authoritative' });

    const throwF = createInputFrame();
    throwF.buttons = Button.Throw;
    throwF.throwPower = 0.55;
    throwF.aim = 0; // straight along +x toward the dummy
    step(w, inputs({ 0: throwF }), { mode: 'authoritative' });

    let hits = 0;
    const idle = createInputFrame();
    for (let i = 0; i < 90; i++) {
      const evs = step(w, inputs({ 0: idle }), { mode: 'authoritative' });
      hits += evs.filter((e) => e.type === SimEventType.Hit).length;
    }

    expect(hits).toBeGreaterThanOrEqual(1);
    expect(target.hp).toBeLessThan(startHp);
    expect(target.staggerAmount).toBeGreaterThan(0);
  });

  it('does not let a fast ball tunnel through a target', () => {
    // Regression guard for swept collision, isolated from arc geometry: the ball
    // is placed in flight directly, flat and at body height, so the only thing
    // under test is whether a ball moving further per tick than a player is wide
    // still registers. At 30Hz a max-speed ball covers 30 units per tick against
    // a 17-unit radius, so a point-in-circle test misses most of these.
    const trials = 40;
    let hits = 0;

    // 140 units at 900 u/s is ~4.7 ticks -- close enough that gravity has barely
    // acted, so the ball is unambiguously inside the body band on arrival and a
    // miss can only mean tunnelling.
    for (let i = 0; i < trials; i++) {
      const w = makeEmptyWorld();
      const target = spawnPlayer(w, { x: 340, y: 400, isDummy: true })!;

      const b = allocBall(w)!;
      b.state = BallState.Flight;
      b.size = BallSize.Normal;
      b.owner = 99; // nobody, so owner immunity cannot mask a miss
      b.team = TEAM_NONE;
      // Sub-tick phase offset across one full tick of travel: a tunnelling bug
      // shows up as misses at specific offsets rather than uniformly.
      b.x = 200 + i * (30 / trials);
      b.y = 400;
      b.z = 30;
      b.vx = THROW_MAX_SPEED;
      b.vy = 0;
      b.vz = 0;
      b.stateTick = w.tick;

      const idle = createInputFrame();
      let hit = false;
      for (let k = 0; k < 12 && !hit; k++) {
        const evs = step(w, inputs({ 0: idle }), { mode: 'authoritative' });
        if (evs.some((e) => e.type === SimEventType.Hit && e.id === target.id)) hit = true;
      }
      if (hit) hits++;
    }

    expect(hits).toBe(trials);
  });

  it('lets a ball fly over a target when it is above body height', () => {
    // The complement of the test above: the vertical gate must actually gate.
    // Kept deliberately short-range, because over a longer flight gravity would
    // bring the ball down into the body band and the pass would be meaningless.
    const w = makeEmptyWorld();
    const target = spawnPlayer(w, { x: 340, y: 400, isDummy: true })!;
    const startHp = target.hp;

    const b = allocBall(w)!;
    b.state = BallState.Flight;
    b.size = BallSize.Normal;
    b.owner = 99;
    b.team = TEAM_NONE;
    b.x = 200;
    b.y = 400;
    b.z = 140; // well clear of a 58-unit body
    b.vx = THROW_MAX_SPEED;
    b.vy = 0;
    b.vz = 0;
    b.stateTick = w.tick;

    const idle = createInputFrame();
    for (let k = 0; k < 8; k++) step(w, inputs({ 0: idle }), { mode: 'authoritative' });
    expect(target.x).toBe(340);
    expect(target.hp).toBe(startHp);
  });

  it('cannot hit its own thrower immediately after release', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    const f = createInputFrame();
    f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
    validateInput(f);
    while (p.heldBall < 0) step(w, inputs({ 0: f }), { mode: 'authoritative' });

    const t = createInputFrame();
    t.buttons = Button.Throw;
    t.throwPower = 0.1;
    t.aim = 0;
    step(w, inputs({ 0: t }), { mode: 'authoritative' });

    const idle = createInputFrame();
    let selfHits = 0;
    for (let i = 0; i < 40; i++) {
      const evs = step(w, inputs({ 0: idle }), { mode: 'authoritative' });
      selfHits += evs.filter((e) => e.type === SimEventType.Hit && e.id === p.id).length;
    }
    expect(selfHits).toBe(0);
  });
});

describe('determinism', () => {
  it('produces an identical world hash from the same seed and input script', () => {
    // This is the guard that makes client-side prediction safe: replaying the
    // same inputs from the same state must land in the same place, or
    // reconciliation would fight itself every snapshot.
    const runOnce = (): number[] => {
      const w = createWorld(0xc0ffee, MAP_ARENA01.bounds);
      w.props = MAP_ARENA01.props.map((p) => ({ ...p }));
      spawnPlayer(w, { x: 300, y: 400 });
      spawnPlayer(w, { x: 700, y: 400 });
      spawnPlayer(w, { x: 500, y: 250, isDummy: true });

      const hashes: number[] = [];
      const a = createInputFrame();
      const b = createInputFrame();

      for (let t = 0; t < 1200; t++) {
        // A scripted, deterministic input pattern that exercises every action.
        a.moveX = Math.sin(t * 0.05);
        a.moveY = Math.cos(t * 0.037);
        a.aim = t * 0.02;
        a.packDelta = t % 3 === 0 ? 0.03 : 0;
        a.buttons = t % 97 === 0 ? Button.Throw : 0;
        a.throwPower = 0.8;

        b.moveX = Math.cos(t * 0.041);
        b.moveY = Math.sin(t * 0.06);
        b.aim = Math.PI - t * 0.015;
        b.packDelta = t % 4 === 0 ? 0.03 : 0;
        b.buttons = t % 89 === 0 ? Button.Throw : t % 53 === 0 ? Button.Place : 0;
        b.throwPower = 0.55;

        step(w, inputs({ 0: a, 1: b }), { mode: 'authoritative' });
        if (t % 100 === 0) hashes.push(hashWorld(w));
      }
      hashes.push(hashWorld(w));
      return hashes;
    };

    const first = runOnce();
    const second = runOnce();
    expect(second).toEqual(first);
    // Sanity: the world must actually be evolving, or this test proves nothing.
    expect(new Set(first).size).toBeGreaterThan(5);
  });

  it('never leaks ball slots over a long run', () => {
    const w = makeWorld();
    spawnPlayer(w, { x: 500, y: 400 });
    const f = createInputFrame();
    const before = w.freeBalls.length;

    for (let t = 0; t < 3000; t++) {
      f.packDelta = 0.05;
      f.buttons = t % 20 === 0 ? Button.Throw : 0;
      f.throwPower = 0.9;
      f.aim = t * 0.1;
      validateInput(f);
      step(w, inputs({ 0: f }), { mode: 'authoritative' });
    }

    const live = w.balls.filter((b) => b.alive).length;
    expect(w.freeBalls.length + live).toBe(before);
    // No duplicate ids on the free list -- a double-free would be silent
    // corruption otherwise.
    expect(new Set(w.freeBalls).size).toBe(w.freeBalls.length);
  });
});

describe('predict mode', () => {
  it('only advances the local player', () => {
    const w = makeWorld();
    const local = spawnPlayer(w, { x: 300, y: 400 })!;
    const remote = spawnPlayer(w, { x: 700, y: 400 })!;

    const f = createInputFrame();
    f.moveX = 1;
    const remoteStartX = remote.x;

    for (let i = 0; i < 20; i++) {
      step(w, inputs({ 0: f, 1: f }), { mode: 'predict', localPlayerId: 0 });
    }

    expect(local.x).toBeGreaterThan(300);
    // The remote player is interpolated from snapshots, never predicted.
    expect(remote.x).toBe(remoteStartX);
  });
});
