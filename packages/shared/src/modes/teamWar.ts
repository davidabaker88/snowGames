/**
 * Team Snowball War -- team deathmatch.
 *
 * Built first of the competitive modes on purpose: it is the simplest mode that
 * exercises every part of the framework at once -- team assignment, team spawns,
 * the friendly-fire veto, respawning, team scoring and a score win condition. If
 * this works, the framework works, and the other modes are variations rather than
 * new machinery.
 */

import { secondsToTicks } from '../constants.js';
import { MatchPhase, TEAM_NONE, type PlayerId, type TeamId } from '../sim/types.js';
import type { Player, World } from '../sim/world.js';
import { MAP_ARENA01 } from '../map/arena01.js';
import {
  formatClock,
  leadingTeam,
  nearestEnemy,
  safestSpawn,
  standardHit,
  teamName,
  weakestTeam,
} from './common.js';
import type { GameMode, ModeCtx, ModeHud, Vec2Out, WinResult } from './types.js';

const SCORE_TO_WIN = 20;

export const TEAM_WAR: GameMode = {
  id: 'teamWar',
  label: 'Team Snowball War',
  blurb: 'Two teams, respawns on. First to 20 hits wins.',
  config: {
    teams: 2,
    friendlyFire: false,
    respawnTicks: secondsToTicks(4),
    timeLimitTicks: secondsToTicks(300),
    scoreToWin: SCORE_TO_WIN,
    buildBudget: -1,
    warmupTicks: secondsToTicks(3),
    suggestedBots: 5,
  },

  init(w: World) {
    w.match.teamScores[0] = 0;
    w.match.teamScores[1] = 0;
  },

  assignTeam(w: World, _p: Player): TeamId {
    return weakestTeam(w, 2);
  },

  spawnPoint(w: World, p: Player, out: Vec2Out) {
    const cluster = MAP_ARENA01.teamSpawns[p.team] ?? MAP_ARENA01.spawns;
    safestSpawn(w, cluster, p, out);
  },

  onTick() {
    /* no objectives beyond hitting people */
  },

  onPlayerHit(w: World, victim: Player, attacker: PlayerId) {
    return standardHit(w, victim, attacker, TEAM_WAR.config);
  },

  onEliminate(w: World, victim: Player, attacker: PlayerId, ctx: ModeCtx) {
    const shooter = w.players[attacker];
    if (shooter?.active && shooter.team !== TEAM_NONE && shooter.team !== victim.team) {
      ctx.addTeamScore(shooter.team, 1);
      ctx.addPlayerScore(shooter, 1);
    }
    // Everyone comes back; the mode's respawnTicks drives the timer.
    victim.respawnTicks = TEAM_WAR.config.respawnTicks;
  },

  onBuildRequest() {
    return true;
  },

  checkWin(w: World): WinResult | null {
    for (let t = 0; t < 2; t++) {
      if ((w.match.teamScores[t] ?? 0) >= SCORE_TO_WIN) {
        return { team: t, player: -1, reason: `${teamName(t)} reached ${SCORE_TO_WIN} hits` };
      }
    }
    if (w.match.phase === MatchPhase.Playing && w.match.timeRemainingTicks <= 0) {
      const lead = leadingTeam(w, 2);
      return lead.tied
        ? { team: TEAM_NONE, player: -1, reason: 'Time up -- a draw' }
        : { team: lead.team, player: -1, reason: `Time up -- ${teamName(lead.team)} ahead` };
    }
    return null;
  },

  hud(w: World, viewer: PlayerId, out: ModeHud) {
    const me = w.players[viewer];
    out.title = 'Team Snowball War';
    out.headline = `${w.match.teamScores[0] ?? 0} - ${w.match.teamScores[1] ?? 0}`;
    out.sub =
      me?.active && !me.alive
        ? `Back in ${Math.ceil(me.respawnTicks / 30)}`
        : `${formatClock(w.match.timeRemainingTicks)} left`;
    out.teamScores.length = 2;
    out.teamScores[0] = w.match.teamScores[0] ?? 0;
    out.teamScores[1] = w.match.teamScores[1] ?? 0;
    out.banner = '';
  },

  botObjective(w: World, p: Player, out: Vec2Out) {
    // Just hunt: the nearest enemy IS the objective in deathmatch.
    const target = nearestEnemy(w, p);
    if (!target) return false;
    out.x = target.x;
    out.y = target.y;
    return true;
  },
};
