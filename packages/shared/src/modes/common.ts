/**
 * Helpers shared by the modes.
 *
 * Anything that more than one mode needs lives here rather than being copied, so
 * that a fix to (say) spawn selection or the friendly-fire rule applies everywhere
 * at once.
 */

import { TICK_HZ } from '../constants.js';
import { MatchPhase, TEAM_NONE, type PlayerId, type TeamId } from '../sim/types.js';
import type { Player, World } from '../sim/world.js';
import { HIT_ALLOW, HIT_BLOCK, type HitVerdict, type ModeConfig, type Vec2Out } from './types.js';

export const TEAM_NAMES = ['Blue', 'Red', 'Green', 'Yellow'];
/** Kept in step with the renderer's team tints. */
export const TEAM_COLORS = ['#4d94d6', '#e2603f', '#5fb87a', '#e5b13d'];

export function teamName(t: TeamId): string {
  return TEAM_NAMES[t] ?? 'Nobody';
}

export function countAlive(w: World, team: TeamId = TEAM_NONE): number {
  let n = 0;
  for (const p of w.players) {
    if (!p.active || p.isDummy || !p.alive) continue;
    if (team !== TEAM_NONE && p.team !== team) continue;
    n++;
  }
  return n;
}

export function countActive(w: World, team: TeamId = TEAM_NONE): number {
  let n = 0;
  for (const p of w.players) {
    if (!p.active || p.isDummy) continue;
    if (team !== TEAM_NONE && p.team !== team) continue;
    n++;
  }
  return n;
}

/** The team with the fewest players, so joiners balance the match. */
export function weakestTeam(w: World, teams: number): TeamId {
  let best: TeamId = 0;
  let bestCount = Infinity;
  for (let t = 0; t < teams; t++) {
    const n = countActive(w, t);
    if (n < bestCount) {
      bestCount = n;
      best = t;
    }
  }
  return best;
}

/**
 * Pick the spawn point farthest from any living enemy.
 *
 * Spawning next to someone who is already aiming at you is the single most
 * annoying thing a respawn can do, and it is cheap to avoid with this many
 * candidate points.
 */
export function safestSpawn(
  w: World,
  candidates: readonly { x: number; y: number }[],
  forPlayer: Player,
  out: Vec2Out,
): void {
  let bestIdx = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    let nearest = Infinity;
    for (const other of w.players) {
      if (!other.active || !other.alive || other.id === forPlayer.id) continue;
      if (other.team !== TEAM_NONE && other.team === forPlayer.team) continue;
      nearest = Math.min(nearest, Math.hypot(other.x - c.x, other.y - c.y));
    }
    // No enemies at all: any point will do, so prefer the first for determinism.
    const score = nearest === Infinity ? 0 : nearest;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const chosen = candidates[bestIdx] ?? { x: 0, y: 0 };
  out.x = chosen.x;
  out.y = chosen.y;
}

/**
 * The default hit rule: no damage during warmup or after the match ends, and no
 * damage between teammates unless the mode enables friendly fire.
 *
 * Warmup returns `allow: true` with a zero multiplier rather than blocking, so
 * snowballs still visibly splat on people during the build phase -- blocking
 * outright makes them pass through, which looks broken.
 */
export function standardHit(
  w: World,
  victim: Player,
  attacker: PlayerId,
  cfg: ModeConfig,
): HitVerdict {
  if (w.match.phase !== MatchPhase.Playing) return { allow: true, damageMul: 0 };
  if (!victim.alive) return HIT_BLOCK;

  const shooter = w.players[attacker];
  if (
    !cfg.friendlyFire &&
    shooter?.active &&
    shooter.team !== TEAM_NONE &&
    shooter.team === victim.team &&
    shooter.id !== victim.id
  ) {
    return HIT_BLOCK;
  }
  return HIT_ALLOW;
}

/** Ticks as m:ss, for the HUD timer. */
export function formatClock(ticks: number): string {
  const total = Math.max(0, Math.ceil(ticks / TICK_HZ));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Highest team score, and whether it is shared. */
export function leadingTeam(w: World, teams: number): { team: TeamId; tied: boolean } {
  let best: TeamId = TEAM_NONE;
  let bestScore = -Infinity;
  let tied = false;
  for (let t = 0; t < teams; t++) {
    const s = w.match.teamScores[t] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      best = t;
      tied = false;
    } else if (s === bestScore) {
      tied = true;
    }
  }
  return { team: best, tied };
}

/** Highest-scoring living or dead player, for free-for-all results. */
export function leadingPlayer(w: World): PlayerId {
  let best: PlayerId = -1;
  let bestScore = -Infinity;
  for (const p of w.players) {
    if (!p.active || p.isDummy) continue;
    if (p.score > bestScore) {
      bestScore = p.score;
      best = p.id;
    }
  }
  return best;
}

/** Nearest living enemy, or null. */
export function nearestEnemy(w: World, p: Player): Player | null {
  let best: Player | null = null;
  let bestD2 = Infinity;
  for (const other of w.players) {
    if (!other.active || !other.alive || other.id === p.id) continue;
    if (other.team !== TEAM_NONE && other.team === p.team) continue;
    const d2 = (other.x - p.x) ** 2 + (other.y - p.y) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = other;
    }
  }
  return best;
}
