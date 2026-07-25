/**
 * Skin #2: the chicken.
 *
 * This file exists to prove the claim in skinTypes.ts. It was written AFTER the
 * stick figure and the animation system, and adding it required zero changes to
 * the skeleton solver, the gait code, the clip library or the renderer. If a
 * future creature ever does require an engine change, the abstraction has broken
 * and that is the moment to fix it -- not later.
 *
 * The three things that make a chicken a chicken, all pure data:
 *
 *  - `throwLimb` is a WING with `swing: 'frontal'`. The shared throw clip's
 *    keyframes are unchanged; because the axis differs, the same numbers read as
 *    a wing beating outward rather than an arm swinging forward.
 *  - The gait has a short cycle, a high lift and a big `swayAmp`, which is what
 *    turns a walk into a waddle.
 *  - Body parts are `ellipse` and `poly` instead of `line`, using the same five
 *    closed primitives the stick figure uses.
 */

import type { SkinDef } from '../skinTypes.js';

const BEAK = '#f2a63b';
const COMB = '#d64545';
const FEATHER = '#fdfdfd';
const FEATHER_SHADE = '#e3e7ee';
const OUTLINE = '#3a3226';

export const SKIN_CHICKEN: SkinDef = {
  id: 'chicken',
  label: 'Chicken',
  scale: 1,
  shadow: { rx: 12, ry: 5.5 },
  hold: { bone: 'wing.r', along: 0.9, across: 0 },
  palette: { feather: FEATHER, comb: COMB, beak: BEAK },

  bones: [
    { id: 'root', parent: null, length: 0, ay: 0 },
    // Above the 14-unit leg length, to leave room for the (large) waddle bob
    // without pushing the feet through the ground.
    { id: 'hips', parent: 'root', ay: 17, length: 0 },

    // A plump egg for a body. Short, so the chicken sits low and wide.
    {
      id: 'body',
      parent: 'hips',
      ay: 0,
      length: 13,
      swing: 'sagittal',
      shape: [
        { kind: 'ellipse', rx: 11.5, ry: 13, cy: 7, color: FEATHER, outline: OUTLINE },
        // A hint of a folded wing on the body itself.
        { kind: 'ellipse', rx: 5.5, ry: 7.5, cx: 4, cy: 6, color: FEATHER_SHADE },
      ],
    },

    // Tail: a fan of feathers. The stick figure has no tail role, so the shared
    // clips' tail track is dropped there and used here -- same clips either way.
    {
      id: 'tail',
      parent: 'body',
      ax: 0,
      ay: 6,
      az: -8,
      restAngle: -2.2,
      length: 11,
      swing: 'sagittal',
      shape: {
        kind: 'poly',
        pts: [
          [0, 0],
          [-5, 9],
          [0, 13],
          [5, 9],
        ],
        color: FEATHER_SHADE,
        outline: OUTLINE,
      },
      zBias: -0.3,
    },

    { id: 'neck', parent: 'body', ay: 12, length: 6, swing: 'sagittal' },

    {
      id: 'head',
      parent: 'neck',
      length: 8,
      swing: 'sagittal',
      shape: [
        { kind: 'circle', r: 6.2, cy: 4, color: FEATHER, outline: OUTLINE },
        // Beak, pointing forward (+z becomes forward at render time).
        {
          kind: 'poly',
          pts: [
            [0, 3],
            [9, 5],
            [0, 7],
          ],
          color: BEAK,
          outline: OUTLINE,
        },
        // Comb on top.
        {
          kind: 'poly',
          pts: [
            [-3, 9],
            [-1.5, 13],
            [0, 9.5],
            [1.5, 13],
            [3, 9],
          ],
          color: COMB,
          outline: OUTLINE,
        },
      ],
      zBias: 0.5,
    },

    // WINGS, not arms. `frontal` swing is the whole trick.
    {
      id: 'wing.r',
      parent: 'body',
      ax: 8,
      ay: 8,
      restAngle: 2.9,
      length: 13,
      swing: 'frontal',
      shape: {
        kind: 'poly',
        pts: [
          [0, 0],
          [-4.5, 7],
          [-2.5, 13],
          [3, 9],
        ],
        color: FEATHER,
        outline: OUTLINE,
      },
      zBias: 0.7,
    },
    {
      id: 'wing.l',
      parent: 'body',
      ax: -8,
      ay: 8,
      restAngle: -2.9,
      length: 13,
      swing: 'frontal',
      shape: {
        kind: 'poly',
        pts: [
          [0, 0],
          [4.5, 7],
          [2.5, 13],
          [-3, 9],
        ],
        color: FEATHER_SHADE,
        outline: OUTLINE,
      },
      zBias: -0.7,
    },

    // Scrawny two-segment legs, in beak orange.
    {
      id: 'leg.r.hip',
      parent: 'hips',
      ax: 3,
      ay: 0,
      restAngle: Math.PI,
      length: 7,
      swing: 'sagittal',
      shape: { kind: 'line', w: 2.2, color: BEAK, cap: 'round' },
      zBias: 0.2,
    },
    {
      id: 'leg.r.knee',
      parent: 'leg.r.hip',
      length: 7,
      swing: 'sagittal',
      shape: [
        { kind: 'line', w: 2, color: BEAK, cap: 'round' },
        // Three-toed foot at the tip.
        {
          kind: 'poly',
          pts: [
            [-3.5, 7],
            [0, 5.5],
            [3.5, 7],
            [0, 8],
          ],
          color: BEAK,
          outline: OUTLINE,
        },
      ],
      zBias: 0.2,
    },
    {
      id: 'leg.l.hip',
      parent: 'hips',
      ax: -3,
      ay: 0,
      restAngle: Math.PI,
      length: 7,
      swing: 'sagittal',
      shape: { kind: 'line', w: 2.2, color: BEAK, cap: 'round' },
      zBias: -0.2,
    },
    {
      id: 'leg.l.knee',
      parent: 'leg.l.hip',
      length: 7,
      swing: 'sagittal',
      shape: [
        { kind: 'line', w: 2, color: BEAK, cap: 'round' },
        {
          kind: 'poly',
          pts: [
            [-3.5, 7],
            [0, 5.5],
            [3.5, 7],
            [0, 8],
          ],
          color: BEAK,
          outline: OUTLINE,
        },
      ],
      zBias: -0.2,
    },
  ],

  roles: {
    root: 'root',
    body: 'body',
    head: 'head',
    throwLimb: 'wing.r',
    supportLimb: 'wing.l',
    crouchDriver: 'hips',
    tail: 'tail',
    legs: [
      { hip: 'leg.r.hip', knee: 'leg.r.knee', phase: 0, side: 1 },
      { hip: 'leg.l.hip', knee: 'leg.l.knee', phase: 0.5, side: -1 },
    ],
    gait: {
      // Short cycle + high lift + heavy sway = a waddle, from the same code that
      // gives the stick figure a walk.
      cycleLengthWorld: 52,
      strideAngle: 0.52,
      liftAngle: 0.8,
      bodyBobAmp: 2.6,
      bodyBobFreq: 2,
      leanPerSpeed: 0.24,
      swayAmp: 2.2,
    },
  },
};
