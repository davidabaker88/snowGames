/**
 * End-to-end verification in a real browser.
 *
 * This drives the actual gesture recognizer through real PointerEvents -- the
 * same path a thumb takes -- rather than poking at internal state. A test that
 * sets `packProgress = 2.5` directly would tell us nothing about whether circling
 * works, which is the single riskiest piece of the project.
 *
 * Run:  npx tsx tools/verify.ts [--headed] [--out DIR]
 */

import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]!
  : 'screenshots';
const HEADED = process.argv.includes('--headed');

interface Probe {
  tick: number;
  action: number;
  actionTicks: number;
  packProgress: number;
  heldBall: number;
  x: number;
  y: number;
  facing: number;
  aliveBalls: number;
  groundedBalls: number;
  flightBalls: number;
  gestureState: number;
  circleTurns: number;
  skinId: string;
  dummyHp: number[];
  /** Camera and viewport, so the harness can aim at a world position on screen. */
  cam: { x: number; y: number; zoom: number };
  vp: { width: number; height: number };
  dummies: { x: number; y: number; hp: number }[];
  wallCount: number;
  buildTarget: number;
  /** Height of the tile the player is aiming at, so shrink can be observed. */
  targetHeight: number;
}

declare global {
  interface Window {
    __probe(): Probe;
  }
}

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => window.__probe());
}

