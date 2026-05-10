// SPDX-License-Identifier: Apache-2.0
export interface RateLimitOptions {
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly opts: RateLimitOptions) {}

  tryConsume(ip: string, email: string): boolean {
    const key = `${ip}|${email.toLowerCase()}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return true;
    }
    if (bucket.count >= this.opts.max) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  reset(ip: string, email: string): void {
    this.buckets.delete(`${ip}|${email.toLowerCase()}`);
  }
}

export const defaultLoginLimiter = new LoginRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
