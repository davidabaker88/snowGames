/**
 * Composition root.
 *
 * Wires input -> simulation -> renderer, in one of two ways:
 *
 *  - **Direct** (the default): `step()` is called here, with bots feeding the same
 *    input map a thumb does. No network, because single-device play does not need
 *    one and routing it through a host would add a round trip and a class of
 *    failure for nothing.
 *  - **Hosted** (`?net=1`): a real `GameHost` and `NetClient` in the same tab, with
 *    prediction, reconciliation and interpolation all live. See `net/netSession.ts`.
 *
 * The renderer cannot tell the difference, which is the point -- it reads a `World`
 * either way. When the WebRTC transport lands, the hosted path becomes the only
 * path, and the only thing that changes is how the two ends are connected.
 */

import {
  ACTION_NAMES,
  BallState,
  DUMMY_HP,
  MAP_ARENA01,
  MAX_HP,
  MatchPhase,
  PACK_ROTATIONS_REQUIRED,
  PICKUP_RADIUS,
  SimEventType,
  TICK_DT,
  applyMap,
  botInput,
  buildTargetTile,
  countWalls,
  createBotBrain,
  createModeHud,
  createWorld,
  findGroundedBallNear,
  getMode,
  getSkin,
  skinIds,
  spawnPlayer,
  startMatch,
  step,
  tileAtWorld,
  wallHeightAt,
  type BotBrain,
  type InputFrame,
  type ModeHud,
  type ModeId,
  type LinkConditions,
  type World,
} from '@snow/shared';
import { GameLoop, resizeCanvas } from './loop.js';
import { InputController } from './input/inputController.js';
import { installDebugDriver } from './input/debugDriver.js';
import { Renderer } from './render/renderer.js';
import { createCamera, followCamera, snapCamera, updateZoom } from './render/camera.js';
import { createTerrain, type Terrain } from './render/terrain.js';
import { ParticleSystem } from './render/particles.js';
import { drawHud, type HudModel } from './hud/hud.js';
import { drawModeHud, drawSpectatorNotice } from './hud/modeHud.js';
import { ModeSelect } from './hud/modeSelect.js';
import { RateMeter, drawNetDebug } from './hud/netDebug.js';
import { NetSession } from './net/netSession.js';
import { Lobby } from './hud/lobby.js';
import { HostedRoom, joinRoom, type JoinedRoom, type RoomStatus } from './net/room.js';
import { HttpSignalling } from './net/httpSignalling.js';
import { QrDisplay, QrScanner } from './hud/qrPanel.js';
import { buildQr, qrSupported } from './net/qrCodec.js';
import { createQrInvite, replyToQrInvite, type QrHostInvite } from './net/qrRoom.js';
import type { Camera, Viewport } from './render/projection.js';

/** Turn whatever came back from signalling into something a player can act on. */
function describeError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return 'could not reach the signalling server';
}

/** Safe-area top inset, read from the CSS variable the stylesheet publishes. */
function safeTop(): number {
  const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--sat'));
  return Number.isFinite(v) ? v : 0;
}

const LOCAL_PLAYER = 0;

/** Debug overlay line count * line height + padding. Kept in sync with drawDebug. */
const DEBUG_PANEL_LINES = 10;
const DEBUG_PANEL_HEIGHT = DEBUG_PANEL_LINES * 14 + 12;

export interface GameOptions {
  canvas: HTMLCanvasElement;
  skinId: string;
  debug: boolean;
  /** Mode to start in. Omit to show the picker. */
  modeId?: ModeId;
  bots?: number;
  /** Run through a real host and net client in this tab. */
  networked?: boolean;
  /** Show the netcode overlay. Implies `networked`. */
  netDebug?: boolean;
  /** Injected latency and loss, so the netcode can be felt rather than read about. */
  link?: LinkConditions;
  /** Signalling origin. Empty means no online play, which is a valid configuration. */
  signalUrl?: string;
}

export class Game {
  private world: World;

  private cam: Camera = createCamera();
  private vp: Viewport = { width: 1, height: 1 };
  private terrain: Terrain;
  private renderer = new Renderer();
  private particles = new ParticleSystem();
  private input: InputController;
  private loop: GameLoop;
  private ctx: CanvasRenderingContext2D;

  private time = 0;
  private lastDtMs = 16;
  private currentInput: InputFrame | null = null;
  private hint = '';
  private hintUntil = 0;
  private skinIdx = 0;

