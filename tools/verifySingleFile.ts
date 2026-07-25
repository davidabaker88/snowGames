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

    // The start card hands off to the game's own mode picker. If the two ever get
    // their stacking wrong the picker swallows the taps meant for the card, so
    // assert the handoff rather than assuming it.
    check('the mode picker takes over', await page.isVisible('.mode-select'));
    check(
      'the tool pills are out of the picker\'s way',
      !(await page.isVisible('#tools')),
    );
    await page.screenshot({ path: `${outDir}/single-01b-picker.png` });

    // Practice for the gesture drive: dummies to hit, and no clock or bots to
    // move the world underneath the assertions.
    await page.click('.mode-btn[data-mode="sandbox"]');
    await page.waitForTimeout(300);
    check('picking Practice starts the game', !(await page.isVisible('.mode-select')));

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
    await ctx.close();

    // ---- a competitive mode from the bundle ---------------------------------
    // Practice exercises the gestures but not the mode framework: no teams, no
    // bots, no win condition. Bots are also the most likely thing to be missing
    // from a production bundle that tree-shook something it shouldn't have.
    {
      const c = await browser.newContext({
        viewport: { width: 844, height: 390 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      });
      const p = await c.newPage();
      const errs: string[] = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      p.on('console', (m) => {
        if (m.type() === 'error') errs.push(m.text());
      });
      await p.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });
      await p.waitForTimeout(700);
      await p.click('#go');
      await p.waitForTimeout(150);
      await p.click('.mode-btn[data-mode="teamWar"]');
      await p.waitForTimeout(1600);

      const s = await p.evaluate(() => {
        const g = (window as unknown as { __snowGame: { debugState(): Record<string, unknown> } })
          .__snowGame;
        return g.debugState();
      });
      check(
        'a competitive mode runs from the bundle',
        s['modeId'] === 'teamWar' && (s['activePlayers'] as number) > 1,
        `${String(s['modeId'])}, ${String(s['activePlayers'])} players, my team ${String(s['myTeam'])}`,
      );
      check('bots move on their own', (s['tick'] as number) > 30, `tick ${String(s['tick'])}`);
      check('the competitive mode ran clean', errs.length === 0, errs.slice(0, 3).join(' | '));
      await p.screenshot({ path: `${outDir}/single-06-teamwar.png` });
      await c.close();
    }

    // ---- the start card across real phone sizes ----------------------------
    // The primary action must be reachable WITHOUT scrolling on every one of
    // these. A start card whose button sits below the fold on a small phone is
    // indistinguishable from a broken page to whoever opens it first.
    const sizes = [
      ['portrait 390x844 (iPhone 13)', { width: 390, height: 844 }],
      ['portrait 360x640 (small Android)', { width: 360, height: 640 }],
      ['landscape 844x390', { width: 844, height: 390 }],
      ['landscape 667x375 (small)', { width: 667, height: 375 }],
    ] as const;

    for (const [label, viewport] of sizes) {
      const c = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      });
      const p = await c.newPage();
      const errs: string[] = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'load' });
      await p.waitForTimeout(650);

      const btn = await p.evaluate(() => {
        const el = document.getElementById('go');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });
      const ok =
        btn !== null && btn.bottom <= btn.vh + 1 && btn.top >= -1 && errs.length === 0;
      check(
        `start button reachable without scrolling -- ${label}`,
        ok,
        btn ? `bottom ${btn.bottom.toFixed(0)} of ${btn.vh}` : 'button missing',
      );
      await p.screenshot({
        path: `${outDir}/single-size-${viewport.width}x${viewport.height}.png`,
      });
      await c.close();
    }
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
