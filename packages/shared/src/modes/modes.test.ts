import { describe, expect, it } from 'vitest';
import { createWorld, spawnPlayer, type World } from '../sim/world.js';
import { startMatch, step, type InputMap } from '../sim/step.js';
import { applyMap, MAP_ARENA01 } from '../map/arena01.js';
import { botInput, createBotBrain, powerForDistance, type BotBrain } from '../sim/bot.js';
import type { InputFrame } from '../input/inputFrame.js';
import { getMode, MODES, MODE_ORDER, PLAYABLE_MODES } from './registry.js';
import { createModeCtx } from './ctx.js';
import { createModeHud } from './types.js';
import { FlagState, MatchPhase, SimEventType, TEAM_NONE } from '../sim/types.js';
import { TEAM_WAR } from './teamWar.js';
import { CAPTURE_THE_FLAG } from './captureTheFlag.js';
import { FORT_DEFENSE, KING_OF_THE_HILL } from './kingOfTheHill.js';
import { LAST_ONE_STANDING } from './lastOneStanding.js';
import { countAlive } from './common.js';
import { secondsToTicks } from '../constants.js';

/** Build a world in a given mode with `n` bot-driven players. */
function makeMatch(modeId: string, players = 6, seed = 7): { w: World; brains: BotBrain[] } {
  const w = createWorld(seed, MAP_ARENA01.bounds, getMode(modeId));
  applyMap(w, MAP_ARENA01);

  const brains: BotBrain[] = [];
  for (let i = 0; i < players; i++) {
    const spot = MAP_ARENA01.spawns[i % MAP_ARENA01.spawns.length]!;
    spawnPlayer(w, { x: spot.x, y: spot.y, name: `Bot ${i + 1}` });
    brains.push(createBotBrain(i, seed, 0.4));
  }

  startMatch(w);
  return { w, brains };
}

/** Run bots until the match ends or the tick budget runs out. */
function runMatch(
  w: World,
  brains: BotBrain[],
  maxTicks: number,
): { ticks: number; ended: boolean; events: Record<number, number> } {
  const inputs = new Map<number, InputFrame>();
  const counts: Record<number, number> = {};
  let ticks = 0;

  for (; ticks < maxTicks; ticks++) {
    inputs.clear();
    for (const b of brains) inputs.set(b.playerId, botInput(w, b, ticks));
    const evs = step(w, inputs, { mode: 'authoritative' });
    for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (w.match.phase === MatchPhase.Ended) break;
  }

  return { ticks, ended: w.match.phase === MatchPhase.Ended, events: counts };
}

const idle = (): InputMap => new Map();

describe('the registry', () => {
  it('exposes every mode in a stable order', () => {
    expect(MODE_ORDER.length).toBe(Object.keys(MODES).length);
    for (const id of MODE_ORDER) expect(MODES[id]).toBeDefined();
    expect(PLAYABLE_MODES).not.toContain('sandbox');
  });

  it('falls back to practice for an unknown id', () => {
    expect(getMode('nonsense').id).toBe('sandbox');
    expect(getMode(undefined).id).toBe('sandbox');
  });

  it('gives every mode a label and a blurb for the picker', () => {
    for (const id of MODE_ORDER) {
      const m = MODES[id];
      expect(m.label.length, id).toBeGreaterThan(2);
      expect(m.blurb.length, id).toBeGreaterThan(10);
    }
  });

  it('ships Fort Defense and King of the Hill from one implementation', () => {
    // The payoff of config-driven modes: two shipped modes, one zone mechanic.
    // Asserted BEHAVIOURALLY rather than by comparing function identity -- the
    // factory hands out fresh closures per mode, so identity would always differ
    // even though the code is shared.
    expect(FORT_DEFENSE.id).not.toBe(KING_OF_THE_HILL.id);
    expect(FORT_DEFENSE.config.teams).toBe(KING_OF_THE_HILL.config.teams);
    // The numbers are where they actually differ.
    expect(FORT_DEFENSE.config.warmupTicks).toBeGreaterThan(
      KING_OF_THE_HILL.config.warmupTicks,
    );

    // Same zone-capture mechanic in both: a lone player takes the zone.
    for (const id of ['kingOfTheHill', 'fortDefense'] as const) {
      const { w } = makeMatch(id, 2);
      w.match.phase = MatchPhase.Playing;
      const z = w.zones[0]!;
      const taker = w.players.find((p) => p.active && p.team === 1)!;
      for (const p of w.players) {
        if (!p.active || p.id === taker.id) continue;
        p.x = 960;
        p.y = 40;
      }
      for (let i = 0; i < 400 && z.owner !== 1; i++) {
        taker.x = z.x;
        taker.y = z.y;
        step(w, idle(), { mode: 'authoritative' });
      }
      expect(z.owner, id).toBe(1);
    }
  });
});

