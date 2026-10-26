/** Seeded pseudo-random generator (mulberry32): every renderer builds the same field. */
export class Random {
  private _state: number;

  public constructor(seed: number) {
    this._state = seed >>> 0;
  }

  /** Number in [0, 1). */
  public next(): number {
    let t = (this._state = (this._state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Number in [min, max). */
  public range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
