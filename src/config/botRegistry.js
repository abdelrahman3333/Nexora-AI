import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_BOTS_FILE = path.join(__dirname, 'bots.json');

export const botRegistrationSchema = z.object({
  bot_id: z
    .string()
    .trim()
    .min(2, 'bot_id must be at least 2 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'bot_id may only contain letters, numbers, hyphens, and underscores'),
  business_id: z.string().trim().min(1, 'business_id is required'),
  bot_username: z
    .string()
    .trim()
    .min(3, 'bot_username is required')
    .transform((val) => val.replace(/^@/, '')),
  token_env_var: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]+$/, 'token_env_var must be a valid environment variable name')
    .optional(),
  status: z.enum(['active', 'inactive']).default('active'),
});

const botsFileSchema = z.object({
  bots: z.array(botRegistrationSchema).default([]),
});

/**
 * Enforces that only the platform administrator can register, modify, or remove bots.
 *
 * @param {object} [actor]
 * @param {string} [actor.role]
 */
function assertPlatformAdmin(actor) {
  if (!actor || actor.role !== 'platform_admin') {
    throw new ValidationError(
      'Unauthorized: Only a platform_admin can register or manage Telegram bot accounts.',
      'UNAUTHORIZED_BOT_MANAGEMENT'
    );
  }
}

/**
 * Secure, persistent Bot Registry for the Nexora AI multi-tenant platform.
 *
 * Security guarantees:
 * - Never stores plaintext tokens in `businesses.json` or persists raw tokens to `bots.json`.
 * - Resolves bot tokens from environment variables (`token_env_var`) or an in-memory secret vault.
 * - Public inspection methods (`listBots`, `getBot`) NEVER return the raw Telegram bot token.
 * - Validates `business_id` existence against `BusinessStore` before allowing registration.
 * - Prevents duplicate `bot_id`, duplicate `bot_username`, or duplicate Telegram tokens.
 */
