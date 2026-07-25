/**
 * King of the Hill AND Fort Defense -- one implementation, two shipped modes.
 *
 * This file is the concrete payoff of making modes config-driven. Both are "hold a
 * zone": the difference is entirely in the numbers.
 *
 *   King of the Hill  symmetric. Both teams want the centre. Score accrues while
 *                     you hold it. Equal respawns and equal building.
 *
 *   Fort Defense      asymmetric. One zone, defenders start owning it, and they
 *                     get a build phase, a big wall budget and fast respawns while
 *                     the attackers get almost no snow to build with and long
 *                     respawns. The attackers win by taking the zone at all; the
 *                     defenders win by running the clock out.
 *
 * Nothing below branches on which mode is running -- `makeZoneMode` takes options
 * and the differences fall out of them.
 */

import { secondsToTicks, TICK_DT } from '../constants.js';
import {
  MatchPhase,
  SimEventType,
  TEAM_NONE,
  type PlayerId,
  type TeamId,
} from '../sim/types.js';
import type { Player, World, Zone } from '../sim/world.js';
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
import type { GameMode, ModeCtx, ModeHud, ModeId, Vec2Out, WinResult } from './types.js';

interface ZoneModeOptions {
  id: ModeId;
  label: string;
  blurb: string;
  /** Index into the map's zone list. */
  zoneIndex: number;
  /** Team that owns the zone at the start, or TEAM_NONE for a neutral hill. */
  startingOwner: TeamId;
  /** Score needed to win; for Fort Defense this is what the attackers need. */
  scoreToWin: number;
  /** Points per second for the team holding the zone. 0 for Fort Defense, where
   *  simply TAKING the zone ends it. */
  holdPointsPerSec: number;
  /** True when capturing the zone once wins outright. */
  captureWins: boolean;
  respawnTicks: number;
  /** Per-team respawn override, for asymmetric modes. */
  respawnByTeam?: number[];
  timeLimitTicks: number;
  warmupTicks: number;
  buildBudget: number;
  buildBudgetByTeam?: number[];
  /** Team allowed to build during warmup; TEAM_NONE means everyone. */
  warmupBuilder: TeamId;
  suggestedBots: number;
}

/** Fraction of the zone captured per second by one uncontested attacker. */
const CAPTURE_PER_SEC = 0.34;

