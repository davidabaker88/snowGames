/**
 * Dev launcher: starts Vite bound to the LAN and prints a QR code.
 *
 * The QR is not a gimmick. The alternative is reading an IP address aloud and
 * having someone type `http://192.168.1.42:5173` into a phone keyboard, for every
 * player, every time the address changes. Scanning a code from the terminal turns
 * "get four kids onto the game" from a chore into five seconds.
 *
 *   pnpm dev            # dev server, hot reload
 *   pnpm dev -- --port 8080
 */

import { createServer } from 'vite';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-terminal') as {
  generate(text: string, opts: { small: boolean }, cb: (out: string) => void): void;
};

/**
 * Pick the most likely LAN address.
 *
 * Ranked by how likely the range is to be the real home network: 192.168.* first,
 * then 10.*, then the 172.16-31 block. Docker bridges and VPN adapters routinely
 * add extra 172.* addresses that no phone can reach, so guessing well matters
 * more than listing everything -- though we print the alternatives too.
 */
function lanAddresses(): string[] {
  const out: { addr: string; rank: number }[] = [];
  const ifaces = networkInterfaces();

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Link-local: assigned when DHCP failed, never routable to a phone.
      if (a.address.startsWith('169.254.')) continue;

      let rank = 3;
      if (a.address.startsWith('192.168.')) rank = 0;
      else if (a.address.startsWith('10.')) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) rank = 2;

      // Deprioritise virtual adapters, which look valid and are not reachable.
      if (/^(docker|br-|veth|virbr|vmnet|utun|tun|tailscale|zt)/i.test(name)) rank += 10;

      out.push({ addr: a.address, rank });
    }
  }

  out.sort((x, y) => x.rank - y.rank);
  return out.map((o) => o.addr);
}

function parsePort(): number {
  const i = process.argv.indexOf('--port');
  if (i >= 0) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5173;
}

async function main(): Promise<void> {
  const port = parsePort();

  const server = await createServer({
    root: fileURLToPath(new URL('../packages/client', import.meta.url)),
    server: { host: true, port, strictPort: false },
    // Vite prints its own URL block; ours is friendlier, so keep it quiet.
    logLevel: 'warn',
  });
  await server.listen();

  const actualPort = server.config.server.port ?? port;
  const addrs = lanAddresses();
  const primary = addrs[0];
  const url = primary ? `http://${primary}:${actualPort}` : `http://localhost:${actualPort}`;

  const banner = (s: string): void => console.log(s);

  banner('');
  banner('  ⛄  Snowball Fight');
  banner('');
  banner(`  On this machine   http://localhost:${actualPort}`);
  if (primary) {
    banner(`  On your phone     ${url}      <- scan the code below`);
  } else {
    banner('  No LAN address found -- are you connected to WiFi?');
  }
  for (const a of addrs.slice(1)) {
    banner(`  (also            http://${a}:${actualPort} )`);
  }
  banner('');
  banner('  Rig Lab           ?dev=rig        inspect skins and clips');
  banner('  Chicken skin      ?skin=chicken   the swappable-model proof');
  banner('  Debug overlay     ?debug');
  banner('');

  if (primary) {
    await new Promise<void>((resolve) => {
      qrcode.generate(url, { small: true }, (out) => {
        console.log(
          out
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n'),
        );
        resolve();
      });
    });
    banner('');
    banner('  Phones must be on the SAME WiFi. If a phone cannot connect,');
    banner('  the network probably has "AP isolation" or "guest mode" on --');
    banner('  put everything on the main network, not the guest one.');
    banner('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