/** Install a reader over the game's internals, for assertions only. */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as unknown as { __snowGame: Record<string, unknown> }).__snowGame;
    window.__probe = (): Probe => {
      const world = g['world'] as {
        tick: number;
        players: Record<string, unknown>[];
        balls: Record<string, unknown>[];
      };
      const input = g['input'] as { gestures: { state: number; circleTurns: number } };
      const cam = g['cam'] as { x: number; y: number; zoom: number };
      const vp = g['vp'] as { width: number; height: number };
      const me = world.players[0] as Record<string, number | string>;
      const alive = world.balls.filter((b) => b['alive']);
      // Wall figures come from the game's own debug surface rather than being
      // re-derived here, so the test cannot quietly agree with itself.
      const ds = (
        g as unknown as {
          debugState(): { wallCount: number; buildTarget: number; targetHeight: number };
        }
      ).debugState();
      return {
        tick: world.tick,
        action: me['action'] as number,
        actionTicks: me['actionTicks'] as number,
        packProgress: me['packProgress'] as number,
        heldBall: me['heldBall'] as number,
        x: me['x'] as number,
        y: me['y'] as number,
        facing: me['facing'] as number,
        aliveBalls: alive.length,
        groundedBalls: alive.filter((b) => b['state'] === 2).length,
        flightBalls: alive.filter((b) => b['state'] === 1).length,
        gestureState: input.gestures.state,
        circleTurns: input.gestures.circleTurns,
        skinId: me['skinId'] as string,
        dummyHp: world.players
          .filter((p) => p['active'] && p['isDummy'])
          .map((p) => p['hp'] as number),
        cam: { x: cam.x, y: cam.y, zoom: cam.zoom },
        vp: { width: vp.width, height: vp.height },
        dummies: world.players
          .filter((p) => p['active'] && p['isDummy'])
          .map((p) => ({ x: p['x'] as number, y: p['y'] as number, hp: p['hp'] as number })),
        wallCount: ds.wallCount,
        buildTarget: ds.buildTarget,
        targetHeight: ds.targetHeight,
      };
    };
  });
}

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const server: ViteDevServer = await createServer({
    root: fileURLToPath(new URL('../packages/client', import.meta.url)),
    server: { port: 5199 },
    logLevel: 'warn',
  });
  await server.listen();
  const base = 'http://localhost:5199';

  const browser: Browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: !HEADED,
  });

  try {
    // A phone-shaped viewport, because that is the primary target.
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    console.log('\n=== Boot ===');
    await page.goto(`${base}/?mode=sandbox&debug`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });
    await installProbe(page);
    await page.waitForTimeout(700);

    let p = await probe(page);
    check('game boots and the loop advances', p.tick > 10, `tick=${p.tick}`);
    check('no console or page errors on boot', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.screenshot({ path: `${OUT}/01-boot.png` });

    console.log('\n=== Movement (virtual joystick) ===');
    const before = { x: p.x, y: p.y };
    await page.evaluate(() => window.__snowInput.move({ dx: 1, dy: 0, ms: 700 }));
    await page.waitForTimeout(120);
    p = await probe(page);
    check(
      'joystick drag moves the player right',
      p.x > before.x + 40,
      `x ${before.x.toFixed(0)} -> ${p.x.toFixed(0)}`,
    );
    await page.screenshot({ path: `${OUT}/02-moved.png` });

    console.log('\n=== Pack a snowball by circling ===');
    // This is the headline mechanic: real circular PointerEvents through the real
    // recognizer, no shortcuts.
    await page.evaluate(() => window.__snowInput.circle({ turns: 4, radius: 50, ms: 1500 }));
    await page.waitForTimeout(200);
    p = await probe(page);
    check(
      'circling registers as circling (gesture state 2)',
      p.circleTurns > 1.5,
      `turns=${p.circleTurns.toFixed(2)}`,
    );
    check('circling produced a held snowball', p.heldBall >= 0, `heldBall=${p.heldBall}`);
    await page.screenshot({ path: `${OUT}/03-holding-ball.png` });

    console.log('\n=== Flick to throw ===');
    await page.evaluate(() => window.__snowInput.flick({ dx: 150, dy: -20, ms: 60 }));
    // The throw is not instant by design: wind-up plus throw is ~330ms, with the
    // ball leaving the hand partway through the throw. Probing sooner than that
    // catches the character mid-animation still holding the ball.
    await page.waitForTimeout(120);
    p = await probe(page);
    check('flick starts the throw animation', p.action === 3 || p.action === 4, `action=${p.action}`);
    await page.waitForTimeout(400);
    p = await probe(page);
    check('flick released the held ball', p.heldBall < 0, `heldBall=${p.heldBall}`);
    check('a ball is now in flight', p.flightBalls >= 1, `inFlight=${p.flightBalls}`);
    await page.screenshot({ path: `${OUT}/04-ball-in-flight.png` });
    await page.waitForTimeout(1200);

    console.log('\n=== Long-press to set a ball down, tap to pick it up ===');
    await page.evaluate(() => window.__snowInput.circle({ turns: 4, radius: 50, ms: 1500 }));
    await page.waitForTimeout(200);
    p = await probe(page);
    const hadBall = p.heldBall >= 0;
    check('packed a second ball', hadBall, `heldBall=${p.heldBall}`);

    const groundedBefore = p.groundedBalls;
    await page.evaluate(() => window.__snowInput.longPress({ ms: 620 }));
    await page.waitForTimeout(500);
    p = await probe(page);
    check('long press put the ball on the ground', p.heldBall < 0 && p.groundedBalls > groundedBefore, `grounded ${groundedBefore} -> ${p.groundedBalls}`);
    await page.screenshot({ path: `${OUT}/05-ball-on-ground.png` });

    await page.evaluate(() => window.__snowInput.tap());
    await page.waitForTimeout(500);
    p = await probe(page);
    check('tap picked the ball back up', p.heldBall >= 0, `heldBall=${p.heldBall}`);
    await page.screenshot({ path: `${OUT}/06-picked-up.png` });

    console.log('\n=== Hitting a dummy ===');
    // Walk up toward the dummies, then throw at them repeatedly.
    const hpBefore = (await probe(page)).dummyHp;
    const Y_SQUASH = 0.6;

    /** Project a world position to screen, matching projection.ts exactly. */
    const toScreen = (s: Probe, wx: number, wy: number): { x: number; y: number } => ({
      x: (wx - s.cam.x) * s.cam.zoom + s.vp.width / 2,
      y: (wy * Y_SQUASH - s.cam.y * Y_SQUASH) * s.cam.zoom + s.vp.height / 2,
    });

    for (let i = 0; i < 14; i++) {
      let s = await probe(page);
      const target = s.dummies[0];
      if (!target) break;

      const dx = target.x - s.x;
      const dy = target.y - s.y;
      const distance = Math.hypot(dx, dy);

      // Close the distance first. A soft throw is flat and hits anything in its
      // path within ~170 units, which makes the test about collision rather than
      // about guessing the right power for a long arc.
      if (distance > 150) {
        // Movement input is screen-relative, so compress the world y component.
        const m = Math.hypot(dx, dy * Y_SQUASH) || 1;
        const mx = dx / m;
        const my = (dy * Y_SQUASH) / m;
        await page.evaluate(
          ([a, b]) => window.__snowInput.move({ dx: a as number, dy: b as number, ms: 420 }),
          [mx, my],
        );
        await page.waitForTimeout(80);
        continue;
      }

      s = await probe(page);
      if (s.heldBall < 0) {
        await page.evaluate(() => window.__snowInput.circle({ turns: 4, radius: 50, ms: 1100 }));
        await page.waitForTimeout(180);
        s = await probe(page);
        if (s.heldBall < 0) continue;
      }

      // Aim precisely at the dummy, then tap Space for a soft flat throw.
      const aimAt = toScreen(s, target.x, target.y);
      await page.mouse.move(aimAt.x, aimAt.y);
      await page.waitForTimeout(60);
      await page.evaluate(() => window.__snowInput.key('Space', 40));
      // Wind-up + throw + flight. Being stingy here produces a false failure.
      await page.waitForTimeout(1100);

      const now = await probe(page);
      if (now.dummyHp.some((hp, k) => hp < (hpBefore[k] ?? 999))) break;
    }
    p = await probe(page);
    check(
      'a thrown snowball damaged a training dummy',
      p.dummyHp.some((hp, k) => hp < (hpBefore[k] ?? 999)),
      `hp ${JSON.stringify(hpBefore)} -> ${JSON.stringify(p.dummyHp)}`,
    );
    await page.screenshot({ path: `${OUT}/07-combat.png` });

    console.log('\n=== Snow walls ===');
    // On a FRESH page, deliberately. The wall assertions depend on precise
    // geometry -- where the player stands relative to one specific wall -- and the
    // earlier tests leave the player somewhere arbitrary, possibly having built a
    // wall of their own right in the firing line. Isolating is cheaper than making
    // every assertion position-independent.
    const wallCtx = await browser.newContext({
      viewport: { width: 844, height: 390 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const wallPage = await wallCtx.newPage();
    const wallErrors: string[] = [];
    wallPage.on('pageerror', (e) => wallErrors.push(String(e)));
    await wallPage.goto(`${base}/?mode=sandbox&debug`, { waitUntil: 'networkidle' });
    await wallPage.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });
    await installProbe(wallPage);
    await wallPage.waitForTimeout(600);

    let wp = await probe(wallPage);
    check('the map starts with pre-built walls', wp.wallCount > 0, `${wp.wallCount} tiles`);

    /** Total standing wall height across the arena, straight from the game. */
    const totalWallHeight = async (): Promise<number> =>
      wallPage.evaluate(() =>
        (
          window as unknown as { __snowGame: { wallHeightTotal(): number } }
        ).__snowGame.wallHeightTotal(),
      );

    /** Height of the wall tile at a world position, straight from the game. */
    const heightAt = async (x: number, y: number): Promise<number> =>
      wallPage.evaluate(
        ([a, b]) =>
          (
            window as unknown as { __snowGame: { wallHeightNear(p: number, q: number): number } }
          ).__snowGame.wallHeightNear(a as number, b as number),
        [x, y],
      );

    /** Walk to a world position using the joystick, then stop. */
    const walkTo = async (tx: number, ty: number, tolerance = 34): Promise<boolean> => {
      for (let i = 0; i < 18; i++) {
        const s = await probe(wallPage);
        if (Math.hypot(tx - s.x, ty - s.y) <= tolerance) return true;
        const dx = tx - s.x;
        const dy = ty - s.y;
        // Movement input is screen-relative, so compress the world y component.
        const m = Math.hypot(dx, dy * Y_SQUASH) || 1;
        await wallPage.evaluate(
          ([a, b]) => window.__snowInput.move({ dx: a as number, dy: b as number, ms: 360 }),
          [dx / m, (dy * Y_SQUASH) / m],
        );
        await wallPage.waitForTimeout(70);
      }
      return false;
    };

    /** Pack a snowball by circling, returning true once one is in hand. */
    const packBall = async (): Promise<boolean> => {
      for (let i = 0; i < 3; i++) {
        if ((await probe(wallPage)).heldBall >= 0) return true;
        await wallPage.evaluate(() => window.__snowInput.circle({ turns: 4, radius: 44, ms: 1200 }));
        await wallPage.waitForTimeout(220);
      }
      return (await probe(wallPage)).heldBall >= 0;
    };

    // ---- destroy -----------------------------------------------------------
    // Target the full-height wall below the spawn.
    //
    // Range matters, and not monotonically: a ball leaves the hand at height 40,
    // arcs ABOVE the wall's 48, and comes back down, so there is a mid-range band
    // where a throw sails clean over the wall, with connecting zones at point
    // blank and beyond. That is the mechanic working, not a bug.
    //
    // So rather than encode one magic standoff -- which is fragile, and broke
    // twice while tuning -- try successive distances until one connects. That is
    // what a player does, and it survives future changes to the throw arc.
    const wallX = 224;
    const wallY = 630;

    const totalBefore = await totalWallHeight();
    const wallBefore = await heightAt(wallX, wallY);
    check('the target wall has a height to lose', wallBefore > 0, `${wallBefore.toFixed(1)} units`);

    let shrunk = false;
    let reached = false;
    for (const standoff of [170, 130, 210, 95, 250]) {
      if (shrunk) break;
      const arrived = await walkTo(wallX, wallY - standoff, 22);
      reached = reached || arrived;
      if (!arrived) continue;

      for (let shot = 0; shot < 3 && !shrunk; shot++) {
        if (!(await packBall())) break;
        await walkTo(wallX, wallY - standoff, 26);

        const s = await probe(wallPage);
        const aim = {
          x: (wallX - s.cam.x) * s.cam.zoom + s.vp.width / 2,
          y: (wallY * Y_SQUASH - s.cam.y * Y_SQUASH) * s.cam.zoom + s.vp.height / 2,
        };
        await wallPage.mouse.move(aim.x, aim.y);
        await wallPage.waitForTimeout(70);
        // Shortest possible press, for the flattest arc.
        await wallPage.evaluate(() => window.__snowInput.key('Space', 10));
        await wallPage.waitForTimeout(1000);

        // Measured across the WHOLE wall, because the aim drifts by a tile or two
        // and the throw legitimately lands on a neighbouring tile of the same wall.
        const now = await totalWallHeight();
        if (process.env['VERBOSE']) {
          console.log(
            `      standoff ${standoff} shot ${shot}: at y=${s.y.toFixed(0)} total ${now.toFixed(1)}`,
          );
        }
        if (now < totalBefore - 0.5) shrunk = true;
      }
    }

    check('walked to a throwing standoff', reached);
    const totalAfter = await totalWallHeight();
    check(
      'snowballs chip walls down, shrinking them',
      shrunk,
      `total height ${totalBefore.toFixed(1)} -> ${totalAfter.toFixed(1)} units`,
    );
    await wallPage.screenshot({ path: `${OUT}/15-wall-damaged.png` });

    // ---- build -------------------------------------------------------------
    // The map ships with walls, so a RISING count is what proves building works
    // rather than merely proving walls exist.
    const buildTotalBefore = await totalWallHeight();
    const wallCountBefore = (await probe(wallPage)).wallCount;
    let built = false;
    for (let i = 0; i < 12 && !built; i++) {
      if (!(await packBall())) continue;

      // Aim by moving the MOUSE, not by nudging the stick. Once a mouse has moved,
      // aim follows the cursor, so joystick nudges change where the player stands
      // but not where they are pointing -- which made this loop flaky.
      let s = await probe(wallPage);
      const aimAt = {
        x: (500 - s.cam.x) * s.cam.zoom + s.vp.width / 2,
        y: (400 * Y_SQUASH - s.cam.y * Y_SQUASH) * s.cam.zoom + s.vp.height / 2,
      };
      await wallPage.mouse.move(aimAt.x, aimAt.y);
      await wallPage.waitForTimeout(90);

      s = await probe(wallPage);
      if (s.buildTarget < 0) {
        // Aiming at open ground still gave nothing buildable; shift position.
        await wallPage.evaluate(() => window.__snowInput.move({ dx: 0.5, dy: -0.85, ms: 240 }));
        await wallPage.waitForTimeout(120);
        continue;
      }
      await wallPage.evaluate(() => window.__snowInput.key('KeyB', 60));
      await wallPage.waitForTimeout(1200);
      const post = await probe(wallPage);
      if (process.env['VERBOSE'])
        console.log(
          `      build try ${i}: target=${s.buildTarget} action=${s.action} held=${s.heldBall} -> action=${post.action} held=${post.heldBall} walls=${post.wallCount}`,
        );
      // Total height rather than tile count: building onto an existing wall
      // reinforces it and raises no count at all.
      if ((await totalWallHeight()) > buildTotalBefore + 0.5) built = true;
    }

    wp = await probe(wallPage);
    const buildTotalAfter = await totalWallHeight();
    check(
      'building adds wall',
      built,
      `total height ${buildTotalBefore.toFixed(1)} -> ${buildTotalAfter.toFixed(1)} units, ${wallCountBefore} -> ${wp.wallCount} tiles`,
    );
    check('building consumed the snowball', wp.heldBall < 0, `heldBall=${wp.heldBall}`);
    check('walls produced no runtime errors', wallErrors.length === 0, wallErrors.slice(0, 2).join(' | '));
    await wallPage.screenshot({ path: `${OUT}/16-wall-built.png` });
    await wallCtx.close();

    console.log('\n=== Game modes ===');
    const modeCtx = await browser.newContext({
      viewport: { width: 844, height: 390 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });

    interface ModeProbe {
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
      tick: number;
    }

    const modeState = async (pg: Page): Promise<ModeProbe> =>
      pg.evaluate(
        () =>
          (
            window as unknown as { __snowGame: { debugState(): ModeProbe } }
          ).__snowGame.debugState() as ModeProbe,
      );

    // The picker appears when no mode is given in the URL.
    const pickerPage = await modeCtx.newPage();
    await pickerPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await pickerPage.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });
    await pickerPage.waitForTimeout(400);
    const buttons = await pickerPage.locator('.mode-btn').count();
    check('the mode picker lists every mode', buttons === 6, `${buttons} buttons`);

    // Every choice must be on screen at once on a landscape phone. The card can
    // scroll, and that is the trap: it scrolls silently, so a mode below the fold
    // reads as a mode that does not exist. Measured rather than eyeballed because
    // this regresses whenever a blurb gains a line.
    const fit = await pickerPage.evaluate(() => {
      const els = [
        ...document.querySelectorAll('.mode-btn'),
        ...document.querySelectorAll('.mode-bots'),
      ];
      let worst = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        worst = Math.max(worst, r.bottom);
      }
      return { worst, vh: window.innerHeight, n: els.length };
    });
    check(
      'every mode and the bot slider fit on a landscape phone',
      fit.worst <= fit.vh + 1,
      `lowest edge ${fit.worst.toFixed(0)} of ${fit.vh} (${fit.n} elements)`,
    );
    await pickerPage.screenshot({ path: `${OUT}/17-mode-picker.png` });

    // Picking from the picker actually starts that mode.
    await pickerPage.locator('.mode-btn', { hasText: 'Capture the Flag' }).click();
    await pickerPage.waitForTimeout(700);
    const picked = await modeState(pickerPage);
    check('picking a mode starts it', picked.modeId === 'captureTheFlag', picked.modeId);
    check('the picker closes on pick', !(await pickerPage.isVisible('.mode-select')));
    await pickerPage.close();

    // Each mode boots, fills its slots with bots, and runs.
    for (const mode of [
      'lastOneStanding',
      'teamWar',
      'captureTheFlag',
      'kingOfTheHill',
      'fortDefense',
    ]) {
      const pg = await modeCtx.newPage();
      const errs: string[] = [];
      pg.on('pageerror', (e) => errs.push(String(e)));
      pg.on('console', (m) => {
        if (m.type() === 'error') errs.push(m.text());
      });
      await pg.goto(`${base}/?mode=${mode}&bots=5&debug`, { waitUntil: 'networkidle' });
      await pg.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });
      await pg.waitForTimeout(2500);

      const s = await modeState(pg);
      check(`${mode}: boots with bots`, s.modeId === mode && s.activePlayers === 6, `${s.modeId}, ${s.activePlayers} players`);
      check(`${mode}: no runtime errors`, errs.length === 0, errs.slice(0, 2).join(' | '));

      // Mode-specific objective state is actually live.
      if (mode === 'teamWar' || mode === 'captureTheFlag') {
        check(`${mode}: assigns teams`, s.myTeam === 0 || s.myTeam === 1, `team ${s.myTeam}`);
      }
      if (mode === 'captureTheFlag') {
        check(`${mode}: both flags are in play`, s.flagStates.length === 2, JSON.stringify(s.flagStates));
      }
      if (mode === 'lastOneStanding') {
        check(`${mode}: the blizzard exists`, s.ringRadius > 0, `radius ${s.ringRadius.toFixed(0)}`);
      }
      if (mode === 'kingOfTheHill' || mode === 'fortDefense') {
        check(`${mode}: the zone is active`, s.zoneOwner !== -99, `owner ${s.zoneOwner}`);
      }

      await pg.screenshot({ path: `${OUT}/18-mode-${mode}.png` });
      await pg.close();
    }

    // A short match, played out by bots, must reach a winner in the browser too.
    const finishPage = await modeCtx.newPage();
    const finishErrs: string[] = [];
    finishPage.on('pageerror', (e) => finishErrs.push(String(e)));
    await finishPage.goto(`${base}/?mode=lastOneStanding&bots=3&debug`, {
      waitUntil: 'networkidle',
    });
    await finishPage.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });

    // Bots fight it out. Poll rather than sleeping a fixed time.
    let finished = false;
    for (let i = 0; i < 60 && !finished; i++) {
      await finishPage.waitForTimeout(1000);
      const s = await modeState(finishPage);
      if (s.phase === 2) finished = true;
    }
    const finalState = await modeState(finishPage);
    check(
      'a bot match plays through to a winner in the browser',
      finished,
      `phase ${finalState.phase}, ${finalState.alive} alive after ${finalState.tick} ticks`,
    );
    check('the finished match had no errors', finishErrs.length === 0, finishErrs.slice(0, 2).join(' | '));
    await finishPage.screenshot({ path: `${OUT}/19-match-result.png` });
    await finishPage.close();
    await modeCtx.close();

    console.log('\n=== The swappable-skin promise ===');
    await page.evaluate(() => window.__snowInput.key('KeyK', 60));
    await page.waitForTimeout(400);
    const swapped = await probe(page);
    check(
      'skin swaps at runtime with no reload',
      swapped.skinId !== p.skinId,
      `${p.skinId} -> ${swapped.skinId}`,
    );
    await page.screenshot({ path: `${OUT}/08-skin-swapped.png` });

    // And loading the chicken directly from a URL.
    const page2 = await ctx.newPage();
    const errors2: string[] = [];
    page2.on('pageerror', (e) => errors2.push(String(e)));
    await page2.goto(`${base}/?mode=sandbox&skin=chicken&debug`, { waitUntil: 'networkidle' });
    await page2.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });
    await installProbe(page2);
    await page2.waitForTimeout(600);
    const chick = await probe(page2);
    check('chicken skin loads from ?skin=chicken', chick.skinId === 'chicken', chick.skinId);
    check('chicken skin renders without errors', errors2.length === 0, errors2.slice(0, 2).join(' | '));
    await page2.evaluate(() => window.__snowInput.move({ dx: 1, dy: 0.3, ms: 900 }));
    await page2.waitForTimeout(150);
    await page2.screenshot({ path: `${OUT}/09-chicken-walking.png` });
    await page2.close();

    console.log('\n=== Rig Lab ===');
    const page3 = await ctx.newPage();
    const errors3: string[] = [];
    page3.on('pageerror', (e) => errors3.push(String(e)));
    await page3.goto(`${base}/?dev=rig&skin=chicken`, { waitUntil: 'networkidle' });
    await page3.waitForTimeout(900);
    check('rig lab opens without errors', errors3.length === 0, errors3.slice(0, 2).join(' | '));
    await page3.screenshot({ path: `${OUT}/10-riglab-chicken.png` });
    await page3.goto(`${base}/?dev=rig&skin=stick`, { waitUntil: 'networkidle' });
    await page3.waitForTimeout(900);
    await page3.screenshot({ path: `${OUT}/11-riglab-stick.png` });
    await page3.close();

    console.log('\n=== Landscape phone (the intended play orientation) ===');
    const landCtx = await browser.newContext({
      viewport: { width: 844, height: 390 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const pageL = await landCtx.newPage();
    const errorsL: string[] = [];
    pageL.on('pageerror', (e) => errorsL.push(String(e)));
    await pageL.goto(`${base}/?mode=sandbox&debug`, { waitUntil: 'networkidle' });
    await pageL.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });
    await installProbe(pageL);
    await pageL.waitForTimeout(500);

    // Pack and hold a ball so the screenshot shows the aim preview and HUD rings.
    await pageL.evaluate(() => window.__snowInput.circle({ turns: 4, radius: 44, ms: 1400 }));
    await pageL.waitForTimeout(250);
    const lp = await probe(pageL);
    check('landscape: circling packs a ball', lp.heldBall >= 0, `heldBall=${lp.heldBall}`);
    await pageL.screenshot({ path: `${OUT}/13-landscape.png` });

    // Screenshot mid-circle, to capture the pack progress ring while the gesture
    // is still in flight. The catch matters: this promise is deliberately not
    // awaited, so it would otherwise reject as an unhandled rejection when the
    // context closes underneath it.
    const midCircle = pageL
      .evaluate(() => window.__snowInput.circle({ turns: 6, radius: 44, ms: 2200 }))
      .catch(() => undefined);
    await pageL.waitForTimeout(700);
    await pageL.screenshot({ path: `${OUT}/14-landscape-packing.png` });
    await midCircle;
    check('landscape: no runtime errors', errorsL.length === 0, errorsL.slice(0, 2).join(' | '));
    await landCtx.close();

    console.log('\n=== Desktop viewport ===');
    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page4 = await deskCtx.newPage();
    const errors4: string[] = [];
    page4.on('pageerror', (e) => errors4.push(String(e)));
    await page4.goto(`${base}/?mode=sandbox&debug`, { waitUntil: 'networkidle' });
    await page4.waitForFunction(() => '__snowGame' in window, { timeout: 15000 });
    await page4.waitForTimeout
      ? await page4.waitForTimeout(600)
      : undefined;
    check('desktop viewport runs clean', errors4.length === 0, errors4.slice(0, 2).join(' | '));
    await page4.screenshot({ path: `${OUT}/12-desktop.png` });
    await deskCtx.close();

    console.log('\n=== Errors accumulated during play ===');
    check('no runtime errors across the whole session', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log(`Screenshots in ${OUT}/`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