function makeZoneMode(o: ZoneModeOptions): GameMode {
  const mode: GameMode = {
    id: o.id,
    label: o.label,
    blurb: o.blurb,
    config: {
      teams: 2,
      friendlyFire: false,
      respawnTicks: o.respawnTicks,
      timeLimitTicks: o.timeLimitTicks,
      scoreToWin: o.scoreToWin,
      buildBudget: o.buildBudget,
      warmupTicks: o.warmupTicks,
      suggestedBots: o.suggestedBots,
    },

    init(w: World) {
      w.match.teamScores[0] = 0;
      w.match.teamScores[1] = 0;

      const src = MAP_ARENA01.zones[o.zoneIndex];
      const z = w.zones[0];
      if (!src || !z) return;
      z.active = true;
      z.x = src.x;
      z.y = src.y;
      z.radius = src.radius;
      z.label = src.label;
      z.owner = o.startingOwner;
      z.progress = 0;
      z.contender = TEAM_NONE;

      // Asymmetric build budgets are how Fort Defense makes the defenders feel
      // like defenders without any special-case code.
      if (o.buildBudgetByTeam) {
        for (const p of w.players) {
          if (!p.active) continue;
          p.buildsRemaining = o.buildBudgetByTeam[p.team] ?? o.buildBudget;
        }
      }
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
      const z = w.zones[0];
      if (!z?.active) return;

      // Who is standing in it.
      const inZone = [0, 0];
      for (const p of w.players) {
        if (!p.active || !p.alive || p.isDummy) continue;
        if (Math.hypot(p.x - z.x, p.y - z.y) > z.radius) continue;
        if (p.team === 0 || p.team === 1) inZone[p.team]!++;
      }

      const attackers = inZone[0]! + inZone[1]!;
      if (attackers > 0) {
        // The team with more bodies pushes the capture; a tie freezes it, which
        // makes a contested zone feel like a standoff rather than a coin flip.
        const leader = inZone[0]! > inZone[1]! ? 0 : inZone[1]! > inZone[0]! ? 1 : TEAM_NONE;
        if (leader !== TEAM_NONE && leader !== z.owner) {
          if (z.contender !== leader) {
            z.contender = leader;
            z.progress = 0;
          }
          const margin = Math.abs(inZone[0]! - inZone[1]!);
          z.progress += CAPTURE_PER_SEC * margin * TICK_DT;
          if (z.progress >= 1) {
            z.owner = leader;
            z.progress = 0;
            z.contender = TEAM_NONE;
            ctx.emit(SimEventType.ZoneCaptured, z.id, z.x, z.y, 0, leader, -1);
          }
        }
      } else if (z.contender !== TEAM_NONE) {
        // Abandoned mid-capture: decay rather than holding progress forever.
        z.progress = Math.max(0, z.progress - CAPTURE_PER_SEC * 0.6 * TICK_DT);
        if (z.progress <= 0) z.contender = TEAM_NONE;
      }

      if (o.holdPointsPerSec > 0 && z.owner !== TEAM_NONE) {
        const before = w.match.teamScores[z.owner] ?? 0;
        const after = before + o.holdPointsPerSec * TICK_DT;
        w.match.teamScores[z.owner] = after;
        // Only announce whole points, or the event stream floods.
        if (Math.floor(after) > Math.floor(before)) {
          ctx.emit(SimEventType.Scored, z.owner, z.x, z.y, 0, Math.floor(after));
        }
      }
    },

    onPlayerHit(w: World, victim: Player, attacker: PlayerId) {
      return standardHit(w, victim, attacker, mode.config);
    },

    onEliminate(w: World, victim: Player, attacker: PlayerId, ctx: ModeCtx) {
      const shooter = w.players[attacker];
      if (shooter?.active && shooter.team !== TEAM_NONE && shooter.team !== victim.team) {
        ctx.addPlayerScore(shooter, 1);
      }
      victim.respawnTicks = o.respawnByTeam?.[victim.team] ?? o.respawnTicks;
    },

    onBuildRequest(w: World, p: Player) {
      // During warmup only the designated builder may work -- the defenders'
      // head start in Fort Defense.
      if (w.match.phase === MatchPhase.Warmup) {
        if (o.warmupBuilder !== TEAM_NONE && p.team !== o.warmupBuilder) return false;
      }
      return p.buildsRemaining !== 0;
    },

    checkWin(w: World): WinResult | null {
      const z = w.zones[0];

      if (o.captureWins && z?.active && o.startingOwner !== TEAM_NONE) {
        if (z.owner !== o.startingOwner && z.owner !== TEAM_NONE) {
          return {
            team: z.owner,
            player: -1,
            reason: `${teamName(z.owner)} stormed the fort`,
          };
        }
      }

      if (o.scoreToWin > 0) {
        for (let t = 0; t < 2; t++) {
          if ((w.match.teamScores[t] ?? 0) >= o.scoreToWin) {
            return { team: t, player: -1, reason: `${teamName(t)} held the ${z?.label ?? 'zone'}` };
          }
        }
      }

      if (w.match.phase === MatchPhase.Playing && w.match.timeRemainingTicks <= 0) {
        if (o.captureWins && o.startingOwner !== TEAM_NONE) {
          // Fort Defense: surviving the clock is the defenders' win.
          return {
            team: o.startingOwner,
            player: -1,
            reason: `${teamName(o.startingOwner)} held out`,
          };
        }
        const lead = leadingTeam(w, 2);
        return lead.tied
          ? { team: TEAM_NONE, player: -1, reason: 'Time up -- a draw' }
          : { team: lead.team, player: -1, reason: `Time up -- ${teamName(lead.team)} ahead` };
      }
      return null;
    },

    hud(w: World, viewer: PlayerId, out: ModeHud) {
      const me = w.players[viewer];
      const z = w.zones[0];
      out.title = o.label;

      if (o.holdPointsPerSec > 0) {
        out.headline = `${Math.floor(w.match.teamScores[0] ?? 0)} - ${Math.floor(w.match.teamScores[1] ?? 0)}`;
        out.teamScores.length = 2;
        out.teamScores[0] = Math.floor(w.match.teamScores[0] ?? 0);
        out.teamScores[1] = Math.floor(w.match.teamScores[1] ?? 0);
      } else {
        out.headline = z && z.owner !== TEAM_NONE ? `${teamName(z.owner)} holds the fort` : 'Fort contested';
        out.teamScores.length = 0;
      }

      out.banner = '';
      if (w.match.phase === MatchPhase.Warmup) {
        // Warm-up detail goes in the banner, not the sub. The client draws the
        // warm-up banner mid-screen; putting the same countdown in both places
        // means two clocks disagreeing about which one you should read.
        const who = o.warmupBuilder === TEAM_NONE ? 'Everyone' : teamName(o.warmupBuilder);
        out.banner = `${who} builds -- ${formatClock(o.warmupTicks - w.match.phaseTicks)}`;
        out.sub = '';
      } else if (me?.active && !me.alive) {
        out.sub = `Back in ${Math.ceil(me.respawnTicks / 30)}`;
      } else if (z && z.contender !== TEAM_NONE && z.progress > 0.02) {
        out.sub = `${teamName(z.contender)} capturing ${Math.round(z.progress * 100)}%`;
      } else {
        out.sub = `${formatClock(w.match.timeRemainingTicks)} left`;
      }
    },

    botObjective(w: World, p: Player, out: Vec2Out) {
      const z = w.zones[0];
      if (!z?.active) return false;

      // Hold it if it is ours and someone is contesting; otherwise take it. Either
      // way the zone is where the bot should be, which is what makes the mode
      // actually play out rather than devolving into a field brawl.
      const dist = Math.hypot(p.x - z.x, p.y - z.y);
      if (z.owner !== p.team || dist > z.radius * 0.7) {
        out.x = z.x;
        out.y = z.y;
        return true;
      }

      const target = nearestEnemy(w, p);
      if (!target) {
        out.x = z.x;
        out.y = z.y;
        return true;
      }
      out.x = target.x;
      out.y = target.y;
      return true;
    },
  };

  return mode;
}

