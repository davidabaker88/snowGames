/**
 * Two browser pages, one real WebRTC connection, one real match.
 *
 * This is the check that Phase 7 actually happened. Everything else about the netcode
 * was proved over `createLocalPair()`, which is honest about the protocol but says
 * nothing about whether two separate browser contexts can find each other, complete
 * ICE, and carry a game.
 *
 * So: a `GameHost` in page A, a `NetClient` in page B, two genuine
 * `RTCPeerConnection`s, and THIS PROCESS acting as the signalling mailbox -- relaying
 * descriptions between the pages exactly as the Cloudflare Worker will. Nothing is
 * stubbed except the transport for the mailbox itself, which is the one part that is
 * ordinary HTTP.
 *
 * Two pages rather than two peers in one page, deliberately. Same-page peers share a
 * network stack and an mDNS resolver, so they can connect in situations where separate
 * contexts cannot. Separate contexts is the weaker assumption and therefore the one
 * worth testing.
 *
 *   npx tsx tools/verifyWebrtc.ts [--headed]
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HEADED = process.argv.includes('--headed');
const OUT = 'screenshots';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -- ${detail}` : ''}`);
}

/** What each page exposes for the harness to drive. */
interface RtcBridge {
  hostOpen(modeId: string, bots: number): Promise<void>;
  hostAnswer(offer: { type: string; sdp: string }): Promise<{ type: string; sdp: string }>;
  hostState(): { tick: number; conns: number; players: number };
  joinOffer(): Promise<{ type: string; sdp: string }>;
  joinAccept(answer: { type: string; sdp: string }): Promise<void>;
  joinState(): {
    joined: boolean;
    playerId: number;
    confirmedTick: number;
    rttMs: number;
    heldBall: number;
    bytesIn: number;
    bytesOut: number;
    iceState: string;
  };
  pump(ms: number): Promise<void>;
  qrInvitePixels(modeId: string, bots: number): Promise<Pixels>;
  qrReplyPixels(pix: Pixels): Promise<Pixels>;
  qrAcceptReply(pix: Pixels): Promise<void>;
  qrFinishJoin(): Promise<void>;
}

/** A rendered code, as a camera would deliver it. */
interface Pixels {
  data: number[];
  width: number;
  height: number;
}

