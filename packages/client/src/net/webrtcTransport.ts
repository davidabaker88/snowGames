/**
 * `Transport` over a WebRTC DataChannel pair.
 *
 * This is the file that makes one phone hosting for the others possible, and it is the
 * ONLY thing that had to be written to get there. Everything above it -- the host, the
 * codecs, prediction, reconciliation, interpolation, lag compensation -- was built and
 * tested against `createLocalPair()` and does not change.
 *
 * A browser cannot listen on a TCP port; there is no server-socket API in JavaScript.
 * WebRTC is the way out, because it connects two browsers directly with NEITHER side
 * listening. What it costs is a handshake that has to travel by other means, which is
 * what `signalling.ts` is for.
 *
 * ## Two channels
 *
 * `hot` is unordered with no retransmits; `cold` is reliable and ordered. The split is
 * why rule 3 of the transport seam ("assume nothing about reliability or ordering")
 * was worth writing down a phase early. On a reliable ordered channel a lost snapshot
 * head-of-line blocks every later one behind a retransmit of data that is already
 * obsolete -- the worst possible trade for state that is re-stated fifteen times a
 * second. Snapshots, inputs and pings therefore go down `hot` and are allowed to
 * vanish; joins, events and the rest go down `cold`.
 *
 * The caller says which via `send(data, reliable)`, a delivery hint carrying no game
 * vocabulary. Default reliable, so anything unconsidered is safe.
 *
 * ## Non-trickle
 *
 * All ICE candidates are gathered before the description is handed to signalling, so
 * the mailbox carries exactly one message each way. And the gather does NOT wait for
 * `icegatheringstate === 'complete'`: measured in this project's own test browser,
 * that state never arrives at all, even after nine seconds with no STUN servers
 * configured. Waiting on it would mean every join stalls for the full timeout. What
 * works is to wait for candidates to stop arriving, then go.
 */

import { Emitter, createStats, type CloseInfo, type Signal, type Transport, type TransportStats } from '@snow/shared';
import type { SessionDescription } from '@snow/shared';

/**
 * Public STUN, used to discover a reflexive address for play across the internet.
 *
 * Not needed on a shared WiFi network, where host candidates suffice, and harmless
 * when unreachable -- gathering simply produces fewer candidates. Note there is
 * deliberately NO TURN server: a relay is the one part of WebRTC that genuinely costs
 * money at any volume, so a connection that needs one will fail rather than quietly
 * bill somebody.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

/** Gathering is finished when nothing new has arrived for this long. */
const GATHER_SETTLE_MS = 350;
/** Hard ceiling, so a stalled gather cannot hang a join forever. */
const GATHER_TIMEOUT_MS = 4000;
/** How long to wait for both channels to open before giving up. */
const OPEN_TIMEOUT_MS = 15000;

const HOT_LABEL = 'hot';
const COLD_LABEL = 'cold';

export interface WebRtcTransportOptions {
  id: string;
  iceServers?: RTCIceServer[];
  /** Injected for tests. Defaults to the platform implementation. */
  createPeer?(config: RTCConfiguration): RTCPeerConnection;
}

export class WebRtcTransport implements Transport {
  readonly kind = 'webrtc' as const;
  readonly stats: TransportStats = createStats();

  private readonly openEmitter = new Emitter<void>();
  private readonly messageEmitter = new Emitter<Uint8Array>();
  private readonly closeEmitter = new Emitter<CloseInfo>();
  private readonly errorEmitter = new Emitter<Error>();

  readonly onOpen: Signal<void> = this.openEmitter;
  readonly onMessage: Signal<Uint8Array> = this.messageEmitter;
  readonly onClose: Signal<CloseInfo> = this.closeEmitter;
  readonly onError: Signal<Error> = this.errorEmitter;

  readonly pc: RTCPeerConnection;
  private hot: RTCDataChannel | null = null;
  private cold: RTCDataChannel | null = null;
  private open = false;
  private closed = false;
  private openResolve: (() => void) | null = null;
  private openReject: ((e: Error) => void) | null = null;
  private readonly openPromise: Promise<void>;

