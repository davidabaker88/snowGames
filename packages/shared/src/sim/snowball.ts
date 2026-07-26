/**
 * Snowball lifecycle: launch, integrate, collide, land, melt.
 *
 * Held / Flight / Grounded is ONE entity lifecycle rather than two systems, so
 * pack -> hold -> throw -> land -> pick up -> throw again all reuse the same
 * record. That is what makes "set a ball down for later" work without any
 * special-case inventory code.
 */

import {
  AIR_DRAG,
  BALL_BOUNCE_DAMPING,
  BALL_DAMAGE_BIG,
  BALL_DAMAGE_NORMAL,
  BALL_DAMAGE_SMALL,
  BALL_GROUND_FRICTION,
  BALL_RADIUS_BIG,
  BALL_RADIUS_NORMAL,
  BALL_RADIUS_SMALL,
  BALL_REST_SPEED,
  GRAVITY,
  GROUND_LIFETIME_TICKS,
  IMPACT_SPEED_MAX,
  IMPACT_SPEED_MIN,
  LOB_RATIO,
  OWNER_IMMUNE_TICKS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  STAGGER_TICKS,
  THROW_MAX_SPEED,
  THROW_MIN_SPEED,
  THROW_RELEASE_HEIGHT,
  TICK_DT,
  TILE_SIZE,
  WALL_DAMAGE_BASE,
  Y_SQUASH,
} from '../constants.js';
import { clamp01, invLerp, lerp } from '../math/angle.js';
import { makeSweepResult, sweptCircleHit } from './collision.js';
import { ActionState, BallSize, BallState, SimEventType } from './types.js';
import { freeBall, pushEvent, type Ball, type Player, type World } from './world.js';
import { createModeCtx } from '../modes/ctx.js';
import {
  damageWall,
  makeWallDamageResult,
  tileAtWorld,
  tileCenterX,
  tileCenterY,
  wallHeightAt,
} from './walls.js';

export function ballRadius(size: BallSize): number {
  return size === BallSize.Small
    ? BALL_RADIUS_SMALL
    : size === BallSize.Big
      ? BALL_RADIUS_BIG
      : BALL_RADIUS_NORMAL;
}

export function ballBaseDamage(size: BallSize): number {
  return size === BallSize.Small
    ? BALL_DAMAGE_SMALL
    : size === BallSize.Big
      ? BALL_DAMAGE_BIG
      : BALL_DAMAGE_NORMAL;
}

/**
 * Launch a held ball.
 *
 * `power` in [0,1] maps to speed, and vertical velocity is a fixed ratio of
 * speed, which is what makes the arc predictable enough to aim by eye: a harder
 * throw is both faster AND higher, so it clears taller cover.
 */
export function launchBall(w: World, b: Ball, thrower: Player, aim: number, power: number): void {
  launchBallFrom(w, b, thrower, thrower.x, thrower.y, aim, power);
}

/**
 * Launch from an explicit origin rather than from wherever the thrower is now.
 *
 * Exists for lag compensation: a laggy player's snowball should leave from where
 * they actually were when they flicked, not from where the host has since moved
 * them to. See `LagComp` in `step.ts`.
 */
export function launchBallFrom(
  w: World,
  b: Ball,
  thrower: Player,
  originX: number,
  originY: number,
  aim: number,
  power: number,
  /**
   * Set false when the caller will fast-forward the ball and wants the event to
   * describe where it ENDED UP. The event position drives the release puff, so
   * emitting it before a catch-up would put the puff at a position the ball has
   * already left -- for a lagged player, a couple of body-widths behind the hand.
   */
  emitEvent = true,
): void {
  const speed = lerp(THROW_MIN_SPEED, THROW_MAX_SPEED, clamp01(power));
  b.state = BallState.Flight;
  b.owner = thrower.id;
  b.team = thrower.team;
  b.stateTick = w.tick;

  // Start slightly ahead of the thrower so the ball does not clip their own body.
  const off = PLAYER_RADIUS + ballRadius(b.size) + 2;
  b.x = originX + Math.cos(aim) * off;
  b.y = originY + Math.sin(aim) * off * Y_SQUASH;
  b.z = THROW_RELEASE_HEIGHT;

  b.vx = Math.cos(aim) * speed;
  b.vy = Math.sin(aim) * speed * Y_SQUASH;
  b.vz = speed * LOB_RATIO;
  b.spin = 0;

  if (emitEvent) emitThrown(w, b, power, thrower.id);
}