export const KING_OF_THE_HILL = makeZoneMode({
  id: 'kingOfTheHill',
  label: 'King of the Hill',
  blurb: 'Hold the centre. Score ticks up while your team owns it.',
  zoneIndex: 0,
  startingOwner: TEAM_NONE,
  scoreToWin: 60,
  holdPointsPerSec: 1,
  captureWins: false,
  respawnTicks: secondsToTicks(4),
  timeLimitTicks: secondsToTicks(300),
  warmupTicks: secondsToTicks(3),
  buildBudget: -1,
  warmupBuilder: TEAM_NONE,
  suggestedBots: 5,
});

/**
 * Fort Defense: the same class, different numbers.
 *
 * Blue defends and starts owning the fort with 40 walls and a 60-second build
 * window. Red attacks with 6 walls, slower respawns, and wins by taking the zone
 * at all. If the clock runs out, Blue held.
 */
export const FORT_DEFENSE = makeZoneMode({
  id: 'fortDefense',
  label: 'Fort Defense',
  blurb: 'One team fortifies and holds. The other has to storm it.',
  zoneIndex: 1,
  startingOwner: 0,
  scoreToWin: 0,
  holdPointsPerSec: 0,
  captureWins: true,
  respawnTicks: secondsToTicks(8),
  respawnByTeam: [secondsToTicks(4), secondsToTicks(9)],
  timeLimitTicks: secondsToTicks(240),
  warmupTicks: secondsToTicks(45),
  buildBudget: -1,
  buildBudgetByTeam: [40, 6],
  warmupBuilder: 0,
  suggestedBots: 5,
});
