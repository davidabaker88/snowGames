import { describe, expect, it } from 'vitest';
import { createLocalPair } from './localTransport.js';
import type { Transport } from './transport.js';

function collect(t: Transport): number[] {
  const seen: number[] = [];
  t.onMessage.on((m) => seen.push(m[0]!));
  return seen;
}

async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('createLocalPair', () => {
  it('delivers messages between the two ends', async () => {
    const [a, b] = createLocalPair();
    const gotB = collect(b);
    const gotA = collect(a);
    await Promise.all([a.connect(), b.connect()]);

    a.send(new Uint8Array([1]));
    b.send(new Uint8Array([2]));
    await settle();

    expect(gotB).toEqual([1]);
    expect(gotA).toEqual([2]);
  });

  it('is asynchronous, so no caller can rely on synchronous delivery', async () => {
    // If this ever became synchronous, tests would pass on code that deadlocks
    // the moment a real socket is involved.
    const [a, b] = createLocalPair();
    const got = collect(b);
    await Promise.all([a.connect(), b.connect()]);

    a.send(new Uint8Array([7]));
    expect(got).toEqual([]); // nothing yet, on purpose
    await settle();
    expect(got).toEqual([7]);
  });

  it('copies the payload so the sender can reuse its encode buffer', async () => {
    const [a, b] = createLocalPair();
    const got: number[] = [];
    b.onMessage.on((m) => got.push(m[0]!));
    await Promise.all([a.connect(), b.connect()]);

    const buf = new Uint8Array([42]);
    a.send(buf);
    buf[0] = 99; // the caller immediately reuses the buffer
    await settle();

    expect(got).toEqual([42]);
  });

  it('drops messages at the configured loss rate', async () => {
    const [a, b] = createLocalPair({ lossPct: 50, seed: 12345 });
    const got = collect(b);
    await Promise.all([a.connect(), b.connect()]);

    for (let i = 0; i < 200; i++) a.send(new Uint8Array([i & 0xff]));
    await settle(120);

    expect(got.length).toBeGreaterThan(60);
    expect(got.length).toBeLessThan(140);
  });

  it('is reproducible for a given seed', async () => {
    const run = async (): Promise<number> => {
      const [a, b] = createLocalPair({ lossPct: 40, seed: 999 });
      const got = collect(b);
      await Promise.all([a.connect(), b.connect()]);
      for (let i = 0; i < 100; i++) a.send(new Uint8Array([i & 0xff]));
      await settle(100);
      return got.length;
    };
    expect(await run()).toBe(await run());
  });

  it('can deliver messages out of order', async () => {
    // The game layer must tolerate reordering even though WebSocket does not
    // reorder, so that an unreliable transport later is a config change.
    const [a, b] = createLocalPair({ latencyMs: 5, reorderPct: 60, seed: 4 });
    const got = collect(b);
    await Promise.all([a.connect(), b.connect()]);

    for (let i = 0; i < 40; i++) a.send(new Uint8Array([i]));
    await settle(200);

    const sorted = [...got].sort((x, y) => x - y);
    expect(got.length).toBeGreaterThan(0);
    expect(got).not.toEqual(sorted);
  });

  it('can duplicate messages', async () => {
    const [a, b] = createLocalPair({ duplicatePct: 100, seed: 3 });
    const got = collect(b);
    await Promise.all([a.connect(), b.connect()]);
    a.send(new Uint8Array([5]));
    await settle();
    expect(got).toEqual([5, 5]);
  });

  it('applies latency', async () => {
    const [a, b] = createLocalPair({ latencyMs: 120 });
    const got = collect(b);
    await Promise.all([a.connect(), b.connect()]);
    a.send(new Uint8Array([1]));
    await settle(40);
    expect(got).toEqual([]);
    await settle(150);
    expect(got).toEqual([1]);
  });

  it('notifies both ends on close', async () => {
    const [a, b] = createLocalPair();
    await Promise.all([a.connect(), b.connect()]);
    let aClosed = false;
    let bClosed = false;
    a.onClose.on(() => (aClosed = true));
    b.onClose.on(() => (bClosed = true));

    a.close(4000, 'bye');
    await settle();

    expect(aClosed).toBe(true);
    expect(bClosed).toBe(true);
    expect(a.isOpen).toBe(false);
    expect(b.isOpen).toBe(false);
  });

  it('tracks byte and message counters', async () => {
    const [a, b] = createLocalPair();
    await Promise.all([a.connect(), b.connect()]);
    a.send(new Uint8Array([1, 2, 3]));
    await settle();
    expect(a.stats.msgsOut).toBe(1);
    expect(a.stats.bytesOut).toBe(3);
    expect(b.stats.msgsIn).toBe(1);
    expect(b.stats.bytesIn).toBe(3);
  });

  it('reports an error rather than throwing when sending on a closed transport', async () => {
    const [a, b] = createLocalPair();
    await Promise.all([a.connect(), b.connect()]);
    const errors: Error[] = [];
    a.onError.on((e) => errors.push(e));
    a.close();
    expect(() => a.send(new Uint8Array([1]))).not.toThrow();
    expect(errors.length).toBe(1);
  });
});
