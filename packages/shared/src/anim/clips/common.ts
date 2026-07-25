/**
 * The shared clip library.
 *
 * Every clip here targets ROLES only, so this one file animates stick figures,
 * chickens and cats. Where a creature lacks a role the track is dropped at
 * compile time -- which is why, for instance, the throw clip drives both
 * `throwLimb` AND `head`: an arm-thrower uses the former, and a creature with no
 * throwing limb still gets a readable head-flick from the latter.
 *
 * Durations here are nominal. The animator stretches action clips to the tick
 * counts in constants.ts, because the simulation -- not the artwork -- owns how
 * long an action takes.
 */

import type { ClipDef } from '../clipTypes.js';

/** Arms swing opposite to the legs. Layered additively over the procedural gait. */
export const CLIP_WALK: ClipDef = {
  name: 'walk',
  duration: 0.7,
  loop: true,
  tracks: [
    {
      target: 'throwLimb',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: 0.5, ease: 'quadInOut' },
        { t: 0.5, v: -0.5, ease: 'quadInOut' },
        { t: 1, v: 0.5 },
      ],
    },
    {
      target: 'supportLimb',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: -0.5, ease: 'quadInOut' },
        { t: 0.5, v: 0.5, ease: 'quadInOut' },
        { t: 1, v: -0.5 },
      ],
    },
  ],
};

export const CLIP_IDLE: ClipDef = {
  name: 'idle',
  duration: 2.4,
  loop: true,
  tracks: [
    {
      target: 'throwLimb',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: 0.04, ease: 'quadInOut' },
        { t: 0.5, v: -0.04, ease: 'quadInOut' },
        { t: 1, v: 0.04 },
      ],
    },
    {
      target: 'supportLimb',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: -0.04, ease: 'quadInOut' },
        { t: 0.5, v: 0.04, ease: 'quadInOut' },
        { t: 1, v: -0.04 },
      ],
    },
  ],
};

/**
 * Packing: both limbs forward and low, rolling a ball between them, with the
 * body crouched over the work. Loops for as long as the player keeps circling.
 */
export const CLIP_PACK: ClipDef = {
  name: 'pack',
  duration: 0.55,
  loop: true,
  tracks: [
    {
      target: 'crouchDriver',
      prop: 'oy',
      additive: true,
      keys: [
        { t: 0, v: -2.2, ease: 'quadInOut' },
        { t: 0.5, v: -3.4, ease: 'quadInOut' },
        { t: 1, v: -2.2 },
      ],
    },
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [{ t: 0, v: 0.42 }],
    },
    {
      target: 'throwLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 1.9, ease: 'quadInOut' },
        { t: 0.5, v: 2.5, ease: 'quadInOut' },
        { t: 1, v: 1.9 },
      ],
    },
    {
      target: 'supportLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 2.5, ease: 'quadInOut' },
        { t: 0.5, v: 1.9, ease: 'quadInOut' },
        { t: 1, v: 2.5 },
      ],
    },
    {
      target: 'head',
      prop: 'angle',
      additive: true,
      keys: [{ t: 0, v: 0.3 }],
    },
  ],
  events: [{ t: 0.5, name: 'snowScuff' }],
};

/** Wind up: limb back and up, torso coiled away from the target. */
export const CLIP_WINDUP: ClipDef = {
  name: 'windup',
  duration: 0.22,
  tracks: [
    {
      target: 'throwLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 1, v: -2.1 },
      ],
    },
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 1, v: -0.22 },
      ],
    },
    {
      target: 'supportLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 1, v: 1.1 },
      ],
    },
  ],
};

/**
 * Throw: whip the limb through and follow through past vertical.
 * `backOut` on the release gives the overshoot that makes it read as a snap
 * rather than a slide.
 */
export const CLIP_THROW: ClipDef = {
  name: 'throw',
  duration: 0.3,
  tracks: [
    {
      target: 'throwLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: -2.1, ease: 'cubicIn' },
        { t: 0.35, v: 1.5, ease: 'backOut' },
        { t: 1, v: 0.9 },
      ],
    },
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: -0.22, ease: 'cubicOut' },
        { t: 0.35, v: 0.3, ease: 'quadOut' },
        { t: 1, v: 0.08 },
      ],
    },
    {
      target: 'supportLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 1.1, ease: 'quadOut' },
        { t: 0.4, v: -0.6, ease: 'quadOut' },
        { t: 1, v: -0.2 },
      ],
    },
    // Drives creatures with no throwLimb -- a cat flicks its head instead.
    {
      target: 'head',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: -0.2, ease: 'cubicIn' },
        { t: 0.35, v: 0.45, ease: 'backOut' },
        { t: 1, v: 0 },
      ],
    },
  ],
  events: [{ t: 0.35, name: 'throwRelease' }],
};

