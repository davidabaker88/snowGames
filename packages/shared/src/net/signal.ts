/**
 * A minimal event emitter.
 *
 * Deliberately not Node's `EventEmitter` (not available in the browser) and not
 * the DOM's `EventTarget` (not available in Node). A hand-rolled 30-line
 * emitter is the only thing that behaves identically in both runtimes, which is
 * the whole point of this package.
 */

export interface Signal<T> {
  /** Subscribe. Returns an unsubscribe function. */
  on(fn: (v: T) => void): () => void;
}

export class Emitter<T> implements Signal<T> {
  private fns: ((v: T) => void)[] = [];

  on(fn: (v: T) => void): () => void {
    this.fns.push(fn);
    return () => {
      const i = this.fns.indexOf(fn);
      if (i >= 0) this.fns.splice(i, 1);
    };
  }

  emit(v: T): void {
    // Iterate a copy: a listener is allowed to unsubscribe itself (or others)
    // during dispatch without skipping the next listener.
    const fns = this.fns.length > 1 ? this.fns.slice() : this.fns;
    for (const fn of fns) fn(v);
  }

  get listenerCount(): number {
    return this.fns.length;
  }

  clear(): void {
    this.fns.length = 0;
  }
}
