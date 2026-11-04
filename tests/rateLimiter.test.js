import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { RateLimitError } from '../src/utils/errors.js';

describe('RateLimiter Middleware', () => {
  it('allows requests up to maxRequests within the window and blocks excess requests', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 3 });
    const now = 1000000;

    expect(limiter.consume('tenant-1', 'user-1', now).remaining).toBe(2);
    expect(limiter.consume('tenant-1', 'user-1', now + 100).remaining).toBe(1);
    expect(limiter.consume('tenant-1', 'user-1', now + 200).remaining).toBe(0);

    expect(() => limiter.consume('tenant-1', 'user-1', now + 300)).toThrow(
      RateLimitError
    );
  });

  it('isolates rate limits per user so one noisy user does not block others', () => {
    const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1 });
    const now = 1000000;

    limiter.consume('tenant-1', 'user-A', now);
    expect(() => limiter.consume('tenant-1', 'user-A', now + 10)).toThrow(
      RateLimitError
    );

    // user-B should still be allowed
    const resB = limiter.consume('tenant-1', 'user-B', now + 10);
    expect(resB.allowed).toBe(true);
  });

  it('allows requests again after the sliding window expires', () => {
    const limiter = new RateLimiter({ windowMs: 5000, maxRequests: 2 });
    const start = 1000000;

    limiter.consume('tenant-1', 'user-1', start);
    limiter.consume('tenant-1', 'user-1', start + 1000);

    expect(() => limiter.consume('tenant-1', 'user-1', start + 2000)).toThrow(
      RateLimitError
    );

    // After 5001ms, the first request has slid out of the window
    const afterWindow = limiter.consume('tenant-1', 'user-1', start + 5001);
    expect(afterWindow.allowed).toBe(true);
  });
});

