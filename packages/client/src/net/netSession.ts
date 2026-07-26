/**
 * A whole networked match, in one tab.
 *
 * Runs a real `GameHost` and a real `NetClient` connected by `createLocalPair()`.
 * Nothing here is a simulation of networking: it is the netcode, with the bytes
 * taking a shortcut instead of a socket. That makes the entire authoritative path --
 * handshake, snapshots, delta encoding, prediction, reconciliation, interpolation,
 * lag compensation -- something you can look at on a phone, with `?netdebug=1` to
 * read the numbers.
 *
 * Why this is opt-in via `?net=1` rather than the default: single-device play against
 * bots does not need a network, and routing it through one would add a round trip and
 * a class of failure for no benefit to the player. The value of this path is that it
 * exercises the netcode in a real browser under real frame timing, and it is the
 * shape the WebRTC transport will drop into -- at which point it becomes the only
 * path, because then there genuinely is a network.
 *
 * The transport is the ONLY thing that changes when that happens. `createLocalPair()`
 * becomes a DataChannel pair; everything below stays as it is.
 */

import {
  GameHost,
  NetClient,
  applyMap,
  createLocalPair,
  createWorld,
  getMode,
  MAP_ARENA01,
  type InputFrame,
  type LinkConditions,
  type NetDebugInfo,
  type SimEvent,
  type World,
} from '@snow/shared';

export interface NetSessionOptions {
  modeId: string;
  bots: number;
  skinId: string;
  seed: number;
  /** Injected latency and loss, for feeling the netcode rather than reading about it. */
  link?: LinkConditions;
}

export class NetSession {
  readonly host: GameHost;
  readonly client: NetClient;

  private readonly pendingEvents: SimEvent[] = [];
  private disposed = false;

  constructor(private readonly opts: NetSessionOptions) {
    const factory = (): World => {
      const w = createWorld(opts.seed, MAP_ARENA01.bounds, getMode(opts.modeId));
      applyMap(w, MAP_ARENA01);
      return w;
    };

    this.host = new GameHost({
      createWorld: factory,
      modeId: opts.modeId,
      seed: opts.seed,
      bots: opts.bots,
      maxPlayers: 8,
      now: () => performance.now(),
    });

    const [clientSide, hostSide] = createLocalPair(opts.link ?? {});
    this.host.accept(hostSide);
    void hostSide.connect();

    this.client = new NetClient({
      transport: clientSide,
      createWorld: factory,
      name: 'You',
      skinId: opts.skinId,
      now: () => performance.now(),
    });

    // Buffered rather than dispatched, because events arrive on the transport's
    // timing and the renderer wants them on a tick boundary.
    this.client.onEvents.on((evs) => {
      for (const e of evs) this.pendingEvents.push(e);
    });

    void this.client.connect();
  }

  /**
   * Start the match once the client has actually joined.
   *
   * Order matters: `GameHost.start()` fills the remaining slots with bots, so the
   * human has to be in before it runs or the bots take the low slots and the local
   * player is not player zero.
   */
  get readyToStart(): boolean {
    return this.client.joined;
  }

  start(): void {
    this.host.start();
  }

  get started(): boolean {
    return this.host.world.tick > 0;
  }

  /** What to render: the predicted world, which includes local input immediately. */
  get world(): World {
    return this.client.world;
  }

  get localPlayerId(): number {
    return this.client.playerId;
  }

  get debug(): NetDebugInfo {
    return this.client.debug;
  }

  /** Visual offset that decays a mid-sized correction away. */
  get renderOffset(): { x: number; y: number } {
    return this.client.renderOffset;
  }

  /**
   * Advance both ends and drain this frame's events.
   *
   * Host first: it is the thing being waited on, and stepping it before the client
   * shaves one tick off how long the client's input takes to be reflected.
   */
  advance(frame: InputFrame): readonly SimEvent[] {
    if (this.disposed) return EMPTY;
    this.host.advance();
    this.client.advance(frame);

    if (this.pendingEvents.length === 0) return EMPTY;
    const out = this.pendingEvents.slice();
    this.pendingEvents.length = 0;
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.client.close();
  }
}

const EMPTY: readonly SimEvent[] = [];
