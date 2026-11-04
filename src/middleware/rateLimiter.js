import { RateLimitError } from '../utils/errors.js';

/**
 * Sliding-window per-user rate limiter to protect the AI provider and bot
 * from excessive requests or spam.
 */
export class RateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs=60000] - Time window in milliseconds
   * @param {number} [options.maxRequests=10] - Max requests allowed per user within windowMs
   */
  constructor({ windowMs = 60000, maxRequests = 10 } = {}) {
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error('windowMs must be a positive integer');
    }
    if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
      throw new Error('maxRequests must be a positive integer');
    }
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    /** @type {Map<string, number[]>} */
    this.requests = new Map();
  }

  /**
   * Builds a composite key for tenant + user rate isolation.
   *
   * @param {string} tenantId
   * @param {string} userId
   * @returns {string}
   */
  _buildKey(tenantId, userId) {
    return `${String(tenantId || 'default').trim()}:${String(userId).trim()}`;
  }

  /**
   * Checks if a user request is allowed and records the timestamp if permitted.
   * Throws RateLimitError if the user has exceeded their quota.
   *
   * @param {string} tenantId
   * @param {string} userId
   * @param {number} [now=Date.now()]
   * @returns {{ allowed: true, remaining: number }}
   */
  consume(tenantId, userId, now = Date.now()) {
    if (!userId) {
      throw new Error('userId is required for rate limiting');
    }

    const key = this._buildKey(tenantId, userId);
    const windowStart = now - this.windowMs;
    const timestamps = (this.requests.get(key) || []).filter((ts) => ts > windowStart);

    if (timestamps.length >= this.maxRequests) {
      const oldestTimestamp = timestamps[0];
      const retryAfterMs = Math.max(1000, oldestTimestamp + this.windowMs - now);
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

      this.requests.set(key, timestamps);
      throw new RateLimitError(
        `Rate limit exceeded for user ${userId}. Try again in ${retryAfterSeconds}s.`,
        retryAfterSeconds
      );
    }

    timestamps.push(now);
    this.requests.set(key, timestamps);

    return {
      allowed: true,
      remaining: this.maxRequests - timestamps.length,
    };
  }

  /**
   * Resets rate limit records for a specific user.
   *
   * @param {string} tenantId
   * @param {string} userId
   */
  reset(tenantId, userId) {
    const key = this._buildKey(tenantId, userId);
    this.requests.delete(key);
  }
}

