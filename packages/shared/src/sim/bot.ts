/**
 * Bots.
 *
 * A bot is a DRIVER, not a special kind of entity. It produces the same
 * `InputFrame` a thumb produces and hands it to the same simulation, which has
 * three useful consequences:
 *
 *  - the sim needs no bot-awareness at all;
 *  - anything a bot can do, a player can do, and vice versa;
 *  - a headless test can play a whole match by running bots for every slot.
 *
 * Bot state deliberately lives OUTSIDE the World, for the same reason a human's
 * thumb does. Each brain owns a seeded RNG so a match is reproducible, but the
 * simulation's own determinism does not depend on bots existing.
 *
 * Where to go comes from `mode.botObjective`, so no mode-specific knowledge lives
 * here. This file knows how to fight; the mode knows what winning means.
 */

import {
  MAX_PACK_ROTATIONS_PER_SEC,
  PICKUP_RADIUS,
  THROW_MAX_SPEED,
  THROW_MIN_SPEED,
  TICK_DT,
  Y_SQUASH,
} from '../constants.js';
import { clamp01, wrapPi } from '../math/angle.js';
import { createRng, nextFloat, nextRange, type RngState } from '../math/rng.js';
import { Button, createInputFrame, resetInputFrame, type InputFrame } from '../input/inputFrame.js';
import { MatchPhase } from './types.js';
import { findGroundedBallNear } from './player.js';
import type { Player, World } from './world.js';
import { nearestEnemy } from '../modes/common.js';

/** How close a bot tries to get before throwing. */
const PREFERRED_RANGE = 210;
const RANGE_TOLERANCE = 60;

export interface BotBrain {
  playerId: number;
  rng: RngState;
  frame: InputFrame;
  /** Ticks left before the bot re-decides, so it does not dither every tick. */
  thinkCooldown: number;
  /** Random strafe direction, refreshed on each decision. */
  strafe: number;
  /** Aim error in radians, refreshed per throw, so bots miss like people do. */
  aimJitter: number;
  /** 0 = perfect, 1 = hopeless. Scales reaction time and accuracy. */
  sloppiness: number;
}

export function createBotBrain(playerId: number, seed: number, sloppiness = 0.45): BotBrain {
  return {
    playerId,
    rng: createRng(seed * 2654435761 + playerId * 40503 + 1),
    frame: createInputFrame(),
    thinkCooldown: 0,
    strafe: 1,
    aimJitter: 0,
    sloppiness: clamp01(sloppiness),
  };
}

/**
 * Produce this tick's input for a bot.
 *
 * Returns the brain's own reusable frame; the caller should feed it straight into
 * the input map without holding on to it.
 */
