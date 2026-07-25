/**
 * The skin registry.
 *
 * Adding a creature is: write the skin file, add one line here. That is the
 * entire integration surface -- no renderer change, no clip change, no engine
 * change. A `cat.ts` with four legs at phases [0, 0.5, 0.25, 0.75] and
 * `bodyBobFreq: 4` slots in exactly the same way.
 */

import type { SkinDef } from '../skinTypes.js';
import { SKIN_STICK } from './stickFigure.js';
import { SKIN_CHICKEN } from './chicken.js';

export const SKINS: Record<string, SkinDef> = {
  [SKIN_STICK.id]: SKIN_STICK,
  [SKIN_CHICKEN.id]: SKIN_CHICKEN,
};

export const DEFAULT_SKIN_ID = SKIN_STICK.id;

export function getSkin(id: string | undefined): SkinDef {
  if (!id) return SKIN_STICK;
  return SKINS[id] ?? SKIN_STICK;
}

export function skinIds(): string[] {
  return Object.keys(SKINS);
}
