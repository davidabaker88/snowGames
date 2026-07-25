/**
 * Snow puffs, impact spray and packing scuff.
 *
 * Uses its OWN random source, deliberately separate from the simulation's seeded
 * RNG. If particles drew from the sim RNG, tweaking a visual effect would perturb
 * gameplay and break replay determinism -- a genuinely nasty class of bug.
 * Particles are cosmetic and may be as nondeterministic as they like.
 */

import { Y_SQUASH, clamp01 } from '@snow/shared';
import { worldToScreenX, worldToScreenY, type Camera, type Viewport } from './projection.js';

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
}

const MAX_PARTICLES = 420;

export class ParticleSystem {
  private items: Particle[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.items.push({
        alive: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 1,
        size: 1,
        color: '#fff',
        gravity: 400,
      });
    }
  }

  /** Ring-buffer allocation: the oldest particle is recycled under pressure. */
  private spawn(): Particle {
    const p = this.items[this.cursor]!;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    return p;
  }

  burst(
    x: number,
    y: number,
    z: number,
    count: number,
    opts: {
      speed?: number;
      up?: number;
      life?: number;
      size?: number;
      color?: string;
      gravity?: number;
    } = {},
  ): void {
    const speed = opts.speed ?? 90;
    for (let i = 0; i < count; i++) {
      const p = this.spawn();
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.8);
      p.alive = true;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s * Y_SQUASH;
      p.vz = (opts.up ?? 70) * (0.4 + Math.random());
      p.maxLife = (opts.life ?? 0.5) * (0.7 + Math.random() * 0.6);
      p.life = p.maxLife;
      p.size = (opts.size ?? 2.6) * (0.6 + Math.random() * 0.9);
      p.color = opts.color ?? '#ffffff';
      p.gravity = opts.gravity ?? 420;
    }
  }

  /** A ring of spray thrown outward from an impact, biased along a direction. */
  impact(x: number, y: number, z: number, dirX: number, dirY: number): void {
    const m = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / m;
    const ny = dirY / m;
    for (let i = 0; i < 14; i++) {
      const p = this.spawn();
      const spread = (Math.random() - 0.5) * 1.7;
      const cs = Math.cos(spread);
      const sn = Math.sin(spread);
      const s = 120 * (0.4 + Math.random());
      p.alive = true;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = (nx * cs - ny * sn) * s;
      p.vy = (nx * sn + ny * cs) * s * Y_SQUASH;
      p.vz = 60 * Math.random() + 20;
      p.maxLife = 0.42 * (0.7 + Math.random() * 0.7);
      p.life = p.maxLife;
      p.size = 2.4 * (0.6 + Math.random());
      p.color = '#ffffff';
      p.gravity = 460;
    }
  }

  update(dt: number): void {
    for (const p of this.items) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        continue;
      }
      p.vz -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.z < 0) {
        p.z = 0;
        p.vz *= -0.24;
        p.vx *= 0.6;
        p.vy *= 0.6;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, vp: Viewport): void {
    for (const p of this.items) {
      if (!p.alive) continue;
      const t = clamp01(p.life / p.maxLife);
      ctx.globalAlpha = t * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(
        worldToScreenX(p.x, cam, vp),
        worldToScreenY(p.y, p.z, cam, vp),
        Math.max(0.5, p.size * t * cam.zoom),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
