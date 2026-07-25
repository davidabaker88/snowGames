/**
 * The Rig Lab: a turntable and clip scrubber for skins.
 *
 * This was built before the second skin existed, and it earned its keep
 * immediately. Inspecting a rig inside the running game means fighting the
 * camera, the input system and gameplay all at once; here a skin can be turned
 * through 360 degrees and a clip scrubbed frame by frame in isolation.
 *
 * It also surfaces DROPPED CLIP TRACKS, which is the fastest way to catch a skin
 * that has silently failed to declare a role -- the animation would otherwise
 * just look subtly lifeless with no error anywhere.
 */

import {
  ALL_CLIPS,
  TAU,
  animatePlayer,
  compileClip,
  compileSkin,
  createAnimSet,
  createSolvedPose,
  createWorld,
  getSkin,
  skinIds,
  solve,
  spawnPlayer,
  ActionState,
  type Player,
} from '@snow/shared';
import { drawCharacter } from '../render/characterRenderer.js';
import { resizeCanvas } from '../loop.js';

interface LabState {
  skinId: string;
  clip: string;
  facing: number;
  phase: number;
  autoTurn: boolean;
  autoPlay: boolean;
  walkSpeed: number;
  grid: boolean;
}

export function startRigLab(canvas: HTMLCanvasElement, initialSkin: string): void {
  const ids = skinIds();
  const state: LabState = {
    skinId: ids.includes(initialSkin) ? initialSkin : ids[0]!,
    clip: 'walk',
    facing: 0.6,
    phase: 0,
    autoTurn: true,
    autoPlay: true,
    walkSpeed: 140,
    grid: true,
  };

  const panel = buildPanel(state, ids);
  document.getElementById('hud')?.appendChild(panel.root);

  // A throwaway world holding one player, purely so the real animator can be
  // driven exactly as it is in game rather than through a parallel code path.
  const world = createWorld(1, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
  const player = spawnPlayer(world, { x: 50, y: 50, skinId: state.skinId })!;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  let vp = resizeCanvas(canvas);
  window.addEventListener('resize', () => {
    vp = resizeCanvas(canvas);
  });

  // Drag anywhere to spin the turntable.
  let dragging = false;
  let lastX = 0;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    state.autoTurn = false;
    panel.syncAutoTurn();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    state.facing += (e.clientX - lastX) * 0.012;
    lastX = e.clientX;
    panel.syncFacing();
  });
  const endDrag = (): void => {
    dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  let last = performance.now();
  let time = 0;

  const frame = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;

    if (state.autoTurn) state.facing += dt * 0.7;
    if (state.autoPlay) state.phase = (state.phase + dt / 0.8) % 1;

    const skin = getSkin(state.skinId);
    const skeleton = compileSkin(skin);
    const anim = createAnimSet(skeleton);
    const solved = createSolvedPose(skeleton);

    poseFor(player, state, skin.id, time);

    const pose = animatePlayer(anim, player, { time, alpha: 0 });
    solve(skeleton, pose, solved);

    // ---- draw --------------------------------------------------------------
    ctx.fillStyle = '#101f30';
    ctx.fillRect(0, 0, vp.width, vp.height);

    // Low on the page, since characters extend upward from their ground origin.
    const cx = vp.width * 0.5;
    const cy = vp.height * 0.82;
    // Much larger than gameplay zoom on purpose -- the whole point of this page is
    // to see individual joints clearly.
    const zoom = Math.min(7, Math.max(2.4, Math.min(vp.width, vp.height) / 95));

    if (state.grid) drawGrid(ctx, cx, cy, zoom, vp);

    // Ground shadow, so height reads correctly.
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cx, cy, skin.shadow.rx * zoom, skin.shadow.ry * zoom, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    drawCharacter(ctx, skeleton, solved, {
      screenX: cx,
      screenY: cy,
      facing: state.facing,
      zoom,
    });

    // Report dropped tracks for the selected clip -- an empty list is the healthy
    // state for a skin with every role, and a long list is a missing role.
    const clipDef = ALL_CLIPS.find((c) => c.name === state.clip);
    const dropped = clipDef ? compileClip(skeleton, clipDef).droppedTargets : [];
    panel.setInfo(
      `facing ${((((state.facing % TAU) + TAU) % TAU) * (180 / Math.PI)).toFixed(0)}deg` +
        ` · phase ${state.phase.toFixed(2)} · bones ${skeleton.bones.length}`,
      dropped,
    );

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Drive the throwaway player into the state the selected clip needs. */
function poseFor(p: Player, state: LabState, skinId: string, time: number): void {
  p.skinId = skinId;
  p.facing = state.facing;
  p.aim = state.facing;
  p.staggerAmount = 0;
  p.alive = true;
  p.heldBall = -1;

  const clipToAction: Record<string, ActionState> = {
    idle: ActionState.Idle,
    walk: ActionState.Walking,
    pack: ActionState.Packing,
    windup: ActionState.WindUp,
    throw: ActionState.Throwing,
    place: ActionState.Placing,
    pickup: ActionState.PickingUp,
    build: ActionState.Building,
    stagger: ActionState.Idle,
    eliminated: ActionState.Eliminated,
  };

  const action = clipToAction[state.clip] ?? ActionState.Idle;
  p.action = action;

  // For timed actions, the animator derives clip time from actionTicks, so the
  // scrubber maps onto that rather than onto a separate clock.
  const durations: Partial<Record<ActionState, number>> = {
    [ActionState.WindUp]: 7,
    [ActionState.Throwing]: 9,
    [ActionState.Placing]: 11,
    [ActionState.PickingUp]: 9,
    [ActionState.Eliminated]: 27,
  };
  const dur = durations[action];
  p.actionTicks = dur ? Math.max(1, Math.round(state.phase * dur)) : Math.round(time * 30);

  // Walking needs real speed and distance for the procedural gait to engage.
  const walking = state.clip === 'walk';
  const speed = walking ? state.walkSpeed : 0;
  p.vx = speed;
  p.vy = 0;
  p.gaitDistance = walking ? state.phase * 86 + time * speed : 0;

  if (state.clip === 'stagger') p.staggerAmount = 1 - state.phase;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  zoom: number,
  vp: { width: number; height: number },
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(120,170,220,0.14)';
  ctx.lineWidth = 1;
  // Horizontal rules every 10 skin units, so limb lengths are readable.
  for (let h = 0; h <= 80; h += 10) {
    const y = cy - h * zoom;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(vp.width, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(120,170,220,0.3)';
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, vp.height);
  ctx.stroke();
  ctx.restore();
}

interface Panel {
  root: HTMLElement;
  setInfo(text: string, dropped: string[]): void;
  syncFacing(): void;
  syncAutoTurn(): void;
}

function buildPanel(state: LabState, ids: string[]): Panel {
  const root = document.createElement('div');
  root.className = 'riglab-panel';

  const title = document.createElement('h1');
  title.textContent = 'Rig Lab';
  root.appendChild(title);

  const skinSel = document.createElement('select');
  for (const id of ids) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = getSkin(id).label;
    skinSel.appendChild(o);
  }
  skinSel.value = state.skinId;
  skinSel.addEventListener('change', () => {
    state.skinId = skinSel.value;
  });
  root.appendChild(labelled('Skin', skinSel));

  const clipSel = document.createElement('select');
  for (const c of ALL_CLIPS) {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.name;
    clipSel.appendChild(o);
  }
  clipSel.value = state.clip;
  clipSel.addEventListener('change', () => {
    state.clip = clipSel.value;
  });
  root.appendChild(labelled('Clip', clipSel));

  const facing = slider(-Math.PI * 2, Math.PI * 2, 0.01, state.facing, (v) => {
    state.facing = v;
    state.autoTurn = false;
    autoTurn.checked = false;
  });
  root.appendChild(labelled('Facing (drag the canvas too)', facing));

  const phase = slider(0, 1, 0.005, state.phase, (v) => {
    state.phase = v;
    state.autoPlay = false;
    autoPlay.checked = false;
  });
  root.appendChild(labelled('Clip phase', phase));

  const speed = slider(0, 220, 1, state.walkSpeed, (v) => {
    state.walkSpeed = v;
  });
  root.appendChild(labelled('Walk speed', speed));

  const autoTurn = checkbox('Auto-turn', state.autoTurn, (v) => (state.autoTurn = v));
  const autoPlay = checkbox('Auto-play clip', state.autoPlay, (v) => (state.autoPlay = v));
  const grid = checkbox('Grid', state.grid, (v) => (state.grid = v));
  root.appendChild(autoTurn.parentElement!);
  root.appendChild(autoPlay.parentElement!);
  root.appendChild(grid.parentElement!);

  const info = document.createElement('div');
  info.className = 'riglab-note';
  root.appendChild(info);

  const dropNote = document.createElement('div');
  dropNote.className = 'riglab-note';
  root.appendChild(dropNote);

  return {
    root,
    setInfo(text, dropped) {
      info.textContent = text;
      dropNote.textContent =
        dropped.length === 0
          ? 'All clip tracks resolved for this skin.'
          : `Dropped tracks (roles this skin does not have): ${dropped.join(', ')}`;
    },
    syncFacing() {
      facing.value = String(state.facing);
    },
    syncAutoTurn() {
      autoTurn.checked = state.autoTurn;
    },
  };
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const l = document.createElement('label');
  l.textContent = text;
  l.appendChild(control);
  return l;
}

function slider(
  min: number,
  max: number,
  stepSize: number,
  value: number,
  onInput: (v: number) => void,
): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'range';
  el.min = String(min);
  el.max = String(max);
  el.step = String(stepSize);
  el.value = String(value);
  el.addEventListener('input', () => onInput(parseFloat(el.value)));
  return el;
}

function checkbox(text: string, value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const wrap = document.createElement('label');
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = value;
  el.addEventListener('change', () => onChange(el.checked));
  wrap.appendChild(el);
  wrap.appendChild(document.createTextNode(' ' + text));
  return el;
}
