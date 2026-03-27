type Bucket = {
  hits: number[];
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxHits = 30,
    private readonly windowMs = 60_000
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    const cutoff = now - this.windowMs;
    bucket.hits = bucket.hits.filter((ts) => ts > cutoff);
    if (bucket.hits.length >= this.maxHits) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    return true;
  }
}