describe('every mode plays to a conclusion', () => {
  // The single most valuable test here. A mode that cannot end is not a mode, and
  // elimination and hold-the-zone modes are both prone to stalling.
  for (const id of PLAYABLE_MODES) {
    it(`${id} reaches a winner`, () => {
      const { w, brains } = makeMatch(id, 6);
      const budget = w.mode.config.timeLimitTicks
        ? w.mode.config.timeLimitTicks + secondsToTicks(20)
        : secondsToTicks(400);

      const r = runMatch(w, brains, budget);

      expect(r.ended, `${id} did not end within ${budget} ticks`).toBe(true);
      expect(w.match.winReason.length).toBeGreaterThan(0);
      // Either a team or a player won, or it was an explicit draw.
      const decided =
        w.match.winnerTeam !== TEAM_NONE ||
        w.match.winnerPlayer >= 0 ||
        w.match.winReason.includes('draw');
      expect(decided, `${id}: ${w.match.winReason}`).toBe(true);
      expect(r.events[SimEventType.RoundEnd]).toBe(1);
    });
  }

  it('produces actual gameplay along the way, not just a timeout', () => {
    const { w, brains } = makeMatch('teamWar', 6);
    const r = runMatch(w, brains, w.mode.config.timeLimitTicks);
    // Bots should be packing, throwing and hitting each other.
    expect(r.events[SimEventType.Packed] ?? 0).toBeGreaterThan(10);
    expect(r.events[SimEventType.Thrown] ?? 0).toBeGreaterThan(10);
    expect(r.events[SimEventType.Hit] ?? 0).toBeGreaterThan(5);
  });
});

describe('teams', () => {
  it('splits players evenly across two teams', () => {
    const { w } = makeMatch('teamWar', 6);
    const t0 = w.players.filter((p) => p.active && p.team === 0).length;
    const t1 = w.players.filter((p) => p.active && p.team === 1).length;
    expect(t0).toBe(3);
    expect(t1).toBe(3);
  });

  it('leaves free-for-all modes teamless', () => {
    const { w } = makeMatch('lastOneStanding', 4);
    for (const p of w.players) {
      if (p.active) expect(p.team).toBe(TEAM_NONE);
    }
  });

  it('spawns teams apart from each other', () => {
    const { w } = makeMatch('captureTheFlag', 6);
    const a = w.players.find((p) => p.active && p.team === 0)!;
    const b = w.players.find((p) => p.active && p.team === 1)!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(400);
  });
});