export class BotRegistry {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath]
   * @param {import('./businessStore.js').BusinessStore} [options.businessStore]
   * @param {Record<string, string | undefined>} [options.env]
   */
  constructor({
    filePath = DEFAULT_BOTS_FILE,
    businessStore = null,
    env = process.env,
  } = {}) {
    this.filePath = path.resolve(filePath);
    this.businessStore = businessStore;
    this.env = env;
    /** @type {Map<string, z.infer<typeof botRegistrationSchema>>} */
    this.bots = new Map();
    /**
     * In-memory vault for runtime-injected tokens (never written to disk).
     * @type {Map<string, string>}
     */
    this.#tokenVault = new Map();
    this.reload();
  }

  /** @type {Map<string, string>} */
  #tokenVault;

  /**
   * Loads and validates bot metadata from `bots.json`.
   */
  reload() {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`Bot registry file not found at: ${this.filePath}`);
    }

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in bot registry (${this.filePath}): ${err.message}`
      );
    }

    const validated = botsFileSchema.parse(parsed);
    const nextBots = new Map();
    const seenUsernames = new Set();

    for (const botEntry of validated.bots) {
      if (nextBots.has(botEntry.bot_id)) {
        throw new ValidationError(
          `Duplicate bot_id "${botEntry.bot_id}" in bot registry`,
          'DUPLICATE_BOT_ID'
        );
      }

      const lowerUser = botEntry.bot_username.toLowerCase();
      if (seenUsernames.has(lowerUser)) {
        throw new ValidationError(
          `Duplicate bot_username "${botEntry.bot_username}" in bot registry`,
          'DUPLICATE_BOT_USERNAME'
        );
      }

      if (this.businessStore && !this.businessStore.hasBusiness(botEntry.business_id)) {
        throw new ValidationError(
          `Bot "${botEntry.bot_id}" references unknown business_id "${botEntry.business_id}"`,
          'INVALID_BUSINESS_ASSOCIATION'
        );
      }

      seenUsernames.add(lowerUser);
      nextBots.set(botEntry.bot_id, structuredClone(botEntry));
    }

    this.bots = nextBots;
  }

  /**
   * Persists sanitized bot metadata to `bots.json` (never writes plaintext tokens).
   */
  saveToDisk() {
    const safeRecords = Array.from(this.bots.values()).map((b) => ({
      bot_id: b.bot_id,
      business_id: b.business_id,
      bot_username: b.bot_username,
      ...(b.token_env_var ? { token_env_var: b.token_env_var } : {}),
      status: b.status,
    }));

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ bots: safeRecords }, null, 2),
      'utf-8'
    );
  }

  /**
   * Returns a safe, token-redacted representation of a bot registration.
   *
   * @param {z.infer<typeof botRegistrationSchema>} botEntry
   */
  _sanitizePublicEntry(botEntry) {
    return Object.freeze({
      bot_id: botEntry.bot_id,
      business_id: botEntry.business_id,
      bot_username: botEntry.bot_username,
      token_env_var: botEntry.token_env_var || null,
      status: botEntry.status,
      hasTokenConfigured: Boolean(this._resolveRawToken(botEntry.bot_id, false)),
    });
  }

  /**
   * Resolves the secret Telegram token for internal runtime use only.
   *
   * @param {string} botId
   * @param {boolean} [throwIfMissing=true]
   * @returns {string | null}
   */
  _resolveRawToken(botId, throwIfMissing = true) {
    const entry = this.bots.get(String(botId || '').trim());
    if (!entry) {
      if (throwIfMissing) {
        throw new ValidationError(`Unknown bot_id "${botId}"`, 'BOT_NOT_FOUND');
      }
      return null;
    }

    const vaultToken = this.#tokenVault.get(entry.bot_id);
    const envToken = entry.token_env_var
      ? this.env?.[entry.token_env_var]
      : undefined;
    const rawToken = String(vaultToken || envToken || '').trim();

    if (
      !rawToken ||
      rawToken.length < 20 ||
      rawToken.includes('ABCdefGHIjklMNOpqrsTUVwxyz')
    ) {
      if (throwIfMissing) {
        throw new ValidationError(
          `Telegram bot token is missing or invalid for bot "${entry.bot_id}" (expected in env var ${entry.token_env_var || 'vault'})`,
          'INVALID_BOT_TOKEN'
        );
      }
      return null;
    }

    return rawToken;
  }

  /**
   * Lists all registered bots without exposing any secret tokens.
   */
  listBots() {
    return Array.from(this.bots.values()).map((b) => this._sanitizePublicEntry(b));
  }

  /**
   * Gets safe metadata for a single bot by `bot_id` (never exposes the raw token).
   *
   * @param {string} botId
   */
  getBot(botId) {
    const entry = this.bots.get(String(botId || '').trim());
    if (!entry) {
      throw new ValidationError(`Unknown bot_id "${botId}"`, 'BOT_NOT_FOUND');
    }
    return this._sanitizePublicEntry(entry);
  }

  /**
   * Internal method used exclusively by `TelegramBotManager` to obtain the verified
   * runtime credentials and associated `business_id` for starting a bot.
   *
   * @param {string} botId
   * @returns {{ bot_id: string, business_id: string, bot_username: string, status: string, token: string }}
   */
  getBotRuntimeCredentials(botId) {
    const entry = this.bots.get(String(botId || '').trim());
    if (!entry) {
      throw new ValidationError(`Unknown bot_id "${botId}"`, 'BOT_NOT_FOUND');
    }

    if (this.businessStore && !this.businessStore.hasBusiness(entry.business_id)) {
      throw new ValidationError(
        `Bot "${entry.bot_id}" is associated with non-existent business "${entry.business_id}"`,
        'INVALID_BUSINESS_ASSOCIATION'
      );
    }

    const token = this._resolveRawToken(entry.bot_id, true);

    return {
      bot_id: entry.bot_id,
      business_id: entry.business_id,
      bot_username: entry.bot_username,
      status: entry.status,
      token,
    };
  }

  /**
   * Registers a new Telegram bot account in the registry.
   * Restricted strictly to `{ role: 'platform_admin' }`.
   *
   * @param {object} rawRegistration
   * @param {string} rawRegistration.bot_id
   * @param {string} rawRegistration.business_id
   * @param {string} rawRegistration.bot_username
   * @param {string} [rawRegistration.token_env_var]
   * @param {string} [rawRegistration.token] - Optional runtime token stored in memory vault only
   * @param {'active' | 'inactive'} [rawRegistration.status='active']
   * @param {object} [options]
   * @param {{ role: string }} options.actor
   * @param {boolean} [options.persist=true]
   */
  registerBot(rawRegistration, { actor, persist = true } = {}) {
    assertPlatformAdmin(actor);

    const parsed = botRegistrationSchema.parse(rawRegistration);

    if (this.bots.has(parsed.bot_id)) {
      throw new ValidationError(
        `Bot with bot_id "${parsed.bot_id}" is already registered`,
        'DUPLICATE_BOT_ID'
      );
    }

    const normalizedUsername = parsed.bot_username.toLowerCase();
    for (const existing of this.bots.values()) {
      if (existing.bot_username.toLowerCase() === normalizedUsername) {
        throw new ValidationError(
          `Bot username "@${parsed.bot_username}" is already registered to "${existing.bot_id}"`,
          'DUPLICATE_BOT_USERNAME'
        );
      }
    }

    if (this.businessStore && !this.businessStore.hasBusiness(parsed.business_id)) {
      throw new ValidationError(
        `Cannot register bot "${parsed.bot_id}": business_id "${parsed.business_id}" does not exist`,
        'INVALID_BUSINESS_ASSOCIATION'
      );
    }

    // Validate token uniqueness and format if provided or active
    const candidateToken = String(
      rawRegistration.token ||
        (parsed.token_env_var ? this.env?.[parsed.token_env_var] : '') ||
        ''
    ).trim();

    if (parsed.status === 'active' || rawRegistration.token) {
      if (
        !candidateToken ||
        candidateToken.length < 20 ||
        candidateToken.includes('ABCdefGHIjklMNOpqrsTUVwxyz')
      ) {
        throw new ValidationError(
          `Valid Telegram token is required to register active bot "${parsed.bot_id}"`,
          'INVALID_BOT_TOKEN'
        );
      }

      // Check that no other registered bot uses the exact same Telegram token
      for (const existingId of this.bots.keys()) {
        const existingToken = this._resolveRawToken(existingId, false);
        if (existingToken && existingToken === candidateToken) {
          throw new ValidationError(
            `Telegram token is already in use by another registered bot ("${existingId}")`,
            'DUPLICATE_BOT_TOKEN'
          );
        }
      }
    }

    if (rawRegistration.token) {
      this.#tokenVault.set(parsed.bot_id, candidateToken);
    }

    this.bots.set(parsed.bot_id, structuredClone(parsed));
    if (persist) {
      this.saveToDisk();
    }

    return this._sanitizePublicEntry(parsed);
  }

  /**
   * Updates the active/inactive status of a registered bot.
   * Restricted strictly to `{ role: 'platform_admin' }`.
   *
   * @param {string} botId
   * @param {'active' | 'inactive'} status
   * @param {object} [options]
   * @param {{ role: string }} options.actor
   * @param {boolean} [options.persist=true]
   */
  setBotStatus(botId, status, { actor, persist = true } = {}) {
    assertPlatformAdmin(actor);
    if (status !== 'active' && status !== 'inactive') {
      throw new ValidationError('Invalid bot status', 'INVALID_STATUS');
    }

    const entry = this.bots.get(String(botId || '').trim());
    if (!entry) {
      throw new ValidationError(`Unknown bot_id "${botId}"`, 'BOT_NOT_FOUND');
    }

    entry.status = status;
    this.bots.set(entry.bot_id, entry);
    if (persist) {
      this.saveToDisk();
    }

    return this._sanitizePublicEntry(entry);
  }

  /**
   * Removes a bot registration.
   * Restricted strictly to `{ role: 'platform_admin' }`.
   *
   * @param {string} botId
   * @param {object} [options]
   * @param {{ role: string }} options.actor
   * @param {boolean} [options.persist=true]
   */
  removeBot(botId, { actor, persist = true } = {}) {
    assertPlatformAdmin(actor);
    const id = String(botId || '').trim();
    if (!this.bots.has(id)) {
      throw new ValidationError(`Unknown bot_id "${id}"`, 'BOT_NOT_FOUND');
    }

    this.bots.delete(id);
    this.#tokenVault.delete(id);
    if (persist) {
      this.saveToDisk();
    }
    return true;
  }
}

