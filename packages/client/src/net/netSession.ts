/**
 * One end of a networked match, from this device's point of view.
 *
 * Three shapes, and the reason there are exactly three is worth stating:
 *
 *  - `solo` -- a host and a client in this tab, joined by `createLocalPair()`. Exercises
 *    the whole authoritative path with no network involved, which is what `?net=1` runs.
 *  - `hosting` -- a client attached to a host that ALSO serves remote peers over WebRTC.
 *  - `guest` -- a client and nothing else; the host is somebody else's phone.
 *
 * Notice that the hosting player is a client of their own host, over a local transport
 * pair. That is not a convenience. It means the person hosting runs exactly the code
 * every other player runs, prediction and reconciliation included. A "the host just
 * steps the world directly" shortcut would create a path exercised by one player per
 * match and by no test, which is precisely where bugs nobody can reproduce live.
 *
 * The only thing that differs between a guest on WiFi and a guest across the internet is
 * which `Transport` was handed in. Nothing in this file knows the difference.
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

export function makeWorldFactory(modeId: string, seed: number): () => World {
  return (): World => {
    const w = createWorld(seed, MAP_ARENA01.bounds, getMode(modeId));
    applyMap(w, MAP_ARENA01);
    return w;
  };
}

export class NetSession {
  private readonly pendingEvents: SimEvent[] = [];
  private disposed = false;
  private didStart = false;

  private constructor(
    /** Null for a guest: somebody else is authoritative. */
    readonly host: GameHost | null,
    readonly client: NetClient,
    /** True when this session created the host and is responsible for advancing it. */
    private readonly ownsHost: boolean,
  ) {
    // Buffered rather than dispatched straight through, because events arrive on the
    // transport's timing and the renderer wants them on a tick boundary.
    client.onEvents.on((evs) => {
      for (const e of evs) this.pendingEvents.push(e);
    });
  }

  /** A host and a client in this tab, for `?net=1` and for tests. */
  static solo(opts: {
    modeId: string;
    bots: number;
    skinId: string;
    seed: number;
    link?: LinkConditions;
  }): NetSession {
    const factory = makeWorldFactory(opts.modeId, opts.seed);
    const host = new GameHost({
      createWorld: factory,
      modeId: opts.modeId,
      seed: opts.seed,
      bots: opts.bots,
      maxPlayers: 8,
      now: () => performance.now(),
    });
    const client = attachClient(host, opts.skinId, factory, opts.link);
    return new NetSession(host, client, true);
  }

  /**
   * A client for a host this device is running for others.
   *
   * The host is NOT owned here -- `HostedRoom` created it and owns its lifetime -- but it
   * still has to be advanced, and this session is what has a frame loop. Hence
   * `ownsHost: true` for advancing while the room owns teardown.
   */
  static attachTo(host: GameHost, skinId: string, link?: LinkConditions): NetSession {
    const client = attachClient(host, skinId, makeWorldFactory('sandbox', 0), link);
    return new NetSession(host, client, true);
  }

  /** A guest. Somebody else's phone is authoritative. */
  static fromClient(client: NetClient): NetSession {
    return new NetSession(null, client, false);
  }

  get readyToStart(): boolean {
    return this.client.joined;
  }

  /**
   * Begin the match.
   *
   * Only meaningful where this end owns a host; a guest waits to be told. Idempotent, so
   * a caller can check "has it started" every frame instead of remembering.
   *
   * The idempotence is tracked with a FLAG, not by looking at the host's tick. The host
   * begins ticking the moment it exists -- it has to, or the handshake never completes --
   * so a `tick > 0` guard is already true by the time the first client has joined, and
   * `start()` would return early forever. The visible symptom was a hosted match that
   * ran perfectly and simply had no bots in it.
   */
  start(): void {
    if (!this.ownsHost || this.didStart) return;
    this.didStart = true;
    this.host?.start();
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

  /** Host tick, or the client's confirmed tick when there is no local host. */
  get hostTick(): number {
    return this.host?.world.tick ?? this.client.confirmed.tick;
  }

  /**
   * Advance this end and drain the frame's events.
   *
   * Host first where there is one: it is the thing being waited on, so stepping it
   * before the client shaves a tick off how long local input takes to come back.
   */
  advance(frame: InputFrame): readonly SimEvent[] {
    if (this.disposed) return EMPTY;
    if (this.ownsHost) this.host?.advance();
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

/** Wire a client to a host through an in-process transport pair. */
function attachClient(
  host: GameHost,
  skinId: string,
  factory: () => World,
  link?: LinkConditions,
): NetClient {
  const [clientSide, hostSide] = createLocalPair(link ?? {});
  host.accept(hostSide);
  void hostSide.connect();
  const client = new NetClient({
    transport: clientSide,
    createWorld: factory,
    name: 'You',
    skinId,
    now: () => performance.now(),
  });
  void client.connect();
  return client;
}

const EMPTY: readonly SimEvent[] = [];
