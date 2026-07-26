/**
 * Signalling: how two peers find each other, and nothing more.
 *
 * WebRTC connects browsers directly, but the two ends have to trade a few kilobytes
 * of connection descriptors first, and they cannot use each other to do it. That is
 * all signalling is -- a mailbox, used for a couple of seconds at join time and then
 * never again. It is emphatically NOT a game server: it sees no inputs, no snapshots,
 * and no gameplay, so the cost of running one is a rounding error next to the cost of
 * relaying a match.
 *
 * Two decisions here are worth stating.
 *
 * **Non-trickle.** All ICE candidates are gathered BEFORE the descriptor is posted,
 * so the mailbox only ever carries one message in each direction. Trickle ICE would
 * be faster to connect but turns the mailbox into an ordered stream with a lifetime,
 * which is a large amount of complexity for a second of setup time in a lobby.
 *
 * **The room code is the whole security model, and that is on purpose.** Four
 * characters from a 32-symbol alphabet is a million rooms; a room lives for minutes,
 * accepts a handful of joins and holds nothing sensitive. Anyone who guesses a live
 * code gets to join a snowball fight. The alternative -- accounts, tokens, rate
 * limits -- would cost more than it protects and would put a login in front of a
 * game for children.
 */

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/**
 * A deliberately confusion-free alphabet.
 *
 * No `I`, `1`, `L`, `O`, `0`, `U` or `V`. These codes get read aloud across a room
 * and typed by children on phone keyboards: `0` versus `O` is the single most common
 * way that goes wrong, and `U`/`V` is the second when spoken. Dropping vowels also
 * means a code cannot accidentally spell something.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTWXYZ';
export const ROOM_CODE_LENGTH = 4;

/**
 * Generate a code from an injected random source.
 *
 * `random` is a parameter because `shared/` bans ambient randomness -- and because a
 * test that cannot fix the code it is about to assert on is a test that has to guess.
 */
export function makeRoomCode(random: () => number): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const n = Math.floor(random() * ROOM_CODE_ALPHABET.length);
    out += ROOM_CODE_ALPHABET[Math.min(ROOM_CODE_ALPHABET.length - 1, Math.max(0, n))];
  }
  return out;
}

/**
 * Normalise what somebody typed: upper-case, drop anything not in the alphabet,
 * truncate to length. Spaces and dashes people add for readability just disappear.
 *
 * Note what this deliberately does NOT do: guess. It is tempting to fold `0` onto
 * `Q` and `1` onto `J` on the theory that a misread should still connect, but those
 * mappings are inventions -- `0` resembles `O`, `Q` and `D` about equally, and
 * silently joining the wrong room is worse than being told the code is wrong. The
 * real mitigation is upstream: the generator never emits a confusable character, so
 * a correctly-read code never contains one.
 */
export function normalizeRoomCode(input: string): string {
  let out = '';
  for (const ch of input.toUpperCase()) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) continue;
    out += ch;
    if (out.length === ROOM_CODE_LENGTH) break;
  }
  return out;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The mailbox contract
// ---------------------------------------------------------------------------

/** A session description, as it travels. Opaque to everything but WebRTC. */
export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

/** One joiner's offer, waiting for the host to answer it. */
export interface PendingOffer {
  /** Assigned by the mailbox. The host answers to this id. */
  peerId: string;
  offer: SessionDescription;
  /** Display name, so a host can show who is knocking. */
  name: string;
}

/**
 * Everything a peer needs from signalling.
 *
 * Deliberately tiny, and deliberately free of transport detail: the HTTP client, the
 * in-memory implementation used by tests, and a QR-code-based version if it ever
 * exists all satisfy this. Nothing above this interface knows how the bytes moved.
 */
export interface Signalling {
  /** Host side: claim a room and return its code. */
  createRoom(name: string): Promise<{ code: string; hostToken: string }>;
  /** Host side: collect offers posted since the last call. */
  pollOffers(code: string, hostToken: string): Promise<PendingOffer[]>;
  /** Host side: answer one joiner. */
  postAnswer(
    code: string,
    hostToken: string,
    peerId: string,
    answer: SessionDescription,
  ): Promise<void>;
  /** Joiner side: post an offer and get an id to collect the answer under. */
  postOffer(
    code: string,
    name: string,
    offer: SessionDescription,
  ): Promise<{ peerId: string }>;
  /** Joiner side: null until the host has answered. */
  pollAnswer(code: string, peerId: string): Promise<SessionDescription | null>;
  /** Host side: the room is finished with. Best-effort. */
  closeRoom(code: string, hostToken: string): Promise<void>;
}

export class SignallingError extends Error {
  constructor(
    message: string,
    /** True when retrying could plausibly help. */
    readonly retryable = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Wire shapes, shared with the Worker
// ---------------------------------------------------------------------------

/**
 * The HTTP bodies, declared here rather than in the Worker.
 *
 * The Worker imports these, so the two halves of the protocol cannot drift. A
 * signalling mismatch presents as "nobody can join", which is about the least
 * debuggable symptom available -- worth spending a shared type on.
 */
export interface CreateRoomRequest {
  name: string;
}
export interface CreateRoomResponse {
  code: string;
  hostToken: string;
}
export interface PostOfferRequest {
  name: string;
  offer: SessionDescription;
}
export interface PostOfferResponse {
  peerId: string;
}
export interface PollOffersResponse {
  offers: PendingOffer[];
}
export interface PollAnswerResponse {
  answer: SessionDescription | null;
}
export interface PostAnswerRequest {
  peerId: string;
  answer: SessionDescription;
}
export interface ErrorResponse {
  error: string;
}

/** How long a room survives without the host checking in. */
export const ROOM_TTL_MS = 20 * 60 * 1000;
/** Cap on joiners queued for one room, so a stray script cannot fill memory. */
export const MAX_PENDING_OFFERS = 16;
/** Descriptors are small; anything much larger is not one. */
export const MAX_SDP_BYTES = 16 * 1024;
