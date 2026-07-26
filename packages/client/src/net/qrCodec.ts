/**
 * Signalling through a QR code.
 *
 * The point of this path: **no server, no account, no internet.** Two phones on the
 * same WiFi -- or no WiFi at all, just two phones next to each other -- can connect by
 * showing each other codes. Nothing is deployed and nothing is signed up for.
 *
 * The reason it is possible at all is that a WebRTC description is small. Measured on
 * this project: about 560 bytes with no STUN servers, a little over a kilobyte with
 * them. Deflate takes a large bite out of that, because SDP is extremely repetitive
 * text, and QR byte mode carries the result with no base64 expansion. What is left fits
 * in a code a phone camera can read off another phone's screen.
 *
 * Measured, end to end: a 587-byte description deflates to 455 and lands in a 73x73
 * code -- ordinary density, about what a WiFi-sharing code looks like.
 *
 * Three decisions:
 *
 * **Byte mode with a latin1 string, not base64.** Base64 costs 33% before the QR even
 * starts, which at this size is the difference between a comfortable code and one that
 * needs a steady hand.
 *
 * **Error correction is chosen per payload, not fixed.** These codes are read off a
 * glossy screen, at an angle, possibly with a reflection, so damage recovery is worth
 * paying for -- but only up to the point where the extra recovery data makes the code
 * so dense that reading it is the problem. So: prefer M, and drop to L if M would push
 * past the density a phone camera handles comfortably.
 *
 * **Compression, not SDP reconstruction.** Stripping the description to its essential
 * fields -- ufrag, password, fingerprint, candidates -- and rebuilding the boilerplate on
 * the far side gets the payload to roughly 85 bytes and a much friendlier code. It was
 * measured and rejected: reconstructing SDP encodes assumptions about what each browser
 * emits, and those assumptions can only be tested against the one engine available here.
 * A Chrome-to-Safari mismatch would present as "joining silently never works" on half
 * the phones this path exists for. Deflate is engine-agnostic, and 73x73 is good enough.
 */

import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import type { SessionDescription } from '@snow/shared';

/**
 * What travels in the code.
 *
 * Single-letter keys, because at this size the JSON key names are a measurable
 * fraction of the payload and deflate cannot fully undo that.
 */
export interface QrEnvelope {
  /** `o` for an offer, `a` for an answer. */
  t: 'o' | 'a';
  /** The session description. */
  s: string;
  /** Display name, offers only. */
  n?: string;
}

/**
 * Above this version, recovery data is costing more in density than it returns in
 * robustness, so a smaller code with less redundancy is the better trade.
 */
const DENSITY_BUDGET_VERSION = 14;
/** Nothing this project sends has ever fitted below version 6; skip the attempts. */
const MIN_VERSION = 6;
const MAX_VERSION = 40;

export class QrCodecError extends Error {}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * `deflate-raw` rather than `gzip`: gzip adds an 18-byte header and trailer that buy
 * nothing here, since both ends already agree on the format.
 */
async function deflate(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(text));
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // A fresh copy, so the view handed in is backed by a plain ArrayBuffer. TypeScript
  // models a Uint8Array as possibly SharedArrayBuffer-backed, which is not a valid
  // stream source.
  void writer.write(new Uint8Array(bytes).slice());
  void writer.close();
  return new Response(ds.readable).text();
}

