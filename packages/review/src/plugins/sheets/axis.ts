/**
 * One grid axis (rows or columns): a default size plus sparse overrides
 * (custom sizes, hidden = 0). Position lookups are O(log k) in the number
 * of overrides, so 1 048 576 rows cost nothing until they are customised.
 */
export class Axis {
  readonly count: number;
  readonly defaultSize: number;
  private readonly idx: number[];
  private readonly size: number[];
  /** cum[k] = sum over overrides before k of (size - default). */
  private readonly cum: number[];

  constructor(count: number, defaultSize: number, overrides: Map<number, number>) {
    this.count = count;
    this.defaultSize = defaultSize;
    const entries = [...overrides.entries()]
      .filter(([i, s]) => i >= 1 && i <= count && s !== defaultSize)
      .sort((a, b) => a[0] - b[0]);
    this.idx = entries.map((e) => e[0]);
    this.size = entries.map((e) => e[1]);
    this.cum = [0];
    for (let k = 0; k < entries.length; k++) this.cum.push(this.cum[k]! + this.size[k]! - defaultSize);
  }

  /** Number of overrides with index < i. */
  private before(i: number): number {
    let lo = 0;
    let hi = this.idx.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.idx[mid]! < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  sizeOf(i: number): number {
    const k = this.before(i);
    return this.idx[k] === i ? this.size[k]! : this.defaultSize;
  }

  /** Offset of the start of index `i` (1-based) from the start of index 1. */
  start(i: number): number {
    return (i - 1) * this.defaultSize + this.cum[this.before(i)]!;
  }

  end(i: number): number {
    return this.start(i) + this.sizeOf(i);
  }

  get total(): number {
    return this.start(this.count + 1);
  }

  /** Index whose span contains offset `pos` (clamped to 1..count). Zero-size
   * indices are never returned when a later one starts at the same offset. */
  indexAt(pos: number): number {
    if (pos <= 0) return 1;
    let lo = 1;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.start(mid) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
