/** Binary min-heap of (id, key) pairs. Duplicates allowed; callers do lazy deletion. */
export class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  size = 0;

  constructor(capacity = 1024) {
    this.ids = new Int32Array(Math.max(16, capacity));
    this.keys = new Float64Array(Math.max(16, capacity));
  }

  minKey(): number {
    return this.keys[0];
  }

  push(id: number, key: number): void {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2);
      const keys = new Float64Array(this.size * 2);
      ids.set(this.ids);
      keys.set(this.keys);
      this.ids = ids;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.ids[i] = this.ids[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }

  pop(): number {
    const top = this.ids[0];
    const last = --this.size;
    const id = this.ids[last];
    const key = this.keys[last];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= last) break;
      if (child + 1 < last && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.ids[i] = this.ids[child];
      this.keys[i] = this.keys[child];
      i = child;
    }
    this.ids[i] = id;
    this.keys[i] = key;
    return top;
  }
}
