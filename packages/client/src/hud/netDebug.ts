/**
 * The netcode overlay.
 *
 * Built during the netcode phase rather than after it, on purpose: it is the
 * difference between debugging netcode and guessing at it. Every number here
 * corresponds to a decision documented in `net/protocol.ts`, so a value that looks
 * wrong points straight at the constant that explains it.
 *
 * Bars rather than only text, because the two questions you actually ask in motion
 * are "is this getting worse" and "which of these is the problem" -- and both are
 * shape questions, not reading questions.
 */

import {
  BUDGET_DOWN_BYTES_PER_SEC,
  BUDGET_UP_BYTES_PER_SEC,
  INTERP_DELAY_MAX_MS,
  RECONCILE_SNAP_UNITS,
  type NetDebugInfo,
} from '@snow/shared';
import type { Viewport } from '../render/projection.js';

export interface NetDebugModel {
  vp: Viewport;
  info: NetDebugInfo;
  /** Bytes per second, averaged by the caller over a window. */
  downPerSec: number;
  upPerSec: number;
  hostTick: number;
  clientTick: number;
}

interface Row {
  label: string;
  text: string;
  /** 0..1 for the bar, or null for text-only. */
  fill: number | null;
  /** True when this value is outside what the design expects. */
  bad: boolean;
}

const PANEL_W = 232;
const ROW_H = 15;
const PAD = 8;

export function netDebugHeight(): number {
  return ROWS_COUNT * ROW_H + PAD * 2 + 16;
}

const ROWS_COUNT = 8;

export function drawNetDebug(ctx: CanvasRenderingContext2D, m: NetDebugModel): void {
  const d = m.info;
  const rows: Row[] = [
    {
      label: 'rtt',
      text: `${Math.round(d.rttMs)}ms  min ${Math.round(d.minRttMs)}`,
      fill: clamp01(d.rttMs / 400),
      bad: d.rttMs > 300,
    },
    {
      label: 'jitter',
      text: `${Math.round(d.jitterMs)}ms`,
      fill: clamp01(d.jitterMs / 120),
      bad: d.jitterMs > 80,
    },
    {
      label: 'interp',
      text: `${Math.round(d.interpDelayMs)}ms`,
      fill: clamp01(d.interpDelayMs / INTERP_DELAY_MAX_MS),
      // At the ceiling the delay can no longer cover the snapshot age on its own,
      // and remote entities start relying on extrapolation.
      bad: d.interpDelayMs >= INTERP_DELAY_MAX_MS - 1,
    },
    {
      label: 'snap age',
      text: `${Math.round(d.snapshotAgeMs)}ms`,
      fill: clamp01(d.snapshotAgeMs / (INTERP_DELAY_MAX_MS * 1.5)),
      // Older than the interpolation delay means rendering ahead of the buffer.
      bad: d.snapshotAgeMs > d.interpDelayMs,
    },
    {
      label: 'pred err',
      text: `${d.reconcileErrorUnits.toFixed(2)}u  ${d.snapCount} snaps`,
      fill: clamp01(d.reconcileErrorUnits / RECONCILE_SNAP_UNITS),
      bad: d.reconcileErrorUnits > RECONCILE_SNAP_UNITS,
    },
    {
      label: 'unacked',
      text: `${d.unackedInputs} frames`,
      fill: clamp01(d.unackedInputs / 30),
      bad: d.unackedInputs > 20,
    },
    {
      label: 'down',
      text: `${fmtRate(m.downPerSec)}  of ${fmtRate(BUDGET_DOWN_BYTES_PER_SEC)}`,
      fill: clamp01(m.downPerSec / BUDGET_DOWN_BYTES_PER_SEC),
      bad: m.downPerSec > BUDGET_DOWN_BYTES_PER_SEC,
    },
    {
      label: 'up',
      text: `${fmtRate(m.upPerSec)}  of ${fmtRate(BUDGET_UP_BYTES_PER_SEC)}`,
      fill: clamp01(m.upPerSec / BUDGET_UP_BYTES_PER_SEC),
      bad: m.upPerSec > BUDGET_UP_BYTES_PER_SEC,
    },
  ];

  const h = netDebugHeight();
  const x = m.vp.width - PANEL_W - 10;
  // Below the HUD's own top-right corner text (skin label and fps), rather than on
  // top of it. Two overlapping readouts is worse than either alone.
  const y = 10 + safeTop() + 34;

  ctx.save();
  ctx.fillStyle = 'rgba(8,16,26,0.8)';
  roundRect(ctx, x, y, PANEL_W, h, 8);
  ctx.fill();

  ctx.textBaseline = 'middle';
  ctx.font = '600 10px ui-monospace, monospace';
  ctx.fillStyle = '#7fb2e0';
  ctx.textAlign = 'left';
  ctx.fillText(
    `net  host ${m.hostTick}  client ${m.clientTick}  off ${Math.round(m.info.clockOffsetMs)}ms`,
    x + PAD,
    y + PAD + 5,
  );

  let ry = y + PAD + 18;
  for (const r of rows) {
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(190,214,238,0.72)';
    ctx.fillText(r.label, x + PAD, ry + ROW_H / 2);

    if (r.fill !== null) {
      // Wide enough that the longest label cannot run under the bar.
      const bx = x + PAD + 64;
      const bw = 52;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(bx, ry + 5, bw, 5);
      ctx.fillStyle = r.bad ? '#ef6a52' : '#6ddf8f';
      ctx.fillRect(bx, ry + 5, Math.max(1, bw * r.fill), 5);
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = r.bad ? '#ffb4a6' : 'rgba(224,238,252,0.92)';
    ctx.fillText(r.text, x + PANEL_W - PAD, ry + ROW_H / 2);
    ry += ROW_H;
  }

  ctx.restore();
}

/**
 * Bandwidth needs a rate, and the client only exposes a running total.
 *
 * A sliding window rather than total-over-uptime: the interesting question is what
 * it is doing NOW, and dividing by uptime would make an early burst take a minute to
 * fade out of the number.
 */
export class RateMeter {
  private readonly samples: { t: number; down: number; up: number }[] = [];
  downPerSec = 0;
  upPerSec = 0;

  sample(nowMs: number, bytesIn: number, bytesOut: number): void {
    this.samples.push({ t: nowMs, down: bytesIn, up: bytesOut });
    const cutoff = nowMs - 2000;
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift();

    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.25) return;
    this.downPerSec = (last.down - first.down) / dt;
    this.upPerSec = (last.up - first.up) / dt;
  }
}

function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)}B/s`;
  return `${(bytesPerSec / 1024).toFixed(1)}K/s`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function safeTop(): number {
  const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--sat'));
  return Number.isFinite(v) ? v : 0;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
