/**
 * The mode mutation channel.
 *
 * Modes go through this rather than editing players directly, because the actions
 * they want have consequences that belong in one place. Eliminating someone, for
 * instance, has to drop any flag they were carrying and start their respawn timer;
 * a mode that just set `alive = false` would leave a flag stuck to a corpse.
 */

import { FLAG_RETURN_TICKS, MAX_HP } from '../constants.js';
import {
  ActionState,
  FlagState,
  SimEventType,
  TEAM_NONE,
  type PlayerId,
  type TeamId,
} from '../sim/types.js';
import { dropHeld } from '../sim/player.js';
import { pushEvent, type Player, type World } from '../sim/world.js';
import type { ModeCtx } from './types.js';

const spawnOut = { x: 0, y: 0 };

export function createModeCtx(w: World): ModeCtx {
  // A named object rather than an inline literal, so the methods can call each
  // other without depending on `this` surviving destructuring.
  const ctx: ModeCtx = {
    rng: w.rng,

    addTeamScore(team: TeamId, n: number): void {
      if (team === TEAM_NONE) return;
      w.match.teamScores[team] = (w.match.teamScores[team] ?? 0) + n;
      pushEvent(w, SimEventType.Scored, team, 0, 0, 0, w.match.teamScores[team]!);
    },

    addPlayerScore(p: Player, n: number): void {
      p.score += n;
    },

    damage(p: Player, amount: number, attacker: PlayerId): void {
      if (!p.alive) return;
      const verdict = w.mode.onPlayerHit(w, p, attacker);
      if (!verdict.allow) return;
      const dealt = amount * verdict.damageMul;
      if (dealt <= 0) return;

      p.hp -= dealt;
      if (p.hp <= 0) {
        p.hp = 0;
        ctx.eliminate(p, attacker);
      }
    },

    eliminate(p: Player, attacker: PlayerId): void {
      if (!p.alive) return;
      p.alive = false;
      p.hp = 0;
      p.action = ActionState.Eliminated;
      p.actionTicks = 0;
      p.packProgress = 0;
      p.vx = 0;
      p.vy = 0;

      // Everything a body must let go of.
      dropHeld(w, p);
      releaseCarriedFlag(w, p);

      pushEvent(w, SimEventType.Eliminated, p.id, p.x, p.y, 0, 0, attacker);
      w.mode.onEliminate(w, p, attacker, ctx);
    },

    respawn(p: Player): void {
      w.mode.spawnPoint(w, p, spawnOut);
      p.x = spawnOut.x;
      p.y = spawnOut.y;
      p.vx = 0;
      p.vy = 0;
      p.hp = MAX_HP;
      p.alive = true;
      p.respawnTicks = 0;
      p.action = ActionState.Idle;
      p.actionTicks = 0;
      p.packProgress = 0;
      p.staggerAmount = 0;
      p.heldBall = -1;
      p.carryingFlag = -1;
      pushEvent(w, SimEventType.Respawned, p.id, p.x, p.y);
    },

    emit(type, id, x, y, z = 0, amount = 0, other = -1): void {
      pushEvent(w, type, id, x, y, z, amount, other);
    },
  };
  return ctx;
}

/**
 * Drop a flag where its carrier fell.
 *
 * Lives here rather than in the CTF mode because eliminations happen deep in the
 * projectile code, which must not need to know which mode is running.
 */
function releaseCarriedFlag(w: World, p: Player): void {
  if (p.carryingFlag < 0) return;
  const f = w.flags[p.carryingFlag];
  p.carryingFlag = -1;
  if (!f) return;
  f.state = FlagState.Dropped;
  f.carrier = -1;
  f.x = p.x;
  f.y = p.y;
  f.returnTicks = FLAG_RETURN_TICKS;
  pushEvent(w, SimEventType.FlagDropped, f.id, f.x, f.y, 0, f.team, p.id);
}
