/**
 * The one entry point into the simulation.
 *
 * `step()` is a pure function of (state, inputs): no ambient time, no
 * `Math.random`, no I/O. That is what lets a test hash 1200 ticks and compare
 * runs, and what would let a client replay unacked inputs if prediction is ever
 * needed.
 *
 * Systems are declared as a list with a `predict` flag rather than being
 * scattered behind `if (mode === ...)` checks. Adding a system is one line, and
 * you cannot forget to decide whether a client is allowed to predict it.
 *
 * The active game mode lives on the World and is consulted through hooks. Nothing
 * in this file knows what Capture the Flag is.
 */

import { DUMMY_HP, DUMMY_RESET_TICKS, PLAYER_RADIUS } from '../constants.js';
import { createInputFrame, validateInput, type InputFrame } from '../input/inputFrame.js';
import { createModeCtx } from '../modes/ctx.js';
import type { ModeCtx } from '../modes/types.js';
import { resolveCircleOverlap } from './collision.js';
import { stepBalls } from './snowball.js';
import { dropHeld, stepPlayer } from './player.js';
import { ActionState, MatchPhase, SimEventType, TEAM_NONE, type PlayerId, type SimEvent } from './types.js';
import type { World } from './world.js';

export type StepMode = 'authoritative' | 'predict';

/** Where a player was, for lag compensation. */
export interface ThrowOrigin {
  x: number;
  y: number;
  aim: number;
}

/**
 * Lag compensation, supplied by the host.
 *
 * A seam rather than something the simulation owns, because "how far behind is this
 * player" is a network fact and the simulation must stay a pure function of the
 * state and inputs it is handed. Absent -- in a client's prediction, and in every
 * offline test -- throws simply spawn from the present position, and behaviour is
 * unchanged.
 *
 * Note this compensates the SPAWN only. It deliberately never rewinds a victim; see
 * `ballisticAdvance` for why that would be the wrong trade for a projectile with
 * most of a second of flight time.
 */
export interface LagComp {
  /** How far back this player's throw should originate. 0 disables it. */
  rewindTicks(playerId: PlayerId): number;
  /** Where the player was `ticksAgo` ticks ago. False when unknown. */
  originAt(playerId: PlayerId, ticksAgo: number, out: ThrowOrigin): boolean;
}

export interface StepCtx {
  mode: StepMode;
  /** In predict mode, only this player's input is meaningful. */
  localPlayerId?: PlayerId;
  /** Host-only. See `LagComp`. */
  lagComp?: LagComp;
}

export type InputMap = ReadonlyMap<PlayerId, InputFrame>;

const EMPTY_INPUT = createInputFrame();
const scratch = { x: 0, y: 0 };

/**
 * One ModeCtx per world, cached rather than rebuilt per tick.
 *
 * A WeakMap so a discarded world does not keep its context alive, and so this
 * module stays free of per-world mutable globals.
 */
const modeCtxCache = new WeakMap<World, ModeCtx>();

function ctxFor(w: World): ModeCtx {
  let c = modeCtxCache.get(w);
  if (!c) {
    c = createModeCtx(w);
    modeCtxCache.set(w, c);
  }
  return c;
}

interface SystemDef {
  name: string;
  fn: (w: World, inputs: InputMap, ctx: StepCtx, mc: ModeCtx) => void;
  /** False means a client must NOT predict this -- it would wait for a host. */
  predict: boolean;
}

const SYSTEMS: SystemDef[] = [
  { name: 'match', fn: sysMatch, predict: false },
  { name: 'players', fn: sysPlayers, predict: true },
  { name: 'balls', fn: sysBalls, predict: true },
  { name: 'separation', fn: sysSeparation, predict: true },
  { name: 'mode', fn: sysMode, predict: false },
  { name: 'respawn', fn: sysRespawn, predict: false },
  { name: 'dummies', fn: sysDummies, predict: false },
  { name: 'win', fn: sysWin, predict: false },
];

export function step(w: World, inputs: InputMap, ctx: StepCtx): SimEvent[] {
  w.events.length = 0;
  w.tick++;
  const mc = ctxFor(w);

  for (const sys of SYSTEMS) {
    if (ctx.mode === 'predict' && !sys.predict) continue;
    sys.fn(w, inputs, ctx, mc);
  }

  return w.events;
}

/**
 * Begin a match: assign teams, place everyone, let the mode set up objectives.
 *
 * Separate from `createWorld` because players have to exist before a mode can
 * assign them to teams or pick spawns that avoid them.
 */
