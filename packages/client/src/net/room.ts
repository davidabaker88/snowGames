/**
 * Rooms: bringing a host and its joiners together over WebRTC.
 *
 * This is the orchestration layer, and it is the last piece. `GameHost` already accepts
 * any number of `Transport`s and does not care what they are; `webrtcTransport.ts`
 * already knows how to become one from a description exchange. All that was missing was
 * something to run the introduction.
 *
 * The asymmetry is worth noticing: the HOST answers, and the JOINER offers. It could go
 * either way, but this direction means a host publishes one short code and then reacts,
 * rather than needing to know in advance who is coming -- which is what lets a fifth
 * player join a match that is already running.
 */

import {
  GameHost,
  NetClient,
  applyMap,
  createWorld,
  getMode,
  MAP_ARENA01,
  SignallingError,
  type Signalling,
  type World,
} from '@snow/shared';
import { WebRtcTransport } from './webrtcTransport.js';

/** How often the host checks the mailbox for new joiners. */
const HOST_POLL_MS = 1200;
/** How often a joiner checks for its answer, and for how long. */
const JOIN_POLL_MS = 500;
const JOIN_TIMEOUT_MS = 30_000;

export type RoomStatus =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'hosting'; code: string; peers: number }
  | { kind: 'joining'; step: string }
  | { kind: 'joined' }
  | { kind: 'failed'; reason: string };

function worldFactory(modeId: string, seed: number) {
  return (): World => {
    const w = createWorld(seed, MAP_ARENA01.bounds, getMode(modeId));
    applyMap(w, MAP_ARENA01);
    return w;
  };
}

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

export interface HostedRoomOptions {
  signalling: Signalling;
  modeId: string;
  bots: number;
  seed: number;
  hostName: string;
  iceServers?: RTCIceServer[];
  onStatus?(s: RoomStatus): void;
}

/**
 * A room this device is hosting.
 *
 * Note that the host ALSO plays, through a local transport pair to its own `GameHost`.
 * That is not a shortcut -- it means the hosting player runs exactly the same client
 * code as everybody else, including prediction and reconciliation against its own host.
 * Special-casing the host's own input would create a path that only one player in the
 * match ever exercises, which is precisely where the bugs nobody can reproduce live.
 */
export class HostedRoom {
  readonly host: GameHost;
  private code = '';
  private hostToken = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly peers: WebRtcTransport[] = [];
  private closed = false;

  constructor(private readonly opts: HostedRoomOptions) {
    this.host = new GameHost({
      createWorld: worldFactory(opts.modeId, opts.seed),
      modeId: opts.modeId,
      seed: opts.seed,
      bots: opts.bots,
      maxPlayers: 8,
      now: () => performance.now(),
    });
  }

  get roomCode(): string {
    return this.code;
  }

  get peerCount(): number {
    return this.peers.filter((p) => p.isOpen).length;
  }

  /** Claim a code and start listening for joiners. */
  async open(): Promise<string> {
    this.opts.onStatus?.({ kind: 'creating' });
    const { code, hostToken } = await this.opts.signalling.createRoom(this.opts.hostName);
    this.code = code;
    this.hostToken = hostToken;
    this.opts.onStatus?.({ kind: 'hosting', code, peers: 0 });

    // Polling is also the room's keep-alive, so this interval is what stops the room
    // expiring under a host that is sitting in a lobby waiting for people.
    this.pollTimer = setInterval(() => void this.pump(), HOST_POLL_MS);
    void this.pump();
    return code;
  }

  private async pump(): Promise<void> {
    if (this.closed) return;
    let offers;
    try {
      offers = await this.opts.signalling.pollOffers(this.code, this.hostToken);
    } catch (e) {
      // A transient signalling failure must not kill a match in progress: everybody
      // already connected is on a direct peer connection and unaffected.
      const err = e instanceof SignallingError && !e.retryable;
      if (err) this.opts.onStatus?.({ kind: 'failed', reason: (e as Error).message });
      return;
    }

    for (const pending of offers) {
      if (this.closed) return;
      const t = new WebRtcTransport({
        id: `webrtc:${pending.peerId}`,
        iceServers: this.opts.iceServers,
      });
      try {
        const answer = await t.acceptOffer(pending.offer);
        await this.opts.signalling.postAnswer(
          this.code,
          this.hostToken,
          pending.peerId,
          answer,
        );
        // Hand it to the host BEFORE the channels open. `GameHost.accept` only
        // subscribes to signals, and doing it now means the joiner's Hello cannot
        // arrive before anybody is listening for it.
        this.host.accept(t);
        this.peers.push(t);
        void t
          .waitOpen()
          .then(() => this.opts.onStatus?.({ kind: 'hosting', code: this.code, peers: this.peerCount }))
          .catch(() => t.close(1006, 'never opened'));
      } catch {
        // One joiner failing to connect is that joiner's problem. They can try again.
        t.close(1006, 'handshake failed');
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const p of this.peers) p.close(1000, 'room closed');
    if (this.code) void this.opts.signalling.closeRoom(this.code, this.hostToken).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export interface JoinRoomOptions {
  signalling: Signalling;
  code: string;
  name: string;
  skinId: string;
  iceServers?: RTCIceServer[];
  onStatus?(s: RoomStatus): void;
}

export interface JoinedRoom {
  client: NetClient;
  transport: WebRtcTransport;
  close(): void;
}

/**
 * Join a room by code.
 *
 * The steps are reported through `onStatus` rather than hidden, because a join has four
 * distinct ways to fail -- bad code, no answer, ICE failure, refused by the host -- and
 * a spinner that says nothing turns all four into "it doesn't work".
 */
export async function joinRoom(opts: JoinRoomOptions): Promise<JoinedRoom> {
  const status = (step: string): void => opts.onStatus?.({ kind: 'joining', step });

  const transport = new WebRtcTransport({ id: 'webrtc:host', iceServers: opts.iceServers });

  status('finding a route');
  const offer = await transport.createOffer();

  status('knocking');
  const { peerId } = await opts.signalling.postOffer(opts.code, opts.name, offer);

  status('waiting for the host');
  const answer = await pollForAnswer(opts, peerId);
  await transport.acceptAnswer(answer);

  status('connecting');
  await transport.waitOpen();

  // The client is built only once the channels are up, so its Hello lands on a
  // connection that can carry it. The retry would cover us anyway, but there is no
  // reason to spend a round of it on something we can simply order correctly.
  const client = new NetClient({
    transport,
    createWorld: worldFactory('sandbox', 0),
    name: opts.name,
    skinId: opts.skinId,
    now: () => performance.now(),
  });
  await client.connect();
  opts.onStatus?.({ kind: 'joined' });

  return {
    client,
    transport,
    close: (): void => {
      client.close();
      transport.close(1000, 'left');
    },
  };
}

async function pollForAnswer(
  opts: JoinRoomOptions,
  peerId: string,
): Promise<{ type: 'offer' | 'answer'; sdp: string }> {
  const deadline = performance.now() + JOIN_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const answer = await opts.signalling.pollAnswer(opts.code, peerId);
    if (answer) return answer;
    await sleep(JOIN_POLL_MS);
  }
  // Distinguished from a bad code on purpose: the room existed and took the offer, so
  // what failed is the host answering -- which usually means they closed the lobby.
  throw new SignallingError('the host never answered', true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
