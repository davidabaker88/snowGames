/**
 * Capture the Flag.
 *
 * The only mode with a real object state machine: a flag is AtBase, Carried or
 * Dropped, and every transition has a rule. Three of those rules exist to stop
 * specific degenerate play rather than to add features:
 *
 *  - A dropped flag RETURNS ITSELF after a while, so a flag knocked into a corner
 *    does not take the objective out of the match permanently.
 *  - Carrying SLOWS you and blocks building, so grabbing the flag is a commitment
 *    rather than a free action.
 *  - You must have YOUR OWN flag at home to score, so a mutual grab becomes a
 *    standoff that has to be resolved instead of two simultaneous captures.
 */

import { secondsToTicks } from '../constants.js';
import {
  FlagState,
  MatchPhase,
  SimEventType,
  TEAM_NONE,
  type PlayerId,
  type TeamId,
} from '../sim/types.js';
import type { Flag, Player, World } from '../sim/world.js';
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

const CAPTURES_TO_WIN = 3;
const PICKUP_RANGE = 30;
const CAPTURE_RANGE = 40;
const DROPPED_RETURN_TICKS = secondsToTicks(25);

export const CAPTURE_THE_FLAG: GameMode = {
  id: 'captureTheFlag',
  label: 'Capture the Flag',
  blurb: "Steal their flag and bring it home. Yours must be at base to score.",
  config: {
    teams: 2,
    friendlyFire: false,
    respawnTicks: secondsToTicks(5),
    timeLimitTicks: secondsToTicks(360),
    scoreToWin: CAPTURES_TO_WIN,
    buildBudget: -1,
    warmupTicks: secondsToTicks(3),
    suggestedBots: 5,
  },

  init(w: World) {
    w.match.teamScores[0] = 0;
    w.match.teamScores[1] = 0;

    MAP_ARENA01.flagBases.forEach((base, team) => {
      const f = w.flags[team];
      if (!f) return;
      f.active = true;
      f.team = team;
      f.state = FlagState.AtBase;
      f.baseX = base.x;
      f.baseY = base.y;
      f.x = base.x;
      f.y = base.y;
      f.carrier = -1;
      f.returnTicks = 0;
    });
  },

  assignTeam(w: World): TeamId {
    return weakestTeam(w, 2);
  },

  spawnPoint(w: World, p: Player, out: Vec2Out) {
    const cluster = MAP_ARENA01.teamSpawns[p.team] ?? MAP_ARENA01.spawns;
    safestSpawn(w, cluster, p, out);
  },

  onTick(w: World, ctx: ModeCtx) {
    if (w.match.phase !== MatchPhase.Playing) return;

    for (const f of w.flags) {
      if (!f.active) continue;

      switch (f.state) {
        case FlagState.Carried: {
          const carrier = w.players[f.carrier];
          if (!carrier?.active || !carrier.alive) {
            // Carrier died or left between ticks; drop where they stood.
            dropFlag(w, f, carrier?.x ?? f.x, carrier?.y ?? f.y, ctx);
            break;
          }
          f.x = carrier.x;
          f.y = carrier.y;
          tryCapture(w, f, carrier, ctx);
          break;
        }

        case FlagState.Dropped: {
          f.returnTicks--;
          if (f.returnTicks <= 0) {
            returnFlag(w, f, ctx);
            break;
          }
          pickupChecks(w, f, ctx);
          break;
        }

        case FlagState.AtBase:
          pickupChecks(w, f, ctx);
          break;
      }
    }
  },

  onPlayerHit(w: World, victim: Player, attacker: PlayerId) {
    return standardHit(w, victim, attacker, CAPTURE_THE_FLAG.config);
  },

  onEliminate(w: World, victim: Player, attacker: PlayerId, ctx: ModeCtx) {
    const shooter = w.players[attacker];
    if (shooter?.active && shooter.team !== TEAM_NONE && shooter.team !== victim.team) {
      // A hit is worth a point but does not win the match -- captures do. Kills
      // are a means, not the objective.
      ctx.addPlayerScore(shooter, 1);
    }
    victim.respawnTicks = CAPTURE_THE_FLAG.config.respawnTicks;
  },

  onBuildRequest(_w: World, p: Player) {
    // Carrying the flag occupies your hands.
    return p.carryingFlag < 0;
  },

  checkWin(w: World): WinResult | null {
    for (let t = 0; t < 2; t++) {
      if ((w.match.teamScores[t] ?? 0) >= CAPTURES_TO_WIN) {
        return {
          team: t,
          player: -1,
          reason: `${teamName(t)} captured ${CAPTURES_TO_WIN} flags`,
        };
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
    out.title = 'Capture the Flag';
    out.headline = `${w.match.teamScores[0] ?? 0} - ${w.match.teamScores[1] ?? 0}`;
    out.teamScores.length = 2;
    out.teamScores[0] = w.match.teamScores[0] ?? 0;
    out.teamScores[1] = w.match.teamScores[1] ?? 0;

    if (me?.active && !me.alive) {
      out.sub = `Back in ${Math.ceil(me.respawnTicks / 30)}`;
    } else if (me?.active && me.carryingFlag >= 0) {
      const own = w.flags[me.team];
      out.sub = own && own.state === FlagState.AtBase ? 'Run it home!' : 'Your flag is not at base';
    } else {
      out.sub = `${formatClock(w.match.timeRemainingTicks)} left`;
    }
    out.banner = '';
  },

  botObjective(w: World, p: Player, out: Vec2Out) {
    // Carrying: head home. Otherwise go for the enemy flag, unless our own is
    // loose, in which case recovering it is more urgent -- you cannot score
    // without it.
    if (p.carryingFlag >= 0) {
      const own = w.flags[p.team];
      if (own) {
        out.x = own.baseX;
        out.y = own.baseY;
        return true;
      }
    }

    const own = w.flags[p.team];
    if (own && own.state !== FlagState.AtBase) {
      out.x = own.x;
      out.y = own.y;
      return true;
    }

    const enemyFlag = w.flags.find((f) => f.active && f.team !== p.team);
    if (enemyFlag) {
      out.x = enemyFlag.x;
      out.y = enemyFlag.y;
      return true;
    }

    const target = nearestEnemy(w, p);
    if (!target) return false;
    out.x = target.x;
    out.y = target.y;
    return true;
  },
};

/** Enemies take the flag; owners standing on a dropped one send it home. */
function pickupChecks(w: World, f: Flag, ctx: ModeCtx): void {
  for (const p of w.players) {
    if (!p.active || !p.alive || p.isDummy) continue;
    if (p.carryingFlag >= 0) continue;
    if (Math.hypot(p.x - f.x, p.y - f.y) > PICKUP_RANGE) continue;

    if (p.team === f.team) {
      // Touching your own flag only does something if it is loose.
      if (f.state === FlagState.Dropped) returnFlag(w, f, ctx);
      continue;
    }

    f.state = FlagState.Carried;
    f.carrier = p.id;
    f.returnTicks = 0;
    p.carryingFlag = f.id;
    ctx.emit(SimEventType.FlagTaken, f.id, f.x, f.y, 0, f.team, p.id);
    return;
  }
}

function tryCapture(w: World, f: Flag, carrier: Player, ctx: ModeCtx): void {
  const home = w.flags[carrier.team];
  if (!home) return;
  if (Math.hypot(carrier.x - home.baseX, carrier.y - home.baseY) > CAPTURE_RANGE) return;
  // The standoff rule: your own flag has to be home.
  if (home.state !== FlagState.AtBase) return;

  ctx.addTeamScore(carrier.team, 1);
  ctx.addPlayerScore(carrier, 3);
  carrier.carryingFlag = -1;
  ctx.emit(SimEventType.FlagCaptured, f.id, carrier.x, carrier.y, 0, carrier.team, carrier.id);
  resetFlag(f);
}

export function dropFlag(w: World, f: Flag, x: number, y: number, ctx: ModeCtx): void {
  const carrier = w.players[f.carrier];
  if (carrier) carrier.carryingFlag = -1;
  f.state = FlagState.Dropped;
  f.carrier = -1;
  f.x = x;
  f.y = y;
  f.returnTicks = DROPPED_RETURN_TICKS;
  ctx.emit(SimEventType.FlagDropped, f.id, x, y, 0, f.team, -1);
}

function returnFlag(w: World, f: Flag, ctx: ModeCtx): void {
  resetFlag(f);
  ctx.emit(SimEventType.FlagReturned, f.id, f.baseX, f.baseY, 0, f.team, -1);
  void w;
}

function resetFlag(f: Flag): void {
  f.state = FlagState.AtBase;
  f.carrier = -1;
  f.returnTicks = 0;
  f.x = f.baseX;
  f.y = f.baseY;
}
