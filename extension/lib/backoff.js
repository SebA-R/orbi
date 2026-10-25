// Exponential backoff with jitter for reconnects.

export class Backoff {
  constructor({ min = 500, max = 15_000, factor = 2, jitter = 0.2, random = Math.random } = {}) {
    Object.assign(this, { min, max, factor, jitter, random });
    this.attempt = 0;
  }

  next() {
    const base = Math.min(this.max, this.min * this.factor ** this.attempt);
    this.attempt++;
    const spread = base * this.jitter * (this.random() * 2 - 1);
    return Math.max(0, Math.min(this.max, Math.round(base + spread)));
  }

  reset() {
    this.attempt = 0;
  }
}
