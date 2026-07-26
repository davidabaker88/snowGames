/**
 * Player movement and the action state machine.
 *
 * Note what is NOT here: no reference to animation clips, no canvas, no timing
 * read from artwork. Action durations come from constants.ts and the animator
 * stretches clips to fit. That direction of dependency is load-bearing -- the
 * authoritative host runs this file with no renderer at all.
 */

import {
  ACCEL,
  BUILD_HP_PER_BALL,
  BUILD_REACH,
  BUILD_SPEED_MUL,
  BUILD_TICKS,
  BUILD_TRANSFER_TICK,
  CARRY_SPEED_MUL,
  TIER_MAX_HP,
  TILE_SIZE,
  Y_SQUASH,
  FRICTION,
  MOVE_Y_BIAS,
  PACKING_SPEED_MUL,
  PACK_DECAY_DELAY_TICKS,
  PACK_DECAY_PER_SEC,
  PACK_ROTATIONS_REQUIRED,
  PICKUP_RADIUS,
  PICKUP_TICKS,
  PICKUP_TRANSFER_TICK,
  PLACE_TICKS,
  PLACE_TRANSFER_TICK,
  PLAYER_RADIUS,
  STAGGER_TICKS,
  THROW_COOLDOWN_TICKS,
  THROW_TICKS,
  THROW_RELEASE_TICK,
  TICK_DT,
  TURN_RATE,
  WALK_SPEED,
  WINDUP_TICKS,
} from '../constants.js';
import { clamp, decayFactor, turnToward } from '../math/angle.js';
import { Button, hasButton, type InputFrame } from '../input/inputFrame.js';
import { resolveCircleOverlap } from './collision.js';
import { ActionState, BallState, SimEventType, type EntityId } from './types.js';
import { allocBall, freeBall, pushEvent, type Player, type World } from './world.js';
import {
  ballisticAdvance,
  emitThrown,
  launchBall,
  launchBallFrom,
  placeBallAt,
} from './snowball.js';
import type { LagComp, ThrowOrigin } from './step.js';
import {
  buildAt,
  makeCircleResolve,
  resolveCircleAgainstWalls,
  tileAtWorld,
  tileCenterX,
  tileCenterY,
  tileMinX,
  tileMinY,
  WallTier,
} from './walls.js';

const scratch = { x: 0, y: 0 };
const wallResolve = makeCircleResolve();

/** True when the action fully occupies the character and cannot be interrupted. */
function isBusy(a: ActionState): boolean {
  return (
    a === ActionState.WindUp ||
    a === ActionState.Throwing ||
    a === ActionState.Placing ||
    a === ActionState.PickingUp ||
    a === ActionState.Building ||
    a === ActionState.Stagger
  );
}

function actionDuration(a: ActionState): number {
  switch (a) {
    case ActionState.WindUp:
      return WINDUP_TICKS;
    case ActionState.Throwing:
      return THROW_TICKS;
    case ActionState.Placing:
      return PLACE_TICKS;
    case ActionState.PickingUp:
      return PICKUP_TICKS;
    case ActionState.Building:
      return BUILD_TICKS;
    case ActionState.Stagger:
      return STAGGER_TICKS;
    default:
      return 0;
  }
}

/**
 * The tile this player would build on: one reach-length ahead, along the aim.
 *
 * Returns -1 when there is nothing valid to build on -- off the grid, or a tile
 * with a player standing in it. Building someone into a box would be funny once
 * and infuriating forever, and it is also how you trap yourself.
 */
export function buildTargetTile(w: World, p: Player): number {
  const tx = p.x + Math.cos(p.aim) * BUILD_REACH;
  const ty = p.y + Math.sin(p.aim) * BUILD_REACH * Y_SQUASH;
  const i = tileAtWorld(w.walls, tx, ty);
  if (i < 0) return -1;

  // Already at maximum reinforcement -- nothing more to add.
  if (w.walls.tier[i] === WallTier.Reinforced && w.walls.hp[i]! >= TIER_MAX_HP[WallTier.Reinforced]!) {
    return -1;
  }

  const minX = tileMinX(w.walls, i);
  const minY = tileMinY(w.walls, i);
  for (const other of w.players) {
    if (!other.active || !other.alive) continue;
    // A player's own tile is excluded too, so you cannot wall up your own feet.
    if (
      other.x + PLAYER_RADIUS > minX &&
      other.x - PLAYER_RADIUS < minX + TILE_SIZE &&
      other.y + PLAYER_RADIUS > minY &&
      other.y - PLAYER_RADIUS < minY + TILE_SIZE
    ) {
      return -1;
    }
  }
  return i;
}