describe('hit rules', () => {
  it('blocks friendly fire in team modes', () => {
    const { w } = makeMatch('teamWar', 4);
    // Skip the warmup, which blocks damage for its own reasons.
    w.match.phase = MatchPhase.Playing;
    const a = w.players.find((p) => p.active && p.team === 0)!;
    const b = w.players.filter((p) => p.active && p.team === 0)[1]!;
    expect(TEAM_WAR.onPlayerHit(w, b, a.id).allow).toBe(false);

    const enemy = w.players.find((p) => p.active && p.team === 1)!;
    expect(TEAM_WAR.onPlayerHit(w, enemy, a.id).allow).toBe(true);
  });

  it('allows anything in free-for-all', () => {
    const { w } = makeMatch('lastOneStanding', 4);
    w.match.phase = MatchPhase.Playing;
    const a = w.players.find((p) => p.active)!;
    const b = w.players.filter((p) => p.active)[1]!;
    expect(LAST_ONE_STANDING.onPlayerHit(w, b, a.id).allow).toBe(true);
  });

  it('does no damage during warmup, but still registers the hit', () => {
    // Zero damage rather than a veto, so snowballs visibly splat instead of
    // passing straight through people during a build phase.
    const { w } = makeMatch('fortDefense', 4);
    expect(w.match.phase).toBe(MatchPhase.Warmup);
    const a = w.players.find((p) => p.active && p.team === 0)!;
    const enemy = w.players.find((p) => p.active && p.team === 1)!;
    const v = FORT_DEFENSE.onPlayerHit(w, enemy, a.id);
    expect(v.allow).toBe(true);
    expect(v.damageMul).toBe(0);
  });

  it('does no damage once the match has ended', () => {
    const { w } = makeMatch('teamWar', 4);
    w.match.phase = MatchPhase.Ended;
    const a = w.players.find((p) => p.active && p.team === 0)!;
    const enemy = w.players.find((p) => p.active && p.team === 1)!;
    expect(TEAM_WAR.onPlayerHit(w, enemy, a.id).damageMul).toBe(0);
  });
});

describe('elimination and respawn', () => {
  it('brings players back in modes with respawns', () => {
    const { w } = makeMatch('teamWar', 4);
    w.match.phase = MatchPhase.Playing;
    const ctx = createModeCtx(w);
    const victim = w.players.find((p) => p.active)!;

    ctx.eliminate(victim, -1);
    expect(victim.alive).toBe(false);
    expect(victim.respawnTicks).toBeGreaterThan(0);

    for (let i = 0; i < TEAM_WAR.config.respawnTicks + 4; i++) {
      step(w, idle(), { mode: 'authoritative' });
      if (victim.alive) break;
    }
    expect(victim.alive).toBe(true);
    expect(victim.hp).toBeGreaterThan(0);
  });

  it('keeps players out permanently in Last One Standing', () => {
    const { w } = makeMatch('lastOneStanding', 4);
    w.match.phase = MatchPhase.Playing;
    const ctx = createModeCtx(w);
    const victim = w.players.find((p) => p.active)!;

    ctx.eliminate(victim, -1);
    expect(victim.respawnTicks).toBe(0);

    for (let i = 0; i < 200; i++) step(w, idle(), { mode: 'authoritative' });
    expect(victim.alive).toBe(false);
  });

  it('awards the attacker a point', () => {
    const { w } = makeMatch('teamWar', 4);
    w.match.phase = MatchPhase.Playing;
    const ctx = createModeCtx(w);
    const shooter = w.players.find((p) => p.active && p.team === 0)!;
    const victim = w.players.find((p) => p.active && p.team === 1)!;

    ctx.eliminate(victim, shooter.id);
    expect(w.match.teamScores[0]).toBe(1);
    expect(shooter.score).toBe(1);
  });

  it('does not award a point for eliminating a teammate', () => {
    const { w } = makeMatch('teamWar', 4);
    w.match.phase = MatchPhase.Playing;
    const ctx = createModeCtx(w);
    const team0 = w.players.filter((p) => p.active && p.team === 0);
    ctx.eliminate(team0[1]!, team0[0]!.id);
    expect(w.match.teamScores[0]).toBe(0);
  });
});