  private brains: BotBrain[] = [];
  private modeHudModel: ModeHud = createModeHud();
  private modeSelect: ModeSelect;
  private inputSeq = 0;
  /** Whose eyes we are watching through: the local player, or a survivor. */
  private cameraTarget = LOCAL_PLAYER;
  /** Set when the match has ended, so a tap restarts rather than acting in-game. */
  private awaitingRestart = false;
  private currentModeId: ModeId;
  private currentBots: number;

  /** Set only in hosted mode. See the file header. */
  private session: NetSession | null = null;
  private readonly rates = new RateMeter();
  private netStarted = false;

  private lobby: Lobby;
  /** Set when this device is hosting for others over WebRTC. */
  private room: HostedRoom | null = null;
  /** Set when this device joined somebody else's room. */
  private guest: JoinedRoom | null = null;
  private pendingModeId: ModeId = 'teamWar';
  private pendingBots = 3;

  private readonly qrDisplay = new QrDisplay();
  private readonly qrScanner = new QrScanner();
  private qrInvite: QrHostInvite | null = null;

  constructor(private readonly opts: GameOptions) {
    const canvas = opts.canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    const ids = skinIds();
    this.skinIdx = Math.max(0, ids.indexOf(opts.skinId));

    this.currentModeId = opts.modeId ?? 'sandbox';
    this.currentBots = opts.bots ?? 0;

    this.terrain = createTerrain(MAP_ARENA01.bounds, 1);
    this.input = new InputController(canvas);
    this.input.attach();
    installDebugDriver(canvas);

    // Built before the loop starts, so there is always a world to render.
    this.world = this.buildMatch(this.currentModeId, this.currentBots);

    const hudRoot = document.getElementById('hud') ?? document.body;
    this.modeSelect = new ModeSelect(hudRoot, {
      onPick: (id, bots) => this.startMode(id, bots),
      onPlayTogether: (id, bots) => {
        // Remember what they picked, because the lobby comes BEFORE the match is built:
        // a joiner's mode comes from the host, and a host's from this choice.
        this.pendingModeId = id;
        this.pendingBots = bots;
        this.modeSelect.hide();
        this.lobby.showChoice();
        this.lobby.show();
      },
    });
    this.lobby = new Lobby(hudRoot, {
      onHost: () => void this.hostRoom(),
      onJoin: (code) => void this.joinAsGuest(code),
      onStart: () => this.startHostedMatch(),
      onCancel: () => this.leaveOnline(),
      onHostQr: () => void this.hostViaQr(),
      onJoinQr: () => void this.joinViaQr(),
    });
    if (!opts.modeId) this.modeSelect.show();

    this.resize();
    snapCamera(this.cam, this.me.x, this.me.y);

    this.loop = new GameLoop({
      tick: () => this.tick(),
      render: (alpha, dtMs) => this.render(alpha, dtMs),
    });

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => this.resize());

