/**
 * The WebRTC lab: `?dev=rtc`.
 *
 * A page that can be either end of a peer connection, with the description exchange
 * driven from outside. It exists so `tools/verifyWebrtc.ts` can put a host in one
 * browser context and a client in another and relay between them -- standing in for
 * the signalling Worker, which is the one part of the path that is ordinary HTTP and
 * needs no browser to test.
 *
 * Dev-only, and not reachable from the game. It deliberately does NOT use `HostedRoom`
 * or `joinRoom`, because those own their own polling loops and timing; driving the
 * transport directly is what lets a test step the handshake and assert on each stage
 * rather than waiting on a spinner.
 */

import {
  GameHost,
  NetClient,
  applyMap,
  createWorld,
  getMode,
  MAP_ARENA01,
  type SessionDescription,
  type World,
} from '@snow/shared';
import { createInputFrame } from '@snow/shared';
import { WebRtcTransport } from '../net/webrtcTransport.js';

interface HostState {
  tick: number;
  conns: number;
  players: number;
}

interface JoinState {
  joined: boolean;
  playerId: number;
  confirmedTick: number;
  rttMs: number;
  heldBall: number;
  bytesIn: number;
  bytesOut: number;
  iceState: string;
}

function factory(modeId: string, seed: number) {
  return (): World => {
    const w = createWorld(seed, MAP_ARENA01.bounds, getMode(modeId));
    applyMap(w, MAP_ARENA01);
    return w;
  };
}

export function startRtcLab(canvas: HTMLCanvasElement): void {
  // No ICE servers. A test must not depend on reaching a public STUN host, and inside
  // a container it could not anyway -- host candidates are what this exercises.
  const iceServers: RTCIceServer[] = [];

  let host: GameHost | null = null;
  let hostTransport: WebRtcTransport | null = null;
  let client: NetClient | null = null;
  let joinTransport: WebRtcTransport | null = null;
  let started = false;
  const frame = createInputFrame();

  const bridge = {
    async hostOpen(modeId: string, bots: number): Promise<void> {
      host = new GameHost({
        createWorld: factory(modeId, 0x51e161),
        modeId,
        seed: 0x51e161,
        bots,
        maxPlayers: 8,
        now: () => performance.now(),
      });
    },

    async hostAnswer(offer: SessionDescription): Promise<SessionDescription> {
      if (!host) throw new Error('hostOpen first');
      hostTransport = new WebRtcTransport({ id: 'webrtc:peer', iceServers });
      const answer = await hostTransport.acceptOffer(offer);
      // Accepted before the channels open, so a Hello arriving immediately has
      // somebody listening for it.
      host.accept(hostTransport);
      return answer;
    },

    hostState(): HostState {
      if (!host) return { tick: -1, conns: 0, players: 0 };
      return {
        tick: host.world.tick,
        conns: host.stats.connections,
        players: host.world.players.filter((p) => p.active && !p.isDummy).length,
      };
    },

    async joinOffer(): Promise<SessionDescription> {
      joinTransport = new WebRtcTransport({ id: 'webrtc:host', iceServers });
      return joinTransport.createOffer();
    },

    async joinAccept(answer: SessionDescription): Promise<void> {
      if (!joinTransport) throw new Error('joinOffer first');
      await joinTransport.acceptAnswer(answer);
      await joinTransport.waitOpen();
      client = new NetClient({
        transport: joinTransport,
        createWorld: factory('sandbox', 0),
        name: 'Joiner',
        skinId: 'stick',
        now: () => performance.now(),
      });
      await client.connect();
    },

    joinState(): JoinState {
      const d = client?.debug;
      return {
        joined: client?.joined ?? false,
        playerId: client?.playerId ?? -1,
        confirmedTick: client?.confirmed.tick ?? -1,
        rttMs: d?.rttMs ?? 0,
        heldBall: client ? (client.world.players[client.playerId]?.heldBall ?? -1) : -1,
        bytesIn: d?.bytesIn ?? 0,
        bytesOut: d?.bytesOut ?? 0,
        iceState: joinTransport?.pc.iceConnectionState ?? 'none',
      };
    },

    /**
     * Run both ends for a while.
     *
     * Real time, not a virtual clock: the whole point of this harness is that the
     * transport is real, and a real DataChannel delivers on real timers.
     */
    pump(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const until = performance.now() + ms;
        const tickOnce = (): void => {
          // Start once a slot has actually been CLAIMED, which only happens when a
          // Hello has been processed. Checking the connection count is not enough --
          // a connection exists from the moment the channels open, before the
          // handshake -- and checking the local `client` is wrong on this page, since
          // the hosting page has no client of its own. Starting too early lets bots
          // take the low player slots ahead of the human.
          const seated = host?.world.players.some((p) => p.active && !p.isDummy) ?? false;
          if (host && !started && seated) {
            host.start();
            started = true;
          }
          host?.advance();
          client?.advance(frame);
          if (performance.now() < until) requestAnimationFrame(tickOnce);
          else resolve();
        };
        requestAnimationFrame(tickOnce);
      });
    },
  };

  (window as unknown as { __rtc: typeof bridge }).__rtc = bridge;

  // Minimal visible feedback, so a `--headed` run shows something.
  const ctx = canvas.getContext('2d');
  const paint = (): void => {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e9f1fa';
    ctx.font = '600 16px ui-monospace, monospace';
    const hs = bridge.hostState();
    const js = bridge.joinState();
    const lines = [
      'WebRTC lab',
      `host   tick ${hs.tick}  conns ${hs.conns}  players ${hs.players}`,
      `joiner joined ${js.joined}  player ${js.playerId}  confirmed ${js.confirmedTick}`,
      `ice ${js.iceState}  rtt ${Math.round(js.rttMs)}ms`,
      `bytes in ${js.bytesIn}  out ${js.bytesOut}`,
    ];
    lines.forEach((l, i) => ctx.fillText(l, 20, 40 + i * 26));
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
}