describe('capture the flag', () => {
  function ctfMatch() {
    const { w } = makeMatch('captureTheFlag', 4);
    w.match.phase = MatchPhase.Playing;
    return { w, ctx: createModeCtx(w) };
  }

  it('sets both flags at their bases', () => {
    const { w } = ctfMatch();
    expect(w.flags[0]!.active).toBe(true);
    expect(w.flags[1]!.active).toBe(true);
    expect(w.flags[0]!.state).toBe(FlagState.AtBase);
    expect(Math.hypot(w.flags[0]!.x - w.flags[1]!.x, w.flags[0]!.y - w.flags[1]!.y)).toBeGreaterThan(
      500,
    );
  });

  it('lets an enemy pick a flag up, and carries it with them', () => {
    const { w } = ctfMatch();
    const thief = w.players.find((p) => p.active && p.team === 0)!;
    const enemyFlag = w.flags[1]!;
    thief.x = enemyFlag.x;
    thief.y = enemyFlag.y;

    step(w, idle(), { mode: 'authoritative' });
    expect(enemyFlag.state).toBe(FlagState.Carried);
    expect(enemyFlag.carrier).toBe(thief.id);
    expect(thief.carryingFlag).toBe(enemyFlag.id);

    thief.x += 60;
    step(w, idle(), { mode: 'authoritative' });
    expect(enemyFlag.x).toBeCloseTo(thief.x, 1);
  });

  it('ignores your own flag while it is at base', () => {
    const { w } = ctfMatch();
    const owner = w.players.find((p) => p.active && p.team === 0)!;
    const ownFlag = w.flags[0]!;
    owner.x = ownFlag.x;
    owner.y = ownFlag.y;
    step(w, idle(), { mode: 'authoritative' });
    expect(ownFlag.state).toBe(FlagState.AtBase);
    expect(owner.carryingFlag).toBe(-1);
  });

  it('drops the flag where the carrier fell', () => {
    const { w, ctx } = ctfMatch();
    const thief = w.players.find((p) => p.active && p.team === 0)!;
    const enemyFlag = w.flags[1]!;
    thief.x = enemyFlag.x;
    thief.y = enemyFlag.y;
    step(w, idle(), { mode: 'authoritative' });
    expect(enemyFlag.state).toBe(FlagState.Carried);

    thief.x = 500;
    thief.y = 300;
    ctx.eliminate(thief, -1);
    expect(enemyFlag.state).toBe(FlagState.Dropped);
    expect(enemyFlag.x).toBeCloseTo(500, 1);
    expect(thief.carryingFlag).toBe(-1);
  });

  it('returns a dropped flag home on its own, so the objective cannot be lost', () => {
    const { w, ctx } = ctfMatch();
    const thief = w.players.find((p) => p.active && p.team === 0)!;
    const enemyFlag = w.flags[1]!;
    thief.x = enemyFlag.x;
    thief.y = enemyFlag.y;
    step(w, idle(), { mode: 'authoritative' });
    // Strand it in a far corner.
    thief.x = 980;
    thief.y = 700;
    ctx.eliminate(thief, -1);
    expect(enemyFlag.state).toBe(FlagState.Dropped);

    // Capture the budget FIRST: `returnTicks` counts down, so using it directly as
    // the loop bound makes i and the bound meet in the middle and exit early.
    const budget = enemyFlag.returnTicks + 5;
    for (let i = 0; i < budget; i++) {
      step(w, idle(), { mode: 'authoritative' });
      if (enemyFlag.state === FlagState.AtBase) break;
    }
    expect(enemyFlag.state).toBe(FlagState.AtBase);
    expect(enemyFlag.x).toBeCloseTo(enemyFlag.baseX, 1);
  });

  it('scores a capture when the carrier reaches their own base', () => {
    const { w } = ctfMatch();
    const thief = w.players.find((p) => p.active && p.team === 0)!;
    const enemyFlag = w.flags[1]!;
    const ownFlag = w.flags[0]!;

    thief.x = enemyFlag.x;
    thief.y = enemyFlag.y;
    step(w, idle(), { mode: 'authoritative' });
    expect(thief.carryingFlag).toBe(enemyFlag.id);

    thief.x = ownFlag.baseX;
    thief.y = ownFlag.baseY;
    step(w, idle(), { mode: 'authoritative' });

    expect(w.match.teamScores[0]).toBe(1);
    expect(thief.carryingFlag).toBe(-1);
    expect(enemyFlag.state).toBe(FlagState.AtBase);
  });

  it('refuses the capture while your own flag is away -- the standoff rule', () => {
    const { w } = ctfMatch();
    const thief = w.players.find((p) => p.active && p.team === 0)!;
    const enemy = w.players.find((p) => p.active && p.team === 1)!;
    const enemyFlag = w.flags[1]!;
    const ownFlag = w.flags[0]!;

    // Both teams grab.
    thief.x = enemyFlag.x;
    thief.y = enemyFlag.y;
    enemy.x = ownFlag.x;
    enemy.y = ownFlag.y;
    step(w, idle(), { mode: 'authoritative' });
    expect(thief.carryingFlag).toBe(enemyFlag.id);
    expect(enemy.carryingFlag).toBe(ownFlag.id);

    // Running it home does nothing while your own flag is out.
    thief.x = ownFlag.baseX;
    thief.y = ownFlag.baseY;
    for (let i = 0; i < 5; i++) step(w, idle(), { mode: 'authoritative' });
    expect(w.match.teamScores[0] ?? 0).toBe(0);
  });

  it('blocks building while carrying the flag', () => {
    const { w } = ctfMatch();
    const p = w.players.find((p) => p.active)!;
    expect(CAPTURE_THE_FLAG.onBuildRequest(w, p)).toBe(true);
    p.carryingFlag = 1;
    expect(CAPTURE_THE_FLAG.onBuildRequest(w, p)).toBe(false);
  });
});