declare global {
  interface Window {
    __rtc: RtcBridge;
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const server: ViteDevServer = await createServer({
    root: fileURLToPath(new URL('../packages/client', import.meta.url)),
    server: { port: 5201, strictPort: true },
    logLevel: 'error',
  });
  await server.listen();
  const base = 'http://localhost:5201';

  const browser: Browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: !HEADED,
    // Without this, Chrome hides local IPs behind mDNS `.local` candidate hostnames.
    // Two peers in one browser resolve those themselves; two independent contexts in a
    // container generally cannot, and the connection dies in ICE with no useful error.
    // On real devices mDNS resolution usually works, so this is a harness concession --
    // and precisely the thing to re-check on real hardware before trusting LAN play.
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });

  try {
    console.log('=== WebRTC between two browser contexts ===');

    // Separate contexts, so the two ends share nothing: no storage, no page, and as
    // little of the network stack as Chromium will allow.
    const hostCtx = await browser.newContext({ viewport: { width: 900, height: 500 } });
    const joinCtx = await browser.newContext({ viewport: { width: 900, height: 500 } });
    const hostPage = await hostCtx.newPage();
    const joinPage = await joinCtx.newPage();

    const errs: string[] = [];
    for (const [label, pg] of [
      ['host', hostPage],
      ['join', joinPage],
    ] as const) {
      pg.on('pageerror', (e) => errs.push(`${label}: ${String(e)}`));
      pg.on('console', (m) => {
        if (m.type() === 'error') errs.push(`${label}: ${m.text()}`);
      });
    }

    await hostPage.goto(`${base}/?dev=rtc`, { waitUntil: 'networkidle' });
    await joinPage.goto(`${base}/?dev=rtc`, { waitUntil: 'networkidle' });
    await hostPage.waitForFunction(() => '__rtc' in window, { timeout: 15000 });
    await joinPage.waitForFunction(() => '__rtc' in window, { timeout: 15000 });
    check('both pages exposed the WebRTC harness', true);

    // ---- the handshake, with this process as the mailbox --------------------
    await hostPage.evaluate(() => window.__rtc.hostOpen('teamWar', 3));

    const offer = await joinPage.evaluate(() => window.__rtc.joinOffer());
    check(
      'the joiner produced an offer with candidates in it',
      offer.sdp.includes('a=candidate'),
      `${new TextEncoder().encode(offer.sdp).length} bytes, ${
        offer.sdp.split('\n').filter((l) => l.startsWith('a=candidate')).length
      } candidates`,
    );

    const answer = await hostPage.evaluate((o) => window.__rtc.hostAnswer(o), offer);
    check(
      'the host answered',
      answer.sdp.includes('a=candidate'),
      `${new TextEncoder().encode(answer.sdp).length} bytes`,
    );

    await joinPage.evaluate((a) => window.__rtc.joinAccept(a), answer);

    // ---- did it actually connect? ------------------------------------------
    let joined = false;
    for (let i = 0; i < 60 && !joined; i++) {
      await Promise.all([
        hostPage.evaluate(() => window.__rtc.pump(100)),
        joinPage.evaluate(() => window.__rtc.pump(100)),
      ]);
      joined = (await joinPage.evaluate(() => window.__rtc.joinState())).joined;
    }
    const js0 = await joinPage.evaluate(() => window.__rtc.joinState());
    check('the data channels opened and the client joined', joined, `ice ${js0.iceState}`);
    check('the host sees the connection', (await hostPage.evaluate(() => window.__rtc.hostState())).conns === 1);
    check('the joiner was given a player slot', js0.playerId >= 0, `player ${js0.playerId}`);

    // ---- a real match over a real peer connection ---------------------------
    for (let i = 0; i < 40; i++) {
      await Promise.all([
        hostPage.evaluate(() => window.__rtc.pump(100)),
        joinPage.evaluate(() => window.__rtc.pump(100)),
      ]);
    }
    const hs = await hostPage.evaluate(() => window.__rtc.hostState());
    const js = await joinPage.evaluate(() => window.__rtc.joinState());
    check('the host is simulating', hs.tick > 60, `tick ${hs.tick}`);
    check(
      'snapshots are reaching the joiner over WebRTC',
      js.confirmedTick > 40,
      `confirmed ${js.confirmedTick} against host ${hs.tick}`,
    );
    check('bots joined the hosted match', hs.players === 4, `${hs.players} players`);
    check('the round trip is measured over the peer connection', js.rttMs > 0, `${Math.round(js.rttMs)}ms`);
    check(
      'bytes flowed both ways',
      js.bytesIn > 2000 && js.bytesOut > 200,
      `${Math.round(js.bytesIn / 1024)} KB in, ${Math.round(js.bytesOut / 1024)} KB out`,
    );

    await hostPage.screenshot({ path: `${OUT}/22-webrtc-host.png` });
    await joinPage.screenshot({ path: `${OUT}/23-webrtc-joiner.png` });

    check('neither page reported an error', errs.length === 0, errs.slice(0, 3).join(' | '));

    await hostCtx.close();
    await joinCtx.close();

    // ---- the same thing again, with NO signalling server at all -------------
    //
    // This is the path that needs no account, no deploy and no internet: the host renders
    // its offer as a QR code, the joiner's camera reads it, the joiner renders its answer,
    // and the host's camera reads that. Here the "cameras" are this process moving pixel
    // arrays between two pages -- the only part that is stubbed, and the part that is
    // ordinary hardware.
    console.log('\n=== QR signalling, no server ===');
    const qrHostCtx = await browser.newContext({ viewport: { width: 900, height: 500 } });
    const qrJoinCtx = await browser.newContext({ viewport: { width: 900, height: 500 } });
    const qrHost = await qrHostCtx.newPage();
    const qrJoin = await qrJoinCtx.newPage();
    const qrErrs: string[] = [];
    for (const [label, pg] of [
      ['qr-host', qrHost],
      ['qr-join', qrJoin],
    ] as const) {
      pg.on('pageerror', (e) => qrErrs.push(`${label}: ${String(e)}`));
      pg.on('console', (m) => {
        if (m.type() === 'error') qrErrs.push(`${label}: ${m.text()}`);
      });
    }
    await qrHost.goto(`${base}/?dev=rtc`, { waitUntil: 'networkidle' });
    await qrJoin.goto(`${base}/?dev=rtc`, { waitUntil: 'networkidle' });
    await qrHost.waitForFunction(() => '__rtc' in window, { timeout: 15000 });
    await qrJoin.waitForFunction(() => '__rtc' in window, { timeout: 15000 });

    const invitePix = await qrHost.evaluate(() => window.__rtc.qrInvitePixels('teamWar', 2));
    check(
      'the host rendered an invite code',
      invitePix.width > 0 && invitePix.data.length === invitePix.width * invitePix.height * 4,
      `${invitePix.width}x${invitePix.height}px at 2px per module`,
    );

    const replyPix = await qrJoin.evaluate((p) => window.__rtc.qrReplyPixels(p), invitePix);
    check(
      'the joiner read the invite and rendered a reply',
      replyPix.width > 0,
      `${replyPix.width}x${replyPix.height}px`,
    );

    await qrHost.evaluate((p) => window.__rtc.qrAcceptReply(p), replyPix);
    await qrJoin.evaluate(() => window.__rtc.qrFinishJoin());
    check('the host read the reply and the channels opened', true);

    let qrJoined = false;
    for (let i = 0; i < 60 && !qrJoined; i++) {
      await Promise.all([
        qrHost.evaluate(() => window.__rtc.pump(100)),
        qrJoin.evaluate(() => window.__rtc.pump(100)),
      ]);
      qrJoined = (await qrJoin.evaluate(() => window.__rtc.joinState())).joined;
    }
    const qjs0 = await qrJoin.evaluate(() => window.__rtc.joinState());
    check('the client joined with no signalling server', qrJoined, `ice ${qjs0.iceState}`);
    check('the joiner got a player slot', qjs0.playerId === 0, `player ${qjs0.playerId}`);

    for (let i = 0; i < 30; i++) {
      await Promise.all([
        qrHost.evaluate(() => window.__rtc.pump(100)),
        qrJoin.evaluate(() => window.__rtc.pump(100)),
      ]);
    }
    const qhs = await qrHost.evaluate(() => window.__rtc.hostState());
    const qjs = await qrJoin.evaluate(() => window.__rtc.joinState());
    check('a match is running over the QR-negotiated connection', qhs.tick > 60, `tick ${qhs.tick}`);
    check(
      'snapshots are reaching the joiner',
      qjs.confirmedTick > 40,
      `confirmed ${qjs.confirmedTick} against host ${qhs.tick}`,
    );
    check('bots joined', qhs.players === 3, `${qhs.players} players`);
    check('neither QR page reported an error', qrErrs.length === 0, qrErrs.slice(0, 3).join(' | '));

    await qrHost.screenshot({ path: `${OUT}/26-qr-host.png` });
    await qrHostCtx.close();
    await qrJoinCtx.close();
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