/** Crouch down, set the ball on the ground, stand back up. */
export const CLIP_PLACE: ClipDef = {
  name: 'place',
  duration: 0.36,
  tracks: [
    {
      target: 'crouchDriver',
      prop: 'oy',
      additive: true,
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 0.45, v: -7, ease: 'quadInOut' },
        { t: 1, v: 0 },
      ],
    },
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 0.45, v: 0.62, ease: 'quadInOut' },
        { t: 1, v: 0 },
      ],
    },
    {
      target: 'throwLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 0.45, v: 2.7, ease: 'quadInOut' },
        { t: 1, v: 0 },
      ],
    },
  ],
  events: [{ t: 0.45, name: 'ballDown' }],
};

/** Same shape as place, slightly quicker -- picking up should feel snappier. */
export const CLIP_PICKUP: ClipDef = {
  name: 'pickup',
  duration: 0.3,
  tracks: [
    {
      target: 'crouchDriver',
      prop: 'oy',
      additive: true,
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 0.4, v: -7.5, ease: 'quadOut' },
        { t: 1, v: 0 },
      ],
    },
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 0.4, v: 0.66, ease: 'quadOut' },
        { t: 1, v: 0 },
      ],
    },
    {
      target: 'throwLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 0, ease: 'quadOut' },
        { t: 0.4, v: 2.8, ease: 'quadOut' },
        { t: 1, v: 0.2 },
      ],
    },
  ],
  events: [{ t: 0.4, name: 'ballUp' }],
};

/** Patting a wall into shape: repeated two-handed presses. */
export const CLIP_BUILD: ClipDef = {
  name: 'build',
  duration: 0.4,
  loop: true,
  tracks: [
    {
      target: 'crouchDriver',
      prop: 'oy',
      additive: true,
      keys: [
        { t: 0, v: -3, ease: 'quadInOut' },
        { t: 0.5, v: -5.5, ease: 'quadInOut' },
        { t: 1, v: -3 },
      ],
    },
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [{ t: 0, v: 0.34 }],
    },
    {
      target: 'throwLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 1.5, ease: 'quadOut' },
        { t: 0.5, v: 2.3, ease: 'quadIn' },
        { t: 1, v: 1.5 },
      ],
    },
    {
      target: 'supportLimb',
      prop: 'angle',
      keys: [
        { t: 0, v: 1.5, ease: 'quadOut' },
        { t: 0.5, v: 2.3, ease: 'quadIn' },
        { t: 1, v: 1.5 },
      ],
    },
  ],
  events: [{ t: 0.5, name: 'wallPat' }],
};

/** Recoil from a hit. Additive so it layers over whatever you were doing. */
export const CLIP_STAGGER: ClipDef = {
  name: 'stagger',
  duration: 0.4,
  tracks: [
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: -0.5, ease: 'elasticOut' },
        { t: 1, v: 0 },
      ],
    },
    {
      target: 'head',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: -0.55, ease: 'elasticOut' },
        { t: 1, v: 0 },
      ],
    },
    {
      target: 'throwLimb',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: -0.7, ease: 'elasticOut' },
        { t: 1, v: 0 },
      ],
    },
    {
      target: 'supportLimb',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: 0.7, ease: 'elasticOut' },
        { t: 1, v: 0 },
      ],
    },
  ],
};

/** Fold up and fade. Non-looping; holds its final frame. */
export const CLIP_ELIMINATED: ClipDef = {
  name: 'eliminated',
  duration: 0.9,
  tracks: [
    {
      target: 'crouchDriver',
      prop: 'oy',
      additive: true,
      keys: [
        { t: 0, v: 0, ease: 'quadIn' },
        { t: 1, v: -13 },
      ],
    },
    {
      target: 'body',
      prop: 'angle',
      additive: true,
      keys: [
        { t: 0, v: 0, ease: 'quadIn' },
        { t: 1, v: 1.2 },
      ],
    },
    {
      target: 'root',
      prop: 'alpha',
      keys: [
        { t: 0, v: 1, ease: 'quadIn' },
        { t: 0.7, v: 0.55 },
        { t: 1, v: 0.5 },
      ],
    },
  ],
};

export const ALL_CLIPS: readonly ClipDef[] = [
  CLIP_IDLE,
  CLIP_WALK,
  CLIP_PACK,
  CLIP_WINDUP,
  CLIP_THROW,
  CLIP_PLACE,
  CLIP_PICKUP,
  CLIP_BUILD,
  CLIP_STAGGER,
  CLIP_ELIMINATED,
];
