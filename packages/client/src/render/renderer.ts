/**
 * The frame.
 *
 * Order is fixed and each step exists for a reason:
 *   1. terrain + decals   -- baked, one blit each
 *   2. shadows            -- ONE pass for everything, at z=0
 *   3. the depth-sorted draw list (props, players, balls together)
 *   4. world-space overlays (aim preview, nameplates)
 *
 * Shadows get their own pass rather than being drawn with each entity because
 * they must never occlude one another, and because ctx.shadowBlur is
 * catastrophically slow on mobile Safari -- these are plain translucent ellipses.
 */

import {
  ActionState,
  BallState,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  Y_SQUASH,
  ballRadius,
  clamp01,
  compileSkin,
  createAnimSet,
  createSolvedPose,
  getSkin,
  solve,
  animatePlayer,
  type AnimSet,
  type Ball,
  type Player,
  type Prop,
  type Skeleton,
  type SolvedPose,
  type World,
} from '@snow/shared';
import { DrawKind, DrawList } from './drawList.js';
import { drawCharacter, holdPointScreen } from './characterRenderer.js';
import {
  isVisible,
  worldToScreenX,
  worldToScreenY,
  type Camera,
  type Viewport,
} from './projection.js';
import { fadeDecals, stampFootprint, type Terrain } from './terrain.js';
import { drawAimPreview } from './aimPreview.js';
import type { ParticleSystem } from './particles.js';

interface SkinRuntime {
  skeleton: Skeleton;
  anim: AnimSet;
  solved: SolvedPose;
}

export interface RenderOpts {
  world: World;
  cam: Camera;
  vp: Viewport;
  terrain: Terrain;
  /** Interpolation alpha within the current tick. */
  alpha: number;
  /** Monotonic seconds. */
  time: number;
  localPlayerId: number;
  particles: ParticleSystem;
  /** Aim preview is only drawn while the local player is holding a ball. */
  showAim: boolean;
  aimAngle: number;
  aimPower: number;
  debug: boolean;
}

const holdPt = { x: 0, y: 0 };

export class Renderer {
  private list = new DrawList();
  private skins = new Map<string, SkinRuntime>();
  private lastFootprint = new Map<number, number>();

  private runtimeFor(skinId: string): SkinRuntime {
    let rt = this.skins.get(skinId);
    if (!rt) {
      // Compile on first sight. One skeleton and one animator per SKIN, not per
      // character: the pose buffer is transient, used and drawn within one call.
      const skeleton = compileSkin(getSkin(skinId));
      rt = {
        skeleton,
        anim: createAnimSet(skeleton),
        solved: createSolvedPose(skeleton),
      };
      this.skins.set(skinId, rt);
    }
    return rt;
  }

  render(ctx: CanvasRenderingContext2D, o: RenderOpts): void {
    const { world: w, cam, vp } = o;

    ctx.clearRect(0, 0, vp.width, vp.height);
    this.drawTerrain(ctx, o);

    // ---- shadows, one pass -------------------------------------------------
    ctx.save();
    for (const p of w.players) {
      if (!p.active) continue;
      if (!isVisible(p.x, p.y, cam, vp)) continue;
      const skin = getSkin(p.skinId);
      this.drawShadow(ctx, o, p.x, p.y, 0, skin.shadow.rx, skin.shadow.ry);
    }
    for (const b of w.balls) {
      if (!b.alive || b.state === BallState.Held) continue;
      if (!isVisible(b.x, b.y, cam, vp)) continue;
      const r = ballRadius(b.size);
      this.drawShadow(ctx, o, b.x, b.y, b.z, r * 0.95, r * 0.55);
    }
    for (const prop of w.props) {
      if (prop.radius <= 0) continue;
      if (!isVisible(prop.x, prop.y, cam, vp)) continue;
      this.drawShadow(ctx, o, prop.x, prop.y, 0, prop.radius * 1.05, prop.radius * 0.5);
    }
    ctx.restore();

    // ---- build the single sorted list --------------------------------------
    this.list.clear();
    w.props.forEach((prop, i) => {
      if (isVisible(prop.x, prop.y, cam, vp)) this.list.push(DrawKind.Prop, i, prop.y);
    });
    for (const p of w.players) {
      if (!p.active) continue;
      if (!isVisible(p.x, p.y, cam, vp)) continue;
      this.list.push(DrawKind.Player, p.id, p.y);
    }
    for (const b of w.balls) {
      if (!b.alive || b.state === BallState.Held) continue;
      if (!isVisible(b.x, b.y, cam, vp)) continue;
      // Sorted by GROUND y even though drawn at height z -- so a ball in the air
      // is occluded by scenery in front of it, not by scenery it is above.
      this.list.push(DrawKind.Ball, b.id, b.y);
    }
    this.list.sort();

    this.list.forEach((d) => {
      switch (d.kind) {
        case DrawKind.Prop:
          this.drawProp(ctx, o, w.props[d.ref]!);
          break;
        case DrawKind.Player:
          this.drawPlayer(ctx, o, w.players[d.ref]!);
          break;
        case DrawKind.Ball:
          this.drawBall(ctx, o, w.balls[d.ref]!);
          break;
        default:
          break;
      }
    });

    // ---- overlays ----------------------------------------------------------
    o.particles.draw(ctx, cam, vp);

    if (o.showAim) {
      const me = w.players[o.localPlayerId];
      if (me?.active && me.alive) {
        drawAimPreview(ctx, w, me, o.aimAngle, o.aimPower, cam, vp);
      }
    }

    this.drawNameplates(ctx, o);
  }

