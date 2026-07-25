/**
 * Verify the single-file playtest bundle.
 *
 * A self-contained build is exactly where things break silently: an inlined
 * module that fails to parse, a missing DOM hook, a wrapper control wired to
 * nothing. So this loads the real file from disk, taps through the start card,
 * and drives a full pack-and-throw with real PointerEvents.
 *
 *   npx tsx tools/verifySingleFile.ts <file.html> [outDir]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const file = process.argv[2];
const outDir = process.argv[3] ?? 'screenshots-single';
if (!file) {
  console.error('usage: tsx tools/verifySingleFile.ts <file.html> [outDir]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: true,
  });

  try {
    // Landscape phone: the orientation the game asks for.
    const ctx = await browser.newContext({
      viewport: { width: 844, height: 390 },
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

    await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });
    await page.waitForTimeout(700);

    check('start card is shown', await page.isVisible('#start'));
    check('inlined game module booted', await page.evaluate(() => '__snowGame' in window));
    check(
      'viewport meta was injected by the wrapper',
      await page.evaluate(() =>
        (document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '').includes(
          'user-scalable=no',
        ),
      ),
    );
    await page.screenshot({ path: `${outDir}/single-01-start.png` });

    await page.click('#go');
    await page.waitForTimeout(250);
    check('start card dismisses', !(await page.isVisible('#start')));

    // Probe into the running game the same way the main verifier does.
    const probe = async (): Promise<{ tick: number; held: number; skin: string; flight: number }> =>
      page.evaluate(() => {
        const g = (window as unknown as { __snowGame: Record<string, unknown> }).__snowGame;
        const w = g['world'] as { tick: number; players: Record<string, unknown>[]; balls: Record<string, unknown>[] };
        const me = w.players[0] as Record<string, unknown>;
        return {
          tick: w.tick,
          held: me['heldBall'] as number,
          skin: me['skinId'] as string,
          flight: w.balls.filter((b) => b['alive'] && b['state'] === 1).length,
        };
      });

    const t0 = await probe();
    await page.waitForTimeout(400);
    check('game loop is advancing', (await probe()).tick > t0.tick, `tick ${t0.tick} -> ${(await probe()).tick}`);

    // Real gestures through the real recognizer.
    await page.evaluate(() =>
      (window as unknown as { __snowInput: { circle(o: unknown): Promise<void> } }).__snowInput.circle({
        turns: 4,
        radius: 44,
        ms: 1400,
      }),
    );
    await page.waitForTimeout(250);
    check('circling packs a snowball', (await probe()).held >= 0, `held=${(await probe()).held}`);
    await page.screenshot({ path: `${outDir}/single-02-holding.png` });

    await page.evaluate(() =>
      (window as unknown as { __snowInput: { flick(o: unknown): Promise<void> } }).__snowInput.flick({
        dx: 170,
        dy: -25,
        ms: 60,
      }),
    );

    // Poll rather than sampling once. A single snapshot has to land inside the
    // window after the ball leaves the hand but before it lands -- and at high
    // power over a short arena that window is only a few hundred milliseconds,
    // which makes a fixed sleep flaky rather than wrong.
    let sawFlight = false;
    let released = false;
    for (let i = 0; i < 25 && !(sawFlight && released); i++) {
      const s = await probe();
      if (s.flight >= 1) sawFlight = true;
      if (s.held < 0) released = true;
      if (!sawFlight || !released) await page.waitForTimeout(60);
    }
    check('flick throws it', released && sawFlight, `released=${released} sawFlight=${sawFlight}`);
    await page.screenshot({ path: `${outDir}/single-03-thrown.png` });

    // The wrapper's own controls.
    const before = (await probe()).skin;
    await page.click('#swap');
    await page.waitForTimeout(350);
    const after = (await probe()).skin;
    check('the Swap model button works', after !== before, `${before} -> ${after}`);
    await page.screenshot({ path: `${outDir}/single-04-swapped.png` });

    await page.click('#rig');
    await page.waitForTimeout(900);
    check(
      'the Rig Lab button opens the rig lab',
      await page.evaluate(() => document.querySelector('.riglab-panel') !== null),
    );
    await page.screenshot({ path: `${outDir}/single-05-riglab.png` });

    check('no runtime errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
