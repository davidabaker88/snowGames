/**
 * Reader and writer, driven by the schema tables.
 *
 * A `Writer` wraps a preallocated buffer and allocates nothing per message; that
 * is the entire point of having a binary path at all. The JSON codec at the bottom
 * of this file produces the same VALUES through a readable encoding, and both go
 * through `quantize`, so switching between them cannot change the simulation.
 *
 * Bounds are checked on read, not trusted. Every byte here arrived from another
 * device: a truncated or hostile message must produce a clean error, never a
 * silently half-applied world.
 */

import { MAX_MESSAGE_BYTES } from './transport.js';
import {
  fieldBytes,
  quantize,
  type FieldKind,
  type StructSchema,
} from './schema.js';

const TAU = Math.PI * 2;

export class CodecError extends Error {}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class Writer {
  private readonly buf: ArrayBuffer;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private off = 0;

  constructor(capacity = MAX_MESSAGE_BYTES) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  get length(): number {
    return this.off;
  }

  get capacity(): number {
    return this.buf.byteLength;
  }

  /** Bytes still available. Callers use this to stop before overflowing. */
  get remaining(): number {
    return this.buf.byteLength - this.off;
  }

  reset(): Writer {
    this.off = 0;
    return this;
  }

  /**
   * A view over what has been written.
   *
   * Deliberately NOT a copy: transports copy if they need to retain it, and the
   * whole design goal is zero allocation on the send path. `LocalTransport.send`
   * documents that it copies for exactly this reason.
   */
  view_(): Uint8Array {
    return this.bytes.subarray(0, this.off);
  }

  private need(n: number): number {
    if (this.off + n > this.buf.byteLength) {
      throw new CodecError(`writer overflow: need ${n}, have ${this.remaining}`);
    }
    const at = this.off;
    this.off += n;
    return at;
  }

  u8(v: number): void {
    this.view.setUint8(this.need(1), v & 0xff);
  }

  i8(v: number): void {
    this.view.setInt8(this.need(1), v | 0);
  }

  u16(v: number): void {
    this.view.setUint16(this.need(2), v & 0xffff);
  }

  i16(v: number): void {
    this.view.setInt16(this.need(2), v | 0);
  }

  u32(v: number): void {
    this.view.setUint32(this.need(4), v >>> 0);
  }

  i32(v: number): void {
    this.view.setInt32(this.need(4), v | 0);
  }

  f32(v: number): void {
    this.view.setFloat32(this.need(4), v);
  }

  field(v: number, k: FieldKind): void {
    if (!Number.isFinite(v)) v = 0;
    switch (k.t) {
      case 'u8':
        return this.u8(clamp(Math.round(v), 0, 0xff));
      case 'i8':
        return this.i8(clamp(Math.round(v), -0x80, 0x7f));
      case 'u16':
        return this.u16(clamp(Math.round(v), 0, 0xffff));
      case 'i16':
        return this.i16(clamp(Math.round(v), -0x8000, 0x7fff));
      case 'u32':
        return this.u32(clamp(Math.round(v), 0, 0xffffffff));
      case 'i32':
        return this.i32(clamp(Math.round(v), -0x80000000, 0x7fffffff));
      case 'f32':
        return this.f32(v);
      case 'q': {
        const raw = Math.round(v * k.scale);
        if (k.bytes === 1) {
          return k.signed ? this.i8(clamp(raw, -0x80, 0x7f)) : this.u8(clamp(raw, 0, 0xff));
        }
        if (k.bytes === 2) {
          return k.signed
            ? this.i16(clamp(raw, -0x8000, 0x7fff))
            : this.u16(clamp(raw, 0, 0xffff));
        }
        return k.signed
          ? this.i32(clamp(raw, -0x80000000, 0x7fffffff))
          : this.u32(clamp(raw, 0, 0xffffffff));
      }
      case 'angle': {
        let a = v % TAU;
        if (a < 0) a += TAU;
        return this.u8(Math.round((a / TAU) * 256) & 0xff);
      }
    }
  }