  private drawTerrain(ctx: CanvasRenderingContext2D, o: RenderOpts): void {
    const { terrain: t, cam, vp } = o;
    const sx = worldToScreenX(t.bounds.minX, cam, vp);
    const sy = worldToScreenY(t.bounds.minY, 0, cam, vp);
    const w = (t.bounds.maxX - t.bounds.minX) * cam.zoom;
    const h = (t.bounds.maxY - t.bounds.minY) * Y_SQUASH * cam.zoom;

    // Off-map area: a darker blue so the arena edge is legible.
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, vp.width, vp.height);
    ctx.drawImage(t.ground, sx, sy, w, h);
    ctx.drawImage(t.decals, sx, sy, w, h);

    // Arena border.
    ctx.strokeStyle = 'rgba(120,150,185,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, w, h);
  }

  private drawShadow(
    ctx: CanvasRenderingContext2D,
    o: RenderOpts,
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
  ): void {
    const { cam, vp } = o;
    // Higher up = larger and fainter shadow, which is most of what sells height.
    const lift = clamp01(z / 120);
    const spread = 1 + lift * 0.9;
    const alpha = 0.26 * (1 - lift * 0.62);

    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#4a6785';
    ctx.beginPath();
    ctx.ellipse(
      worldToScreenX(x, cam, vp),
      worldToScreenY(y, 0, cam, vp),
      rx * spread * cam.zoom,
      ry * spread * cam.zoom,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawProp(ctx: CanvasRenderingContext2D, o: RenderOpts, prop: Prop): void {
    const { cam, vp } = o;
    const x = worldToScreenX(prop.x, cam, vp);
    const yBase = worldToScreenY(prop.y, 0, cam, vp);
    const z = cam.zoom;

    switch (prop.kind) {
      case 'tree': {
        const trunkH = 34 * z;
        ctx.fillStyle = '#6b5136';
        ctx.fillRect(x - 3.4 * z, yBase - trunkH, 6.8 * z, trunkH);
        // Three stacked snowy tiers.
        for (let i = 0; i < 3; i++) {
          const ty = yBase - trunkH - i * 26 * z;
          const tw = (30 - i * 7) * z;
          ctx.beginPath();
          ctx.moveTo(x - tw, ty);
          ctx.lineTo(x, ty - 40 * z);
          ctx.lineTo(x + tw, ty);
          ctx.closePath();
          ctx.fillStyle = i === 2 ? '#2f5d4a' : '#2a5142';
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(x - tw * 0.82, ty - 2 * z);
          ctx.lineTo(x, ty - 34 * z);
          ctx.lineTo(x + tw * 0.82, ty - 2 * z);
          ctx.closePath();
          ctx.fillStyle = 'rgba(248,252,255,0.82)';
          ctx.fill();
        }
        break;
      }
      case 'rock': {
        // A mound sitting ON the ground, not an ellipse floating above it: a flat
        // base line plus a domed top is what makes it read as a rock rather than
        // as a grey disc hovering in the snow.
        const r = prop.radius * z;
        const h = prop.height * z;
        ctx.beginPath();
        ctx.moveTo(x - r, yBase);
        ctx.bezierCurveTo(x - r * 0.95, yBase - h * 1.5, x + r * 0.95, yBase - h * 1.5, x + r, yBase);
        ctx.closePath();
        ctx.fillStyle = '#8d9aab';
        ctx.fill();
        ctx.strokeStyle = '#6d7d90';
        ctx.lineWidth = Math.max(0.8, 1.1 * z);
        ctx.stroke();

        // Snow settled on the crown: a SOLID dome capping the top. Drawing it as a
        // crescent between two arcs instead makes the rock look like a basket
        // with a handle.
        ctx.beginPath();
        ctx.moveTo(x - r * 0.74, yBase - h * 0.55);
        ctx.bezierCurveTo(
          x - r * 0.7,
          yBase - h * 1.42,
          x + r * 0.7,
          yBase - h * 1.42,
          x + r * 0.74,
          yBase - h * 0.55,
        );
        // Sag the underside slightly so the snow line follows the rock's contour.
        ctx.quadraticCurveTo(x, yBase - h * 0.38, x - r * 0.74, yBase - h * 0.55);
        ctx.closePath();
        ctx.fillStyle = '#f4f8fd';
        ctx.fill();
        break;
      }
      case 'crate': {
        const r = prop.radius * z;
        const h = prop.height * z;
        ctx.fillStyle = '#9a7346';
        ctx.fillRect(x - r, yBase - h, r * 2, h);
        ctx.strokeStyle = '#6f5230';
        ctx.lineWidth = Math.max(1, 1.6 * z);
        ctx.strokeRect(x - r, yBase - h, r * 2, h);
        ctx.fillStyle = 'rgba(248,252,255,0.9)';
        ctx.fillRect(x - r, yBase - h, r * 2, 4.5 * z);
        break;
      }
      case 'lamp': {
        const h = prop.height * z;
        ctx.strokeStyle = '#3d4a5a';
        ctx.lineWidth = Math.max(1, 3 * z);
        ctx.beginPath();
        ctx.moveTo(x, yBase);
        ctx.lineTo(x, yBase - h);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, yBase - h, 6 * z, 0, Math.PI * 2);
        ctx.fillStyle = '#ffe9a8';
        ctx.fill();
        // A soft pool of light on the snow.
        const grad = ctx.createRadialGradient(x, yBase, 0, x, yBase, 60 * z);
        grad.addColorStop(0, 'rgba(255,225,150,0.22)');
        grad.addColorStop(1, 'rgba(255,225,150,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(x, yBase, 60 * z, 30 * z, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, o: RenderOpts, p: Player): void {
    const { cam, vp } = o;
    const rt = this.runtimeFor(p.skinId);

    const pose = animatePlayer(rt.anim, p, { time: o.time, alpha: o.alpha });
    solve(rt.skeleton, pose, rt.solved);

    const drawOpts = {
      screenX: worldToScreenX(p.x, cam, vp),
      screenY: worldToScreenY(p.y, 0, cam, vp),
      facing: p.facing,
      zoom: cam.zoom,
      alpha: p.action === ActionState.Eliminated ? 0.75 : 1,
      tint: '#ff5d47',
      tintAmount: p.staggerAmount * 0.8,
    };

    drawCharacter(ctx, rt.skeleton, rt.solved, drawOpts);

    // A held ball rides the skin's declared hold bone.
    if (p.heldBall >= 0) {
      const b = o.world.balls[p.heldBall];
      if (b?.alive && holdPointScreen(rt.skeleton, rt.solved, drawOpts, holdPt)) {
        this.paintBall(ctx, holdPt.x, holdPt.y, ballRadius(b.size) * cam.zoom, 0);
      }
    }

    // Footprints, rate-limited by distance rather than by time so they space
    // evenly regardless of speed.
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 20 && p.alive) {
      const last = this.lastFootprint.get(p.id) ?? -1e9;
      if (p.gaitDistance - last > 26) {
        this.lastFootprint.set(p.id, p.gaitDistance);
        stampFootprint(o.terrain, p.x, p.y, p.facing);
      }
    }
  }

  private drawBall(ctx: CanvasRenderingContext2D, o: RenderOpts, b: Ball): void {
    const { cam, vp } = o;
    const x = worldToScreenX(b.x, cam, vp);
    const y = worldToScreenY(b.y, b.z, cam, vp);
    this.paintBall(ctx, x, y, ballRadius(b.size) * cam.zoom, b.spin);
  }

  private paintBall(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    spin: number,
  ): void {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, r), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#a9bed6';
    ctx.lineWidth = Math.max(0.6, r * 0.16);
    ctx.stroke();
    // A single offset highlight, rotated by spin, reads as tumbling.
    ctx.beginPath();
    ctx.arc(x + Math.cos(spin) * r * 0.3, y + Math.sin(spin) * r * 0.3, r * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(214,230,246,0.85)';
    ctx.fill();
  }

  private drawNameplates(ctx: CanvasRenderingContext2D, o: RenderOpts): void {
    const { world: w, cam, vp } = o;
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(11 * Math.max(1, cam.zoom))}px system-ui, sans-serif`;

    for (const p of w.players) {
      if (!p.active || !isVisible(p.x, p.y, cam, vp)) continue;
      if (p.id === o.localPlayerId) continue;

      const x = worldToScreenX(p.x, cam, vp);
      const y = worldToScreenY(p.y, PLAYER_HEIGHT + 20, cam, vp);

      // Health bar, only when damaged -- a screen full of full bars is noise.
      const maxHp = p.isDummy ? 60 : 100;
      if (p.hp < maxHp && p.alive) {
        const bw = PLAYER_RADIUS * 2.2 * cam.zoom;
        const bh = 3.5 * cam.zoom;
        ctx.fillStyle = 'rgba(20,30,45,0.55)';
        ctx.fillRect(x - bw / 2, y, bw, bh);
        ctx.fillStyle = p.hp > maxHp * 0.4 ? '#6ddf8f' : '#ef6a52';
        ctx.fillRect(x - bw / 2, y, bw * clamp01(p.hp / maxHp), bh);
      }

      if (p.isDummy) continue;
      ctx.fillStyle = 'rgba(15,25,40,0.7)';
      ctx.fillText(p.name, x, y - 4 * cam.zoom);
    }
    ctx.textAlign = 'left';
  }

  /** Called once per tick, not once per frame. */
  tickDecals(t: Terrain): void {
    fadeDecals(t, 0.004);
  }
}
