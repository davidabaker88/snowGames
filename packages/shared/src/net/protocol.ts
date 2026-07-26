/**
 * The wire protocol.
 *
 * Split by a single leading opcode byte: **below 0x80 is binary, 0x80 and up is
 * JSON.** The hot path (snapshots, inputs, events, pings) is binary; the cold path
 * (join, welcome, lobby, errors) is JSON.
 *
 * The reason for binary is GC, not bytes. `JSON.parse` fifteen times a second,
 * allocating a few hundred objects each time, produces visible frame hitches on a
 * mid-range Android. A DataView codec writing into a preallocated buffer allocates
 * nothing in steady state. The 4-6x size saving is a bonus.
 *
 * The reason the cold path stays JSON is that it happens a handful of times per
 * match and readability is worth more than bytes there. A room-join bug you can
 * read in a network log is a bug you fix in minutes.
 */

import { TICK_HZ } from '../constants.js';

/**
 * Message opcodes.
 *
 * Values are frozen once shipped: a client and host from different builds must at
 * minimum be able to identify each other's messages well enough to report a
 * version mismatch rather than misparsing.
 */
export const enum Op {
  // ---- binary, hot path -------------------------------------------------
  /** Host -> client: authoritative world state, possibly delta-encoded. */
  Snapshot = 0x01,
  /** Client -> host: a redundant window of recent input frames. */
  Input = 0x02,
  /** Host -> client: discrete events (hits, captures) sent without waiting. */
  Events = 0x03,
  /** Either direction: clock sync probe. */
  Ping = 0x04,
  Pong = 0x05,

  // ---- JSON, cold path --------------------------------------------------
  /** Client -> host: I would like to join, here is my name and skin. */
  Hello = 0x80,
  /** Host -> client: you are player N, here is the match you have joined. */
  Welcome = 0x81,
  /** Host -> client: lobby roster and settings changed. */
  RoomState = 0x82,
  /** Host -> client: a new match is starting; reset and resync. */
  MatchStart = 0x83,
  /** Either direction: clean shutdown with a reason. */
  Bye = 0x84,
  /** Host -> client: your request was refused, here is why. */
  Refused = 0x85,
}

export function isJsonOp(op: number): boolean {
  return op >= 0x80;
}

/** Bumped when any wire format changes incompatibly. Checked in Hello. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * Snapshots go out at half the simulation rate.
 *
 * 15Hz is enough because the client interpolates between snapshots and predicts
 * its own movement; what it buys is halving the most expensive thing the host
 * does. Events are NOT rate-limited to this -- a hit is sent the moment it
 * happens, because a 66ms delay on your own hit registering is felt.
 */
export const SNAPSHOT_HZ = 15;
export const SNAPSHOT_EVERY_TICKS = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ));

/**
 * How many recent input frames each input message carries.
 *
 * Sending the last 3 unacked frames means a single lost packet is invisible: the
 * next message already contains the frame that went missing. Retransmit-on-nack
 * would cost a full round-trip to discover the loss, by which time the input is
 * far too late to apply. Three frames is 100ms of cover for ~12 extra bytes.
 */
export const INPUT_REDUNDANCY = 3;

/**
 * How many input frames the host holds before it starts consuming them.
 *
 * A jitter buffer, and it is not optional. The client sends at exactly 30Hz and the
 * host consumes at exactly 30Hz, so with zero buffer the slightest jitter leaves the
 * host with nothing to apply on some tick. It then substitutes a synthesised
 * "held" frame -- which the CLIENT has no way to know about, so its replay of that
 * tick used a different input than the host did, and the two disagree by a whole
 * tick of movement. Measured, that one effect dominated prediction error entirely:
 * a 60ms link showed a 2.3-unit 90th-percentile error, against 0.1 with a buffer.
 *
 * Two frames costs 66ms of extra input latency and absorbs the jitter that a phone
 * on WiFi produces all day long. Deeper would be smoother and less responsive.
 */
export const INPUT_BUFFER_TARGET = 2;

/** Clock sync probe interval. Frequent at first, then settles. */
export const PING_INTERVAL_TICKS = TICK_HZ * 2;
export const PING_INTERVAL_TICKS_INITIAL = Math.round(TICK_HZ / 4);
/** Probes counted as "initial" before backing off to the slow rate. */
export const PING_FAST_COUNT = 8;

// ---------------------------------------------------------------------------
// Budgets, enforced by test
// ---------------------------------------------------------------------------

/**
 * Per-client bandwidth ceilings. A regression here is a real regression: mobile
 * data and weak WiFi are the target environment, not a gigabit LAN.
 */
export const BUDGET_DOWN_BYTES_PER_SEC = 8 * 1024;
export const BUDGET_UP_BYTES_PER_SEC = 1.2 * 1024;

// ---------------------------------------------------------------------------
// Reconciliation thresholds
// ---------------------------------------------------------------------------

/**
 * Three bands, because one threshold cannot serve all three cases.
 *
 *  - Below IGNORE, the difference is float noise from replaying the same inputs
 *    in a different order of operations. Correcting it produces visible jitter
 *    while the player stands still, which is worse than the error.
 *  - Between IGNORE and SNAP, the simulation is corrected immediately but the
 *    RENDER position keeps the old offset and decays it away, so a correction
 *    looks like the character drifting into place rather than teleporting.
 *  - Above SNAP it is not a prediction error, it is a teleport, a respawn or a
 *    bug. Smoothing a genuine teleport over 100ms would be a lie about where the
 *    player is, and lies about position get people hit from behind cover.
 */
