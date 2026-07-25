/**
 * The single depth-sorted draw list.
 *
 * Players, snowballs, props and (later) wall tiles all go into ONE list keyed by
 * ground y. Drawing them in separate passes is the intuitive thing to do and is
 * wrong: a player standing behind a rock must be occluded by it, which is
 * impossible if all rocks draw before all players.
 *
 * Two performance notes that matter on a phone:
 *  - The array of drawables is preallocated and reused. A per-frame array of
 *    object literals is a steady GC drip that shows up as periodic frame hitches.
 *  - Sorting uses insertion sort, because frame-to-frame the list is very nearly
 *    sorted already. It also avoids allocating a comparator closure.
 */

export const enum DrawKind {
  Prop = 0,
  Player = 1,
  Ball = 2,
  Wall = 3,
}

export interface Drawable {
  kind: DrawKind;
  /** Index into the relevant source array. */
  ref: number;
  /** GROUND y plus a small bias. Never screen y -- see projection.ts. */
  sortKey: number;
}

export class DrawList {
  private items: Drawable[] = [];
  private count = 0;

  clear(): void {
    this.count = 0;
  }

  push(kind: DrawKind, ref: number, sortKey: number): void {
    let item = this.items[this.count];
    if (!item) {
      item = { kind, ref, sortKey };
      this.items.push(item);
    } else {
      item.kind = kind;
      item.ref = ref;
      item.sortKey = sortKey;
    }
    this.count++;
  }

  /** Insertion sort: near-sorted input, no allocation, stable. */
  sort(): void {
    const a = this.items;
    for (let i = 1; i < this.count; i++) {
      const cur = a[i]!;
      const key = cur.sortKey;
      let j = i - 1;
      while (j >= 0 && a[j]!.sortKey > key) {
        a[j + 1] = a[j]!;
        j--;
      }
      a[j + 1] = cur;
    }
  }

  forEach(fn: (d: Drawable) => void): void {
    for (let i = 0; i < this.count; i++) fn(this.items[i]!);
  }

  get length(): number {
    return this.count;
  }
}
