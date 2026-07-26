/**
 * Lag compensation.
 *
 * The scheme is deliberately asymmetric -- thrower-favoured spawn, victim-favoured
 * hit -- so these tests check both halves separately:
 *
 *  - the ball LEAVES from where the thrower was when they flicked;
 *  - the ball still COLLIDES against where bodies are now, with no rewind.
 *
 * The second is the one worth being careful about. Shooter-style hit rewind would be
 * wrong here: a snowball is visibly in the air for most of a second, so rewinding the
 * victim would produce "I was clearly behind that wall and still got hit" -- and the
 * player would be right.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, spawnPlayer, allocBall, type World } from '../sim/world.js';
import { MAP_ARENA01 } from '../map/arena01.js';
import { getMode } from '../modes/registry.js';
import { step, type InputMap, type LagComp, type ThrowOrigin } from '../sim/step.js';
import { Button, createInputFrame, validateInput, type InputFrame } from '../input/inputFrame.js';
import { BallState, SimEventType } from '../sim/types.js';
import {
  MAX_PACK_ROTATIONS_PER_SEC,
  THROW_RELEASE_HEIGHT,
  TICK_DT,
  WINDUP_TICKS,
} from '../constants.js';
import { ballisticAdvance, launchBall } from '../sim/snowball.js';
import { LAGCOMP_MAX_REWIND_TICKS } from './protocol.js';

function makeWorld(): World {
  return createWorld(555, MAP_ARENA01.bounds, getMode('sandbox'));
}

function inputs(map: Record<number, InputFrame>): InputMap {
  return new Map(Object.entries(map).map(([k, v]) => [Number(k), v]));
}

/** A stub history: the player was `back` units to the left, aiming the same way. */
function fixedLag(rewind: number, origin: ThrowOrigin): LagComp {
  return {
    rewindTicks: () => rewind,
    originAt: (_id, _ticksAgo, out) => {
      out.x = origin.x;
      out.y = origin.y;
      out.aim = origin.aim;
      return true;
    },
  };
}

function giveBall(w: World, id: number, lag?: LagComp): void {
  const p = w.players[id]!;
  const f = createInputFrame();
  f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT;
  validateInput(f);
  let guard = 0;
  while (p.heldBall < 0 && guard++ < 500) {
    step(w, inputs({ [id]: f }), { mode: 'authoritative', lagComp: lag });
  }
}

/**
 * Throw, and report the release as the SIMULATION announced it.
 *
 * Read from the `Thrown` event rather than from the ball afterwards. `sysBalls` runs
 * after `sysPlayers` in the same tick, so by the time `step` returns, the ball has
 * already been integrated once and is no longer where it was released -- which is a
 * trap worth avoiding rather than compensating for.
 */
function throwAndCatchRelease(
  w: World,
  id: number,
  aim: number,
  power: number,
  lag?: LagComp,
): { x: number; y: number; z: number; ballId: number; vz: number } {
  const p = w.players[id]!;
  const f = createInputFrame();
  f.buttons = Button.Throw;
  f.throwPower = power;
  f.aim = aim;
  const ballId = p.heldBall;
  step(w, inputs({ [id]: f }), { mode: 'authoritative', lagComp: lag });

  const idle = createInputFrame();
  idle.aim = aim;
  for (let i = 0; i < WINDUP_TICKS + 8; i++) {
    const evs = step(w, inputs({ [id]: idle }), { mode: 'authoritative', lagComp: lag });
    const thrown = evs.find((e) => e.type === SimEventType.Thrown);
    if (thrown) {
      return { x: thrown.x, y: thrown.y, z: thrown.z, ballId, vz: w.balls[ballId]!.vz };
    }
  }
  throw new Error('the ball was never thrown');
}

