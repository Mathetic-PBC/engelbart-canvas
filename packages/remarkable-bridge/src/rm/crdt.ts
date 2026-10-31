// Ordering a CRDT sequence (a layer's strokes, the typed text's characters). Each element names the element to its
// left and to its right when it was inserted; the order is a topological sort of those edges. A side that is (0,0), or
// names an element not in the sequence, is the sequence's start or end. When several elements could come next
// (inserted at the same place at once), the tablet puts the higher author index first, then the lower counter.
// Kahn's algorithm with a binary heap, after rmscene's crdt_sequence.py (MIT; see THIRD_PARTY_NOTICES.md). Elements
// left over by a cycle (a damaged file) are appended in file order rather than dropped.

import { END_KEY, type CrdtId, type IdKey } from './reader.ts';

export interface Ordered {
  id: CrdtId;
  key: IdKey;
  left: IdKey;
  right: IdKey;
}

const START = -1;

/** `items` in sequence order. Later duplicates of an id replace earlier ones. */
export function crdtOrder<T extends Ordered>(items: readonly T[]): T[] {
  const byKey = new Map<IdKey, number>();
  for (let i = 0; i < items.length; i++) byKey.set(items[i]!.key, i);
  if (byKey.size === 0) return [];
  const n = items.length;
  // Node i is items[i] (only the last of duplicate ids takes part); START is virtual. The end needs no node: nothing
  // waits on it.
  const inDegree = new Int32Array(n);
  const after = new Map<number, number[]>();
  const link = (from: number, to: number) => {
    const list = after.get(from);
    if (list) list.push(to); else after.set(from, [to]);
  };
  for (const i of byKey.values()) {
    const item = items[i]!;
    const left = item.left === END_KEY ? undefined : byKey.get(item.left);
    const right = item.right === END_KEY ? undefined : byKey.get(item.right);
    link(left ?? START, i);
    inDegree[i]! += 1;
    if (right !== undefined) {
      link(i, right);
      inDegree[right]! += 1;
    }
  }

  const heap = new Heap((x, y) => before(items, x, y));
  const out: T[] = [];
  const done = new Uint8Array(n);
  const release = (from: number) => {
    for (const next of after.get(from) ?? []) {
      inDegree[next]! -= 1;
      if (inDegree[next] === 0) heap.push(next);
    }
  };
  release(START);
  while (heap.size > 0) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    out.push(items[i]!);
    release(i);
  }
  if (out.length < byKey.size) for (const i of byKey.values()) if (!done[i]) out.push(items[i]!);
  return out;
}

/** Whether element x goes before element y when both could come next: higher author first, then lower counter. */
function before<T extends Ordered>(items: readonly T[], x: number, y: number): boolean {
  const a = items[x]!.id, b = items[y]!.id;
  return a.a !== b.a ? a.a > b.a : a.c < b.c;
}

class Heap {
  private readonly data: number[] = [];
  private readonly less: (x: number, y: number) => boolean;
  constructor(less: (x: number, y: number) => boolean) { this.less = less; }
  get size(): number { return this.data.length; }
  push(value: number): void {
    const d = this.data;
    d.push(value);
    for (let i = d.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (!this.less(d[i]!, d[parent]!)) break;
      [d[i], d[parent]] = [d[parent]!, d[i]!];
      i = parent;
    }
  }
  pop(): number {
    const d = this.data;
    const top = d[0]!;
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < d.length && this.less(d[l]!, d[m]!)) m = l;
        if (r < d.length && this.less(d[r]!, d[m]!)) m = r;
        if (m === i) break;
        [d[i], d[m]] = [d[m]!, d[i]!];
        i = m;
      }
    }
    return top;
  }
}
