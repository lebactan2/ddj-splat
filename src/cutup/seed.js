/**
 * seed.js
 * Seeded pseudo-random number generator (mulberry32).
 * Same seed + same inputs = same output, every time.
 */

export class SeededRandom {
  constructor(seed) {
    this.state = seed | 0;
  }

  /** Returns a float in [0, 1) */
  next() {
    this.state |= 0;
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an int in [min, max) */
  nextInt(min, max) {
    return Math.floor(this.next() * (max - min)) + min;
  }

  /** Returns a float in [min, max) */
  nextFloat(min, max) {
    return this.next() * (max - min) + min;
  }

  /** Fisher-Yates shuffle (in-place) using this RNG */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}
