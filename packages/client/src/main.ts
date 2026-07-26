import './styles.css';
import { DEFAULT_SKIN_ID, isModeId, skinIds, type ModeId } from '@snow/shared';
import { Game } from './game.js';
import { startRigLab } from './dev/rigLab.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('#game canvas missing');

// `?dev=rig` opens the Rig Lab: a turntable and clip scrubber for inspecting
// skins in isolation. It exists to make the skeletal system debuggable, and it is
// how the chicken skin was validated without engine changes.
if (params.get('dev') === 'rig') {
  startRigLab(canvas, params.get('skin') ?? DEFAULT_SKIN_ID);
} else {
  const requested = params.get('skin') ?? DEFAULT_SKIN_ID;
  const skinId = skinIds().includes(requested) ? requested : DEFAULT_SKIN_ID;

  // `?mode=` skips the picker, which is what the automated tests and a shared link
  // both want. Without it the picker opens.
  const requestedMode = params.get('mode');
  const modeId: ModeId | undefined =
    requestedMode && isModeId(requestedMode) ? requestedMode : undefined;
  const botsParam = Number(params.get('bots'));
  const bots = Number.isFinite(botsParam) && botsParam >= 0 ? Math.min(9, botsParam) : 5;

  // `?net=1` routes play through a real host and net client in this tab;
  // `?netdebug=1` implies it and shows the overlay. `?lat=` and `?loss=` inject
  // link conditions, which is the only way to actually FEEL 150ms rather than read
  // a number about it.
  const netDebug = params.get('netdebug') === '1';
  const networked = netDebug || params.get('net') === '1';
  const lat = Number(params.get('lat'));
  const loss = Number(params.get('loss'));
  const link =
    Number.isFinite(lat) || Number.isFinite(loss)
      ? {
          latencyMs: Number.isFinite(lat) ? Math.max(0, lat) : 0,
          jitterMs: Number.isFinite(lat) ? Math.max(0, lat) * 0.25 : 0,
          lossPct: Number.isFinite(loss) ? Math.max(0, loss) : 0,
        }
      : undefined;

  const game = new Game({
    canvas,
    skinId,
    debug: params.has('debug'),
    modeId,
    bots: modeId === 'sandbox' ? 0 : bots,
    networked,
    netDebug,
    link,
  });
  game.start();

  // Exposed for automated tests and for poking at things from a console.
  (window as unknown as { __snowGame: Game }).__snowGame = game;
}
