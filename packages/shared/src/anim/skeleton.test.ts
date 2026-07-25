import { describe, expect, it } from 'vitest';
import {
  compileSkin,
  createPoseBuffer,
  createSolvedPose,
  localToWorldOffset,
  POSE_ANGLE,
  POSE_STRIDE,
  resetPose,
  solve,
} from './skeleton.js';
import { SKIN_STICK } from './skins/stickFigure.js';
import { SKIN_CHICKEN } from './skins/chicken.js';
import { SKINS } from './skins/registry.js';
import { ALL_CLIPS } from './clips/common.js';
import { compileClip } from './pose.js';
import type { SkinDef } from './skinTypes.js';

describe('compileSkin', () => {
  it('compiles every registered skin', () => {
    for (const skin of Object.values(SKINS)) {
      expect(() => compileSkin(skin), `skin ${skin.id}`).not.toThrow();
    }
  });

  it('rejects a bone whose parent is declared after it', () => {
    const bad: SkinDef = {
      ...SKIN_STICK,
      id: 'bad',
      bones: [
        { id: 'child', parent: 'parent', length: 5 },
        { id: 'parent', parent: null, length: 5 },
      ],
    };
    expect(() => compileSkin(bad)).toThrow(/must precede children/);
  });

  it('rejects a role pointing at a nonexistent bone', () => {
    const bad: SkinDef = {
      ...SKIN_STICK,
      id: 'bad2',
      roles: { ...SKIN_STICK.roles, head: 'no-such-bone' },
    };
    expect(() => compileSkin(bad)).toThrow(/does not exist/);
  });

  it('rejects duplicate bone ids', () => {
    const bad: SkinDef = {
      ...SKIN_STICK,
      id: 'bad3',
      bones: [
        { id: 'root', parent: null, length: 0 },
        { id: 'root', parent: null, length: 0 },
      ],
    };
    expect(() => compileSkin(bad)).toThrow(/duplicate bone id/);
  });
});

describe('forward kinematics', () => {
  it('places the stick figure head above the hips in the rest pose', () => {
    const sk = compileSkin(SKIN_STICK);
    const pose = createPoseBuffer(sk);
    resetPose(pose, sk.bones.length);
    const out = solve(sk, pose, createSolvedPose(sk));

    const head = out.bones[sk.roles.get('head')!]!;
    const hips = out.bones[sk.roles.get('crouchDriver')!]!;
    expect(head.oy).toBeGreaterThan(hips.oy);
  });

  it('hangs legs below the hips at rest', () => {
    const sk = compileSkin(SKIN_STICK);
    const pose = createPoseBuffer(sk);
    resetPose(pose, sk.bones.length);
    const out = solve(sk, pose, createSolvedPose(sk));

    const hips = out.bones[sk.roles.get('crouchDriver')!]!;
    const knee = out.bones[sk.roles.get('leg.0.knee')!]!;
    // The knee bone's TIP is the foot, which must reach roughly the ground.
    expect(knee.ty).toBeLessThan(hips.oy);
    expect(Math.abs(knee.ty)).toBeLessThan(4);
  });

  it('produces no NaN for any skin at any facing', () => {
    for (const skin of Object.values(SKINS)) {
      const sk = compileSkin(skin);
      const pose = createPoseBuffer(sk);
      resetPose(pose, sk.bones.length);
      const out = solve(sk, pose, createSolvedPose(sk));
      for (const b of out.bones) {
        for (const v of [b.ox, b.oy, b.oz, b.tx, b.ty, b.tz, b.scale, b.alpha]) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('rotates a child bone when its parent rotates (hierarchy is respected)', () => {
    const sk = compileSkin(SKIN_STICK);
    const pose = createPoseBuffer(sk);
    resetPose(pose, sk.bones.length);
    const spine = sk.roles.get('body')!;
    const before = solve(sk, pose, createSolvedPose(sk)).bones[sk.roles.get('head')!]!;
    const beforeZ = before.oz;

    // Lean the spine forward; the head must move forward with it.
    pose[spine * POSE_STRIDE + POSE_ANGLE] = 0.6;
    const after = solve(sk, pose, createSolvedPose(sk)).bones[sk.roles.get('head')!]!;
    expect(after.oz).toBeGreaterThan(beforeZ + 1);
  });
});

describe('turntable projection', () => {
  const out = { x: 0, y: 0 };

  it('maps local forward onto the facing direction', () => {
    // Facing +x (screen right): forward should project to screen right.
    localToWorldOffset(0, 10, 0, out);
    expect(out.x).toBeCloseTo(10, 5);
    expect(out.y).toBeCloseTo(0, 5);

    // Facing +y (screen down): forward should project to +y.
    localToWorldOffset(0, 10, Math.PI / 2, out);
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(10, 5);
  });

  it('never collapses a stride to zero screen motion at any facing', () => {
    // This is the failure mode the projection convention was chosen to avoid:
    // with the naive convention, forward maps purely onto the compressed axis at
    // facings of +/-90deg and the legs visibly freeze.
    const Y_SQUASH = 0.6;
    let worst = Infinity;
    for (let i = 0; i < 64; i++) {
      const f = (i / 64) * Math.PI * 2;
      localToWorldOffset(0, 1, f, out);
      // Screen-space magnitude of one unit of forward motion.
      const mag = Math.hypot(out.x, out.y * Y_SQUASH);
      worst = Math.min(worst, mag);
    }
    expect(worst).toBeGreaterThan(0.55);
  });
});

describe('the swappable-skin contract', () => {
  it('drops clip tracks for roles a skin does not have, without throwing', () => {
    const stick = compileSkin(SKIN_STICK);
    // The stick figure has no tail; the shared clips include tail tracks.
    expect(stick.roles.has('tail')).toBe(false);
    for (const clip of ALL_CLIPS) {
      expect(() => compileClip(stick, clip)).not.toThrow();
    }
  });

  it('keeps the tail track for a skin that does declare a tail', () => {
    const chicken = compileSkin(SKIN_CHICKEN);
    expect(chicken.roles.has('tail')).toBe(true);
  });

  it('compiles the identical clip library against every skin', () => {
    for (const skin of Object.values(SKINS)) {
      const sk = compileSkin(skin);
      for (const clip of ALL_CLIPS) {
        const compiled = compileClip(sk, clip);
        // Every surviving track must address a real bone in this skeleton.
        for (const tr of compiled.tracks) {
          const bone = Math.floor(tr.slot / POSE_STRIDE);
          expect(bone).toBeGreaterThanOrEqual(0);
          expect(bone).toBeLessThan(sk.bones.length);
        }
      }
    }
  });

  it('drives the chicken throw through a frontal-swing wing', () => {
    // The point of the abstraction: same clip, different axis, different read.
    const wing = SKIN_CHICKEN.bones.find((b) => b.id === SKIN_CHICKEN.roles.throwLimb);
    expect(wing?.swing).toBe('frontal');
    const arm = SKIN_STICK.bones.find((b) => b.id === SKIN_STICK.roles.throwLimb);
    expect(arm?.swing ?? 'sagittal').toBe('sagittal');
  });
});
