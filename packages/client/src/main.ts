import './styles.css';
import { DEFAULT_SKIN_ID, skinIds } from '@snow/shared';
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

  const game = new Game({
    canvas,
    skinId,
    debug: params.has('debug'),
  });
  game.start();

  // Exposed for automated tests and for poking at things from a console.
  (window as unknown as { __snowGame: Game }).__snowGame = game;
}