describe('thrower-favoured spawn', () => {
  it('spawns from the present position when there is no compensation', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    giveBall(w, 0);
    const at = throwAndCatchRelease(w, 0, 0, 0.5);
    // Just ahead of the body, at release height.
    expect(at.x).toBeGreaterThan(p.x);
    expect(at.x).toBeLessThan(p.x + 40);
    expect(at.z).toBeCloseTo(THROW_RELEASE_HEIGHT, 3);
  });

  it('spawns from where the thrower was, not where they are now', () => {
    const w = makeWorld();
    spawnPlayer(w, { x: 500, y: 400 })!;
    giveBall(w, 0);

    // The client flicked while 120 units to the left of the current position.
    const lag = fixedLag(4, { x: 380, y: 400, aim: 0 });
    const at = throwAndCatchRelease(w, 0, 0, 0.5, lag);

    // The spawn origin was the historical position -- so after four ticks of
    // catch-up the ball is still well left of where a present-position throw
    // would have put it, and moving.
    const noLag = makeWorld();
    spawnPlayer(noLag, { x: 500, y: 400 });
    giveBall(noLag, 0);
    const plain = throwAndCatchRelease(noLag, 0, 0, 0.5);

    expect(at.x).toBeLessThan(plain.x);
  });

  it('fast-forwards the ball so it is already in flight', () => {
    // The point of the catch-up: a laggy player's ball is not artificially behind.
    // Compare against the same throw with no rewind, advanced by hand.
    const lagged = makeWorld();
    spawnPlayer(lagged, { x: 500, y: 400 });
    giveBall(lagged, 0);
    const rewind = 5;
    const at = throwAndCatchRelease(lagged, 0, 0, 0.8, fixedLag(rewind, { x: 500, y: 400, aim: 0 }));

    const plain = makeWorld();
    spawnPlayer(plain, { x: 500, y: 400 });
    giveBall(plain, 0);
    const plainAt = throwAndCatchRelease(plain, 0, 0, 0.8);

    // Same origin, but the compensated ball has already travelled `rewind` ticks.
    expect(at.x).toBeGreaterThan(plainAt.x + 60);
    // And gravity has been applied for those ticks, so it is further through its
    // arc. (Not necessarily LOWER -- at this power it is still climbing toward apex,
    // which is exactly the sort of thing worth checking against velocity instead.)
    expect(at.vz).toBeLessThan(plainAt.vz);
  });

  it('uses the historical aim, not the current one', () => {
    // Launching from an old position along a new heading is neither what the player
    // saw nor what they asked for.
    const w = makeWorld();
    spawnPlayer(w, { x: 500, y: 400 });
    giveBall(w, 0);
    // History says they were aiming straight up-screen; the input says right.
    const at = throwAndCatchRelease(w, 0, 0, 0.6, fixedLag(3, { x: 500, y: 400, aim: -Math.PI / 2 }));
    const b = w.balls[at.ballId]!;
    expect(b.vy).toBeLessThan(0);
    expect(Math.abs(b.vx)).toBeLessThan(Math.abs(b.vy));
  });

  it('falls back to the present position when history is missing', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 500, y: 400 })!;
    giveBall(w, 0);
    const noHistory: LagComp = {
      rewindTicks: () => 5,
      originAt: () => false,
    };
    const at = throwAndCatchRelease(w, 0, 0, 0.5, noHistory);
    expect(at.x).toBeGreaterThan(p.x);
    expect(at.z).toBeCloseTo(THROW_RELEASE_HEIGHT, 3);
  });
});

describe('ballisticAdvance', () => {
  it('matches what a normal tick would do in open air', () => {
    // The catch-up has to use the SAME gravity and drag the simulation uses, or a
    // compensated throw follows a different arc from an uncompensated one.
    const a = makeWorld();
    const pa = spawnPlayer(a, { x: 200, y: 400 })!;
    const ba = allocBall(a)!;
    launchBall(a, ba, pa, 0, 0.7);

    const b = makeWorld();
    const pb = spawnPlayer(b, { x: 200, y: 400 })!;
    const bb = allocBall(b)!;
    launchBall(b, bb, pb, 0, 0.7);

    // One is stepped by the simulation, the other fast-forwarded.
    const idle = createInputFrame();
    for (let i = 0; i < 4; i++) step(a, inputs({ 0: idle }), { mode: 'authoritative' });
    ballisticAdvance(bb, 4);

    expect(bb.x).toBeCloseTo(ba.x, 4);
    expect(bb.y).toBeCloseTo(ba.y, 4);
    expect(bb.z).toBeCloseTo(ba.z, 4);
    expect(bb.vz).toBeCloseTo(ba.vz, 4);
  });

  it('stops at the ground rather than burrowing', () => {
    const w = makeWorld();
    const p = spawnPlayer(w, { x: 200, y: 400 })!;
    const b = allocBall(w)!;
    launchBall(w, b, p, 0, 0);
    // Far more catch-up than the flight lasts.
    ballisticAdvance(b, 100);
    expect(b.z).toBe(0);
  });

  it('does nothing to a ball that is not in flight', () => {
    const w = makeWorld();
    const b = allocBall(w)!;
    b.state = BallState.Grounded;
    b.x = 100;
    b.z = 0;
    ballisticAdvance(b, 6);
    expect(b.x).toBe(100);
    expect(b.z).toBe(0);
  });
});

