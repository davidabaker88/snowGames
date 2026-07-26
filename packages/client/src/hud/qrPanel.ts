/**
 * Showing a code, and scanning one.
 *
 * Both halves of the QR handshake, as DOM: a canvas for the code we display and a video
 * plus a hidden canvas for the code we read.
 *
 * ## The secure-context trap
 *
 * `getUserMedia` requires a secure context. That has a specific and important
 * consequence for this path:
 *
 *   - Opening the downloaded HTML file (`file://`) works -- browsers treat file URLs as
 *     potentially trustworthy.
 *   - `https://` works.
 *   - **`http://192.168.x.x` does NOT.** A LAN dev server cannot use the camera.
 *
 * So the no-server path wants the downloaded file, not the dev server, and the failure is
 * reported explicitly rather than presenting as a camera that never turns on.
 *
 * ## Frames
 *
 * The scanner pulls frames on `requestAnimationFrame` and downsamples to a fixed working
 * width. Full-resolution frames from a modern phone camera are several megapixels, and
 * decoding one takes long enough to drop the frame rate into a slideshow -- which makes
 * aiming the camera harder, so the higher resolution actively costs accuracy.
 */

import { scanQr, type QrMatrix } from '../net/qrCodec.js';
import { drawQr } from '../net/qrCodec.js';

/** Working width for decode. Wide enough for a 73-module code filling the frame. */
const SCAN_WIDTH = 480;

export class QrDisplay {
  readonly canvas: HTMLCanvasElement;

  constructor(private readonly cssSize = 300) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'qr-display';
  }

  /**
   * Render a matrix.
   *
   * Sized in DEVICE pixels at an integer module scale, then constrained back with CSS.
   * Letting the browser scale a canvas to fit produces fractional module widths and
   * anti-aliased edges, and a decoder sampling the middle of a module then finds grey
   * where it needs a decision.
   */
  render(matrix: QrMatrix): void {
    const quiet = 4;
    const total = matrix.size + quiet * 2;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const scale = Math.max(2, Math.floor((this.cssSize * dpr) / total));
    const px = total * scale;

    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.width = `${Math.round(px / dpr)}px`;
    this.canvas.style.height = `${Math.round(px / dpr)}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    drawQr(ctx, matrix, px);
  }
}

export type ScanResult = (payload: Uint8Array) => void;

export class QrScanner {
  readonly video: HTMLVideoElement;
  private readonly work: HTMLCanvasElement;
  private stream: MediaStream | null = null;
  private running = false;
  private onFound: ScanResult | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.className = 'qr-video';
    // Required for iOS to play inline rather than going fullscreen, and muted so
    // autoplay is permitted at all.
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.work = document.createElement('canvas');
  }

  /** Why the camera is unavailable, or null when it should work. */
  static unavailableReason(): string | null {
    if (!window.isSecureContext) {
      return 'The camera needs a secure page. Open the downloaded file, or use https.';
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      return 'This browser will not give the page a camera.';
    }
    return null;
  }

  async start(onFound: ScanResult): Promise<void> {
    const why = QrScanner.unavailableReason();
    if (why) throw new Error(why);

    this.onFound = onFound;
    // `environment` rather than the default, because the code being scanned is on
    // somebody else's phone, not the user's own face.
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    this.running = true;
    requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (!this.running) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw > 0 && vh > 0) {
      const w = Math.min(SCAN_WIDTH, vw);
      const h = Math.round((vh / vw) * w);
      if (this.work.width !== w || this.work.height !== h) {
        this.work.width = w;
        this.work.height = h;
      }
      const ctx = this.work.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(this.video, 0, 0, w, h);
        const found = this.feed(ctx.getImageData(0, 0, w, h));
        if (found) return;
      }
    }
    requestAnimationFrame(() => this.tick());
  }

  /**
   * Try one frame. Separated from the camera so a test can inject pixels.
   *
   * That separation is what makes the QR handshake testable at all: the camera is only a
   * source of ImageData, and a harness can render a code in one page and hand the pixels
   * to another without any hardware involved.
   */
  feed(image: ImageData): boolean {
    const payload = scanQr(image.data, image.width, image.height);
    if (!payload || payload.length === 0) return false;
    const cb = this.onFound;
    this.stop();
    cb?.(payload);
    return true;
  }

  stop(): void {
    this.running = false;
    this.onFound = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}