export function emitThrown(w: World, b: Ball, power: number, throwerId: number): void {
  pushEvent(w, SimEventType.Thrown, b.id, b.x, b.y, b.z, power, throwerId);
}

/**
 * Advance a ball through `ticks` of pure ballistics: gravity and drag, no collision.
 *
 * This is the "fast-forward" half of lag compensation. Deliberately collision-free,
 * and that is the whole design rather than a shortcut: the ball is catching up
 * through time that has already happened, so testing it against where bodies are
 * NOW would be checking the wrong world, while testing it against where they were
 * would be shooter-style hit rewind -- which is exactly what this scheme avoids,
 * because a snowball is visibly in the air for the better part of a second and
 * "I was behind cover" would be a legitimate complaint.
 *
 * So the catch-up is ballistic, and from the current tick onward the ball collides
 * normally against present positions. Thrower-favoured spawn, victim-favoured hit.
 */
export function ballisticAdvance(b: Ball, ticks: number): void {
  const drag = 1 - AIR_DRAG * TICK_DT;
  for (let i = 0; i < ticks; i++) {
    if (b.state !== BallState.Flight) return;
    b.vx *= drag;
    b.vy *= drag;
    b.vz = b.vz * drag - GRAVITY * TICK_DT;

    const dx = b.vx * TICK_DT;
    const dy = b.vy * TICK_DT;
    b.x += dx;
    b.y += dy;
    b.z += b.vz * TICK_DT;
    b.spin += Math.sqrt(dx * dx + dy * dy) * 0.05;

    // A short throw can land inside the catch-up window. Stop at the ground and
    // leave the landing itself to the normal step, which knows how to bounce.
    if (b.z <= 0) {
      b.z = 0;
      return;
    }
  }
}

/** Set a held ball down on the ground in front of the player. */
export function placeBallAt(w: World, b: Ball, p: Player): void {
  const off = PLAYER_RADIUS + ballRadius(b.size) + 3;
  b.state = BallState.Grounded;
  b.owner = p.id;
  b.team = p.team;
  b.x = p.x + Math.cos(p.aim) * off;
  b.y = p.y + Math.sin(p.aim) * off * Y_SQUASH;
  b.z = 0;
  b.vx = 0;
  b.vy = 0;
  b.vz = 0;
  b.stateTick = w.tick;
  pushEvent(w, SimEventType.Placed, b.id, b.x, b.y, 0, 0, p.id);
}

const sweep = makeSweepResult();
const wallDamage = makeWallDamageResult();

export function stepBalls(w: World): void {
  for (const b of w.balls) {
    if (!b.alive) continue;

    if (b.state === BallState.Held) continue;

    if (b.state === BallState.Grounded) {
      stepGroundedBall(w, b);
      continue;
    }

    stepFlightBall(w, b);
  }
}

function stepGroundedBall(w: World, b: Ball): void {
  // Roll to a stop, then sit until it melts.
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  if (sp > 0) {
    const drop = BALL_GROUND_FRICTION * TICK_DT * 60;
    if (sp <= drop || sp < BALL_REST_SPEED) {
      b.vx = 0;
      b.vy = 0;
    } else {
      const s = (sp - drop) / sp;
      b.vx *= s;
      b.vy *= s;
      b.x += b.vx * TICK_DT;
      b.y += b.vy * TICK_DT;
      clampBallToBounds(w, b);
    }
  }

  if (w.tick - b.stateTick > GROUND_LIFETIME_TICKS) {
    pushEvent(w, SimEventType.Melted, b.id, b.x, b.y, 0);
    freeBall(w, b);
  }
}