function setAction(p: Player, a: ActionState): void {
  if (p.action === a) return;
  p.action = a;
  p.actionTicks = 0;
}

function speedMultiplier(p: Player): number {
  switch (p.action) {
    case ActionState.Packing:
      return PACKING_SPEED_MUL;
    case ActionState.Building:
      return BUILD_SPEED_MUL;
    case ActionState.WindUp:
      return 0.6;
    case ActionState.Throwing:
      return 0.45;
    case ActionState.Placing:
    case ActionState.PickingUp:
      return 0.25;
    case ActionState.Stagger:
      return 0.15;
    default:
      // Carrying a flag slows you exactly like carrying a snowball does, so
      // grabbing an objective is a commitment rather than a free action.
      return p.heldBall >= 0 || p.carryingFlag >= 0 ? CARRY_SPEED_MUL : 1;
  }
}

/** Nearest grounded ball within pickup range, or -1. */
export function findGroundedBallNear(w: World, x: number, y: number, radius: number): EntityId {
  let best = -1;
  let bestD2 = radius * radius;
  for (const b of w.balls) {
    if (!b.alive || b.state !== BallState.Grounded) continue;
    const dx = b.x - x;
    const dy = b.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = b.id;
    }
  }
  return best;
}

export function stepPlayer(
  w: World,
  p: Player,
  input: InputFrame,
  lagComp?: LagComp,
): void {
  if (!p.active) return;

  if (!p.alive) {
    p.vx = 0;
    p.vy = 0;
    setAction(p, ActionState.Eliminated);
    p.actionTicks++;
    return;
  }

  if (p.throwCooldown > 0) p.throwCooldown--;
  p.staggerAmount *= decayFactor(0.18, TICK_DT);

  // ---- advance timed actions -------------------------------------------------
  const dur = actionDuration(p.action);
  if (dur > 0) {
    p.actionTicks++;

    // Mid-action transfer points. These read from constants, never from a clip.
    if (p.action === ActionState.Throwing && p.actionTicks === THROW_RELEASE_TICK) {
      releaseThrow(w, p, lagComp);
    } else if (p.action === ActionState.Placing && p.actionTicks === PLACE_TRANSFER_TICK) {
      doPlace(w, p);
    } else if (p.action === ActionState.PickingUp && p.actionTicks === PICKUP_TRANSFER_TICK) {
      doPickup(w, p);
    } else if (p.action === ActionState.Building && p.actionTicks === BUILD_TRANSFER_TICK) {
      doBuild(w, p);
    }

    if (p.actionTicks >= dur) {
      if (p.action === ActionState.WindUp) {
        setAction(p, ActionState.Throwing);
      } else {
        setAction(p, ActionState.Idle);
      }
    }
  } else {
    p.actionTicks++;
  }

  // ---- aim -------------------------------------------------------------------
  if (!p.isDummy) p.aim = input.aim;

  // ---- discrete actions ------------------------------------------------------
  if (!p.isDummy && !isBusy(p.action)) {
    if (hasButton(input, Button.Throw) && p.heldBall >= 0 && p.throwCooldown === 0) {
      p.pendingThrowPower = input.throwPower;
      setAction(p, ActionState.WindUp);
    } else if (hasButton(input, Button.Build) && p.heldBall >= 0) {
      // Building spends the held snowball, so packing feeds both offence and
      // defence out of one resource -- no separate economy to explain.
      // The mode gets a veto: build budgets and Fort Defense's build phase.
      if (buildTargetTile(w, p) >= 0 && w.mode.onBuildRequest(w, p)) {
        setAction(p, ActionState.Building);
      }
    } else if (hasButton(input, Button.Place) && p.heldBall >= 0) {
      setAction(p, ActionState.Placing);
    } else if (hasButton(input, Button.Pickup) && p.heldBall < 0) {
      const near = findGroundedBallNear(w, p.x, p.y, PICKUP_RADIUS);
      if (near >= 0) setAction(p, ActionState.PickingUp);
    }
  }

  // ---- packing ---------------------------------------------------------------
  // Only with empty hands: you cannot roll a new ball while holding one.
  const wantsPack = input.packDelta > 0 && p.heldBall < 0 && !isBusy(p.action);
  if (wantsPack) {
    p.packProgress += input.packDelta;
    p.packIdleTicks = 0;
    setAction(p, ActionState.Packing);

    if (p.packProgress >= PACK_ROTATIONS_REQUIRED) {
      p.packProgress = 0;
      const b = allocBall(w);
      if (b) {
        b.state = BallState.Held;
        b.owner = p.id;
        b.team = p.team;
        b.x = p.x;
        b.y = p.y;
        b.z = 0;
        b.vx = 0;
        b.vy = 0;
        b.vz = 0;
        b.stateTick = w.tick;
        p.heldBall = b.id;
        pushEvent(w, SimEventType.Packed, p.id, p.x, p.y, 0, 0, b.id);
      }
      setAction(p, ActionState.Idle);
    }
  } else if (p.packProgress > 0) {
    // Drain after a grace period, so progress cannot be parked indefinitely.
    p.packIdleTicks++;
    if (p.packIdleTicks > PACK_DECAY_DELAY_TICKS) {
      p.packProgress = Math.max(0, p.packProgress - PACK_DECAY_PER_SEC * TICK_DT);
    }
    if (p.action === ActionState.Packing) setAction(p, ActionState.Idle);
  }

  // ---- movement --------------------------------------------------------------
  const mul = speedMultiplier(p);
  let ix = p.isDummy ? 0 : input.moveX;
  let iy = p.isDummy ? 0 : input.moveY;

  // Compensate for the compressed Y axis so pushing "up" does not feel sluggish.
  iy *= MOVE_Y_BIAS;
  const im = Math.sqrt(ix * ix + iy * iy);
  if (im > 1) {
    ix /= im;
    iy /= im;
  }

  const targetVx = ix * WALK_SPEED * mul;
  const targetVy = iy * WALK_SPEED * mul;

  if (im > 0.01) {
    p.vx += clamp(targetVx - p.vx, -ACCEL * TICK_DT, ACCEL * TICK_DT);
    p.vy += clamp(targetVy - p.vy, -ACCEL * TICK_DT, ACCEL * TICK_DT);
  } else {
    const drop = FRICTION * TICK_DT;
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (sp <= drop) {
      p.vx = 0;
      p.vy = 0;
    } else {
      const s = (sp - drop) / sp;
      p.vx *= s;
      p.vy *= s;
    }
  }

  const dx = p.vx * TICK_DT;
  const dy = p.vy * TICK_DT;
  p.x += dx;
  p.y += dy;
  p.gaitDistance += Math.sqrt(dx * dx + dy * dy);

  // ---- facing ----------------------------------------------------------------
  // While aiming or throwing the body turns to the aim; otherwise it follows the
  // direction of travel.
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  let targetFacing = p.facing;
  if (p.action === ActionState.WindUp || p.action === ActionState.Throwing) {
    targetFacing = p.aim;
  } else if (speed > 8) {
    // Undo the Y compression so a character walking "up" faces up, not diagonally.
    targetFacing = Math.atan2(p.vy, p.vx);
  }
  p.facing = turnToward(p.facing, targetFacing, TURN_RATE * TICK_DT);

  // ---- walking vs idle -------------------------------------------------------
  if (!isBusy(p.action) && p.action !== ActionState.Packing) {
    setAction(p, speed > 12 ? ActionState.Walking : ActionState.Idle);
    // setAction resets actionTicks on change; for the idle/walk pair that would
    // restart the breathing cycle constantly, so keep it monotonic instead.
    if (p.action === ActionState.Walking || p.action === ActionState.Idle) {
      p.actionTicks = Math.max(p.actionTicks, 1);
    }
  }

  // ---- world bounds and props ------------------------------------------------
  const b = w.bounds;
  if (p.x < b.minX + PLAYER_RADIUS) {
    p.x = b.minX + PLAYER_RADIUS;
    p.vx = 0;
  }
  if (p.x > b.maxX - PLAYER_RADIUS) {
    p.x = b.maxX - PLAYER_RADIUS;
    p.vx = 0;
  }
  if (p.y < b.minY + PLAYER_RADIUS) {
    p.y = b.minY + PLAYER_RADIUS;
    p.vy = 0;
  }
  if (p.y > b.maxY - PLAYER_RADIUS) {
    p.y = b.maxY - PLAYER_RADIUS;
    p.vy = 0;
  }

  for (const prop of w.props) {
    if (prop.radius <= 0) continue;
    if (resolveCircleOverlap(p.x, p.y, PLAYER_RADIUS, prop.x, prop.y, prop.radius, scratch)) {
      p.x = scratch.x;
      p.y = scratch.y;
    }
  }

  // Walls. Velocity is zeroed only on the axis that was corrected, so running
  // along a wall keeps its tangential speed instead of grinding to a halt.
  if (resolveCircleAgainstWalls(w.walls, p.x, p.y, PLAYER_RADIUS, wallResolve)) {
    p.x = wallResolve.x;
    p.y = wallResolve.y;
    if (wallResolve.hitX) p.vx = 0;
    if (wallResolve.hitY) p.vy = 0;
  }

  // Carry the held ball with the hand.
  if (p.heldBall >= 0) {
    const held = w.balls[p.heldBall];
    if (held && held.alive) {
      held.x = p.x;
      held.y = p.y;
      held.z = 34;
    } else {
      p.heldBall = -1;
    }
  }
}