export function startMatch(w: World): void {
  const mc = ctxFor(w);
  const cfg = w.mode.config;

  w.match.phase = cfg.warmupTicks > 0 ? MatchPhase.Warmup : MatchPhase.Playing;
  w.match.phaseTicks = 0;
  w.match.timeRemainingTicks = cfg.timeLimitTicks;
  w.match.teamScores.fill(0);
  w.match.winnerTeam = TEAM_NONE;
  w.match.winnerPlayer = -1;
  w.match.winReason = '';

  for (const p of w.players) {
    if (!p.active || p.isDummy) continue;
    p.team = w.mode.assignTeam(w, p);
    p.score = 0;
    p.buildsRemaining = cfg.buildBudget;
  }

  // Spawn placement happens after every team is assigned, so "spawn away from
  // enemies" can actually see who the enemies are.
  for (const p of w.players) {
    if (!p.active || p.isDummy) continue;
    mc.respawn(p);
  }

  w.mode.init(w, mc);
  w.events.push({
    type: SimEventType.RoundStart,
    id: -1,
    other: -1,
    x: 0,
    y: 0,
    z: 0,
    amount: 0,
  });
}

function sysMatch(w: World): void {
  const m = w.match;
  m.phaseTicks++;

  if (m.phase === MatchPhase.Warmup) {
    if (m.phaseTicks >= w.mode.config.warmupTicks) {
      m.phase = MatchPhase.Playing;
      m.phaseTicks = 0;
    }
    return;
  }

  if (m.phase === MatchPhase.Playing && m.timeRemainingTicks > 0) {
    m.timeRemainingTicks--;
  }
}

function sysPlayers(w: World, inputs: InputMap, ctx: StepCtx): void {
  for (const p of w.players) {
    if (!p.active) continue;

    // In predict mode only the local player's motion is ours to simulate.
    if (ctx.mode === 'predict' && p.id !== ctx.localPlayerId) continue;

    const raw = inputs.get(p.id);
    const input = raw ?? EMPTY_INPUT;
    if (raw) validateInput(raw);
    stepPlayer(w, p, input, ctx.lagComp);
  }
}

function sysBalls(w: World): void {
  stepBalls(w);
}

/** Push overlapping players apart. Positional only, no impulse. */
function sysSeparation(w: World): void {
  const ps = w.players;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    if (!a || !a.active || !a.alive) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j];
      if (!b || !b.active || !b.alive) continue;
      if (resolveCircleOverlap(a.x, a.y, PLAYER_RADIUS, b.x, b.y, PLAYER_RADIUS, scratch)) {
        // Split the correction between both so neither gets shoved unfairly.
        const midX = (a.x + scratch.x) * 0.5;
        const midY = (a.y + scratch.y) * 0.5;
        const bx = b.x - (scratch.x - a.x) * 0.5;
        const by = b.y - (scratch.y - a.y) * 0.5;
        a.x = midX + (scratch.x - midX);
        a.y = midY + (scratch.y - midY);
        b.x = bx;
        b.y = by;
      }
    }
  }
}

function sysMode(w: World, _inputs: InputMap, _ctx: StepCtx, mc: ModeCtx): void {
  if (w.match.phase === MatchPhase.Ended) return;
  w.mode.onTick(w, mc);
}

function sysRespawn(w: World, _inputs: InputMap, _ctx: StepCtx, mc: ModeCtx): void {
  if (w.match.phase === MatchPhase.Ended) return;
  for (const p of w.players) {
    if (!p.active || p.isDummy || p.alive) continue;
    if (p.respawnTicks <= 0) continue;
    p.respawnTicks--;
    if (p.respawnTicks <= 0) mc.respawn(p);
  }
}

/** Training dummies pop back up shortly after being knocked down. */
function sysDummies(w: World): void {
  for (const p of w.players) {
    if (!p.active || !p.isDummy) continue;
    if (p.respawnTicks > 0) {
      p.respawnTicks++;
      if (p.respawnTicks === 1) dropHeld(w, p);
      if (p.respawnTicks >= DUMMY_RESET_TICKS) {
        p.respawnTicks = 0;
        p.hp = DUMMY_HP;
        p.alive = true;
        p.action = ActionState.Idle;
        p.actionTicks = 0;
        p.staggerAmount = 0;
      } else {
        p.alive = false;
      }
    }
  }
}

function sysWin(w: World): void {
  if (w.match.phase !== MatchPhase.Playing) return;
  const result = w.mode.checkWin(w);
  if (!result) return;

  w.match.phase = MatchPhase.Ended;
  w.match.phaseTicks = 0;
  w.match.winnerTeam = result.team;
  w.match.winnerPlayer = result.player;
  w.match.winReason = result.reason;
  w.events.push({
    type: SimEventType.RoundEnd,
    id: result.player,
    other: result.team,
    x: 0,
    y: 0,
    z: 0,
    amount: 0,
  });
}