/**
 * Advance one ball through one tick, in SUBSTEPS.
 *
 * Substepping is not optional here. A max-power ball covers ~30 units per tick
 * against a 32-unit wall tile and a 17-unit player radius, so a single test per
 * tick misses a wall roughly as often as it hits one -- and "my snowball went
 * through the fort" is the kind of bug that makes a mechanic feel fake.
 *
 * The substep length is capped by the smallest thing worth not missing.
 */
function stepFlightBall(w: World, b: Ball): void {
  const r = ballRadius(b.size);

  // Integrate velocity once for the whole tick; only position is substepped.
  const drag = 1 - AIR_DRAG * TICK_DT;
  b.vx *= drag;
  b.vy *= drag;
  b.vz = b.vz * drag - GRAVITY * TICK_DT;

  const dx = b.vx * TICK_DT;
  const dy = b.vy * TICK_DT;
  const dz = b.vz * TICK_DT;

  b.spin += Math.sqrt(dx * dx + dy * dy) * 0.05;

  const travel = Math.sqrt(dx * dx + dy * dy);
  const maxStep = Math.min(r, TILE_SIZE / 2);
  const steps = Math.max(1, Math.ceil(travel / maxStep));
  const inv = 1 / steps;

  const immune = w.tick - b.stateTick < OWNER_IMMUNE_TICKS;

  for (let s = 0; s < steps; s++) {
    const sx = dx * inv;
    const sy = dy * inv;
    const sz = dz * inv;

    // ---- swept player collision over this substep ---------------------------
    let hitPlayer: Player | null = null;
    let hitT = 1;

    for (const p of w.players) {
      if (!p.active || !p.alive) continue;
      if (p.id === b.owner && immune) continue;

      // Vertical gate: the ball must be inside the body height band, else it
      // sails overhead.
      const zAt = b.z + sz * 0.5;
      if (zAt > PLAYER_HEIGHT + r || zAt < -r) continue;

      const pdx = p.vx * TICK_DT * inv;
      const pdy = p.vy * TICK_DT * inv;
      sweptCircleHit(b.x, b.y, sx, sy, r, p.x, p.y, pdx, pdy, PLAYER_RADIUS, sweep);
      if (sweep.hit && sweep.t < hitT) {
        hitT = sweep.t;
        hitPlayer = p;
      }
    }

    if (hitPlayer) {
      applyHit(w, b, hitPlayer, b.x + sx * hitT, b.y + sy * hitT, b.z + sz * hitT);
      return;
    }

    b.x += sx;
    b.y += sy;
    b.z += sz;

    // ---- walls -------------------------------------------------------------
    // The ENTIRE "throw over a low wall" feature is this height comparison.
    // No special case, no separate low-wall type: a ball clears a wall exactly
    // when it is flying higher than that wall currently stands.
    const tile = tileAtWorld(w.walls, b.x, b.y);
    if (tile >= 0 && w.walls.tier[tile]! > 0 && b.z < wallHeightAt(w.walls, tile)) {
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
      const scale = 0.55 + 0.45 * invLerp(IMPACT_SPEED_MIN, IMPACT_SPEED_MAX, speed);
      const damage =
        WALL_DAMAGE_BASE * scale * (ballBaseDamage(b.size) / BALL_DAMAGE_NORMAL);

      damageWall(w.walls, tile, damage, wallDamage);
      pushEvent(w, SimEventType.WallHit, tile, b.x, b.y, b.z, speed, b.owner);
      if (wallDamage.destroyed) {
        pushEvent(
          w,
          SimEventType.WallDestroyed,
          tile,
          tileCenterX(w.walls, tile),
          tileCenterY(w.walls, tile),
          0,
          wallDamage.heightBefore,
          b.owner,
        );
      }
      freeBall(w, b);
      return;
    }

    // ---- props -------------------------------------------------------------
    let hitProp = false;
    for (const prop of w.props) {
      if (prop.radius <= 0) continue;
      if (b.z > prop.height) continue;
      const pdx = b.x - prop.x;
      const pdy = b.y - prop.y;
      const rr = prop.radius + r;
      if (pdx * pdx + pdy * pdy <= rr * rr) {
        hitProp = true;
        break;
      }
    }
    if (hitProp) {
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
      pushEvent(w, SimEventType.WallHit, -1, b.x, b.y, b.z, speed, b.owner);
      freeBall(w, b);
      return;
    }

    // ---- ground ------------------------------------------------------------
    if (b.z <= 0) {
      b.z = 0;
      const impact = Math.abs(b.vz);
      if (impact > 220) {
        // One visible bounce, then settle. Reads as a snowball skidding.
        b.vz = impact * BALL_BOUNCE_DAMPING;
        b.vx *= 0.7;
        b.vy *= 0.7;
        pushEvent(w, SimEventType.Bounced, b.id, b.x, b.y, 0, impact);
      } else {
        b.vz = 0;
        b.state = BallState.Grounded;
        b.stateTick = w.tick;
        b.vx *= 0.4;
        b.vy *= 0.4;
      }
      clampBallToBounds(w, b);
      return;
    }
  }

  clampBallToBounds(w, b);
}