describe('king of the hill', () => {
  it('captures the zone for whoever holds it alone, then scores', () => {
    const { w } = makeMatch('kingOfTheHill', 4);
    w.match.phase = MatchPhase.Playing;
    const z = w.zones[0]!;
    expect(z.active).toBe(true);
    expect(z.owner).toBe(TEAM_NONE);

    // Park a lone team-0 player on the hill and keep everyone else away.
    const holder = w.players.find((p) => p.active && p.team === 0)!;
    for (const p of w.players) {
      if (!p.active || p.id === holder.id) continue;
      p.x = 960;
      p.y = 40;
    }

    for (let i = 0; i < 400 && z.owner !== 0; i++) {
      holder.x = z.x;
      holder.y = z.y;
      step(w, idle(), { mode: 'authoritative' });
    }
    expect(z.owner).toBe(0);

    const before = w.match.teamScores[0] ?? 0;
    for (let i = 0; i < 120; i++) {
      holder.x = z.x;
      holder.y = z.y;
      step(w, idle(), { mode: 'authoritative' });
    }
    expect(w.match.teamScores[0] ?? 0).toBeGreaterThan(before);
  });

  it('freezes capture progress while the zone is evenly contested', () => {
    const { w } = makeMatch('kingOfTheHill', 4);
    w.match.phase = MatchPhase.Playing;
    const z = w.zones[0]!;
    const a = w.players.find((p) => p.active && p.team === 0)!;
    const b = w.players.find((p) => p.active && p.team === 1)!;
    for (const p of w.players) {
      if (!p.active || p.id === a.id || p.id === b.id) continue;
      p.x = 960;
      p.y = 40;
    }

    for (let i = 0; i < 200; i++) {
      a.x = z.x - 10;
      a.y = z.y;
      b.x = z.x + 10;
      b.y = z.y;
      step(w, idle(), { mode: 'authoritative' });
    }
    expect(z.owner).toBe(TEAM_NONE);
    expect(z.progress).toBeLessThan(0.1);
  });
});

