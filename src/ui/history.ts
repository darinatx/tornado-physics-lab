/** Fixed-interval ring buffer for pinned-probe history (INST-07): a main value and an optional
 *  second one kept in step (wind speed and pressure drop). Pure. */
export class History {
  readonly times: number[] = [];
  readonly values: number[] = [];
  readonly values2: number[] = [];
  private last = -Infinity;

  constructor(
    readonly capacity: number,
    readonly interval: number,
  ) {}

  push(t: number, v: number, v2 = 0): void {
    if (t < this.last) this.clear(); // restart
    if (this.times.length > 0 && t - this.last < this.interval - 1e-9) return;
    this.times.push(t);
    this.values.push(v);
    this.values2.push(v2);
    this.last = t;
    if (this.times.length > this.capacity) {
      this.times.shift();
      this.values.shift();
      this.values2.shift();
    }
  }

  clear(): void {
    this.times.length = 0;
    this.values.length = 0;
    this.values2.length = 0;
    this.last = -Infinity;
  }

  get length(): number {
    return this.times.length;
  }
}
