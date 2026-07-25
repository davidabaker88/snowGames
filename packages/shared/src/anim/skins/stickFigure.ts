/**
 * Skin #1: the stick figure.
 *
 * Deliberately the simplest thing that exercises the whole rig -- lines and one
 * circle. If the animation looks right here, it is the maths that is right rather
 * than the artwork covering for it.
 *
 * Angle convention: 0 points straight up, positive rotates FORWARD (the direction
 * the character faces). So a hanging arm or a standing leg sits near PI.
 *
 * The one non-obvious thing here is that the rest pose is deliberately NOT
 * symmetric or straight. A 3/4 view shows a character in near-profile when it
 * faces east or west, and in profile every left-right offset collapses to nothing
 * -- so a figure whose arms and legs all hang at exactly PI renders as a single
 * vertical line with a head. Offsetting the limbs in the SAGITTAL plane (which is
 * the plane you can see from the side) gives the silhouette structure at every
 * facing, at rest as well as mid-stride.
 *
 * Total height works out at ~62 units, against PLAYER_HEIGHT = 58.
 */

import type { SkinDef } from '../skinTypes.js';

const INK = '#22303f';
/** The far-side limbs, drawn slightly lighter so depth reads at a glance. */
const INK_FAR = '#5a7189';
const SNOW = '#fdfdfd';

/** How far the limbs part in the sagittal plane at rest, in radians. */
const ARM_SPLAY = 0.24;
const LEG_SPLAY = 0.13;

export const SKIN_STICK: SkinDef = {
  id: 'stick',
  label: 'Stick Figure',
  scale: 1,
  shadow: { rx: 12, ry: 5 },
  hold: { bone: 'arm.r', along: 1, across: 0 },
  palette: { ink: INK, accent: '#e8563f' },

  bones: [
    // Root sits on the ground between the feet; everything hangs off it.
    { id: 'root', parent: null, length: 0, ay: 0 },

    // Hips carry the crouch offset, so crouching lowers everything above them.
    // Set slightly ABOVE the leg length (26) on purpose: the body bob lowers the
    // whole figure by up to `bodyBobAmp`, and with zero clearance that pushes the
    // feet through the ground on every stride.
    { id: 'hips', parent: 'root', ay: 28, length: 0 },

    // The spine is the `body` role: leaning it tilts the whole upper body.
    {
      id: 'spine',
      parent: 'hips',
      ay: 0,
      length: 24,
      swing: 'sagittal',
      shape: { kind: 'line', w: 3.6, color: INK, cap: 'round' },
    },

    {
      id: 'neck',
      parent: 'spine',
      length: 5,
      swing: 'sagittal',
      shape: { kind: 'line', w: 3, color: INK, cap: 'round' },
    },
    {
      id: 'head',
      parent: 'neck',
      length: 11,
      swing: 'sagittal',
      // Centred partway up the bone so the neck meets the chin rather than the
      // middle of the face.
      shape: { kind: 'circle', r: 6.2, cy: 6, color: SNOW, outline: INK },
      zBias: 0.5,
    },

    // Arms attach at the shoulder line -- `ay` is explicit rather than
    // auto-attaching at the spine's tip, which would put them at the ears.
    {
      id: 'arm.r',
      parent: 'spine',
      ax: 4,
      ay: 21,
      restAngle: Math.PI - ARM_SPLAY,
      length: 18,
      swing: 'sagittal',
      shape: { kind: 'line', w: 2.9, color: INK, cap: 'round' },
      zBias: 0.8,
    },
    {
      id: 'arm.l',
      parent: 'spine',
      ax: -4,
      ay: 21,
      restAngle: Math.PI + ARM_SPLAY,
      length: 18,
      swing: 'sagittal',
      shape: { kind: 'line', w: 2.9, color: INK_FAR, cap: 'round' },
      zBias: -0.8,
    },

    // Two-bone legs, 13 + 13 = 26, which is exactly the hip height -- so the feet
    // reach the ground at rest without any IK.
    {
      id: 'leg.r.hip',
      parent: 'hips',
      ax: 3.4,
      ay: 0,
      restAngle: Math.PI - LEG_SPLAY,
      length: 13,
      swing: 'sagittal',
      shape: { kind: 'line', w: 3.2, color: INK, cap: 'round' },
      zBias: 0.3,
    },
    {
      id: 'leg.r.knee',
      parent: 'leg.r.hip',
      length: 13,
      swing: 'sagittal',
      shape: { kind: 'line', w: 2.9, color: INK, cap: 'round' },
      zBias: 0.3,
    },
    {
      id: 'leg.l.hip',
      parent: 'hips',
      ax: -3.4,
      ay: 0,
      restAngle: Math.PI + LEG_SPLAY,
      length: 13,
      swing: 'sagittal',
      shape: { kind: 'line', w: 3.2, color: INK_FAR, cap: 'round' },
      zBias: -0.3,
    },
    {
      id: 'leg.l.knee',
      parent: 'leg.l.hip',
      length: 13,
      swing: 'sagittal',
      shape: { kind: 'line', w: 2.9, color: INK_FAR, cap: 'round' },
      zBias: -0.3,
    },
  ],

  roles: {
    root: 'root',
    body: 'spine',
    head: 'head',
    throwLimb: 'arm.r',
    supportLimb: 'arm.l',
    crouchDriver: 'hips',
    // No `tail` -- the shared clips' tail track is dropped for this skin, which
    // is the graceful-degradation contract doing its job.
    legs: [
      { hip: 'leg.r.hip', knee: 'leg.r.knee', phase: 0, side: 1 },
      { hip: 'leg.l.hip', knee: 'leg.l.knee', phase: 0.5, side: -1 },
    ],
    gait: {
      cycleLengthWorld: 92,
      strideAngle: 0.58,
      liftAngle: 0.7,
      bodyBobAmp: 1.8,
      bodyBobFreq: 2,
      leanPerSpeed: 0.15,
    },
  },
};