const throwOrigin: ThrowOrigin = { x: 0, y: 0, aim: 0 };

function releaseThrow(w: World, p: Player, lagComp?: LagComp): void {
  if (p.heldBall < 0) return;
  const b = w.balls[p.heldBall];
  if (!b || !b.alive) {
    p.heldBall = -1;
    return;
  }

  // Lag compensation, when the host supplies it: spawn where the thrower was when
  // they flicked, then fast-forward the ball through the time that has passed since.
  // The aim comes from the history too -- reusing the current aim would launch from
  // an old position along a new heading, which is neither what the player saw nor
  // what they asked for.
  const rewind = lagComp ? lagComp.rewindTicks(p.id) : 0;
  if (rewind > 0 && lagComp!.originAt(p.id, rewind, throwOrigin)) {
    launchBallFrom(
      w,
      b,
      p,
      throwOrigin.x,
      throwOrigin.y,
      throwOrigin.aim,
      p.pendingThrowPower,
      false,
    );
    ballisticAdvance(b, rewind);
    // Announced after the catch-up, so the release puff lands where the ball is.
    emitThrown(w, b, p.pendingThrowPower, p.id);
  } else {
    launchBall(w, b, p, p.aim, p.pendingThrowPower);
  }

  p.heldBall = -1;
  p.throwCooldown = THROW_COOLDOWN_TICKS;
  p.pendingThrowPower = 0;
}

