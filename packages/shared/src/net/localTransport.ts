/**
 * An in-process transport pair.
 *
 * This powers three things: single-device play against bots, every headless
 * test, and the in-tab Web Worker server. Two properties make it worth more to
 * the project than almost anything else in the net layer:
 *
 *  - It is ASYNCHRONOUS. If it delivered synchronously, tests would happily pass
 *    on code that deadlocks the instant a real socket is involved.
 *  - Network conditions live HERE, not in the game. Testing "does this hold up
 *    at 200ms with 5% loss" becomes a deterministic unit test instead of a
 *    manual chore with a phone and a throttling proxy.
 */

import { Emitter, type Signal } from './signal.js';
import {
  createStats,
  type CloseInfo,
  type Transport,
  type TransportStats,
} from './transport.js';
import { createRng, nextFloat, nextSpread, type RngState } from '../math/rng.js';

export interface LinkConditions {
  /** One-way latency in ms. */
  latencyMs?: number;
  /** Random +/- variation added to latency, in ms. */
  jitterMs?: number;
  /** Percentage of messages dropped entirely. */
  lossPct?: number;
  /** Percentage of messages delivered twice. */
  duplicatePct?: number;
  /** Percentage of messages given an extra delay, so they arrive out of order. */
  reorderPct?: number;
  /** Seed for the condition RNG, so a flaky-looking test is reproducible. */
  seed?: number;
}

class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  readonly stats: TransportStats = createStats();

  private readonly openEmitter = new Emitter<void>();
  private readonly messageEmitter = new Emitter<Uint8Array>();
  private readonly closeEmitter = new Emitter<CloseInfo>();
  private readonly errorEmitter = new Emitter<Error>();

  readonly onOpen: Signal<void> = this.openEmitter;
  readonly onMessage: Signal<Uint8Array> = this.messageEmitter;
  readonly onClose: Signal<CloseInfo> = this.closeEmitter;
  readonly onError: Signal<Error> = this.errorEmitter;

  /** Set by createLocalPair. */
  peer!: LocalTransport;

  private open = false;
  private readonly rng: RngState;
  private readonly pending = new Set<TimerHandle>();

  constructor(
    readonly id: string,
    private readonly cond: LinkConditions,
  ) {
    this.rng = createRng(cond.seed ?? 0x5107ba11);
  }

  get isOpen(): boolean {
    return this.open;
  }

  connect(): Promise<void> {
    if (this.open) return Promise.resolve();
    this.open = true;
    // Open on a macrotask, not synchronously: callers must not be able to rely
    // on being connected by the time `connect()` returns.
    return new Promise<void>((resolve) => {
      this.schedule(0, () => {
        this.openEmitter.emit();
        resolve();
      });
    });
  }

  send(data: Uint8Array): void {
    if (!this.open) {
      this.errorEmitter.emit(new Error('send() on a closed transport'));
      return;
    }
    this.stats.bytesOut += data.byteLength;
    this.stats.msgsOut++;

    // Copy: the caller is expected to reuse its encode buffer immediately.
    const copy = data.slice();

    if (this.roll(this.cond.lossPct)) return;

    this.deliver(copy, this.delay());
    if (this.roll(this.cond.duplicatePct)) {
      this.deliver(copy.slice(), this.delay());
    }
  }

  close(code = 1000, reason = ''): void {
    if (!this.open) return;
    this.open = false;
    for (const h of this.pending) clearTimeout(h);
    this.pending.clear();
    this.closeEmitter.emit({ code, reason, wasClean: true });
    // Tell the far end, asynchronously, the way a real socket would.
    const peer = this.peer;
    if (peer?.open) {
      peer.schedule(this.cond.latencyMs ?? 0, () => {
        if (!peer.open) return;
        peer.open = false;
        peer.closeEmitter.emit({ code, reason, wasClean: true });
      });
    }
  }

  private deliver(data: Uint8Array, delayMs: number): void {
    this.schedule(delayMs, () => {
      const peer = this.peer;
      if (!peer?.open) return;
      peer.stats.bytesIn += data.byteLength;
      peer.stats.msgsIn++;
      peer.messageEmitter.emit(data);
    });
  }

  private delay(): number {
    const base = this.cond.latencyMs ?? 0;
    const jitter = this.cond.jitterMs ? nextSpread(this.rng, this.cond.jitterMs) : 0;
    // An explicit reorder bump guarantees out-of-order arrival even when jitter
    // is zero, so ordering assumptions get caught rather than being left to luck.
    const reorder = this.roll(this.cond.reorderPct) ? (this.cond.latencyMs ?? 20) + 25 : 0;
    return Math.max(0, base + jitter + reorder);
  }

  private roll(pct: number | undefined): boolean {
    if (!pct) return false;
    return nextFloat(this.rng) * 100 < pct;
  }

  private schedule(ms: number, fn: () => void): void {
    const handle = setTimeout(() => {
      this.pending.delete(handle);
      fn();
    }, ms);
    this.pending.add(handle);
  }
}

/**
 * Create two transports wired to each other. Conditions apply to both
 * directions; pass separate objects if you want an asymmetric link.
 */
export function createLocalPair(
  cond: LinkConditions = {},
  serverCond: LinkConditions = cond,
): [client: Transport, server: Transport] {
  const a = new LocalTransport('local:client', cond);
  const b = new LocalTransport('local:server', serverCond);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