describe('fort defense', () => {
  it('starts with the defenders owning the fort', () => {
    const { w } = makeMatch('fortDefense', 4);
    expect(w.zones[0]!.owner).toBe(0);
  });

  it('gives the two teams very different build budgets', () => {
    const { w } = makeMatch('fortDefense', 4);
    const def = w.players.find((p) => p.active && p.team === 0)!;
    const att = w.players.find((p) => p.active && p.team === 1)!;
    expect(def.buildsRemaining).toBeGreaterThan(att.buildsRemaining);
  });

  it('lets only the defenders build during the build phase', () => {
    const { w } = makeMatch('fortDefense', 4);
    expect(w.match.phase).toBe(MatchPhase.Warmup);
    const def = w.players.find((p) => p.active && p.team === 0)!;
    const att = w.players.find((p) => p.active && p.team === 1)!;
    expect(FORT_DEFENSE.onBuildRequest(w, def)).toBe(true);
    expect(FORT_DEFENSE.onBuildRequest(w, att)).toBe(false);
  });

  it('refuses to build once a player is out of budget', () => {
    const { w } = makeMatch('fortDefense', 4);
    w.match.phase = MatchPhase.Playing;
    const att = w.players.find((p) => p.active && p.team === 1)!;
    att.buildsRemaining = 0;
    expect(FORT_DEFENSE.onBuildRequest(w, att)).toBe(false);
  });

  it('ends the moment the attackers take the fort', () => {
    const { w } = makeMatch('fortDefense', 4);
    w.match.phase = MatchPhase.Playing;
    w.zones[0]!.owner = 1;
    step(w, idle(), { mode: 'authoritative' });
    expect(w.match.phase).toBe(MatchPhase.Ended);
    expect(w.match.winnerTeam).toBe(1);
  });

  it('hands the win to the defenders if the clock runs out', () => {
    const { w } = makeMatch('fortDefense', 4);
    w.match.phase = MatchPhase.Playing;
    w.match.timeRemainingTicks = 1;
    step(w, idle(), { mode: 'authoritative' });
    step(w, idle(), { mode: 'authoritative' });
    expect(w.match.phase).toBe(MatchPhase.Ended);
    expect(w.match.winnerTeam).toBe(0);
  });
});

describe('last one standing', () => {
  it('damages players caught outside the blizzard', () => {
    const { w } = makeMatch('lastOneStanding', 4);
    w.match.phase = MatchPhase.Playing;
    const r = w.ring;
    r.delayTicks = 0;
    r.radius = 120;

    const outside = w.players.find((p) => p.active)!;
    const hpBefore = outside.hp;
    for (let i = 0; i < 60; i++) {
      outside.x = r.x + 400;
      outside.y = r.y;
      step(w, idle(), { mode: 'authoritative' });
    }
    expect(outside.hp).toBeLessThan(hpBefore);
  });

  it('leaves players inside the blizzard alone', () => {
    const { w } = makeMatch('lastOneStanding', 4);
    w.match.phase = MatchPhase.Playing;
    w.ring.delayTicks = 0;
    const safe = w.players.find((p) => p.active)!;
    const hpBefore = safe.hp;
    for (let i = 0; i < 60; i++) {
      safe.x = w.ring.x;
      safe.y = w.ring.y;
      step(w, idle(), { mode: 'authoritative' });
    }
    expect(safe.hp).toBe(hpBefore);
  });

  it('the blizzard closes, which is what guarantees the match ends', () => {
    const { w } = makeMatch('lastOneStanding', 4);
    w.match.phase = MatchPhase.Playing;
    w.ring.delayTicks = 0;
    const before = w.ring.radius;
    for (let i = 0; i < 300; i++) step(w, idle(), { mode: 'authoritative' });
    expect(w.ring.radius).toBeLessThan(before);
    expect(w.ring.radius).toBeGreaterThanOrEqual(w.ring.targetRadius);
  });

  it('declares the last survivor the winner', () => {
    const { w } = makeMatch('lastOneStanding', 4);
    w.match.phase = MatchPhase.Playing;
    const ctx = createModeCtx(w);
    const players = w.players.filter((p) => p.active);
    for (let i = 1; i < players.length; i++) ctx.eliminate(players[i]!, -1);

    step(w, idle(), { mode: 'authoritative' });
    expect(w.match.phase).toBe(MatchPhase.Ended);
    expect(w.match.winnerPlayer).toBe(players[0]!.id);
    expect(countAlive(w)).toBe(1);
  });
});