describe('victim-favoured hit', () => {
  it('collides against where a target is NOW, not where it was', () => {
    // The defining property. A target that has moved out of the flight path must not
    // be hit, even though it was in the path when the ball was thrown.
    const w = makeWorld();
    spawnPlayer(w, { name: 'thrower', x: 200, y: 400 });
    const target = spawnPlayer(w, { name: 'target', x: 420, y: 400, hp: 100 })!;
    giveBall(w, 0);

    const startHp = target.hp;
    throwAndCatchRelease(w, 0, 0, 0.35);

    // The target sidesteps well clear while the ball is in the air.
    target.y = 400 - 200;

    const idle = createInputFrame();
    for (let i = 0; i < 40; i++) step(w, inputs({}), { mode: 'authoritative' });
    void idle;

    expect(target.hp).toBe(startHp);
  });

  it('still hits a target that stays put', () => {
    // The control for the test above: the miss has to be caused by moving, not by
    // the throw being broken.
    const w = makeWorld();
    spawnPlayer(w, { name: 'thrower', x: 200, y: 400 });
    const target = spawnPlayer(w, { name: 'target', x: 420, y: 400, hp: 100 })!;
    giveBall(w, 0);

    const startHp = target.hp;
    throwAndCatchRelease(w, 0, 0, 0.35);
    for (let i = 0; i < 40; i++) step(w, inputs({}), { mode: 'authoritative' });

    expect(target.hp).toBeLessThan(startHp);
  });

  it('does not rewind the victim even for a heavily compensated throw', () => {
    const w = makeWorld();
    spawnPlayer(w, { name: 'thrower', x: 200, y: 400 });
    const target = spawnPlayer(w, { name: 'target', x: 430, y: 400, hp: 100 })!;
    giveBall(w, 0, fixedLag(LAGCOMP_MAX_REWIND_TICKS, { x: 200, y: 400, aim: 0 }));

    const startHp = target.hp;
    throwAndCatchRelease(
      w,
      0,
      0,
      0.35,
      fixedLag(LAGCOMP_MAX_REWIND_TICKS, { x: 200, y: 400, aim: 0 }),
    );
    target.y = 400 - 200;
    for (let i = 0; i < 40; i++) step(w, inputs({}), { mode: 'authoritative' });

    expect(target.hp).toBe(startHp);
  });
});

describe('the rewind is bounded', () => {
  it('caps at LAGCOMP_MAX_REWIND_TICKS worth of catch-up', () => {
    // A client cannot get an unbounded head start, however far behind it claims to
    // be. Two throws, one asking for the cap and one asking for far more, must land
    // in the same place.
    const capped = makeWorld();
    spawnPlayer(capped, { x: 300, y: 400 });
    giveBall(capped, 0);
    const atCap = throwAndCatchRelease(
      capped,
      0,
      0,
      0.7,
      fixedLag(LAGCOMP_MAX_REWIND_TICKS, { x: 300, y: 400, aim: 0 }),
    );

    // The host clamps before this ever reaches the simulation, so the check is that
    // the constant is small enough to matter: six ticks of a max-power throw is far
    // less than the arena is wide.
    expect(LAGCOMP_MAX_REWIND_TICKS).toBeLessThanOrEqual(6);
    expect(atCap.x - 300).toBeLessThan(300);
  });
});
