/**
 * `claimRoom`, which is the seam the Cloudflare deployment depends on.
 *
 * The Worker addresses each room as a separate Durable Object keyed BY the room code, so
 * the code has to be generated before the object that owns it can be reached. That
 * inverts the normal flow -- the caller picks the code and the room accepts or refuses
 * it -- and two behaviours have to hold or the deployment breaks in ways that are hard
 * to see: a collision must be refused, and a re-adoption after an eviction must succeed.
 */

import { describe, expect, it } from 'vitest';
import { MemorySignalling } from './memorySignalling.js';
import { ROOM_TTL_MS, SignallingError } from './signalling.js';
import { createRng, nextFloat } from '../math/rng.js';

class Clock {
  ms = 500_000;
  now = (): number => this.ms;
}

function makeService(): { svc: MemorySignalling; clock: Clock } {
  const clock = new Clock();
  const rng = createRng(99);
  return { svc: new MemorySignalling({ now: clock.now, random: () => nextFloat(rng) }), clock };
}

describe('claiming a specific room code', () => {
  it('creates a room under the code the caller chose', async () => {
    const { svc } = makeService();
    const { code, hostToken } = await svc.claimRoom('ABCD', 'Host');
    expect(code).toBe('ABCD');
    expect(hostToken.length).toBeGreaterThan(0);
    // And it behaves as a normal room afterwards.
    const { peerId } = await svc.postOffer('ABCD', 'J', { type: 'offer', sdp: 'v=0' });
    expect((await svc.pollOffers('ABCD', hostToken))[0]!.peerId).toBe(peerId);
  });

  it('refuses a code that is already live', async () => {
    // This is what the Worker turns into a 409 and retries with a new code. If it
    // silently succeeded, two hosts would share a room and their joiners would land in
    // whichever match answered first.
    const { svc } = makeService();
    await svc.claimRoom('ABCD', 'First');
    await expect(svc.claimRoom('ABCD', 'Second')).rejects.toThrow(SignallingError);
  });

  it('re-adopts a room when the right host token is presented', async () => {
    // A Durable Object can be evicted between requests. Rebuilding itself has to be
    // possible, or an eviction presents to the player as their room code going bad
    // mid-lobby.
    const { svc } = makeService();
    const { hostToken } = await svc.claimRoom('ABCD', 'Host');
    const again = await svc.claimRoom('ABCD', 'Host', hostToken);
    expect(again.hostToken).toBe(hostToken);
    expect(svc.roomCount).toBe(1);
  });

  it('refuses re-adoption with the wrong token', async () => {
    const { svc } = makeService();
    await svc.claimRoom('ABCD', 'Host');
    await expect(svc.claimRoom('ABCD', 'Host', 'not-the-token')).rejects.toThrow(SignallingError);
  });

  it('lets an expired code be claimed again', async () => {
    // Otherwise the code space leaks one entry per abandoned lobby, forever.
    const { svc, clock } = makeService();
    await svc.claimRoom('ABCD', 'First');
    clock.ms += ROOM_TTL_MS + 1;
    const second = await svc.claimRoom('ABCD', 'Second');
    expect(second.code).toBe('ABCD');
    expect(svc.roomCount).toBe(1);
  });

  it('rejects a malformed code', async () => {
    const { svc } = makeService();
    await expect(svc.claimRoom('nope', 'Host')).rejects.toThrow(SignallingError);
    await expect(svc.claimRoom('AB', 'Host')).rejects.toThrow(SignallingError);
  });

  it('keeps a re-adopted room alive', async () => {
    // Re-adoption also has to count as a keep-alive, or a room that is evicted and
    // rebuilt repeatedly could expire while its host is actively polling.
    const { svc, clock } = makeService();
    const { hostToken } = await svc.claimRoom('ABCD', 'Host');
    for (let i = 0; i < 5; i++) {
      clock.ms += ROOM_TTL_MS - 1000;
      await svc.claimRoom('ABCD', 'Host', hostToken);
    }
    expect(svc.roomCount).toBe(1);
  });
});
