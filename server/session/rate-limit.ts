/** Allows short bursts, then a steady rate. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    now: number = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now: number = Date.now()): boolean {
    const earned = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + earned * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
