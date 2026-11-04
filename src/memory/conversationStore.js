/**
 * Tenant- and bot-isolated, per-user in-memory conversation store with sliding window limits
 * and automatic TTL expiration.
 *
 * Isolates conversations by: `tenantId:platform:botId:userId` (or `tenantId:platform:userId` when botId is omitted).
 */
export class ConversationStore {
  /**
   * @param {object} [options]
   * @param {number} [options.maxMessages=20] - Maximum messages stored per user session
   * @param {number} [options.ttlMs=86400000] - Session time-to-live in milliseconds
   */
  constructor({ maxMessages = 20, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1) {
      throw new Error('maxMessages must be a positive integer');
    }
    this.maxMessages = maxMessages;
    this.ttlMs = ttlMs;
    /** @type {Map<string, { messages: Array<{role: 'user'|'model', text: string, timestamp: number}>, updatedAt: number }>} */
    this.sessions = new Map();
  }

  /**
   * Builds a composite key isolating business/tenant, platform, botId, and customer userId.
   *
   * @param {string} tenantId
   * @param {string} userId
   * @param {string} [platform='telegram']
   * @param {string} [botId='default']
   * @returns {string}
   */
  _buildKey(tenantId, userId, platform = 'telegram', botId = 'default') {
    if (!tenantId || !userId) {
      throw new Error('Both tenantId and userId are required for conversation isolation');
    }
    const cleanTenant = String(tenantId).trim();
    const cleanPlatform = String(platform || 'telegram').trim();
    const cleanBot = String(botId || 'default').trim();
    const cleanUser = String(userId).trim();

    if (cleanBot === 'default') {
      return `${cleanTenant}:${cleanPlatform}:${cleanUser}`;
    }

    return `${cleanTenant}:${cleanPlatform}:${cleanBot}:${cleanUser}`;
  }

  /**
   * Checks if a session has expired and removes it if so.
   *
   * @param {string} key
   * @param {number} [now]
   */
  _evictIfExpired(key, now = Date.now()) {
    const session = this.sessions.get(key);
    if (session && now - session.updatedAt > this.ttlMs) {
      this.sessions.delete(key);
    }
  }

  /**
   * Retrieves the conversation history for a specific business, platform, bot, and customer.
   * Returns a shallow copy of messages so callers cannot mutate internal state.
   *
   * @param {string} tenantId
   * @param {string} userId
   * @param {string} [platform='telegram']
   * @param {string} [botId='default']
   * @returns {Array<{role: 'user'|'model', text: string, timestamp: number}>}
   */
  getHistory(tenantId, userId, platform = 'telegram', botId = 'default') {
    const key = this._buildKey(tenantId, userId, platform, botId);
    this._evictIfExpired(key);

    const session = this.sessions.get(key);
    if (!session) {
      return [];
    }

    return session.messages.map((msg) => ({ ...msg }));
  }

  /**
   * Appends a message to the user's conversation history and enforces
   * the configured sliding window limit (maxMessages).
   *
   * @param {string} tenantId
   * @param {string} userId
   * @param {'user' | 'model'} role
   * @param {string} text
   * @param {string} [platform='telegram']
   * @param {string} [botId='default']
   */
  appendMessage(tenantId, userId, role, text, platform = 'telegram', botId = 'default') {
    if (role !== 'user' && role !== 'model') {
      throw new Error(`Invalid message role: ${role}. Must be 'user' or 'model'.`);
    }
    if (typeof text !== 'string' || !text.trim()) {
      return;
    }

    const key = this._buildKey(tenantId, userId, platform, botId);
    const now = Date.now();
    this._evictIfExpired(key, now);

    let session = this.sessions.get(key);
    if (!session) {
      session = { messages: [], updatedAt: now };
      this.sessions.set(key, session);
    }

    session.messages.push({
      role,
      text: text.trim(),
      timestamp: now,
    });

    if (session.messages.length > this.maxMessages) {
      session.messages = session.messages.slice(session.messages.length - this.maxMessages);
    }

    session.updatedAt = now;
  }

  /**
   * Resets/clears the conversation history for a specific user on a specific bot/business.
   *
   * @param {string} tenantId
   * @param {string} userId
   * @param {string} [platform='telegram']
   * @param {string} [botId='default']
   */
  clearHistory(tenantId, userId, platform = 'telegram', botId = 'default') {
    const key = this._buildKey(tenantId, userId, platform, botId);
    this.sessions.delete(key);
  }

  /**
   * Purges all expired sessions across the store.
   *
   * @returns {number} Number of evicted sessions
   */
  purgeExpired() {
    const now = Date.now();
    let evicted = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.updatedAt > this.ttlMs) {
        this.sessions.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }
}
