/**
 * Bundle the built client into ONE self-contained HTML file.
 *
 * Used to publish a playtest build that can be opened on a phone with no
 * toolchain, no install and no local server. Everything is inlined because the
 * hosting environment blocks requests to any external host.
 *
 *   npx vite build packages/client --outDir dist-single --sourcemap false
 *   npx tsx tools/bundleSingleFile.ts <output.html>
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const distDir = fileURLToPath(new URL('../packages/client/dist-single/assets', import.meta.url));
const out = process.argv[2];
if (!out) {
  console.error('usage: tsx tools/bundleSingleFile.ts <output.html>');
  process.exit(1);
}

const files = readdirSync(distDir);
const jsName = files.find((f) => f.endsWith('.js'));
const cssName = files.find((f) => f.endsWith('.css'));
if (!jsName || !cssName) {
  console.error(`could not find built js/css in ${distDir}`);
  process.exit(1);
}

const js = readFileSync(join(distDir, jsName), 'utf8');
const css = readFileSync(join(distDir, cssName), 'utf8');

/**
 * A literal `</script` anywhere in the bundle would terminate the inline script
 * tag early. Minified code can contain it inside a string, so escape it.
 */
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const html = `<style>
${css}

/* ---------------------------------------------------------------------------
   Playtest wrapper.

   The palette is lifted from the game itself rather than invented, so the chrome
   and the world read as one thing: the navy is the arena's off-map void, the
   snow-white is its ground, and the single accent is the orange from the
   chicken skin's beak and legs -- spent only on the primary action.

   Deliberately single-theme. The arena is one committed visual world; a light
   variant of it would be a different game.
   --------------------------------------------------------------------------- */

:root {
  --void: #0d1b2a;
  --panel: #16283c;
  --edge: #2c4459;
  --snow: #e9f1fa;
  --slate: #93a8bf;
  --beak: #f2a63b;
}

#start {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  /* The live game keeps running behind this, dimmed -- it reads as a game
     waiting rather than as a loading screen. */
  background: color-mix(in srgb, var(--void) 78%, transparent);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  z-index: 10;
}

#start[hidden] {
  display: none;
}

.card {
  width: min(420px, 100%);
  max-height: 100%;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: 14px;
  padding: 22px 22px 18px;
  color: var(--snow);
  box-shadow: 0 18px 50px rgb(0 0 0 / 0.45);
  animation: rise 0.32s cubic-bezier(0.2, 0.8, 0.3, 1) both;
}

/* Landscape is the orientation the game asks for, and a short wide viewport puts
   the primary action below the fold in a single column. Split into two columns so
   "Start throwing" is always reachable without scrolling. */
@media (min-width: 620px) and (max-height: 560px) {
  .card {
    width: min(700px, 100%);
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      'head moves'
      'go   moves';
    grid-template-rows: auto 1fr;
    align-content: start;
    column-gap: 26px;
    padding: 20px 22px 18px;
  }

  .card > .head { grid-area: head; }
  .card > .moves { grid-area: moves; align-content: start; }
  .card > .go { grid-area: go; align-self: end; }

  /* Telling someone to turn their phone sideways while they are already holding
     it sideways is worse than saying nothing. */
  .card > .rotate { display: none; }
}

@keyframes rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--beak);
  margin: 0 0 6px;
}

.card h1 {
  font-size: clamp(24px, 7vw, 31px);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.05;
  text-wrap: balance;
  margin: 0 0 4px;
}

.lede {
  margin: 0 0 18px;
  color: var(--slate);
  font-size: 13.5px;
  line-height: 1.5;
}

/* Tighten the vertical rhythm on genuinely short screens rather than letting the
   card scroll. */
@media (max-height: 430px) {
  .card h1 { font-size: 26px; }
  .lede { margin-bottom: 12px; font-size: 13px; }
  .moves { gap: 9px; font-size: 13px; }
  .rotate { margin-bottom: 12px; padding: 8px 10px; font-size: 12px; }
  .go { padding: 11px; }
}

/* Gesture list. Grid + gap rather than per-row margins, so nothing collapses
   or doubles up. */
.moves {
  display: grid;
  gap: 11px;
  margin: 0 0 18px;
  padding: 0;
  list-style: none;
  font-size: 13.5px;
  line-height: 1.45;
}

.moves li {
  display: grid;
  grid-template-columns: 74px 1fr;
  gap: 12px;
  align-items: baseline;
}

.moves b {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--beak);
}

.moves span { color: var(--snow); }
.moves em { color: var(--slate); font-style: normal; }

.rotate {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--slate);
  background: color-mix(in srgb, var(--beak) 11%, transparent);
  border-left: 2px solid var(--beak);
  border-radius: 0 7px 7px 0;
  padding: 9px 11px;
  margin: 0 0 18px;
}

button {
  font: inherit;
  cursor: pointer;
}

.go {
  width: 100%;
  padding: 13px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: #2a1c06;
  background: var(--beak);
  border: none;
  border-radius: 9px;
  transition: filter 0.16s ease;
}

.go:hover { filter: brightness(1.07); }
.go:focus-visible { outline: 2px solid var(--snow); outline-offset: 3px; }

/* Persistent controls, top-centre: clear of the HUD (which draws top-left and
   top-right) and clear of both thumbs. */
#tools {
  position: absolute;
  top: calc(env(safe-area-inset-top, 0px) + 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 7px;
  pointer-events: auto;
  z-index: 5;
}

#tools button {
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--snow);
  background: color-mix(in srgb, var(--void) 72%, transparent);
  border: 1px solid var(--edge);
  border-radius: 999px;
  backdrop-filter: blur(3px);
}

#tools button:focus-visible { outline: 2px solid var(--beak); outline-offset: 2px; }
</style>

<div id="app">
  <canvas id="game"></canvas>
  <div id="hud"></div>

  <div id="tools">
    <button id="swap" type="button">Swap model</button>
    <button id="rig" type="button">Rig Lab</button>
  </div>

  <div id="start">
    <div class="card">
      <div class="head">
        <p class="eyebrow">Playtest build</p>
        <h1>Snowball Fight</h1>
        <p class="lede">
          Your left thumb moves. Your right thumb does everything else.
          There are three training dummies to knock over.
        </p>
      </div>

      <ul class="moves">
        <li><b>Circle</b><span>Circle your right thumb to pack a snowball. <em>Two and a half turns.</em></span></li>
        <li><b>Flick</b><span>Throw it. <em>Direction and power both come from the flick.</em></span></li>
        <li><b>Tap</b><span>Pick up a snowball you are standing next to.</span></li>
        <li><b>Hold</b><span>Set the one you are carrying down. <em>Double-tap works too.</em></span></li>
      </ul>

      <p class="rotate">
        <span aria-hidden="true">&#8635;</span>
        <span>Turn your phone sideways. The camera is angled, so a tall screen
        shows a lot of empty ground.</span>
      </p>

      <button class="go" id="go" type="button">Start throwing</button>
    </div>
  </div>
</div>

<script>
  // Runs before the game module, which reads the canvas size on load.
  //
  // The viewport meta has to be set from script here because this page's <head>
  // is not ours to author. Every part of it earns its place on a phone:
  // user-scalable=no stops double-tap zoom fighting the double-tap gesture, and
  // viewport-fit=cover lets the canvas fill past the notch.
  (function () {
    var m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement('meta');
      m.setAttribute('name', 'viewport');
      document.head.appendChild(m);
    }
    m.setAttribute(
      'content',
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
    );

    // Belt and braces against pinch zoom on iOS, which ignores user-scalable
    // in some versions.
    document.addEventListener(
      'touchmove',
      function (e) { if (e.touches.length > 1) e.preventDefault(); },
      { passive: false }
    );
  })();
</script>

<script type="module">
${safeJs}
</script>

<script>
  (function () {
    var start = document.getElementById('start');
    document.getElementById('go').addEventListener('click', function () {
      start.hidden = true;
    });

    // Cycling the skin at runtime is the whole point of the data-driven rig, so
    // give it a button rather than making a phone find the K key.
    document.getElementById('swap').addEventListener('click', function () {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyK' }));
    });

    document.getElementById('rig').addEventListener('click', function () {
      var p = new URLSearchParams(location.search);
      if (p.get('dev') === 'rig') p.delete('dev');
      else p.set('dev', 'rig');
      location.search = p.toString();
    });
  })();
</script>
`;

writeFileSync(out, html, 'utf8');
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} kB)`);
