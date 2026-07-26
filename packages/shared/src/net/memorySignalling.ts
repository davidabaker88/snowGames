/**
 * Signalling in memory.
 *
 * Two jobs. It is the test double that lets the WebRTC handshake be exercised without
 * a network, and it is the **reference implementation** of the room state machine --
 * the Cloudflare Worker is a thin HTTP shell around exactly this logic, so a rule
 * about room lifetime or offer limits is written once and tested once.
 *
 * Time and randomness are injected. `shared/` bans ambient sources of both, and a
 * room-expiry rule that can only be tested by waiting twenty minutes is a rule that
 * does not get tested.
 */

import {
  MAX_PENDING_OFFERS,
  MAX_SDP_BYTES,
  ROOM_TTL_MS,
  SignallingError,
  isValidRoomCode,
  makeRoomCode,
  type PendingOffer,
  type SessionDescription,
  type Signalling,
} from './signalling.js';

interface Room {
  code: string;
  hostToken: string;
  hostName: string;
  createdAtMs: number;
  /** Refreshed whenever the host polls, which is what keeps a live room alive. */
  touchedAtMs: number;
  /** Offers the host has not collected yet. */
  inbox: PendingOffer[];
  /** Answers waiting for their joiner, keyed by peer id. */
  answers: Map<string, SessionDescription>;
  nextPeer: number;
}

export interface MemorySignallingOptions {
  now(): number;
  random(): number;
}

