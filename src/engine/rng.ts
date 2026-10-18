/**
 * A small seeded generator (mulberry32): the same seed always gives the same
 * sequence, so a stroke's randomness can be replayed in tests.
 */
export class Rng {
  private _state: number;

  constructor(seed: number) {
    this._state = seed >>> 0;
  }

  /** The next value, in [0, 1). */
  next(): number {
    this._state = (this._state + 0x6D2B79F5) >>> 0;
    let t = this._state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** A seed for a stroke that wasn't given one, so strokes differ from each other. */
export function freshSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}
