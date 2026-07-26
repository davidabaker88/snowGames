/**
 * The QR lab: `?dev=qr`.
 *
 * Exists to answer the question the QR path rests on -- does a real WebRTC description
 * actually fit in a code a phone camera can read? -- with measurements rather than
 * estimates. It builds real offers, compresses them, encodes, renders, and decodes the
 * rendered pixels back, reporting sizes and whether the round trip was byte-exact.
 *
 * Kept as a page rather than a one-off script because the answer changes: a browser
 * update that adds a candidate type or a line to the SDP moves the payload size, and
 * this is where that shows up before players find it.
 */

import {
  buildQr,
  decodeQrPayload,
  drawQr,
  encodeQrPayload,
  qrSupported,
  scanQr,
} from '../net/qrCodec.js';

export interface QrMeasurement {
  label: string;
  rawBytes: number;
  compressedBytes: number;
  ratio: number;
  qrVersion: number;
  qrLevel: string;
  qrModules: number;
  /** Smallest module scale, in device pixels, that still decoded. */
  minScale: number;
  /** Canvas pixels needed at the module scale used. */
  renderedPx: number;
  decodedBytes: number;
  byteExact: boolean;
  sdpExact: boolean;
  error?: string;
}

async function measure(label: string, iceServers: RTCIceServer[]): Promise<QrMeasurement> {
  const base: QrMeasurement = {
    label,
    rawBytes: 0,
    compressedBytes: 0,
    ratio: 0,
    qrVersion: 0,
    qrLevel: '',
    qrModules: 0,
    minScale: 0,
    renderedPx: 0,
    decodedBytes: 0,
    byteExact: false,
    sdpExact: false,
  };

  const pc = new RTCPeerConnection({ iceServers });
  try {
    pc.createDataChannel('hot', { ordered: false, maxRetransmits: 0 });
    pc.createDataChannel('cold', { ordered: true });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Same settle-then-go gather the transport uses; see webrtcTransport.ts for why
    // waiting on `complete` is not an option.
    await new Promise<void>((res) => {
      let settle: ReturnType<typeof setTimeout> | undefined;
      const bump = (): void => {
        if (settle) clearTimeout(settle);
        settle = setTimeout(res, 400);
      };
      pc.onicecandidate = (e): void => {
        if (!e.candidate) res();
        else bump();
      };
      bump();
      setTimeout(res, 4000);
    });

    const sdp = pc.localDescription?.sdp ?? '';
    base.rawBytes = new TextEncoder().encode(sdp).length;

    const payload = await encodeQrPayload({ t: 'o', s: sdp, n: 'Host' });
    base.compressedBytes = payload.length;
    base.ratio = base.rawBytes > 0 ? payload.length / base.rawBytes : 0;

    const matrix = buildQr(payload);
    base.qrVersion = matrix.version;
    base.qrLevel = matrix.level;
    base.qrModules = matrix.size;

    // Render at four pixels per module, which is about what a phone shows and near the
    // floor of what a camera can resolve off a screen.
    const total = (matrix.size + 8) * 4;
    base.renderedPx = total;
    const canvas = document.createElement('canvas');
    canvas.width = total;
    canvas.height = total;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, total, total);
    drawQr(ctx, matrix, total);

    const img = ctx.getImageData(0, 0, total, total);
    const decoded = scanQr(img.data, total, total);
    if (!decoded) throw new Error('jsQR could not read the rendered code');
    base.decodedBytes = decoded.length;

    base.byteExact =
      decoded.length === payload.length && decoded.every((b, i) => b === payload[i]);

    const env = await decodeQrPayload(decoded);
    base.sdpExact = env.s === sdp;

    // How small can the modules get and still decode? This is the real margin: a
    // camera reading a code off a screen resolves fewer pixels per module than a
    // pixel-perfect render does, so anything that only works at 4 has no headroom.
    for (let scale = 1; scale <= 6; scale++) {
      const px = (matrix.size + 8) * scale;
      const c2 = document.createElement('canvas');
      c2.width = px;
      c2.height = px;
      const x2 = c2.getContext('2d');
      if (!x2) break;
      x2.fillStyle = '#fff';
      x2.fillRect(0, 0, px, px);
      drawQr(x2, matrix, px);
      const got = scanQr(x2.getImageData(0, 0, px, px).data, px, px);
      if (got && got.length === payload.length) {
        base.minScale = scale;
        break;
      }
    }
    return base;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    return base;
  } finally {
    pc.close();
  }
}

export function startQrLab(canvas: HTMLCanvasElement): void {
  const results: QrMeasurement[] = [];
  let done = false;

  const run = async (): Promise<void> => {
    results.push(await measure('no stun (same WiFi)', []));
    results.push(
      await measure('with stun (across the internet)', [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      ]),
    );
    done = true;
  };
  void run();

  (window as unknown as { __qrLab: { results(): QrMeasurement[]; done(): boolean } }).__qrLab = {
    results: () => results,
    done: () => done,
  };

  const ctx = canvas.getContext('2d');
  const paint = (): void => {
    if (!ctx) return;
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e9f1fa';
    ctx.font = '600 15px ui-monospace, monospace';
    const lines: string[] = ['QR lab', `CompressionStream: ${qrSupported() ? 'yes' : 'NO'}`, ''];
    for (const r of results) {
      lines.push(
        r.error
          ? `${r.label}: ERROR ${r.error}`
          : `${r.label}: ${r.rawBytes}B -> ${r.compressedBytes}B (${(r.ratio * 100).toFixed(0)}%)`,
      );
      if (!r.error) {
        lines.push(
          `   QR v${r.qrVersion}${r.qrLevel} ${r.qrModules}x${r.qrModules}, min scale ${r.minScale}px/module, exact ${r.byteExact && r.sdpExact}`,
        );
      }
    }
    if (!done) lines.push('measuring…');
    lines.forEach((l, i) => ctx.fillText(l, 20, 34 + i * 24));
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
}