export function botInput(w: World, brain: BotBrain, seq: number): InputFrame {
  const p = w.players[brain.playerId];
  const f = resetInputFrame(brain.frame);
  f.seq = seq;
  if (!p?.active || !p.alive) return f;

  // Periodically re-roll the small random choices, rather than every tick, so
  // movement reads as intent instead of vibration.
  if (brain.thinkCooldown-- <= 0) {
    brain.thinkCooldown = Math.round(nextRange(brain.rng, 12, 30));
    brain.strafe = nextFloat(brain.rng) > 0.5 ? 1 : -1;
    // Aim error shrinks with skill and grows with distance (applied below).
    brain.aimJitter = nextRange(brain.rng, -1, 1) * 0.16 * (0.3 + brain.sloppiness);
  }

  // ---- pick something to head toward --------------------------------------
  let goalX = p.x;
  let goalY = p.y;
  let hasGoal = w.mode.botObjective(w, p, objectiveOut);
  if (hasGoal) {
    goalX = objectiveOut.x;
    goalY = objectiveOut.y;
  }

  // ---- pick something to shoot at -----------------------------------------
  const target = nearestEnemy(w, p);
  const targetDist = target ? Math.hypot(target.x - p.x, target.y - p.y) : Infinity;

  // Aim at whoever is closest, leading them slightly. Without lead, bots
  // consistently miss anyone who is moving, which reads as broken rather than easy.
  if (target) {
    const lead = 0.32 * (1 - brain.sloppiness * 0.6);
    const px = target.x + target.vx * lead;
    const py = target.y + target.vy * lead;
    f.aim = wrapPi(Math.atan2(py - p.y, px - p.x) + brain.aimJitter);
  } else if (hasGoal) {
    f.aim = Math.atan2(goalY - p.y, goalX - p.x);
  }

  // ---- snowball management ------------------------------------------------
  const canFight = w.match.phase === MatchPhase.Playing;

  if (p.heldBall < 0) {
    // Prefer picking up a ball that is already lying there over packing a new one.
    if (findGroundedBallNear(w, p.x, p.y, PICKUP_RADIUS) >= 0) {
      f.buttons |= Button.Pickup;
    } else {
      // Pack, at a rate scaled by skill. A perfect bot packs at the human cap.
      f.packDelta = MAX_PACK_ROTATIONS_PER_SEC * TICK_DT * (1 - brain.sloppiness * 0.5);
    }
  } else if (canFight && target && targetDist < 430) {
    // Throw power chosen for the distance, using the same arc the game uses.
    f.throwPower = powerForDistance(targetDist);
    // Hesitate a little, so bots do not all fire on the exact same tick.
    if (nextFloat(brain.rng) < 0.5 - brain.sloppiness * 0.25) f.buttons |= Button.Throw;
  }

  // ---- movement ------------------------------------------------------------
  let mx = 0;
  let my = 0;

  if (target && targetDist < PREFERRED_RANGE - RANGE_TOLERANCE) {
    // Too close: back off while strafing, which also makes them harder to hit.
    mx = (p.x - target.x) / targetDist;
    my = ((p.y - target.y) / targetDist) * Y_SQUASH;
  } else if (target && targetDist > PREFERRED_RANGE + RANGE_TOLERANCE && !hasGoal) {
    mx = (target.x - p.x) / targetDist;
    my = ((target.y - p.y) / targetDist) * Y_SQUASH;
  } else if (hasGoal) {
    const dx = goalX - p.x;
    const dy = goalY - p.y;
    const d = Math.hypot(dx, dy);
    if (d > 26) {
      mx = dx / d;
      my = (dy / d) * Y_SQUASH;
    }
  }

  // A constant sideways component, so bots are not stationary targets.
  const perpX = -my;
  const perpY = mx;
  mx += perpX * 0.45 * brain.strafe;
  my += perpY * 0.45 * brain.strafe;

  const m = Math.hypot(mx, my);
  if (m > 1e-4) {
    f.moveX = mx / m;
    f.moveY = my / m;
  }

  return f;
}

const objectiveOut = { x: 0, y: 0 };

/**
 * Pick a throw power that lands at roughly `dist`.
 *
 * Solved from the same arc the simulation integrates, rather than tuned by feel,
 * so bots are affected by a change to the throw constants exactly as players are.
 * Range for a launch at speed s is approximately
 * `s * Y_SQUASH_ADJUSTED * (v0z + sqrt(v0z^2 + 2*g*h0)) / g`, but a monotonic
 * bisection over the real formula is simpler to keep correct than an inversion.
 */
export function powerForDistance(dist: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (estimateRange(mid) < dist) lo = mid;
    else hi = mid;
  }
  // Bias slightly long: falling short is a guaranteed miss, whereas overshooting
  // still passes through the target's body band on the way down.
  return clamp01((lo + hi) / 2 + 0.04);
}

/** Ground range of a throw at this power, in world units. */
function estimateRange(power: number): number {
  const speed = THROW_MIN_SPEED + (THROW_MAX_SPEED - THROW_MIN_SPEED) * clamp01(power);
  const vz = speed * 0.28; // LOB_RATIO
  const h0 = 40; // THROW_RELEASE_HEIGHT
  const g = 900;
  const t = (vz + Math.sqrt(vz * vz + 2 * g * h0)) / g;
  return speed * t;
}