    this.showHint('Left thumb to move. Circle with your right thumb to pack a snowball.', 7);
  }

  /**
   * Build a fresh world for a mode.
   *
   * Rebuilt from scratch per match rather than reset in place: a half-cleared
   * world is where stale-state bugs live, and building one is cheap.
   */
  private buildMatch(modeId: ModeId, bots: number): World {
    if (this.opts.networked) return this.buildHostedMatch(modeId, bots);
    if (this.room || this.guest) {
      // Online play owns the world; rebuilding it here would discard the host.
      return this.session?.world ?? this.world;
    }
    const mode = getMode(modeId);
    const w = createWorld(0x51e161, MAP_ARENA01.bounds, mode);
    applyMap(w, MAP_ARENA01);

    const ids = skinIds();
    const spawn = MAP_ARENA01.spawns[0]!;
    spawnPlayer(w, { x: spawn.x, y: spawn.y, name: 'You', skinId: this.opts.skinId });

    // Bots wear the OTHER skin, so both rigs are on screen at once and a
    // regression in either is immediately visible.
    const otherSkin = ids.find((s) => s !== this.opts.skinId) ?? this.opts.skinId;
    this.brains = [];
    for (let i = 0; i < bots; i++) {
      const spot = MAP_ARENA01.spawns[(i + 1) % MAP_ARENA01.spawns.length]!;
      spawnPlayer(w, {
        x: spot.x,
        y: spot.y,
        name: `Bot ${i + 1}`,
        skinId: i % 2 === 0 ? otherSkin : this.opts.skinId,
      });
      this.brains.push(createBotBrain(i + 1, 0x51e161 + i, 0.5));
    }

    // Practice keeps its training dummies; competitive modes have real opponents.
    if (mode.id === 'sandbox') {
      for (const d of MAP_ARENA01.dummies) {
        spawnPlayer(w, { x: d.x, y: d.y, isDummy: true, hp: DUMMY_HP, skinId: otherSkin });
      }
    }

    startMatch(w);
    this.cameraTarget = LOCAL_PLAYER;
    this.awaitingRestart = false;
    this.particles = new ParticleSystem();
    return w;
  }

  /**
   * Build a hosted match: a host and a client, joined over an in-tab transport.
   *
   * Returns the client's predicted world so the renderer has something immediately.
   * The match itself does not begin until the handshake completes -- `GameHost.start`
   * fills the spare slots with bots, so the human has to be seated first or the bots
   * take the low slots and the local player is no longer player zero.
   */
  private buildHostedMatch(modeId: ModeId, bots: number): World {
    this.session?.dispose();
    this.netStarted = false;
    // Bots live on the HOST in this mode. Leaving stale brains here would have them
    // driving player ids in a world they no longer belong to.
    this.brains = [];
    this.session = NetSession.solo({
      modeId,
      bots,
      skinId: this.opts.skinId,
      seed: 0x51e161,
      link: this.opts.link,
    });
    this.cameraTarget = LOCAL_PLAYER;
    this.awaitingRestart = false;
    this.particles = new ParticleSystem();
    return this.session.world;
  }

  /** Switch modes, which means a whole new match. */
  startMode(modeId: ModeId, bots: number): void {
    this.currentModeId = modeId;
    this.currentBots = bots;
    this.world = this.buildMatch(modeId, bots);
    this.terrain = createTerrain(MAP_ARENA01.bounds, 1);
    snapCamera(this.cam, this.me.x, this.me.y);
    this.showHint(getMode(modeId).blurb, 6);
  }

  // ---- online play -------------------------------------------------------

  private signalling(): HttpSignalling {
    return new HttpSignalling({ baseUrl: this.opts.signalUrl ?? '' });
  }

  /**
   * Host a room over WebRTC.
   *
   * The hosting player plays through the same `NetSession` a solo hosted match uses --
   * a local transport pair to its own `GameHost` -- while remote players arrive as
   * WebRTC transports on the same host. So the host is a client of itself, and runs
   * exactly the code every other player runs, prediction included. A special-cased
   * "the host just steps the world" path would be exercised by one player per match,
   * which is where the bugs nobody can reproduce come from.
   */
  private async hostRoom(): Promise<void> {
    this.teardownOnline();
    const onStatus = (s: RoomStatus): void => this.lobby.setStatus(s, this.onlineRoster());
    try {
      const room = new HostedRoom({
        signalling: this.signalling(),
        modeId: this.pendingModeId,
        bots: this.pendingBots,
        seed: 0x51e161,
        hostName: 'Host',
        onStatus,
      });
      this.room = room;

      // The local player attaches to this host through an in-process pair, so the host
      // has a client too.
      const session = NetSession.attachTo(room.host, this.opts.skinId, this.opts.link);
      this.session = session;
      this.netStarted = false;
      this.world = session.world;

      await room.open();
    } catch (e) {
      this.failOnline(e);
    }
  }

  /** Join somebody else's room. */
  private async joinAsGuest(code: string): Promise<void> {
    this.teardownOnline();
    try {
      const joined = await joinRoom({
        signalling: this.signalling(),
        code,
        name: 'Player',
        skinId: this.opts.skinId,
        onStatus: (s) => this.lobby.setStatus(s),
      });
      this.guest = joined;
      const session = NetSession.fromClient(joined.client);
      this.session = session;
      this.world = session.world;
      this.netStarted = true;
      this.lobby.hide();
      this.showHint('Joined. Waiting for the host to start.', 5);
    } catch (e) {
      this.failOnline(e);
    }
  }

  /**
   * Report a failed host or join, and make sure the report is actually on screen.
   *
   * The `show()` is load-bearing. An earlier version tore down through `leaveOnline`,
   * which returns to the mode picker -- so the failure text rendered into a panel that
   * had just been hidden, and pressing Host with no signalling server flipped back to
   * the picker with no explanation at all.
   */
  private failOnline(e: unknown): void {
    this.teardownOnline();
    this.lobby.setStatus({ kind: 'failed', reason: describeError(e) });
    this.lobby.show();
  }

  // ---- QR play, which needs no server at all ------------------------------

  /**
   * Host by showing a code.
   *
   * A fresh `HostedRoom` is NOT used here: that class owns a signalling mailbox and a
   * polling loop, and there is no mailbox in this path. What is shared is everything
   * below -- the same `GameHost`, the same `WebRtcTransport`, the same client.
   */
  private async hostViaQr(): Promise<void> {
    if (!this.ensureQrSupported()) return;
    this.teardownOnline();
    try {
      const room = new HostedRoom({
        signalling: this.signalling(),
        modeId: this.pendingModeId,
        bots: this.pendingBots,
        seed: 0x51e161,
        hostName: 'Host',
      });
      this.room = room;
      const session = NetSession.attachTo(room.host, this.opts.skinId, this.opts.link);
      this.session = session;
      this.netStarted = false;
      this.world = session.world;

      await this.showNextInvite();
    } catch (e) {
      this.failOnline(e);
    }
  }

  /**
   * Show an invite, then scan for the reply.
   *
   * One invite per joiner: an offer is specific to the peer that answers it, so a host
   * expecting three friends shows three codes in turn. `showNextInvite` is therefore
   * called again after each successful connection rather than once.
   */
  private async showNextInvite(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.qrInvite?.cancel();
    const invite = await createQrInvite(room.host, 'Host');
    this.qrInvite = invite;

    this.qrDisplay.render(buildQr(invite.payload));
    this.lobby.showQr({
      title: 'Show this to your friend',
      instruction: 'They tap “Scan a code” and point their camera at this.',
      canvas: this.qrDisplay.canvas,
      note: 'Then they will show you a code to scan back.',
      next: { label: 'Scan their reply', onClick: () => void this.scanReply() },
    });
    this.lobby.show();
  }

  /** Host: read the joiner's reply code and finish the connection. */
  private async scanReply(): Promise<void> {
    const invite = this.qrInvite;
    if (!invite) return;
    const why = QrScanner.unavailableReason();
    if (why) {
      this.lobby.setStatus({ kind: 'failed', reason: why });
      return;
    }

    this.lobby.showScanner({
      title: 'Scan their reply',
      instruction: 'Point at the code on their screen.',
      video: this.qrScanner.video,
    });
    try {
      await this.qrScanner.start((payload) => {
        void invite
          .accept(payload)
          .then(() => {
            // Straight into showing the next invite, so adding a third player is one tap
            // rather than a trip back through the menu.
            this.showHostQrConnected();
          })
          .catch((e: unknown) => this.lobby.setStatus({ kind: 'failed', reason: describeError(e) }));
      });
    } catch (e) {
      this.lobby.setStatus({ kind: 'failed', reason: describeError(e) });
    }
  }

  private showHostQrConnected(): void {
    this.qrInvite = null;
    this.lobby.showQrHostConnected(this.room?.peerCount ?? 0, this.onlineRoster(), {
      onAnother: () => void this.showNextInvite(),
      onStart: () => this.startHostedMatch(),
    });
    this.lobby.show();
  }

  /** Join by scanning a host's code, then showing a reply. */
  private async joinViaQr(): Promise<void> {
    if (!this.ensureQrSupported()) return;
    const why = QrScanner.unavailableReason();
    if (why) {
      this.lobby.setStatus({ kind: 'failed', reason: why });
      return;
    }
    this.teardownOnline();

    this.lobby.showScanner({
      title: 'Scan the host’s code',
      instruction: 'Point at the code on their screen.',
      video: this.qrScanner.video,
    });
    try {
      await this.qrScanner.start((payload) => void this.afterScanningInvite(payload));
    } catch (e) {
      this.lobby.setStatus({ kind: 'failed', reason: describeError(e) });
    }
  }

  private async afterScanningInvite(payload: Uint8Array): Promise<void> {
    try {
      const reply = await replyToQrInvite(payload);
      this.qrDisplay.render(buildQr(reply.payload));
      this.lobby.showQr({
        title: 'Show this back',
        instruction: `Hold this up for ${reply.hostName} to scan.`,
        canvas: this.qrDisplay.canvas,
        note: 'The match starts on its own once they have scanned it.',
      });
      this.lobby.show();

      // No handshake message says "they scanned it" -- the channels opening is the first
      // evidence, which is what `connect` waits for.
      const client = await reply.connect(this.opts.skinId, 'Player');
      this.guest = { client, close: () => reply.cancel() };
      const session = NetSession.fromClient(client);
      this.session = session;
      this.world = session.world;
      this.netStarted = true;
      this.lobby.hide();
      this.showHint('Connected. Waiting for the host to start.', 5);
    } catch (e) {
      this.failOnline(e);
    }
  }

  private ensureQrSupported(): boolean {
    if (qrSupported()) return true;
    this.lobby.setStatus({
      kind: 'failed',
      reason: 'This browser cannot compress the invite. Try Chrome or a recent Safari.',
    });
    this.lobby.show();
    return false;
  }

  /** Host only: begin the match everybody is waiting in the lobby for. */
  private startHostedMatch(): void {
    if (!this.room || !this.session) return;
    this.room.host.start();
    this.netStarted = true;
    this.lobby.hide();
    this.showHint(getMode(this.pendingModeId).blurb, 5);
  }

  private onlineRoster(): string[] {
    return (this.session?.client.roster ?? []).filter((r) => !r.isBot).map((r) => r.name);
  }

  /**
   * Drop any online session WITHOUT touching which screen is showing.
   *
   * Separate from `leaveOnline` deliberately: starting a host or a join needs to clear
   * whatever came before, but must not navigate -- the lobby is mid-flow and still has
   * something to say.
   */
  private teardownOnline(): void {
    this.qrScanner.stop();
    this.qrInvite?.cancel();
    this.qrInvite = null;
    this.room?.close();
    this.room = null;
    this.guest?.close();
    this.guest = null;
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }

  /** Give up on online play and go back to the picker. */
  private leaveOnline(): void {
    this.teardownOnline();
    this.lobby.hide();
    if (!this.opts.networked) {
      this.world = this.buildMatch(this.currentModeId, this.currentBots);
      this.modeSelect.show();
    }
  }

  /** Re-run the current mode. */
  restart(): void {
    this.startMode(this.currentModeId, this.currentBots);
  }

  openModeSelect(): void {
    this.modeSelect.show();
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
    this.input.dispose();
  }

  private resize(): void {
    this.vp = resizeCanvas(this.opts.canvas);
    updateZoom(this.cam, this.vp);
    this.input.setViewport(this.vp);
  }

  private get me() {
    return this.world.players[LOCAL_PLAYER]!;
  }

  private tick(): void {
    if (this.session) this.pumpSession();
    const me = this.me;

    // Checked before buildFrame, which consumes the key's edge state.
    if (this.input.keyboard.cycleSkinPressed) this.cycleSkin();

    const ballInReach =
      me.heldBall < 0 && findGroundedBallNear(this.world, me.x, me.y, PICKUP_RADIUS) >= 0;

    const frame = this.input.buildFrame(performance.now(), this.lastDtMs, {
      cam: this.cam,
      vp: this.vp,
      playerX: me.x,
      playerY: me.y,
      currentAim: me.aim,
      holdingBall: me.heldBall >= 0,
      ballInReach,
    });
    this.currentInput = frame;

    // Any action ends the results screen. Reusing the existing gesture buttons
    // rather than adding a "play again" control means the tap that would have
    // been a throw restarts instead, which is what a player reaches for anyway.
    if (this.awaitingRestart) {
      if (frame.buttons !== 0 || this.input.keyboard.throwPressed) {
        this.restart();
        return;
      }
    }

    // Bots produce the SAME InputFrame a thumb does and go into the same map, so
    // the simulation has no idea which players are bots.
    const inputs = new Map<number, InputFrame>();
    inputs.set(LOCAL_PLAYER, frame);
    this.inputSeq++;
    for (const b of this.brains) {
      inputs.set(b.playerId, botInput(this.world, b, this.inputSeq));
    }

    const events = this.session
      ? this.session.advance(frame)
      : step(this.world, inputs, { mode: 'authoritative' });

    this.reactToEvents(events);
    this.updateCameraTarget();
    this.renderer.tickDecals(this.terrain);
    this.time += TICK_DT;
  }

  /**
   * Bring a hosted match up once the client has actually joined.
   *
   * Split out of `tick` because it only matters for the first few frames of a hosted
   * match, and burying a one-shot startup condition inside the per-tick path is how
   * it ends up being checked forever.
   */
  private pumpSession(): void {
    const s = this.session!;
    // The client's world object is stable for the session's lifetime, so this is a
    // pointer refresh rather than a copy.
    this.world = s.world;
    if (this.netStarted || !s.readyToStart) return;
    s.start();
    this.netStarted = true;
    snapCamera(this.cam, this.me.x, this.me.y);
  }

  /**
   * Follow a survivor once the local player is out.
   *
   * Staring at your own corpse for the rest of a Last One Standing match is a
   * miserable way to lose, and spectating costs nothing: pick a living player and
   * point the camera at them.
   */
  private updateCameraTarget(): void {
    const me = this.me;
    if (me.alive) {
      this.cameraTarget = LOCAL_PLAYER;
      return;
    }
    const current = this.world.players[this.cameraTarget];
    if (current?.active && current.alive && this.cameraTarget !== LOCAL_PLAYER) return;

    for (const p of this.world.players) {
      if (!p.active || p.isDummy || !p.alive) continue;
      this.cameraTarget = p.id;
      return;
    }
    this.cameraTarget = LOCAL_PLAYER;
  }

  /**
   * Turn simulation events into presentation. Note the direction: the sim emits,
   * the client reacts. Nothing here can influence the simulation, which is what
   * keeps this safe to run on a client that is also receiving authoritative state.
   */
  private reactToEvents(events: readonly { type: number; x: number; y: number; z: number; id: number; other: number; amount: number }[]): void {
    for (const e of events) {
      switch (e.type) {
        case SimEventType.Packed:
          this.particles.burst(e.x, e.y, 12, 10, { speed: 60, up: 50, size: 2.2 });
          // Particles for everyone; instructions only for the person being
          // instructed. Five bots packing snow otherwise keeps a tutorial hint
          // permanently on screen telling you to throw a ball you don't have.
          if (e.id === LOCAL_PLAYER) {
            this.showHint('Flick to throw. Long-press or double-tap to set it down.', 5);
          }
          break;
        case SimEventType.Thrown:
          this.particles.burst(e.x, e.y, e.z, 6, { speed: 40, up: 20, size: 1.8, life: 0.3 });
          break;
        case SimEventType.Hit: {
          const b = this.world.balls[e.id];
          this.particles.impact(e.x, e.y, e.z, b?.vx ?? 1, b?.vy ?? 0);
          this.particles.burst(e.x, e.y, e.z, 10, { speed: 110, up: 90, size: 2.6 });
          break;
        }
        case SimEventType.WallHit:
          this.particles.burst(e.x, e.y, e.z, 12, { speed: 120, up: 60, size: 2.4 });
          break;
        case SimEventType.WallBuilt:
          this.particles.burst(e.x, e.y, 6, 14, { speed: 70, up: 90, size: 2.6 });
          // `id` is the tile; the builder is in `other`.
          if (e.other === LOCAL_PLAYER) {
            this.showHint('Snowballs chip walls down. Chip one low enough and you can throw over it.', 5);
          }
          break;
        case SimEventType.WallDestroyed:
          // A bigger burst, at the height the wall used to stand, so the collapse
          // reads from where the wall was rather than from the ground.
          this.particles.burst(e.x, e.y, e.amount * 0.5, 26, {
            speed: 150,
            up: 130,
            size: 3.1,
            life: 0.7,
          });
          break;
        case SimEventType.Bounced:
          this.particles.burst(e.x, e.y, 2, 5, { speed: 50, up: 40, size: 1.8, life: 0.3 });
          break;
        case SimEventType.Placed:
          this.particles.burst(e.x, e.y, 3, 6, { speed: 40, up: 25, size: 2 });
          break;
        case SimEventType.PickedUp:
          this.particles.burst(e.x, e.y, 8, 5, { speed: 45, up: 40, size: 1.8 });
          break;
        case SimEventType.RoundEnd:
          this.awaitingRestart = true;
          break;
        case SimEventType.FlagTaken:
          this.particles.burst(e.x, e.y, 20, 16, { speed: 90, up: 110, size: 2.8 });
          break;
        case SimEventType.FlagCaptured:
          this.particles.burst(e.x, e.y, 24, 34, { speed: 150, up: 170, size: 3.2, life: 0.9 });
          break;
        case SimEventType.ZoneCaptured:
          this.particles.burst(e.x, e.y, 10, 30, { speed: 160, up: 120, size: 3, life: 0.8 });
          break;
        case SimEventType.Respawned:
          this.particles.burst(e.x, e.y, 10, 12, { speed: 70, up: 80, size: 2.4 });
          break;
        case SimEventType.Melted:
          this.particles.burst(e.x, e.y, 2, 4, { speed: 22, up: 14, size: 1.6, life: 0.7 });
          break;
        default:
          break;
      }
    }
  }

  private render(alpha: number, dtMs: number): void {
    this.lastDtMs = dtMs;
    const dt = dtMs / 1000;
    const me = this.me;

    const camTarget = this.world.players[this.cameraTarget] ?? me;
    followCamera(this.cam, camTarget.x, camTarget.y, dt, this.vp, this.world.bounds);
    this.particles.update(dt);

    const holdingBall = me.heldBall >= 0;
    const aimPower = this.input.previewPower();
    const buildTarget = holdingBall ? buildTargetTile(this.world, me) : -1;

    // Keep the button's hit test in sync with what is actually drawn, so a tap
    // can never land on an invisible button or miss a visible one.
    this.input.buildButtonVisible = holdingBall;
    this.input.bottomInset = this.opts.debug ? DEBUG_PANEL_HEIGHT + 8 : 0;

    this.renderer.render(this.ctx, {
      world: this.world,
      cam: this.cam,
      vp: this.vp,
      terrain: this.terrain,
      alpha,
      time: this.time + alpha * TICK_DT,
      localPlayerId: LOCAL_PLAYER,
      particles: this.particles,
      showAim: holdingBall,
      aimAngle: me.aim,
      aimPower,
      buildTarget,
      debug: this.opts.debug,
    });

    const ballInReach =
      !holdingBall && findGroundedBallNear(this.world, me.x, me.y, PICKUP_RADIUS) >= 0;

    const model: HudModel = {
      vp: this.vp,
      joystick: this.input.joystick,
      gestures: this.input.gestures,
      packProgress: me.packProgress,
      holdingBall,
      ballInReach,
      hp: me.hp,
      maxHp: MAX_HP,
      alive: me.alive,
      skinLabel: getSkin(me.skinId).label,
      fps: this.loop.fps,
      showDebug: this.opts.debug,
      // A tutorial hint left up under the result banner is telling the player to
      // do something the match no longer allows, so hints expire with the match.
      hint:
        this.world.match.phase !== MatchPhase.Ended && performance.now() < this.hintUntil
          ? this.hint
          : '',
      bottomInset: this.input.bottomInset,
      canBuild: buildTarget >= 0,
    };
    drawHud(this.ctx, model);

    // The mode fills a pure-data model; this draws it. No mode writes canvas code.
    this.world.mode.hud(this.world, LOCAL_PLAYER, this.modeHudModel);
    drawModeHud(this.ctx, {
      vp: this.vp,
      model: this.modeHudModel,
      world: this.world,
      viewer: LOCAL_PLAYER,
      top: 14 + safeTop() + 62,
    });

    if (!me.alive && this.cameraTarget !== LOCAL_PLAYER && this.world.match.phase !== MatchPhase.Ended) {
      const watching = this.world.players[this.cameraTarget];
      if (watching) drawSpectatorNotice(this.ctx, this.vp, watching.name);
    }

    if (this.opts.debug) this.drawDebug();

    if (this.opts.netDebug && this.session) {
      const d = this.session.debug;
      this.rates.sample(performance.now(), d.bytesIn, d.bytesOut);
      drawNetDebug(this.ctx, {
        vp: this.vp,
        info: d,
        downPerSec: this.rates.downPerSec,
        upPerSec: this.rates.upPerSec,
        hostTick: this.session.hostTick,
        clientTick: this.session.client.confirmed.tick,
      });
    }
  }

  private drawDebug(): void {
    const ctx = this.ctx;
    const me = this.me;
    const f = this.currentInput;
    const lines = [
      `tick ${this.world.tick}`,
      `action ${ACTION_NAMES[me.action] ?? me.action} (${me.actionTicks})`,
      `pack ${me.packProgress.toFixed(2)} / ${PACK_ROTATIONS_REQUIRED}`,
      `held ${me.heldBall}`,
      `pos ${me.x.toFixed(0)},${me.y.toFixed(0)}  facing ${((me.facing * 180) / Math.PI).toFixed(0)}deg`,
      `input move ${f?.moveX.toFixed(2)},${f?.moveY.toFixed(2)} packDelta ${f?.packDelta.toFixed(3)}`,
      `gesture state ${this.input.gestures.state} turns ${this.input.gestures.circleTurns.toFixed(2)}`,
      `balls ${this.world.balls.filter((b) => b.alive).length} (grounded ${this.world.balls.filter((b) => b.alive && b.state === BallState.Grounded).length})`,
      `walls ${countWalls(this.world.walls)}  buildTarget ${buildTargetTile(this.world, me)}`,
      `mode ${this.world.mode.id} phase ${this.world.match.phase} scores ${this.world.match.teamScores.slice(0, 2).map((n) => Math.floor(n)).join('-')}`,
    ];

    ctx.save();
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    const w = 300;
    const h = DEBUG_PANEL_HEIGHT;
    const x = 10;
    const y = this.vp.height - h - 10;
    ctx.fillStyle = 'rgba(8,16,26,0.72)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#9fd0ff';
    lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 6 + i * 14));
    ctx.restore();
  }

  private showHint(text: string, seconds: number): void {
    this.hint = text;
    this.hintUntil = performance.now() + seconds * 1000;
  }

  /**
   * A read-only snapshot for automated tests.
   *
   * Exposed as a method rather than letting the harness reach into internals and
   * re-derive things like the build target: a test that reimplements the logic it
   * is checking will happily agree with itself while the game is broken.
   */
  debugState(): {
    tick: number;
    wallCount: number;
    buildTarget: number;
    targetHeight: number;
    heldBall: number;
    packProgress: number;
    modeId: string;
    phase: number;
    teamScores: number[];
    myTeam: number;
    alive: number;
    activePlayers: number;
    winnerTeam: number;
    winnerPlayer: number;
    ringRadius: number;
    flagStates: number[];
    zoneOwner: number;
    /** Null when running the direct path. */
    net: {
      joined: boolean;
      localPlayerId: number;
      hostTick: number;
      confirmedTick: number;
      rttMs: number;
      interpDelayMs: number;
      snapCount: number;
      reconcileErrorUnits: number;
      bytesIn: number;
      bytesOut: number;
    } | null;
  } {
    const me = this.me;
    const target = buildTargetTile(this.world, me);
    return {
      tick: this.world.tick,
      wallCount: countWalls(this.world.walls),
      buildTarget: target,
      targetHeight: target >= 0 ? wallHeightAt(this.world.walls, target) : 0,
      heldBall: me.heldBall,
      packProgress: me.packProgress,
      modeId: this.world.mode.id,
      phase: this.world.match.phase,
      teamScores: this.world.match.teamScores.slice(0, 2),
      myTeam: me.team,
      alive: this.world.players.filter((p) => p.active && !p.isDummy && p.alive).length,
      activePlayers: this.world.players.filter((p) => p.active && !p.isDummy).length,
      winnerTeam: this.world.match.winnerTeam,
      winnerPlayer: this.world.match.winnerPlayer,
      ringRadius: this.world.ring.active ? this.world.ring.radius : 0,
      flagStates: this.world.flags.filter((f) => f.active).map((f) => f.state),
      zoneOwner: this.world.zones[0]?.active ? this.world.zones[0].owner : -99,
      net: this.session
        ? {
            joined: this.session.client.joined,
            localPlayerId: this.session.localPlayerId,
            hostTick: this.session.hostTick,
            confirmedTick: this.session.client.confirmed.tick,
            rttMs: this.session.debug.rttMs,
            interpDelayMs: this.session.debug.interpDelayMs,
            snapCount: this.session.debug.snapCount,
            reconcileErrorUnits: this.session.debug.reconcileErrorUnits,
            bytesIn: this.session.debug.bytesIn,
            bytesOut: this.session.debug.bytesOut,
          }
        : null,
    };
  }

  /** Height of the wall tile nearest a world position, for test assertions. */
  wallHeightNear(x: number, y: number): number {
    return wallHeightAt(this.world.walls, tileAtWorld(this.world.walls, x, y));
  }

  /**
   * Total standing wall height across the arena.
   *
   * The right quantity to assert on for "walls can be built and destroyed": tile
   * COUNT misses a build that reinforces an existing wall rather than adding a new
   * one, and a SINGLE tile's height misses a throw that landed one tile over on a
   * multi-tile wall. Both of those produced intermittent test failures against a
   * game that was working correctly.
   */
  wallHeightTotal(): number {
    const g = this.world.walls;
    let total = 0;
    for (let i = 0; i < g.tier.length; i++) {
      if (g.tier[i]! > 0) total += wallHeightAt(g, i);
    }
    return total;
  }

  /** Cycle the local player's skin at runtime -- proves the swap needs no reload. */
  cycleSkin(): string {
    const ids = skinIds();
    this.skinIdx = (this.skinIdx + 1) % ids.length;
    const id = ids[this.skinIdx]!;
    this.me.skinId = id;
    this.showHint(`Skin: ${getSkin(id).label}`, 2.5);
    return id;
  }
}
