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
