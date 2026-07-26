/**
 * The QR handshake.
 *
 * Two phones, two codes, no server:
 *
 *   1. The host makes an offer and shows it as a code.
 *   2. The joiner scans it, makes an answer, and shows THAT as a code.
 *   3. The host scans the answer. Connected.
 *
 * Two scans per player, and after that the phones talk directly for the whole match.
 *
 * The direction is the same as the room-code path -- host answers, joiner offers -- no,
 * note that it is REVERSED here, and deliberately. Over a mailbox the host publishes a
 * code and reacts to whoever turns up, which lets a fifth player join a match already in
 * progress. Face to face there is no mailbox to react to: somebody has to display first,
 * and the natural thing is for the host to hold up a code and the joiners to come to it.
 *
 * Everything below the handshake is the same `WebRtcTransport` the room-code path uses,
 * which is the same `Transport` the whole netcode was built against. This file only
 * decides who says what first.
 */

import { NetClient, type GameHost } from '@snow/shared';
import { WebRtcTransport } from './webrtcTransport.js';
import { makeWorldFactory } from './netSession.js';
import {
  QrCodecError,
  decodeQrPayload,
  encodeQrPayload,
  envelopeToDescription,
  type QrEnvelope,
} from './qrCodec.js';

/**
 * No STUN servers for the QR path.
 *
 * The people using it are in the same room, which means host candidates are all that
 * are needed -- and gathering a reflexive address takes a network round trip that would
 * make the code slower to appear for no benefit. It also keeps the payload smaller.
 */
const QR_ICE_SERVERS: RTCIceServer[] = [];

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

export interface QrHostInvite {
  /** The payload to render as a code. */
  payload: Uint8Array;
  /** Feed the answer scanned from the joiner. Resolves once connected. */
  accept(answerPayload: Uint8Array): Promise<void>;
  /** Give up on this invite. */
  cancel(): void;
}

/**
 * Prepare an invitation for one joiner.
 *
 * One transport per invite, because each joiner is a separate peer connection. A host
 * expecting three friends calls this three times and shows three codes in turn -- there
 * is no way around that, since an offer is specific to the peer that answers it.
 */
export async function createQrInvite(host: GameHost, hostName: string): Promise<QrHostInvite> {
  const transport = new WebRtcTransport({
    id: `webrtc:qr:${Math.floor(performance.now())}`,
    iceServers: QR_ICE_SERVERS,
  });

  const offer = await transport.createOffer();
  const payload = await encodeQrPayload({ t: 'o', s: offer.sdp, n: hostName });

  let settled = false;
  return {
    payload,
    async accept(answerPayload: Uint8Array): Promise<void> {
      if (settled) throw new QrCodecError('this invite has already been used');
      const env = await decodeQrPayload(answerPayload);
      if (env.t !== 'a') {
        // Almost always means the two phones scanned each other's offers, which is easy
        // to do and worth naming precisely rather than reporting as a bad code.
        throw new QrCodecError('that is an invite code, not a reply code');
      }
      settled = true;
      await transport.acceptAnswer(envelopeToDescription(env));
      // Attached before the channels open, so a Hello arriving immediately has somebody
      // listening for it.
      host.accept(transport);
      await transport.waitOpen();
    },
    cancel(): void {
      if (!settled) transport.close(1000, 'invite cancelled');
    },
  };
}

// ---------------------------------------------------------------------------
// Joiner side
// ---------------------------------------------------------------------------

export interface QrJoinReply {
  /** The payload to render as a code, for the host to scan. */
  payload: Uint8Array;
  /** The host's display name, if it sent one. */
  hostName: string;
  /**
   * Wait for the host to scan the reply and the connection to come up.
   *
   * There is no signal for "the host scanned it" -- the first evidence is the data
   * channels opening, which is exactly what this waits for.
   */
  connect(skinId: string, playerName: string): Promise<NetClient>;
  cancel(): void;
  /** ICE state, for diagnostics. A lab that reports "none" for a live connection lies. */
  iceState(): string;
}

/** Answer an invite scanned from a host's screen. */
export async function replyToQrInvite(offerPayload: Uint8Array): Promise<QrJoinReply> {
  const env: QrEnvelope = await decodeQrPayload(offerPayload);
  if (env.t !== 'a' && env.t !== 'o') throw new QrCodecError('that is not a snowball code');
  if (env.t === 'a') {
    throw new QrCodecError('that is a reply code -- scan the host’s invite instead');
  }

  const transport = new WebRtcTransport({ id: 'webrtc:qr:host', iceServers: QR_ICE_SERVERS });
  const answer = await transport.acceptOffer(envelopeToDescription(env));
  const payload = await encodeQrPayload({ t: 'a', s: answer.sdp });

  let cancelled = false;
  return {
    payload,
    hostName: env.n ?? 'Host',
    async connect(skinId: string, playerName: string): Promise<NetClient> {
      await transport.waitOpen();
      if (cancelled) throw new QrCodecError('cancelled');
      const client = new NetClient({
        transport,
        createWorld: makeWorldFactory('sandbox', 0),
        name: playerName,
        skinId,
        now: () => performance.now(),
      });
      await client.connect();
      return client;
    },
    cancel(): void {
      cancelled = true;
      transport.close(1000, 'join cancelled');
    },
    iceState: () => transport.pc.iceConnectionState,
  };
}