  struct(obj: Record<string, number>, s: StructSchema): void {
    for (const fd of s) this.field(obj[fd.key] ?? 0, fd.kind);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export class Reader {
  private readonly view: DataView;
  private off = 0;

  constructor(private readonly src: Uint8Array) {
    this.view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  }

  get offset(): number {
    return this.off;
  }

  get remaining(): number {
    return this.src.byteLength - this.off;
  }

  get done(): boolean {
    return this.off >= this.src.byteLength;
  }

  private need(n: number): number {
    if (this.off + n > this.src.byteLength) {
      throw new CodecError(`truncated message: need ${n}, have ${this.remaining}`);
    }
    const at = this.off;
    this.off += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }

  i8(): number {
    return this.view.getInt8(this.need(1));
  }

  u16(): number {
    return this.view.getUint16(this.need(2));
  }

  i16(): number {
    return this.view.getInt16(this.need(2));
  }

  u32(): number {
    return this.view.getUint32(this.need(4));
  }

  i32(): number {
    return this.view.getInt32(this.need(4));
  }

  f32(): number {
    return this.view.getFloat32(this.need(4));
  }

  field(k: FieldKind): number {
    switch (k.t) {
      case 'u8':
        return this.u8();
      case 'i8':
        return this.i8();
      case 'u16':
        return this.u16();
      case 'i16':
        return this.i16();
      case 'u32':
        return this.u32();
      case 'i32':
        return this.i32();
      case 'f32':
        return this.f32();
      case 'q': {
        const raw =
          k.bytes === 1
            ? k.signed
              ? this.i8()
              : this.u8()
            : k.bytes === 2
              ? k.signed
                ? this.i16()
                : this.u16()
              : k.signed
                ? this.i32()
                : this.u32();
        return raw / k.scale;
      }
      case 'angle': {
        const back = (this.u8() / 256) * TAU;
        return back > Math.PI ? back - TAU : back;
      }
    }
  }

  /** Read into `out` in place, so the hot path allocates nothing. */
  struct(out: Record<string, number>, s: StructSchema): Record<string, number> {
    for (const fd of s) out[fd.key] = this.field(fd.kind);
    return out;
  }

  /** Skip a struct without decoding it -- used to walk past unknown entities. */
  skipStruct(s: StructSchema): void {
    let n = 0;
    for (const fd of s) n += fieldBytes(fd.kind);
    this.need(n);
  }
}

// ---------------------------------------------------------------------------
// The JSON path
// ---------------------------------------------------------------------------

/**
 * Encode a struct the way `?netjson=1` does.
 *
 * The quantization is not optional and not a nicety: it is what makes this a
 * DEBUG VIEW of the binary protocol rather than a second, subtly different
 * protocol. A field that survives the JSON path unrounded would make a
 * quantization bug disappear the moment you turned on logging to look for it.
 */
export function jsonStruct(
  obj: Record<string, number>,
  s: StructSchema,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const fd of s) out[fd.key] = quantize(obj[fd.key] ?? 0, fd.kind);
  return out;
}

export function jsonStructInto(
  out: Record<string, number>,
  src: Record<string, unknown>,
  s: StructSchema,
): Record<string, number> {
  for (const fd of s) {
    const v = src[fd.key];
    out[fd.key] = quantize(typeof v === 'number' ? v : 0, fd.kind);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON framing
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Frame a cold-path message: one opcode byte followed by UTF-8 JSON. */
export function encodeJson(op: number, body: unknown): Uint8Array {
  const text = JSON.stringify(body);
  const payload = encoder.encode(text);
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = op;
  out.set(payload, 1);
  return out;
}

export function decodeJson(data: Uint8Array): unknown {
  if (data.byteLength < 1) throw new CodecError('empty message');
  try {
    return JSON.parse(decoder.decode(data.subarray(1)));
  } catch {
    throw new CodecError('malformed JSON body');
  }
}

export function opOf(data: Uint8Array): number {
  if (data.byteLength < 1) throw new CodecError('empty message');
  return data[0]!;
}