  constructor(private readonly opts: WebRtcTransportOptions) {
    const make = opts.createPeer ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
    this.pc = make({ iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS });

    this.openPromise = new Promise<void>((res, rej) => {
      this.openResolve = res;
      this.openReject = rej;
    });

    this.pc.onconnectionstatechange = (): void => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        // 'disconnected' can recover on its own, but for a lobby-scale game the honest
        // move is to surface it and let the player rejoin rather than sit in limbo.
        this.fail(s === 'failed' ? 'ice failed' : `connection ${s}`);
      }
    };
  }

  get id(): string {
    return this.opts.id;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Resolves once both channels are usable. */
  connect(): Promise<void> {
    return this.openPromise;
  }

  send(data: Uint8Array, reliable = true): void {
    const ch = reliable ? this.cold : this.hot;
    if (!ch || ch.readyState !== 'open') return;
    try {
      // A copy, because SCTP send is asynchronous and the caller reuses its encode
      // buffer immediately -- `Writer.view_()` documents that it hands out a view.
      ch.send(data.slice().buffer as ArrayBuffer);
      this.stats.bytesOut += data.byteLength;
      this.stats.msgsOut++;
    } catch (e) {
      // A full send buffer throws. Dropping the message is right for the hot path and
      // survivable on the cold one, where every exchange has a retry above it.
      this.errorEmitter.emit(e instanceof Error ? e : new Error(String(e)));
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try {
      this.hot?.close();
      this.cold?.close();
      this.pc.close();
    } catch {
      // Closing an already-dead peer connection is not interesting.
    }
    this.closeEmitter.emit({ code, reason, wasClean: true });
  }

  // ---- the offering side (a joiner) ---------------------------------------

  /**
   * Create the channels and produce an offer with candidates already in it.
   *
   * The OFFERER creates both channels. Doing it on both sides would produce four, and
   * `ondatachannel` on the answering side is how the other end picks them up.
   */
  async createOffer(): Promise<SessionDescription> {
    this.hot = this.attach(
      this.pc.createDataChannel(HOT_LABEL, { ordered: false, maxRetransmits: 0 }),
    );
    this.cold = this.attach(this.pc.createDataChannel(COLD_LABEL, { ordered: true }));

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.gather();
    return describe(this.pc.localDescription);
  }

  async acceptAnswer(answer: SessionDescription): Promise<void> {
    await this.pc.setRemoteDescription(answer as RTCSessionDescriptionInit);
  }

  // ---- the answering side (a host) ----------------------------------------

  async acceptOffer(offer: SessionDescription): Promise<SessionDescription> {
    this.pc.ondatachannel = (e): void => {
      if (e.channel.label === HOT_LABEL) this.hot = this.attach(e.channel);
      else if (e.channel.label === COLD_LABEL) this.cold = this.attach(e.channel);
    };
    await this.pc.setRemoteDescription(offer as RTCSessionDescriptionInit);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.gather();
    return describe(this.pc.localDescription);
  }

  // ---- internals ---------------------------------------------------------

  private attach(ch: RTCDataChannel): RTCDataChannel {
    ch.binaryType = 'arraybuffer';
    ch.onopen = (): void => this.maybeOpen();
    ch.onclose = (): void => {
      if (!this.closed) this.fail(`channel ${ch.label} closed`);
    };
    ch.onmessage = (e): void => {
      const data = e.data;
      if (!(data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data);
      this.stats.bytesIn += bytes.byteLength;
      this.stats.msgsIn++;
      this.messageEmitter.emit(bytes);
    };
    return ch;
  }

  /** Open only once BOTH channels are ready, or a first send could vanish. */
  private maybeOpen(): void {
    if (this.open || this.closed) return;
    if (this.hot?.readyState !== 'open' || this.cold?.readyState !== 'open') return;
    this.open = true;
    this.openResolve?.();
    this.openEmitter.emit();
  }

  private fail(reason: string): void {
    if (this.closed) return;
    const wasOpen = this.open;
    this.closed = true;
    this.open = false;
    if (!wasOpen) this.openReject?.(new Error(reason));
    this.closeEmitter.emit({ code: 1006, reason, wasClean: false });
  }

  /**
   * Wait for ICE gathering to settle.
   *
   * Deliberately not `await until iceGatheringState === 'complete'`. That never fires
   * in this project's test browser -- measured, nine seconds, no STUN configured -- and
   * can stall in the wild whenever a configured STUN server is unreachable. Waiting for
   * candidates to STOP arriving gets the same descriptor without betting the join on a
   * state transition that may never happen.
   */
  private gather(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.pc.iceGatheringState === 'complete') return resolve();

      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (settleTimer) clearTimeout(settleTimer);
        clearTimeout(hard);
        this.pc.onicecandidate = null;
        this.pc.onicegatheringstatechange = null;
        resolve();
      };

      const hard = setTimeout(finish, GATHER_TIMEOUT_MS);
      const bump = (): void => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, GATHER_SETTLE_MS);
      };

      this.pc.onicecandidate = (e): void => {
        // A null candidate is the end-of-gathering marker; anything else restarts the
        // settle window because more may follow.
        if (!e.candidate) finish();
        else bump();
      };
      this.pc.onicegatheringstatechange = (): void => {
        if (this.pc.iceGatheringState === 'complete') finish();
      };

      // Start the window even if no candidate ever arrives, so a peer with no usable
      // interface fails fast rather than hanging on the hard timeout.
      bump();
    });
  }

  /** Reject if the channels have not opened within a sane wait. */
  async waitOpen(timeoutMs = OPEN_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => rej(new Error('data channels did not open')), timeoutMs);
    });
    try {
      await Promise.race([this.openPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function describe(d: RTCSessionDescription | null): SessionDescription {
  if (!d) throw new Error('no local description');
  return { type: d.type as 'offer' | 'answer', sdp: d.sdp };
}