describe('the HUD contract', () => {
  it('every mode fills the HUD without touching a canvas', () => {
    for (const id of MODE_ORDER) {
      const { w } = makeMatch(id, 4);
      const hud = createModeHud();
      w.mode.hud(w, 0, hud);
      expect(hud.title.length, id).toBeGreaterThan(0);
      // Team modes expose per-team chips; free-for-all ones must not.
      if (w.mode.config.teams > 0 && w.mode.id !== 'fortDefense') {
        expect(hud.teamScores.length, id).toBe(2);
      }
    }
  });

  /**
   * The warm-up countdown must live in exactly one field.
   *
   * The client draws `banner` mid-screen and `sub` under the score, and on a
   * landscape phone those two land within a few pixels of each other. Putting the
   * countdown in both printed two clocks on top of one another.
   */
  it('puts warm-up detail in the banner and leaves the sub empty', () => {
    const { w } = makeMatch('fortDefense', 4);
    w.match.phase = MatchPhase.Warmup;
    w.match.phaseTicks = 30;
    const hud = createModeHud();
    w.mode.hud(w, 0, hud);
    expect(hud.banner).toContain('builds');
    expect(hud.sub).toBe('');

    // Once play starts the banner goes away and the sub carries the clock.
    w.match.phase = MatchPhase.Playing;
    w.mode.hud(w, 0, hud);
    expect(hud.banner).toBe('');
    expect(hud.sub.length).toBeGreaterThan(0);
  });
});

describe('bots', () => {
  it('produce only valid input', () => {
    const { w, brains } = makeMatch('teamWar', 6);
    for (let t = 0; t < 300; t++) {
      const inputs = new Map<number, InputFrame>();
      for (const b of brains) {
        const f = botInput(w, b, t);
        expect(Math.hypot(f.moveX, f.moveY)).toBeLessThanOrEqual(1.0001);
        expect(f.throwPower).toBeGreaterThanOrEqual(0);
        expect(f.throwPower).toBeLessThanOrEqual(1);
        expect(Number.isFinite(f.aim)).toBe(true);
        inputs.set(b.playerId, f);
      }
      step(w, inputs, { mode: 'authoritative' });
    }
  });

  it('are reproducible for a given seed', () => {
    const run = (): number[] => {
      const { w, brains } = makeMatch('teamWar', 6, 1234);
      runMatch(w, brains, 600);
      return w.players.filter((p) => p.active).map((p) => Math.round(p.x * 8));
    };
    expect(run()).toEqual(run());
  });

  it('chooses throw power that increases with distance', () => {
    expect(powerForDistance(400)).toBeGreaterThan(powerForDistance(150));
    expect(powerForDistance(150)).toBeGreaterThanOrEqual(0);
    expect(powerForDistance(5000)).toBeLessThanOrEqual(1);
  });
});

describe('practice mode is a real mode', () => {
  it('never ends and keeps no score', () => {
    const w = createWorld(3, MAP_ARENA01.bounds);
    applyMap(w, MAP_ARENA01);
    spawnPlayer(w, { x: 200, y: 520 });
    startMatch(w);
    for (let i = 0; i < 400; i++) step(w, idle(), { mode: 'authoritative' });
    expect(w.match.phase).toBe(MatchPhase.Playing);
    expect(w.mode.checkWin(w)).toBeNull();
  });

  it('is what a world defaults to', () => {
    const w = createWorld(1, MAP_ARENA01.bounds);
    expect(w.mode.id).toBe('sandbox');
  });
});
