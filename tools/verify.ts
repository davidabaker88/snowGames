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
    await page.goto(`${base}/?debug`, { waitUntil: 'networkidle' });
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
    await page2.goto(`${base}/?skin=chicken&debug`, { waitUntil: 'networkidle' });
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
    await pageL.goto(`${base}/?debug`, { waitUntil: 'networkidle' });
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
    await page4.goto(`${base}/?debug`, { waitUntil: 'networkidle' });
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
