/**
 * Synthetic input for automated tests.
 *
 * Exposed on `window.__snowInput` so Playwright can drive real gestures --
 * dispatching actual PointerEvents through the same code path a thumb uses,
 * rather than poking at internal state. That distinction matters: a test that
 * sets `packProgress = 2.5` directly proves nothing about the recognizer.
 */

export interface SnowInputApi {
  /** Dispatch a circular drag on the right half. Returns when the drag ends. */
  circle(opts?: { turns?: number; radius?: number; cx?: number; cy?: number; ms?: number }): Promise<void>;
  /** Dispatch a straight fast drag: a flick. */
  flick(opts: { dx: number; dy: number; ms?: number; cx?: number; cy?: number }): Promise<void>;
  tap(opts?: { cx?: number; cy?: number }): Promise<void>;
  doubleTap(opts?: { cx?: number; cy?: number }): Promise<void>;
  longPress(opts?: { cx?: number; cy?: number; ms?: number }): Promise<void>;
  /** Hold the joystick in a direction for a duration. */
  move(opts: { dx: number; dy: number; ms: number }): Promise<void>;
  key(code: string, ms?: number): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let nextPointerId = 1000;

function send(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  x: number,
  y: number,
): void {
  const rect = canvas.getBoundingClientRect();
  const ev = new PointerEvent(type, {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
    bubbles: true,
    cancelable: true,
  });
  canvas.dispatchEvent(ev);
}

export function installDebugDriver(canvas: HTMLCanvasElement): void {
  const rightX = (): number => canvas.clientWidth * 0.75;
  const midY = (): number => canvas.clientHeight * 0.6;
  const leftX = (): number => canvas.clientWidth * 0.25;

  const api: SnowInputApi = {
    async circle(opts = {}) {
      const turns = opts.turns ?? 3;
      const radius = opts.radius ?? 46;
      const cx = opts.cx ?? rightX();
      const cy = opts.cy ?? midY();
      const ms = opts.ms ?? turns * 380;
      const id = nextPointerId++;
      // ~60Hz of samples, matching what a real pointer produces.
      const steps = Math.max(12, Math.round(ms / 16));

      send(canvas, 'pointerdown', id, cx + radius, cy);
      for (let i = 1; i <= steps; i++) {
        const a = (i / steps) * turns * Math.PI * 2;
        send(canvas, 'pointermove', id, cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
        await sleep(ms / steps);
      }
      send(canvas, 'pointerup', id, cx + Math.cos(turns * Math.PI * 2) * radius, cy);
    },

    async flick({ dx, dy, ms = 70, cx, cy }) {
      const sx = cx ?? rightX();
      const sy = cy ?? midY();
      const id = nextPointerId++;
      const steps = 6;
      send(canvas, 'pointerdown', id, sx, sy);
      for (let i = 1; i <= steps; i++) {
        send(canvas, 'pointermove', id, sx + (dx * i) / steps, sy + (dy * i) / steps);
        await sleep(ms / steps);
      }
      send(canvas, 'pointerup', id, sx + dx, sy + dy);
    },

    async tap(opts = {}) {
      const id = nextPointerId++;
      const x = opts.cx ?? rightX();
      const y = opts.cy ?? midY();
      send(canvas, 'pointerdown', id, x, y);
      await sleep(60);
      send(canvas, 'pointerup', id, x, y);
    },

    async doubleTap(opts = {}) {
      await api.tap(opts);
      await sleep(90);
      await api.tap(opts);
    },

    async longPress(opts = {}) {
      const id = nextPointerId++;
      const x = opts.cx ?? rightX();
      const y = opts.cy ?? midY();
      send(canvas, 'pointerdown', id, x, y);
      await sleep(opts.ms ?? 620);
      send(canvas, 'pointerup', id, x, y);
    },

    async move({ dx, dy, ms }) {
      const id = nextPointerId++;
      const sx = leftX();
      const sy = midY();
      send(canvas, 'pointerdown', id, sx, sy);
      // Push well past the ring so the output saturates at full tilt.
      send(canvas, 'pointermove', id, sx + dx * 90, sy + dy * 90);
      await sleep(ms);
      send(canvas, 'pointerup', id, sx + dx * 90, sy + dy * 90);
    },

    async key(code, ms = 100) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await sleep(ms);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    },
  };

  (window as unknown as { __snowInput: SnowInputApi }).__snowInput = api;
}