function clampBallToBounds(w: World, b: Ball): void {
  const bo = w.bounds;
  const r = ballRadius(b.size);
  if (b.x < bo.minX + r) {
    b.x = bo.minX + r;
    b.vx = -b.vx * 0.3;
  } else if (b.x > bo.maxX - r) {
    b.x = bo.maxX - r;
    b.vx = -b.vx * 0.3;
  }
  if (b.y < bo.minY + r) {
    b.y = bo.minY + r;
    b.vy = -b.vy * 0.3;
  } else if (b.y > bo.maxY - r) {
    b.y = bo.maxY - r;
    b.vy = -b.vy * 0.3;
  }
}

function applyHit(w: World, b: Ball, victim: Player, x: number, y: number, z: number): void {
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
  const scale = 0.55 + 0.45 * invLerp(IMPACT_SPEED_MIN, IMPACT_SPEED_MAX, speed);

  // Ask the mode first. It may veto the hit entirely (friendly fire) or scale it
  // to nothing (warmup), and a vetoed ball should pass through rather than vanish
  // -- otherwise teammates can body-block for each other by accident.
  const verdict = w.mode.onPlayerHit(w, victim, b.owner);
  if (!verdict.allow) return;

  const damage = ballBaseDamage(b.size) * scale * verdict.damageMul;
  victim.hp -= damage;
  victim.staggerAmount = Math.min(1, victim.staggerAmount + 0.6 + scale * 0.4);

  // Knockback along the ball's travel direction, scaled by impact.
  const k = 60 + scale * 90;
  const sp2 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  if (sp2 > 1e-6) {
    victim.vx += (b.vx / sp2) * k;
    victim.vy += (b.vy / sp2) * k;
  }

  // Being hit interrupts whatever you were doing, and spills packing progress.
  victim.action = ActionState.Stagger;
  victim.actionTicks = 0;
  victim.packProgress = 0;
  void STAGGER_TICKS;

  pushEvent(w, SimEventType.Hit, victim.id, x, y, z, damage, b.owner);
  freeBall(w, b);

  if (victim.hp <= 0) {
    victim.hp = 0;
    if (victim.isDummy) {
      // Dummies are a training aid, not a participant: knock them over and reset.
      victim.respawnTicks = 1;
      victim.alive = false;
      victim.action = ActionState.Eliminated;
      victim.actionTicks = 0;
      pushEvent(w, SimEventType.Eliminated, victim.id, victim.x, victim.y, 0, 0, b.owner);
    } else {
      // Through the mode, so it can award the point, drop a carried flag and
      // decide whether this player comes back.
      createModeCtx(w).eliminate(victim, b.owner);
    }
  }
}
