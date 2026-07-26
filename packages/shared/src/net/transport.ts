/**
 * The transport seam.
 *
 * Six rules keep later transports (WebRTC, a native Bluetooth bridge) additive
 * rather than a rewrite. They are worth stating because each one is easy to
 * violate accidentally:
 *
 *  1. BYTES ONLY. This interface has zero game vocabulary -- no `sendSnapshot`,
 *     no `playerId`. Encoding lives in the codec. A transport written in two
 *     years should not need to know what a snowball is.
 *  2. ONE INTERFACE, BOTH DIRECTIONS. A client's transport and the server's
 *     per-connection transport are the same type. That is what makes
 *     `createLocalPair()` five lines instead of a shim layer.
 *  3. ASSUME NOTHING ABOUT RELIABILITY OR ORDERING, even though WebSocket
 *     provides both. Snapshots carry absolute ticks, inputs carry sequence
 *     numbers in a redundant window, events are idempotent. This is the single
 *     decision that makes a future unreliable WebRTC DataChannel a config
 *     change rather than a netcode rewrite.
 *  4. EVERY MESSAGE <= ~1100 BYTES, so no transport ever needs to fragment.
 *  5. LocalTransport is asynchronous and lossy-capable (see localTransport.ts).
 *  6. Server *core* code may not import node builtins, so the same core runs
 *     under Node, a Web Worker, and a Cloudflare Durable Object.
 */

import type { Signal } from './signal.js';

export type TransportKind = 'ws' | 'local' | 'webrtc' | 'bluetooth';

export const MAX_MESSAGE_BYTES = 1100;

export interface TransportStats {
  bytesIn: number;
  bytesOut: number;
  msgsIn: number;
  msgsOut: number;
  /** Round-trip time reported by the transport itself, if it knows one. */
  nativeRttMs?: number;
}

export interface CloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface Transport {
  readonly kind: TransportKind;
  /** Stable identifier, useful for logging and for keying server-side state. */
  readonly id: string;

  connect(): Promise<void>;
  /**
   * Send bytes.
   *
   * `reliable` is a DELIVERY HINT, not game vocabulary -- rule 1 still holds, and a
   * transport that cannot honour it may ignore it. It exists because WebRTC can offer
   * an unreliable unordered channel, and for the hot path that is strictly better: a
   * reliable ordered channel head-of-line blocks every later snapshot behind a
   * retransmit of one that is already obsolete.
   *
   * Defaults to `true`, so a caller that has not thought about it gets the safe
   * behaviour rather than silent loss.
   */
  send(data: Uint8Array, reliable?: boolean): void;
  close(code?: number, reason?: string): void;

  readonly onOpen: Signal<void>;
  readonly onMessage: Signal<Uint8Array>;
  readonly onClose: Signal<CloseInfo>;
  readonly onError: Signal<Error>;

  readonly stats: TransportStats;
  readonly isOpen: boolean;
}

/** The listening side. `urls` is what gets printed and turned into a QR code. */
export interface ServerTransport {
  listen(): Promise<{ urls: string[] }>;
  readonly onConnection: Signal<Transport>;
  close(): Promise<void>;
}

export function createStats(): TransportStats {
  return { bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0 };
}
