/**
 * This package's tsconfig deliberately excludes both "DOM" and @types/node, so
 * that nothing here can accidentally depend on one runtime. That also hides the
 * handful of globals which genuinely exist in BOTH runtimes, so we declare
 * exactly those and nothing more.
 *
 * Adding anything to this file is a decision, not a formality: if it is not
 * present and identical in Node and every target browser, it does not belong.
 *
 * Note these are NOT usable from `sim/` -- ambient time is banned there by lint.
 * They exist for the transport layer's latency simulation only.
 */

declare const setTimeout: (fn: () => void, ms?: number) => TimerHandle;
declare const clearTimeout: (handle: TimerHandle) => void;
declare const queueMicrotask: (fn: () => void) => void;

/** Opaque: Node returns a Timeout object, browsers return a number. */
declare type TimerHandle = number | { readonly __timerBrand: 'TimerHandle' };

/**
 * WHATWG Encoding, used by the JSON cold path of the protocol.
 *
 * These are genuine globals in every runtime this package targets -- browsers, Node
 * since v11, and Cloudflare Workers -- but they belong to the Encoding standard rather
 * than to ECMAScript, so `lib: ["ES2022"]` does not declare them. Pulling in "DOM" to
 * get them would hand this package `window` and `document` as well, which is exactly
 * what the tsconfig is arranged to prevent. Declaring the two of them is the narrow fix.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
  readonly encoding: string;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBuffer | ArrayBufferView): string;
  readonly encoding: string;
}