export class MemorySignalling implements Signalling {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly opts: MemorySignallingOptions) {}

  /** Rooms currently alive. Exposed so a test can assert cleanup actually happens. */
  get roomCount(): number {
    this.expire();
    return this.rooms.size;
  }

  /**
   * Every method here is `async`, and that is not decoration.
   *
   * These validate their arguments before doing anything, and a plain function that
   * returns a promise would throw SYNCHRONOUSLY on a bad room code -- so a caller
   * writing `postOffer(...).catch(...)` would get an uncaught exception instead of the
   * rejection it asked for. `async` turns every throw into a rejection, which is the
   * only behaviour a promise-returning API can safely have.
   */
  async createRoom(name: string): Promise<{ code: string; hostToken: string }> {
    this.expire();
    // Retry on collision rather than trusting a million-room space blindly. With a
    // handful of live rooms a collision is vanishingly rare, but "vanishingly rare"
    // handled by ignoring it is how two families end up in the same match.
    let code = '';
    for (let i = 0; i < 32; i++) {
      const candidate = makeRoomCode(this.opts.random);
      if (!this.rooms.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new SignallingError('no free room code', true);

    const hostToken = this.token();
    const t = this.opts.now();
    this.rooms.set(code, {
      code,
      hostToken,
      hostName: name,
      createdAtMs: t,
      touchedAtMs: t,
      inbox: [],
      answers: new Map(),
      nextPeer: 1,
    });
    return { code, hostToken };
  }

  /**
   * Create a room with a code chosen by the CALLER.
   *
   * `createRoom` picks its own code, which is right when one service owns the whole
   * code space. It is wrong for the Cloudflare deployment, where each room is a
   * separate Durable Object addressed BY its code -- there, the code has to exist
   * before the object that owns it can be reached, so the code is generated outside
   * and claimed here.
   *
   * Passing `hostToken` re-adopts an existing room rather than making a new one, which
   * is how a Durable Object rebuilds itself after being evicted between requests.
   * Without it, an eviction would present to the player as their room code going bad.
   */
  async claimRoom(
    code: string,
    name: string,
    hostToken?: string,
  ): Promise<{ code: string; hostToken: string }> {
    this.expire();
    if (!isValidRoomCode(code)) throw new SignallingError('not a room code');

    const existing = this.rooms.get(code);
    if (existing) {
      // Re-adopting with the right token is idempotent; anything else is a collision.
      if (hostToken && existing.hostToken === hostToken) {
        existing.touchedAtMs = this.opts.now();
        return { code, hostToken };
      }
      throw new SignallingError('room code taken', true);
    }

    const token = hostToken ?? this.token();
    const t = this.opts.now();
    this.rooms.set(code, {
      code,
      hostToken: token,
      hostName: name,
      createdAtMs: t,
      touchedAtMs: t,
      inbox: [],
      answers: new Map(),
      nextPeer: 1,
    });
    return { code, hostToken: token };
  }

  async pollOffers(code: string, hostToken: string): Promise<PendingOffer[]> {
    const room = this.hostRoom(code, hostToken);
    // Polling is the host's liveness signal, so it doubles as the keep-alive.
    room.touchedAtMs = this.opts.now();
    // Drained, not copied: the host is expected to answer what it takes, and leaving
    // offers in place would have it re-answering the same joiner every poll.
    const out = room.inbox;
    room.inbox = [];
    return out;
  }

  async postAnswer(
    code: string,
    hostToken: string,
    peerId: string,
    answer: SessionDescription,
  ): Promise<void> {
    const room = this.hostRoom(code, hostToken);
    checkSdp(answer);
    room.touchedAtMs = this.opts.now();
    room.answers.set(peerId, answer);
  }

  async postOffer(
    code: string,
    name: string,
    offer: SessionDescription,
  ): Promise<{ peerId: string }> {
    const room = this.room(code);
    checkSdp(offer);
    if (room.inbox.length >= MAX_PENDING_OFFERS) {
      throw new SignallingError('too many pending joins', true);
    }
    const peerId = `p${room.nextPeer++}`;
    room.inbox.push({ peerId, offer, name: name.slice(0, 24) });
    return { peerId };
  }

  async pollAnswer(code: string, peerId: string): Promise<SessionDescription | null> {
    const room = this.room(code);
    const answer = room.answers.get(peerId);
    if (!answer) return null;
    // Delivered once. A joiner that has its answer has no further use for signalling,
    // and keeping it would leave the descriptor readable by anyone with the code.
    room.answers.delete(peerId);
    return answer;
  }

  async closeRoom(code: string, hostToken: string): Promise<void> {
    const room = this.rooms.get(code);
    // Idempotent and quiet: a host closing a room that already expired is the normal
    // case at the end of a match, not an error worth surfacing.
    if (room && room.hostToken === hostToken) this.rooms.delete(code);
  }

  // ---- internals ---------------------------------------------------------

  private room(code: string): Room {
    this.expire();
    if (!isValidRoomCode(code)) throw new SignallingError('not a room code');
    const room = this.rooms.get(code);
    // One message for both "never existed" and "expired", deliberately: the useful
    // information for the person typing is that this code will not work, and
    // distinguishing the two would let anyone probe which codes are live.
    if (!room) throw new SignallingError('no such room');
    return room;
  }

  private hostRoom(code: string, hostToken: string): Room {
    const room = this.room(code);
    if (room.hostToken !== hostToken) throw new SignallingError('not the host of this room');
    return room;
  }

  private expire(): void {
    const cutoff = this.opts.now() - ROOM_TTL_MS;
    for (const [code, room] of this.rooms) {
      if (room.touchedAtMs < cutoff) this.rooms.delete(code);
    }
  }

  private token(): string {
    let out = '';
    for (let i = 0; i < 4; i++) {
      out += Math.floor(this.opts.random() * 0x10000)
        .toString(36)
        .padStart(3, '0');
    }
    return out;
  }
}

function checkSdp(d: SessionDescription): void {
  if (d.type !== 'offer' && d.type !== 'answer') {
    throw new SignallingError('bad description type');
  }
  if (typeof d.sdp !== 'string' || d.sdp.length === 0) {
    throw new SignallingError('empty description');
  }
  // A descriptor is a few hundred bytes. Anything near this cap is either a bug or
  // somebody using the mailbox as free storage.
  if (d.sdp.length > MAX_SDP_BYTES) throw new SignallingError('description too large');
}
