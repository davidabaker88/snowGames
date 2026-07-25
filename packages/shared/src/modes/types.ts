/**
 * The game-mode contract.
 *
 * The simulation knows nothing about any specific mode. It calls these hooks and
 * a mode decides what they mean, so adding a mode is a new file plus one line in
 * the registry -- no changes to movement, projectiles, walls, rendering or HUD.
 *
 * Two rules keep that true:
 *
 *  1. MODES ARE STATELESS. Every piece of mutable data lives on the World (scores
 *     on `match`, objectives on `flags`/`zones`/`ring`). A mode that stashed state
 *     in a closure would break replay and make two matches share data.
 *
 *  2. `ModeCtx` IS THE ONLY MUTATION CHANNEL for the things modes care about --
 *     scoring, damage, elimination, events. Modes may read the World freely but
 *     should not, for instance, set `player.alive` directly, because eliminating
 *     someone has consequences (dropping a carried flag, awarding a point) that
 *     belong in one place.
 *
 * Deliberately NOT here: a serialization schema for mode state. That was designed
 * for netcode, and there is no server, so it would be code with no reader.
 */

import type { RngState } from '../math/rng.js';
import type { SimEventType, PlayerId, TeamId } from '../sim/types.js';
import type { Player, World } from '../sim/world.js';

export type ModeId =
  | 'sandbox'
  | 'lastOneStanding'
  | 'teamWar'
  | 'captureTheFlag'
  | 'kingOfTheHill'
  | 'fortDefense';

export interface ModeConfig {
  /** 0 means free-for-all. */
  teams: number;
  friendlyFire: boolean;
  /** 0 means eliminations are permanent. */
  respawnTicks: number;
  /** 0 means no time limit. */
  timeLimitTicks: number;
  /** Team or player score that ends the match; 0 means score does not end it. */
  scoreToWin: number;
  /** Walls each player may build; -1 for unlimited. */
  buildBudget: number;
  /** A pre-match phase during which nobody can be damaged. */
  warmupTicks: number;
  /** Recommended number of bots to fill the match with. */
  suggestedBots: number;
}

/**
 * A mode's ruling on an incoming hit. `damageMul` of 0 with `allow` true still
 * counts as a hit for effects but does no harm, which is what a warmup phase wants.
 */
export interface HitVerdict {
  allow: boolean;
  damageMul: number;
}

export const HIT_ALLOW: HitVerdict = { allow: true, damageMul: 1 };
export const HIT_BLOCK: HitVerdict = { allow: false, damageMul: 0 };

export interface WinResult {
  team: TeamId;
  player: PlayerId;
  reason: string;
}

export interface ModeCtx {
  rng: RngState;
  addTeamScore(team: TeamId, n: number): void;
  addPlayerScore(p: Player, n: number): void;
  /** Apply damage through the mode's own hit rules. */
  damage(p: Player, amount: number, attacker: PlayerId): void;
  /** Take a player out, handling flag drops and scoring side effects. */
  eliminate(p: Player, attacker: PlayerId): void;
  /** Put a player back in, at a spawn point the mode chooses. */
  respawn(p: Player): void;
  emit(
    type: SimEventType,
    id: number,
    x: number,
    y: number,
    z?: number,
    amount?: number,
    other?: number,
  ): void;
}

/** What the HUD needs. Pure data, so no mode ever writes drawing code. */
export interface ModeHud {
  /** Short mode name, e.g. "Capture the Flag". */
  title: string;
  /** The dominant readout, e.g. "2 - 1" or "4 alive". */
  headline: string;
  /** Supporting line, e.g. "1:24 left" or "respawning in 3". */
  sub: string;
  /** Large centred message, e.g. "Blue team wins". Empty for none. */
  banner: string;
  /** Per-team scores to render as chips; empty for free-for-all. */
  teamScores: number[];
}

export function createModeHud(): ModeHud {
  return { title: '', headline: '', sub: '', banner: '', teamScores: [] };
}

export interface Vec2Out {
  x: number;
  y: number;
}

export interface GameMode {
  readonly id: ModeId;
  readonly label: string;
  /** One line explaining the mode, shown in the mode picker. */
  readonly blurb: string;
  readonly config: ModeConfig;

  /** Set up objectives. Called once, after players have been spawned. */
  init(w: World, ctx: ModeCtx): void;

  /** Which team a joining player belongs to. */
  assignTeam(w: World, p: Player): TeamId;

  /** Where a player should (re)appear. */
  spawnPoint(w: World, p: Player, out: Vec2Out): void;

  /** Per-tick rules: objectives, zones, the closing ring. */
  onTick(w: World, ctx: ModeCtx): void;

  /** Veto or scale an incoming hit -- friendly fire, warmup, spawn protection. */
  onPlayerHit(w: World, victim: Player, attacker: PlayerId): HitVerdict;

  /** Award points and decide whether the victim can come back. */
  onEliminate(w: World, victim: Player, attacker: PlayerId, ctx: ModeCtx): void;

  /** Whether this player may build right now. */
  onBuildRequest(w: World, p: Player): boolean;

  /** Non-null ends the match. */
  checkWin(w: World): WinResult | null;

  hud(w: World, viewer: PlayerId, out: ModeHud): void;

  /**
   * Where a bot should head, so bot code needs no mode-specific knowledge.
   * Return false to let the bot fall back on hunting the nearest enemy.
   */
  botObjective(w: World, p: Player, out: Vec2Out): boolean;
}