function doPlace(w: World, p: Player): void {
  if (p.heldBall < 0) return;
  const b = w.balls[p.heldBall];
  if (!b || !b.alive) {
    p.heldBall = -1;
    return;
  }
  placeBallAt(w, b, p);
  p.heldBall = -1;
}

function doPickup(w: World, p: Player): void {
  if (p.heldBall >= 0) return;
  const id = findGroundedBallNear(w, p.x, p.y, PICKUP_RADIUS);
  if (id < 0) return;
  const b = w.balls[id];
  if (!b || !b.alive) return;
  b.state = BallState.Held;
  b.owner = p.id;
  b.team = p.team;
  b.vx = 0;
  b.vy = 0;
  b.vz = 0;
  b.stateTick = w.tick;
  p.heldBall = b.id;
  pushEvent(w, SimEventType.PickedUp, p.id, p.x, p.y, 0, 0, b.id);
}

function doBuild(w: World, p: Player): void {
  if (p.heldBall < 0) return;
  // Re-check the target: the player may have turned or walked during the channel,
  // or someone may have stepped into the tile.
  const i = buildTargetTile(w, p);
  if (i < 0) return;

  const b = w.balls[p.heldBall];
  if (!b || !b.alive) {
    p.heldBall = -1;
    return;
  }

  const tier = buildAt(w.walls, i, BUILD_HP_PER_BALL);
  p.heldBall = -1;
  freeBall(w, b);
  if (p.buildsRemaining > 0) p.buildsRemaining--;

  pushEvent(
    w,
    SimEventType.WallBuilt,
    i,
    tileCenterX(w.walls, i),
    tileCenterY(w.walls, i),
    0,
    tier,
    p.id,
  );
}

/** Drop whatever the player is holding, e.g. on elimination. */
export function dropHeld(w: World, p: Player): void {
  if (p.heldBall < 0) return;
  const b = w.balls[p.heldBall];
  p.heldBall = -1;
  if (!b || !b.alive) return;
  freeBall(w, b);
}
