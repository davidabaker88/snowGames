/**
 * Last One Standing -- free-for-all elimination.
 *
 * The interesting design problem here is not the elimination rule, it is that
 * elimination modes stall. Two cautious players hiding behind opposite walls with
 * unlimited snow will never resolve, and the match just sits there.
 *
 * So the closing blizzard is not decoration: it is the mechanism that guarantees
 * the match ends. It damages anyone outside it and shrinks toward a small circle,
 * which forces the survivors together on a schedule the players can see.
 */

import { secondsToTicks, TICK_DT } from '../constants.js';
import { MatchPhase, SimEventType, TEAM_NONE, type PlayerId } from '../sim/types.js';
import type { Player, World } from '../sim/world.js';
import { MAP_ARENA01 } from '../map/arena01.js';
import { countAlive, formatClock, nearestEnemy, safestSpawn, standardHit } from './common.js';
import { HIT_BLOCK, type GameMode, type ModeCtx, type ModeHud, type Vec2Out, type WinResult } from './types.js';

/** Damage per second to anyone caught outside the blizzard. */
const RING_DPS = 11;
const RING_START_RADIUS = 620;
const RING_FINAL_RADIUS = 110;
const RING_DELAY = secondsToTicks(25);
const RING_CLOSE_SECONDS = 150;

export const LAST_ONE_STANDING: GameMode = {
  id: 'lastOneStanding',
  label: 'Last One Standing',
  blurb: 'Everyone for themselves. No respawns, and a closing blizzard.',
  config: {
    teams: 0,
    friendlyFire: true,
    respawnTicks: 0,
    timeLimitTicks: 0,
    scoreToWin: 0,
    buildBudget: -1,
    warmupTicks: secondsToTicks(3),
    suggestedBots: 5,
  },

  init(w: World) {
    const r = w.ring;
    r.active = true;
    r.x = (w.bounds.minX + w.bounds.maxX) / 2;
    r.y = (w.bounds.minY + w.bounds.maxY) / 2;
    r.radius = RING_START_RADIUS;
    r.targetRadius = RING_FINAL_RADIUS;
    r.delayTicks = RING_DELAY;
    r.shrinkPerTick =
      (RING_START_RADIUS - RING_FINAL_RADIUS) / secondsToTicks(RING_CLOSE_SECONDS);
  },

  assignTeam() {
    return TEAM_NONE;
  },

  spawnPoint(w: World, p: Player, out: Vec2Out) {
    safestSpawn(w, MAP_ARENA01.spawns, p, out);
  },

  onTick(w: World, ctx: ModeCtx) {
    if (w.match.phase !== MatchPhase.Playing) return;
    const r = w.ring;
    if (!r.active) return;

    if (r.delayTicks > 0) {
      r.delayTicks--;
    } else if (r.radius > r.targetRadius) {
      r.radius = Math.max(r.targetRadius, r.radius - r.shrinkPerTick);
    }

    // Outside the blizzard: steady damage, and an event so the client can tint the
    // screen. Players need to feel it immediately, not discover it at zero health.
    for (const p of w.players) {
      if (!p.active || !p.alive || p.isDummy) continue;
      const d = Math.hypot(p.x - r.x, p.y - r.y);
      if (d > r.radius) {
        ctx.damage(p, RING_DPS * TICK_DT, -1);
        if (w.tick % 15 === 0) ctx.emit(SimEventType.RingDamage, p.id, p.x, p.y);
      }
    }
  },

  onPlayerHit(w: World, victim: Player, attacker: PlayerId) {
    // Free-for-all, so no friendly fire rule applies -- but a player already out
    // must not keep soaking hits.
    if (!victim.alive) return HIT_BLOCK;
    return standardHit(w, victim, attacker, LAST_ONE_STANDING.config);
  },

  onEliminate(w: World, victim: Player, attacker: PlayerId, ctx: ModeCtx) {
    const shooter = w.players[attacker];
    if (shooter?.active && shooter.id !== victim.id) ctx.addPlayerScore(shooter, 1);
    // No respawn: being out is being out. That is the mode.
    victim.respawnTicks = 0;
  },

  onBuildRequest() {
    return true;
  },

  checkWin(w: World): WinResult | null {
    if (w.match.phase !== MatchPhase.Playing) return null;
    const alive = countAlive(w);
    if (alive > 1) return null;

    for (const p of w.players) {
      if (!p.active || p.isDummy || !p.alive) continue;
      return { team: TEAM_NONE, player: p.id, reason: `${p.name} is the last one standing` };
    }
    // Everyone went out on the same tick, e.g. both frozen by the blizzard.
    return { team: TEAM_NONE, player: -1, reason: 'Nobody survived the blizzard' };
  },

  hud(w: World, viewer: PlayerId, out: ModeHud) {
    const me = w.players[viewer];
    const alive = countAlive(w);
    out.title = 'Last One Standing';
    out.headline = `${alive} alive`;

    if (me?.active && !me.alive) {
      out.sub = 'You are out -- watching';
    } else if (w.ring.delayTicks > 0) {
      out.sub = `Blizzard closes in ${formatClock(w.ring.delayTicks)}`;
    } else if (w.ring.radius > w.ring.targetRadius) {
      out.sub = 'Blizzard closing';
    } else {
      out.sub = 'Blizzard fully closed';
    }

    out.teamScores.length = 0;
    out.banner = '';
  },

  botObjective(w: World, p: Player, out: Vec2Out) {
    // Staying inside the blizzard beats fighting: a bot that ignores the ring
    // simply dies to it, which makes the mode look broken rather than tense.
    const r = w.ring;
    if (r.active) {
      const d = Math.hypot(p.x - r.x, p.y - r.y);
      if (d > r.radius * 0.82) {
        out.x = r.x;
        out.y = r.y;
        return true;
      }
    }
    const target = nearestEnemy(w, p);
    if (!target) return false;
    out.x = target.x;
    out.y = target.y;
    return true;
  },
};
