/**
 * The one entry point into the simulation.
 *
 * `step()` is a pure function of (state, inputs): no ambient time, no
 * `Math.random`, no I/O. That is what lets the client replay unacked inputs for
 * prediction and lets a test hash 3000 ticks and compare against a snapshot.
 *
 * Systems are declared as a list with a `predict` flag rather than being
 * scattered behind `if (mode === ...)` checks. Adding a system is one line, and
 * you cannot forget to decide whether the client is allowed to predict it.
 */

import { DUMMY_HP, DUMMY_RESET_TICKS, MAX_HP } from '../constants.js';
import { createInputFrame, validateInput, type InputFrame } from '../input/inputFrame.js';
import { resolveCircleOverlap } from './collision.js';
import { stepBalls } from './snowball.js';
import { dropHeld, stepPlayer } from './player.js';
import { ActionState, type PlayerId, type SimEvent } from './types.js';
import { PLAYER_RADIUS } from '../constants.js';
import type { World } from './world.js';

export type StepMode = 'authoritative' | 'predict';

export interface StepCtx {
  mode: StepMode;
  /** In predict mode, only this player's input is meaningful. */
  localPlayerId?: PlayerId;
}

export type InputMap = ReadonlyMap<PlayerId, InputFrame>;

const EMPTY_INPUT = createInputFrame();
const scratch = { x: 0, y: 0 };

interface SystemDef {
  name: string;
  fn: (w: World, inputs: InputMap, ctx: StepCtx) => void;
  /** False means the client must NOT predict this -- it waits for the host. */
  predict: boolean;
}

const SYSTEMS: SystemDef[] = [
  { name: 'players', fn: sysPlayers, predict: true },
  { name: 'balls', fn: sysBalls, predict: true },
  { name: 'separation', fn: sysSeparation, predict: true },
  { name: 'dummies', fn: sysDummies, predict: false },
];

export function step(w: World, inputs: InputMap, ctx: StepCtx): SimEvent[] {
  w.events.length = 0;
  w.tick++;

  for (const sys of SYSTEMS) {
    if (ctx.mode === 'predict' && !sys.predict) continue;
    sys.fn(w, inputs, ctx);
  }

  return w.events;
}

function sysPlayers(w: World, inputs: InputMap, ctx: StepCtx): void {
  for (const p of w.players) {
    if (!p.active) continue;

    // In predict mode only the local player's motion is ours to simulate;
    // everyone else is interpolated from snapshots, so leave them untouched.
    if (ctx.mode === 'predict' && p.id !== ctx.localPlayerId) continue;

    const raw = inputs.get(p.id);
    const input = raw ?? EMPTY_INPUT;
    if (raw) validateInput(raw);
    stepPlayer(w, p, input);
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
  void MAX_HP;
}
