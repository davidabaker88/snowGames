/**
 * The mode registry.
 *
 * Adding a mode is: write the file, add one line here. Nothing in the simulation,
 * renderer or HUD needs to know it exists. Note that Fort Defense is not a fifth
 * implementation -- it is King of the Hill with different numbers.
 */

import { SANDBOX } from './sandbox.js';
import { LAST_ONE_STANDING } from './lastOneStanding.js';
import { TEAM_WAR } from './teamWar.js';
import { CAPTURE_THE_FLAG } from './captureTheFlag.js';
import { FORT_DEFENSE, KING_OF_THE_HILL } from './kingOfTheHill.js';
import type { GameMode, ModeId } from './types.js';

export const MODES: Record<ModeId, GameMode> = {
  sandbox: SANDBOX,
  lastOneStanding: LAST_ONE_STANDING,
  teamWar: TEAM_WAR,
  captureTheFlag: CAPTURE_THE_FLAG,
  kingOfTheHill: KING_OF_THE_HILL,
  fortDefense: FORT_DEFENSE,
};

/** Order shown in the mode picker: practice first, then increasing complexity. */
export const MODE_ORDER: ModeId[] = [
  'sandbox',
  'lastOneStanding',
  'teamWar',
  'captureTheFlag',
  'kingOfTheHill',
  'fortDefense',
];

/** The competitive modes, i.e. everything that can actually be won. */
export const PLAYABLE_MODES: ModeId[] = MODE_ORDER.filter((m) => m !== 'sandbox');

export function getMode(id: string | undefined): GameMode {
  if (!id) return SANDBOX;
  return MODES[id as ModeId] ?? SANDBOX;
}

export function isModeId(id: string): id is ModeId {
  return id in MODES;
}
