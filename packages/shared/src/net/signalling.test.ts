import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_OFFERS,
  MAX_SDP_BYTES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_TTL_MS,
  SignallingError,
  isValidRoomCode,
  makeRoomCode,
  normalizeRoomCode,
  type SessionDescription,
} from './signalling.js';
import { MemorySignalling } from './memorySignalling.js';
import { createRng, nextFloat } from '../math/rng.js';

const OFFER: SessionDescription = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' };
const ANSWER: SessionDescription = { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\n' };

class Clock {
  ms = 1_000_000;
  now = (): number => this.ms;
}

function makeService(seed = 1234): { svc: MemorySignalling; clock: Clock } {
  const clock = new Clock();
  const rng = createRng(seed);
  return { svc: new MemorySignalling({ now: clock.now, random: () => nextFloat(rng) }), clock };
}

describe('room codes', () => {
  it('only ever emits characters from the alphabet', () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i++) {
      const code = makeRoomCode(() => nextFloat(rng));
      expect(code.length).toBe(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it('never emits a confusable character', () => {
    // The whole mitigation for misreads is upstream of normalisation: a correctly
    // read code cannot contain one of these, so there is nothing to guess about.
    for (const bad of ['0', '1', 'I', 'L', 'O', 'U', 'V']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(bad);
    }
  });

  it('survives a broken random source', () => {
    // Math.floor(1 * len) would index off the end. Worth pinning, because a random
    // source that can return exactly 1 is a real thing.
    expect(isValidRoomCode(makeRoomCode(() => 1))).toBe(true);
    expect(isValidRoomCode(makeRoomCode(() => 0))).toBe(true);
    expect(isValidRoomCode(makeRoomCode(() => 0.999999999))).toBe(true);
  });

  it('normalises what a person actually types', () => {
    expect(normalizeRoomCode('a b c d')).toBe('ABCD');
    expect(normalizeRoomCode('ab-cd')).toBe('ABCD');
    expect(normalizeRoomCode('abcd')).toBe('ABCD');
    expect(normalizeRoomCode('  abcdEFGH ')).toBe('ABCD');
    // Excluded characters are dropped rather than guessed at.
    expect(normalizeRoomCode('AOBO')).toBe('AB');
    expect(normalizeRoomCode('')).toBe('');
  });

  it('rejects codes of the wrong shape', () => {
    expect(isValidRoomCode('ABC')).toBe(false);
    expect(isValidRoomCode('ABCDE')).toBe(false);
    expect(isValidRoomCode('ABC0')).toBe(false);
    expect(isValidRoomCode('abcd')).toBe(false);
  });
});

describe('the room mailbox', () => {
  it('carries an offer to the host and an answer back', async () => {
    const { svc } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    expect(isValidRoomCode(code)).toBe(true);

    const { peerId } = await svc.postOffer(code, 'Joiner', OFFER);
    expect(await svc.pollAnswer(code, peerId)).toBeNull();

    const offers = await svc.pollOffers(code, hostToken);
    expect(offers.length).toBe(1);
    expect(offers[0]!.peerId).toBe(peerId);
    expect(offers[0]!.name).toBe('Joiner');
    expect(offers[0]!.offer.sdp).toBe(OFFER.sdp);

    await svc.postAnswer(code, hostToken, peerId, ANSWER);
    const got = await svc.pollAnswer(code, peerId);
    expect(got?.sdp).toBe(ANSWER.sdp);
  });

  it('drains offers, so the host does not answer the same joiner twice', async () => {
    const { svc } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    await svc.postOffer(code, 'A', OFFER);
    expect((await svc.pollOffers(code, hostToken)).length).toBe(1);
    expect((await svc.pollOffers(code, hostToken)).length).toBe(0);
  });

  it('delivers an answer exactly once', async () => {
    // Leaving it in place would keep a connection descriptor readable by anybody
    // holding the room code, for as long as the room lives.
    const { svc } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    const { peerId } = await svc.postOffer(code, 'A', OFFER);
    await svc.pollOffers(code, hostToken);
    await svc.postAnswer(code, hostToken, peerId, ANSWER);
    expect(await svc.pollAnswer(code, peerId)).not.toBeNull();
    expect(await svc.pollAnswer(code, peerId)).toBeNull();
  });

  it('keeps several joiners separate', async () => {
    const { svc } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    const a = await svc.postOffer(code, 'A', OFFER);
    const b = await svc.postOffer(code, 'B', OFFER);
    const c = await svc.postOffer(code, 'C', OFFER);
    expect(new Set([a.peerId, b.peerId, c.peerId]).size).toBe(3);

    const offers = await svc.pollOffers(code, hostToken);
    expect(offers.map((o) => o.name)).toEqual(['A', 'B', 'C']);

    await svc.postAnswer(code, hostToken, b.peerId, { type: 'answer', sdp: 'for-b' });
    expect(await svc.pollAnswer(code, a.peerId)).toBeNull();
    expect((await svc.pollAnswer(code, b.peerId))?.sdp).toBe('for-b');
    expect(await svc.pollAnswer(code, c.peerId)).toBeNull();
  });
});

describe('the room mailbox refuses nonsense', () => {
  it('rejects an unknown or malformed code', async () => {
    const { svc } = makeService();
    await expect(svc.postOffer('ZZZZ', 'A', OFFER)).rejects.toThrow(SignallingError);
    await expect(svc.postOffer('nope', 'A', OFFER)).rejects.toThrow(SignallingError);
  });

  it('will not let a stranger answer for the host', async () => {
    const { svc } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    const { peerId } = await svc.postOffer(code, 'A', OFFER);
    await expect(svc.postAnswer(code, 'wrong-token', peerId, ANSWER)).rejects.toThrow(
      SignallingError,
    );
    await expect(svc.pollOffers(code, 'wrong-token')).rejects.toThrow(SignallingError);
    // And the real host still works afterwards.
    await svc.postAnswer(code, hostToken, peerId, ANSWER);
    expect(await svc.pollAnswer(code, peerId)).not.toBeNull();
  });

  it('does not distinguish an expired room from one that never existed', async () => {
    // Distinguishing them would let anyone probe which codes are live.
    const { svc, clock } = makeService();
    const { code } = await svc.createRoom('Host');
    clock.ms += ROOM_TTL_MS + 1;
    const expired = await svc.postOffer(code, 'A', OFFER).catch((e: Error) => e.message);
    const missing = await svc.postOffer('ZZZZ', 'A', OFFER).catch((e: Error) => e.message);
    expect(expired).toBe(missing);
  });

  it('caps the offer queue', async () => {
    const { svc } = makeService();
    const { code } = await svc.createRoom('Host');
    for (let i = 0; i < MAX_PENDING_OFFERS; i++) {
      await svc.postOffer(code, `J${i}`, OFFER);
    }
    await expect(svc.postOffer(code, 'one-too-many', OFFER)).rejects.toThrow(SignallingError);
  });

  it('rejects an oversized or empty description', async () => {
    const { svc } = makeService();
    const { code } = await svc.createRoom('Host');
    await expect(
      svc.postOffer(code, 'A', { type: 'offer', sdp: 'x'.repeat(MAX_SDP_BYTES + 1) }),
    ).rejects.toThrow(SignallingError);
    await expect(svc.postOffer(code, 'A', { type: 'offer', sdp: '' })).rejects.toThrow(
      SignallingError,
    );
    await expect(
      svc.postOffer(code, 'A', { type: 'bogus' as 'offer', sdp: 'v=0' }),
    ).rejects.toThrow(SignallingError);
  });

  it('truncates a silly display name rather than storing it', async () => {
    const { svc } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    await svc.postOffer(code, 'x'.repeat(500), OFFER);
    const offers = await svc.pollOffers(code, hostToken);
    expect(offers[0]!.name.length).toBeLessThanOrEqual(24);
  });
});

describe('room lifetime', () => {
  it('expires a room the host has abandoned', async () => {
    const { svc, clock } = makeService();
    const { code } = await svc.createRoom('Host');
    expect(svc.roomCount).toBe(1);
    clock.ms += ROOM_TTL_MS + 1;
    expect(svc.roomCount).toBe(0);
    await expect(svc.postOffer(code, 'A', OFFER)).rejects.toThrow(SignallingError);
  });

  it('keeps a room alive while the host is polling', async () => {
    // Polling IS the liveness signal, so a host sitting in a lobby for half an hour
    // must not have the room vanish underneath it.
    const { svc, clock } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    for (let i = 0; i < 10; i++) {
      clock.ms += ROOM_TTL_MS - 1000;
      await svc.pollOffers(code, hostToken);
    }
    expect(svc.roomCount).toBe(1);
    await expect(svc.postOffer(code, 'A', OFFER)).resolves.toBeTruthy();
  });

  it('closes a room on request, and closing twice is not an error', async () => {
    const { svc } = makeService();
    const { code, hostToken } = await svc.createRoom('Host');
    await svc.closeRoom(code, hostToken);
    expect(svc.roomCount).toBe(0);
    await expect(svc.closeRoom(code, hostToken)).resolves.toBeUndefined();
  });

  it('ignores a close from someone who is not the host', async () => {
    const { svc } = makeService();
    const { code } = await svc.createRoom('Host');
    await svc.closeRoom(code, 'not-the-token');
    expect(svc.roomCount).toBe(1);
  });

  it('does not hand out a code that is already live', async () => {
    // A degenerate random source is the cheapest way to force the collision path.
    const clock = new Clock();
    const svc = new MemorySignalling({ now: clock.now, random: () => 0 });
    const first = await svc.createRoom('A');
    // Every code generated is identical, so the retry loop must give up rather than
    // silently hand two hosts the same room.
    await expect(svc.createRoom('B')).rejects.toThrow(SignallingError);
    expect(first.code).toBeTruthy();
    expect(svc.roomCount).toBe(1);
  });
});
