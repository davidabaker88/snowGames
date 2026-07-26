/**
 * Codec round-trip tests.
 *
 * Property-style, but driven by the project's own seeded RNG rather than
 * fast-check. That is a deliberate trade: no new dependency, and a failure is
 * reproducible from the seed printed in the assertion instead of from a shrinking
 * report. The generators below deliberately include the values that break naive
 * codecs -- exact bounds, values past the bounds, negative zero, NaN, and angles
 * either side of the +/-pi seam.
 */

import { describe, expect, it } from 'vitest';
import { Reader, Writer, CodecError, decodeJson, encodeJson, jsonStruct, opOf } from './codec.js';
import {
  BALL_SCHEMA,
  EVENT_SCHEMA,
  FLAG_SCHEMA,
  INPUT_SCHEMA,
  MATCH_SCHEMA,
  PLAYER_SCHEMA,
  RING_SCHEMA,
  TILE_SCHEMA,
  ZONE_SCHEMA,
  quantize,
  structBytes,
  structEqual,
  type StructSchema,
} from './schema.js';
import { createRng, nextFloat, nextSpread } from '../math/rng.js';
import { Op, isJsonOp } from './protocol.js';

const SCHEMAS: [string, StructSchema][] = [
  ['player', PLAYER_SCHEMA],
  ['ball', BALL_SCHEMA],
  ['match', MATCH_SCHEMA],
  ['flag', FLAG_SCHEMA],
  ['zone', ZONE_SCHEMA],
  ['ring', RING_SCHEMA],
  ['tile', TILE_SCHEMA],
  ['input', INPUT_SCHEMA],
  ['event', EVENT_SCHEMA],
];

/** Random-ish values spanning and overflowing every field's range. */
function randomStruct(s: StructSchema, seed: number): Record<string, number> {
  const rng = createRng(seed);
  const out: Record<string, number> = {};
  for (const f of s) {
    const roll = nextFloat(rng);
    if (roll < 0.1) out[f.key] = 0;
    else if (roll < 0.2) out[f.key] = nextSpread(rng, 100000); // deliberate overflow
    else if (roll < 0.3) out[f.key] = nextSpread(rng, Math.PI * 3); // past the angle seam
    else out[f.key] = nextSpread(rng, 500);
  }
  return out;
}

describe('binary codec', () => {
  it('round-trips every schema at 400 seeds', () => {
    for (const [name, schema] of SCHEMAS) {
      for (let seed = 1; seed <= 400; seed++) {
        const src = randomStruct(schema, seed);
        const w = new Writer();
        w.struct(src, schema);
        expect(w.length, `${name} size`).toBe(structBytes(schema));

        const got = new Reader(w.view_()).struct({}, schema);

        // The value that comes back must equal the value quantize() predicted.
        // If these two ever disagree, delta compression starts re-sending
        // unchanged fields forever and nobody notices except the bandwidth test.
        for (const f of schema) {
          expect(got[f.key], `${name}.${f.key} seed=${seed}`).toBeCloseTo(
            quantize(src[f.key]!, f.kind),
            6,
          );
        }
      }
    }
  });

  it('treats quantization as idempotent', () => {
    // Quantizing twice must not move the value, or `structEqual` would report a
    // field as changed on every snapshot even when nothing touched it.
    for (const [name, schema] of SCHEMAS) {
      for (let seed = 1; seed <= 100; seed++) {
        const src = randomStruct(schema, seed);
        for (const f of schema) {
          const once = quantize(src[f.key]!, f.kind);
          expect(quantize(once, f.kind), `${name}.${f.key}`).toBe(once);
        }
      }
    }
  });

  it('survives NaN, Infinity and negative zero', () => {
    for (const [name, schema] of SCHEMAS) {
      for (const bad of [NaN, Infinity, -Infinity, -0]) {
        const src: Record<string, number> = {};
        for (const f of schema) src[f.key] = bad;
        const w = new Writer();
        w.struct(src, schema);
        const got = new Reader(w.view_()).struct({}, schema);
        for (const f of schema) {
          expect(Number.isFinite(got[f.key]), `${name}.${f.key} from ${bad}`).toBe(true);
        }
      }
    }
  });

  it('keeps angles stable across the +/-pi seam', () => {
    const kind = PLAYER_SCHEMA.find((f) => f.key === 'facing')!.kind;
    for (const a of [Math.PI, -Math.PI, Math.PI - 1e-9, -Math.PI + 1e-9, 0, -0]) {
      const w = new Writer();
      w.field(a, kind);
      const back = new Reader(w.view_()).field(kind);
      expect(Math.abs(Math.atan2(Math.sin(back - a), Math.cos(back - a)))).toBeLessThan(0.02);
      // And the decoded value must be in the range the simulation expects.
      expect(back).toBeGreaterThan(-Math.PI - 1e-9);
      expect(back).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('reports a truncated message instead of returning junk', () => {
    const w = new Writer();
    w.struct(randomStruct(PLAYER_SCHEMA, 7), PLAYER_SCHEMA);
    const full = w.view_();
    // Every prefix short of the whole struct must throw, not silently read zeros
    // past the end -- a half-applied player is a desync you cannot trace.
    for (let cut = 0; cut < full.byteLength; cut++) {
      const r = new Reader(full.subarray(0, cut));
      expect(() => r.struct({}, PLAYER_SCHEMA)).toThrow(CodecError);
    }
  });

  it('refuses to write past the end of its buffer', () => {
    const w = new Writer(4);
    w.u16(1);
    w.u16(2);
    expect(() => w.u8(3)).toThrow(CodecError);
    // And the failed write must not have advanced the offset.
    expect(w.length).toBe(4);
  });
});

describe('the JSON debug path', () => {
  it('produces the same values as the binary path', () => {
    for (const [name, schema] of SCHEMAS) {
      for (let seed = 1; seed <= 200; seed++) {
        const src = randomStruct(schema, seed);

        const w = new Writer();
        w.struct(src, schema);
        const binary = new Reader(w.view_()).struct({}, schema);
        const json = jsonStruct(src, schema);

        for (const f of schema) {
          expect(json[f.key], `${name}.${f.key} seed=${seed}`).toBeCloseTo(binary[f.key]!, 6);
        }
        // The strong form: the two are interchangeable as delta baselines.
        expect(structEqual(json, binary, schema), `${name} seed=${seed}`).toBe(true);
      }
    }
  });

  it('frames and unframes a cold-path message', () => {
    const body = { v: 1, name: 'Sam', id: 3 };
    const framed = encodeJson(Op.Hello, body);
    expect(opOf(framed)).toBe(Op.Hello);
    expect(isJsonOp(opOf(framed))).toBe(true);
    expect(decodeJson(framed)).toEqual(body);
  });

  it('rejects a malformed body rather than throwing something untyped', () => {
    const bad = new Uint8Array([Op.Hello, 0x7b, 0x22]); // `{"` and then nothing
    expect(() => decodeJson(bad)).toThrow(CodecError);
    expect(() => opOf(new Uint8Array(0))).toThrow(CodecError);
  });

  it('splits hot and cold paths on the 0x80 boundary', () => {
    for (const op of [Op.Snapshot, Op.Input, Op.Events, Op.Ping, Op.Pong]) {
      expect(isJsonOp(op)).toBe(false);
    }
    for (const op of [Op.Hello, Op.Welcome, Op.RoomState, Op.MatchStart, Op.Bye, Op.Refused]) {
      expect(isJsonOp(op)).toBe(true);
    }
  });
});
