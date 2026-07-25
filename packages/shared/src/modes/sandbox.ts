/**
 * The practice arena: no teams, no scoring, no win condition.
 *
 * Worth having as a real mode rather than as a special "no mode" case. It is the
 * default the World is created with, so every existing test and the practice
 * arena go through exactly the same hook path as a competitive match -- which
 * means the framework is exercised constantly rather than only by the modes that
 * need it.
 */

import { HIT_ALLOW, type GameMode, type ModeHud, type Vec2Out } from './types.js';
import { TEAM_NONE } from '../sim/types.js';
import type { Player, World } from '../sim/world.js';

export const SANDBOX: GameMode = {
  id: 'sandbox',
  label: 'Practice',
  blurb: 'Free play with training dummies. No score, no timer.',
  config: {
    teams: 0,
    friendlyFire: true,
    respawnTicks: 0,
    timeLimitTicks: 0,
    scoreToWin: 0,
    buildBudget: -1,
    warmupTicks: 0,
    suggestedBots: 0,
  },

  init() {
    /* nothing to set up */
  },

  assignTeam() {
    return TEAM_NONE;
  },

  spawnPoint(_w: World, p: Player, out: Vec2Out) {
    out.x = p.x;
    out.y = p.y;
  },

  onTick() {
    /* no objectives */
  },

  onPlayerHit() {
    // Damage always lands here, including on yourself -- it is a practice range.
    return HIT_ALLOW;
  },

  onEliminate(_w: World, victim: Player) {
    // Nobody is ever really out in practice; stand back up shortly.
    victim.respawnTicks = 1;
  },

  onBuildRequest() {
    return true;
  },

  checkWin() {
    return null;
  },

  hud(_w: World, _viewer, out: ModeHud) {
    out.title = 'Practice';
    out.headline = '';
    out.sub = '';
    out.banner = '';
    out.teamScores.length = 0;
  },

  botObjective() {
    return false;
  },
};