/** True when this browser can do QR signalling at all. */
export function qrSupported(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export async function encodeQrPayload(env: QrEnvelope): Promise<Uint8Array> {
  return deflate(JSON.stringify(env));
}

export async function decodeQrPayload(bytes: Uint8Array): Promise<QrEnvelope> {
  let text: string;
  try {
    text = await inflate(bytes);
  } catch {
    // A partial or misread scan lands here far more often than a corrupt one, so this
    // is a normal outcome rather than an error worth surfacing loudly.
    throw new QrCodecError('that code did not decode -- try again');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new QrCodecError('that code is not a snowball invite');
  }
  const env = parsed as Partial<QrEnvelope>;
  if ((env.t !== 'o' && env.t !== 'a') || typeof env.s !== 'string' || !env.s) {
    throw new QrCodecError('that code is not a snowball invite');
  }
  return { t: env.t, s: env.s, ...(typeof env.n === 'string' ? { n: env.n } : {}) };
}

export function envelopeToDescription(env: QrEnvelope): SessionDescription {
  return { type: env.t === 'o' ? 'offer' : 'answer', sdp: env.s };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  size: number;
  /** QR version actually used, for diagnostics. */
  version: number;
  /** Error correction level actually used. */
  level: 'L' | 'M';
  isDark(row: number, col: number): boolean;
}

/**
 * Build the smallest matrix that holds the payload.
 *
 * The library throws when data does not fit rather than reporting capacity, so the
 * search is try-and-catch.
 */
export function buildQr(bytes: Uint8Array): QrMatrix {
  let latin = '';
  for (const b of bytes) latin += String.fromCharCode(b);

  // Prefer M. If the payload only fits at a version dense enough to be awkward to
  // scan, take L instead and get a smaller grid -- a code that reads first time beats
  // a code with more redundancy that the camera struggles to resolve at all.
  const best = tryLevel(latin, 'M');
  if (best && best.version <= DENSITY_BUDGET_VERSION) return best;
  const lighter = tryLevel(latin, 'L');
  if (lighter && (!best || lighter.version < best.version)) return lighter;
  if (best) return best;
  throw new QrCodecError('too much data for one QR code');
}

function tryLevel(latin: string, level: 'L' | 'M'): QrMatrix | null {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    try {
      // The library types the version as a closed union of literals; the loop counter
      // has to be asserted into it.
      const qr = qrcode(v as 6, level);
      qr.addData(latin, 'Byte');
      qr.make();
      return {
        size: qr.getModuleCount(),
        version: v,
        level,
        isDark: (row, col) => qr.isDark(row, col),
      };
    } catch {
      // Too small for this level. Next version.
    }
  }
  return null;
}

/**
 * Draw a matrix filling a square canvas.
 *
 * Module size is rounded DOWN to a whole number of pixels and the result is centred.
 * Fractional module widths are the main reason a rendered code fails to scan: the
 * renderer anti-aliases module edges, and a decoder sampling the middle of a module
 * finds a grey pixel where it needs a decision.
 */
export function drawQr(ctx: CanvasRenderingContext2D, m: QrMatrix, cssSize: number): void {
  const quiet = 4;
  const total = m.size + quiet * 2;
  const scale = Math.max(1, Math.floor(cssSize / total));
  const drawn = total * scale;
  const offset = Math.floor((cssSize - drawn) / 2);

  // A white field including the quiet zone. Without the margin, decoders cannot find
  // the finder patterns at all.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(offset, offset, drawn, drawn);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.isDark(r, c)) continue;
      ctx.fillRect(
        offset + (c + quiet) * scale,
        offset + (r + quiet) * scale,
        scale,
        scale,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Look for a code in one frame of pixels.
 *
 * `jsQR` rather than the platform `BarcodeDetector`, deliberately: `BarcodeDetector` is
 * unavailable on iOS Safari, which would leave the no-server path working on exactly
 * half the phones likely to use it. jsQR does its own image processing and behaves the
 * same everywhere.
 *
 * `dontInvert` because we are scanning a phone screen showing dark-on-light. Letting
 * the decoder also try inverted doubles the work per frame for a case that cannot occur.
 */
export function scanQr(data: Uint8ClampedArray, width: number, height: number): Uint8Array | null {
  const found = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  if (!found) return null;
  // `binaryData` rather than `data`: the payload is compressed bytes, and the string
  // form would have mangled anything that is not valid text.
  return new Uint8Array(found.binaryData);
}
