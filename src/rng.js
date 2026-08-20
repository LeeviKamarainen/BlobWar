import { mulberry32 } from './noise.js';

/**
 * Seeded random source for anything that changes the outcome of a turn.
 *
 * Cosmetic randomness (particles, camera shake, wobble) deliberately keeps using
 * Math.random — it never has to agree between machines. Everything gameplay-side
 * goes through here so that:
 *
 *   1. a solo match replays identically from its seed, and
 *   2. online clients roll the same wind, crate drops and shrapnel spreads.
 *
 * The generator is re-seeded at the top of every turn (see Game.nextTurn), so a
 * client that drifts mid-turn is automatically back in step at the next one.
 */
export class RNG {
  constructor(seed = 1) {
    this.reset(seed);
  }

  reset(seed) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
    this.calls = 0;
  }

  next() {
    this.calls++;
    return this._next();
  }

  /** Uniform in [a, b). */
  range(a, b) {
    return a + this.next() * (b - a);
  }

  /** Uniform in [-h, h). */
  spread(h) {
    return (this.next() * 2 - 1) * h;
  }

  int(n) {
    return Math.floor(this.next() * n);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[this.int(list.length)];
  }
}