export const RECONCILE_IGNORE_UNITS = 0.02;
/**
 * Where a correction stops being smoothed and starts being a teleport.
 *
 * Eight units, against a player 34 units wide -- roughly a quarter of a body. The
 * obvious value is 1, and it is wrong: snapping means DISCARDING the smooth
 * correction, so a 1-unit threshold trades an invisible glide for a visible twitch
 * on errors of 3% of a body width. And such errors are routine here, because predict
 * mode steps only the local player, so every body-to-body separation is resolved
 * against slightly stale positions.
 *
 * What genuinely needs snapping is a respawn or a teleport, which moves hundreds of
 * units. Eight sits comfortably between the two, so ordinary noise glides and real
 * discontinuities snap.
 */
export const RECONCILE_SNAP_UNITS = 8;
/** Half-life of the visual correction offset, in seconds. */
export const RECONCILE_DECAY_HALF_LIFE = 0.07;

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Remote entities render this far behind the host's clock, so there is always a
 * snapshot on both sides of the render time to interpolate between.
 *
 * The delay is tuned from the OBSERVED AGE of arriving snapshots, not from jitter.
 * That distinction was a real bug: jitter is only one of the terms. The age of the
 * newest snapshot a client holds is one-way latency, plus up to a full snapshot
 * interval of cadence, plus whatever the clock estimate is off by -- on a 70ms link
 * that measured 233ms, so rendering 100ms behind meant the render time was NEWER
 * than any snapshot held and every frame was extrapolated. Visible result: remote
 * players advancing in ~28-unit lurches instead of walking.
 *
 * Measuring the age directly captures all three terms at once and needs no model of
 * where the delay comes from.
 */
export const INTERP_DELAY_MIN_MS = 100;
/**
 * Ceiling, and it is a playability limit rather than a correctness one. Past this,
 * a connection is bad enough that more buffering would cost more than the stutter
 * it saves, so entities extrapolate briefly and then visibly freeze -- which at
 * least tells everyone WHO is lagging.
 */
export const INTERP_DELAY_MAX_MS = 380;
/** Margin over the measured p95 age, so ordinary variance never starves. */
export const INTERP_JITTER_MARGIN_MS = 45;
/** Snapshot ages kept for the p95 estimate. */
export const INTERP_AGE_SAMPLES = 24;

/**
 * How far past the last snapshot the client will guess before giving up.
 *
 * Then it freezes the entity and fades it, which is a deliberate design choice:
 * extrapolating a running player for a second produces someone sprinting through
 * a wall and then snapping back. Freezing makes it obvious WHO is lagging, which
 * is information players want.
 */
export const EXTRAPOLATE_MAX_MS = 100;

/** Snapshots kept for interpolation and for delta baselines. */
export const SNAPSHOT_HISTORY = 32;

// ---------------------------------------------------------------------------
// Clock sync
// ---------------------------------------------------------------------------

/**
 * The clock offset moves at no more than this fraction of real time.
 *
 * Without slewing, one unlucky RTT sample -- a GC pause on either end is enough --
 * steps the whole world's render time and everything visibly stutters. Slewing
 * means a bad sample costs a slow correction instead of a jump.
 */
export const CLOCK_SLEW_RATE = 0.1;
/** Samples kept for the minimum-RTT estimate. */
export const CLOCK_SAMPLES = 16;

// ---------------------------------------------------------------------------
// Lag compensation
// ---------------------------------------------------------------------------

/**
 * How far back the host will rewind a thrower's position when spawning a ball.
 *
 * Deliberately NOT shooter-style hit rewind. Snowball flight is 0.4-1.2s, which
 * dwarfs any plausible latency, so rewinding the VICTIM would produce the
 * notorious "I was behind cover and still got hit" -- the ball would have been
 * visibly in the air for a second beforehand. Instead the ball spawns where the
 * thrower actually was when they flicked (thrower-favoured) and then collides
 * against present-tick positions with no rewind at all (victim-favoured).
 */
export const LAGCOMP_MAX_REWIND_MS = 200;

// ---------------------------------------------------------------------------
// Disconnect handling
// ---------------------------------------------------------------------------

/**
 * A leaving player's body stays as a frozen snowman for this long.
 *
 * It cannot score, cannot be hit for points, and is moved clear of objectives.
 * The point is that a mid-match disconnect does not instantly delete a body from
 * the middle of a fight -- and if they reconnect inside the window they reclaim
 * their id, team and score instead of joining as a stranger.
 */
export const SNOWMAN_GRACE_TICKS = TICK_HZ * 45;

/** Ticks without any message before the host assumes a client is gone. */
export const CONNECTION_TIMEOUT_TICKS = TICK_HZ * 10;

/**
 * How often an unanswered Hello is repeated.
 *
 * The handshake is the one exchange with no natural redundancy -- inputs carry a
 * sliding window, snapshots re-state the world, events are idempotent -- so it needs
 * an explicit retry or a single dropped packet strands the client forever.
 */
export const HELLO_RETRY_TICKS = Math.round(TICK_HZ * 0.5);
