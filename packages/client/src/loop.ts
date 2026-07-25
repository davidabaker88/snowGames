/**
 * Fixed-timestep loop.
 *
 * The simulation runs at exactly TICK_HZ; rendering runs at display rate and
 * interpolates with the leftover accumulator as an alpha. That separation is what
 * makes the game behave identically on a 60Hz phone and a 144Hz monitor, and it
 * is a hard requirement for prediction later -- replaying inputs only reproduces
 * the same result if each tick is the same size.
 *
 * The catch-up cap matters specifically on mobile: backgrounding a tab and
 * returning produces an enormous elapsed time, and without a cap the game would
 * fast-forward violently (or freeze while it simulated thousands of ticks).
 */

import { MAX_CATCHUP_TICKS, TICK_MS } from '@snow/shared';

export interface LoopCallbacks {
  tick(): void;
  render(alpha: number, dtMs: number): void;
}

export class GameLoop {
  private raf = 0;
  private last = 0;
  private acc = 0;
  private running = false;

  /** Smoothed frames per second, for the debug readout. */
  fps = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    const frame = (now: number): void => {
      if (!this.running) return;
      // Clamp the raw delta: a long stall must not translate into a huge
      // accumulator even before the tick cap applies.
      const dt = Math.min(now - this.last, 250);
      this.last = now;
      this.acc += dt;

      this.fps = this.fps === 0 ? 1000 / Math.max(1, dt) : this.fps * 0.92 + (1000 / Math.max(1, dt)) * 0.08;

      let ticks = 0;
      while (this.acc >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
        this.cb.tick();
        this.acc -= TICK_MS;
        ticks++;
      }
      // If we hit the cap there is still a backlog; drop it rather than trying to
      // catch up over the next several frames, which would feel like a lurch.
      if (ticks >= MAX_CATCHUP_TICKS) this.acc = 0;

      this.cb.render(this.acc / TICK_MS, dt);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

/**
 * Size the canvas backing store for the device pixel ratio.
 *
 * DPR is capped at 2: a 3x phone gains no visible quality for 2.25x the fill
 * cost, and fill rate is the limiting factor for a full-screen canvas game.
 */
export function resizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Draw in CSS pixels; the transform handles the DPR scale.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { width: w, height: h };
}
