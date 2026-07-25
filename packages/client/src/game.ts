/**
 * Composition root.
 *
 * Wires input -> simulation -> renderer. Note that the simulation is run through
 * the same `step()` the authoritative server will use, driven by the same
 * `InputFrame` a network client will send. When the real netcode lands in a later
 * phase, this file swaps a local step call for a transport and gains prediction --
 * the simulation and renderer do not change.
 */

import {
  ACTION_NAMES,
  BallState,
  DUMMY_HP,
  MAP_ARENA01,
  MAX_HP,
  PACK_ROTATIONS_REQUIRED,
  PICKUP_RADIUS,
  SimEventType,
  TICK_DT,
  applyMap,
  buildTargetTile,
  countWalls,
  createWorld,
  findGroundedBallNear,
  getSkin,
  skinIds,
  spawnPlayer,
  step,
  tileAtWorld,
  wallHeightAt,
  type InputFrame,
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
import type { Camera, Viewport } from './render/projection.js';

const LOCAL_PLAYER = 0;

/** Debug overlay line count * line height + padding. Kept in sync with drawDebug. */
const DEBUG_PANEL_LINES = 9;
const DEBUG_PANEL_HEIGHT = DEBUG_PANEL_LINES * 14 + 12;

export interface GameOptions {
  canvas: HTMLCanvasElement;
  skinId: string;
  debug: boolean;
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

  constructor(private readonly opts: GameOptions) {
    const canvas = opts.canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.world = createWorld(0x51e161, MAP_ARENA01.bounds);
    applyMap(this.world, MAP_ARENA01);

    const ids = skinIds();
    this.skinIdx = Math.max(0, ids.indexOf(opts.skinId));

    const spawn = MAP_ARENA01.spawns[0]!;
    spawnPlayer(this.world, {
      x: spawn.x,
      y: spawn.y,
      name: 'You',
      skinId: opts.skinId,
    });

    // Training dummies wear the OTHER skin, so both rigs are on screen at once
    // and a regression in either is immediately visible.
    const otherSkin = ids.find((s) => s !== opts.skinId) ?? opts.skinId;
    for (const d of MAP_ARENA01.dummies) {
      spawnPlayer(this.world, {
        x: d.x,
        y: d.y,
        isDummy: true,
        hp: DUMMY_HP,
        skinId: otherSkin,
      });
    }

    this.terrain = createTerrain(MAP_ARENA01.bounds, 1);
    this.input = new InputController(canvas);
    this.input.attach();
    installDebugDriver(canvas);

    this.resize();
    snapCamera(this.cam, spawn.x, spawn.y);

    this.loop = new GameLoop({
      tick: () => this.tick(),
      render: (alpha, dtMs) => this.render(alpha, dtMs),
    });

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => this.resize());

    this.showHint('Left thumb to move. Circle with your right thumb to pack a snowball.', 7);
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

    const inputs = new Map([[LOCAL_PLAYER, frame]]);
    const events = step(this.world, inputs, { mode: 'authoritative' });

    this.reactToEvents(events);
    this.renderer.tickDecals(this.terrain);
    this.time += TICK_DT;
  }

  /**
   * Turn simulation events into presentation. Note the direction: the sim emits,
   * the client reacts. Nothing here can influence the simulation, which is what
   * keeps this safe to run on a client that is also receiving authoritative state.
   */
  private reactToEvents(events: readonly { type: number; x: number; y: number; z: number; id: number; amount: number }[]): void {
    for (const e of events) {
      switch (e.type) {
        case SimEventType.Packed:
          this.particles.burst(e.x, e.y, 12, 10, { speed: 60, up: 50, size: 2.2 });
          this.showHint('Flick to throw. Long-press or double-tap to set it down.', 5);
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
          this.showHint('Snowballs chip walls down. Chip one low enough and you can throw over it.', 5);
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

    followCamera(this.cam, me.x, me.y, dt, this.vp, this.world.bounds);
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
      hint: performance.now() < this.hintUntil ? this.hint : '',
      bottomInset: this.input.bottomInset,
      canBuild: buildTarget >= 0,
    };
    drawHud(this.ctx, model);

    if (this.opts.debug) this.drawDebug();
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
