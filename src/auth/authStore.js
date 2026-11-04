import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';
import { hashPassword, verifyPassword } from './passwordHasher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_AUTH_DB_PATH = path.resolve(
  __dirname,
  '../../data/nexora-auth.sqlite'
);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address format');

export const USER_ROLES = ['platform_admin', 'business_owner'];

/**
 * Persistent SQLite-backed store for User Accounts and Server-Side Sessions.
 *
 * Security guarantees:
 * - Passwords are always hashed with `crypto.scrypt` before storage; plaintext passwords are never stored.
 * - `password_hash` is stripped from all public return values.
 * - Each `business_owner` must be associated with exactly one valid `business_id`.
 * - Disabling a user account immediately invalidates all of their active sessions.
 */
export class AuthStore {
  /**
   * @param {object} [options]
   * @param {string} [options.dbPath] - Path to SQLite database file or ':memory:'
   * @param {import('../config/businessStore.js').BusinessStore} [options.businessStore]
   * @param {number} [options.sessionTtlMs=86400000] - Default session lifetime (24 hours)
   */
  constructor({
    dbPath = DEFAULT_AUTH_DB_PATH,
    businessStore = null,
    sessionTtlMs = 24 * 60 * 60 * 1000,
  } = {}) {
    this.dbPath = dbPath;
    this.businessStore = businessStore;
    this.sessionTtlMs = sessionTtlMs;

    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(dbPath);
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('platform_admin', 'business_owner')),
        business_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS ai_usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        model TEXT NOT NULL,
        request_id TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        candidates_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        is_success INTEGER NOT NULL,
        error_code TEXT,
        attempt_number INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_usage_biz_time ON ai_usage_logs(business_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_model_time ON ai_usage_logs(model, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_req_id ON ai_usage_logs(request_id);
    `);
  }

  /**
   * Sanitizes a raw database user row so `password_hash` is NEVER exposed.
   *
   * @param {object} row
   */
  _sanitizeUser(row) {
    if (!row) return null;
    return Object.freeze({
      user_id: row.user_id,
      email: row.email,
      role: row.role,
      business_id: row.business_id || null,
      is_active: Boolean(row.is_active),
      created_at: row.created_at,
    });
  }

  /**
   * Asserts that the caller is a `platform_admin`.
   *
   * @param {object} [actor]
   */
  _assertAdmin(actor) {
    if (!actor || actor.role !== 'platform_admin') {
      throw new ValidationError(
        'Forbidden: Only a platform_admin can perform this action.',
        'FORBIDDEN_ADMIN_ONLY'
      );
    }
  }

  /**
   * Creates a new user account (`platform_admin` or `business_owner`).
   *
   * Rules:
   * - If `actor` is provided, only `platform_admin` can create users.
   * - `business_owner` MUST have a valid `business_id` existing in `BusinessStore`.
   * - `platform_admin` does not require a `business_id`.
   *
   * @param {object} params
   * @param {string} params.email
   * @param {string} params.password
   * @param {'platform_admin' | 'business_owner'} params.role
   * @param {string | null} [params.business_id]
   * @param {boolean} [params.is_active=true]
   * @param {object} [options]
   * @param {{ role: string }} [options.actor]
   */
  createUser(
    { email, password, role, business_id = null, is_active = true },
    { actor = undefined } = {}
  ) {
    if (actor !== undefined) {
      this._assertAdmin(actor);
    }

    const parsedEmailResult = emailSchema.safeParse(email);
    if (!parsedEmailResult.success) {
      throw new ValidationError('Invalid email address', 'INVALID_EMAIL');
    }
    const cleanEmail = parsedEmailResult.data;

    if (!USER_ROLES.includes(role)) {
      throw new ValidationError(
        `Invalid role "${role}". Must be platform_admin or business_owner.`,
        'INVALID_ROLE'
      );
    }

    let cleanBusinessId = business_id ? String(business_id).trim() : null;

    if (role === 'business_owner') {
      if (!cleanBusinessId) {
        throw new ValidationError(
          'A business_owner must be associated with exactly one business_id.',
          'MISSING_BUSINESS_ID'
        );
      }
      if (this.businessStore && !this.businessStore.hasBusiness(cleanBusinessId)) {
        throw new ValidationError(
          `Cannot assign business_owner to non-existent business_id "${cleanBusinessId}".`,
          'UNKNOWN_BUSINESS_ID'
        );
      }
    } else {
      cleanBusinessId = null;
    }

    const existing = this.db
      .prepare('SELECT user_id FROM users WHERE email = ?')
      .get(cleanEmail);

    if (existing) {
      throw new ValidationError(
        `A user with email "${cleanEmail}" already exists.`,
        'DUPLICATE_EMAIL'
      );
    }

    const passwordHash = hashPassword(password);
    const userId = `usr_${crypto.randomBytes(12).toString('hex')}`;
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO users (user_id, email, password_hash, role, business_id, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        cleanEmail,
        passwordHash,
        role,
        cleanBusinessId,
        is_active ? 1 : 0,
        now
      );

    return this.getUserById(userId);
  }

  /**
   * Retrieves a sanitized user by `user_id` (never exposes `password_hash`).
   *
   * @param {string} userId
   */
  getUserById(userId) {
    const row = this.db
      .prepare(
        'SELECT user_id, email, role, business_id, is_active, created_at FROM users WHERE user_id = ?'
      )
      .get(String(userId || '').trim());

    return this._sanitizeUser(row);
  }

  /**
   * Lists all user accounts (restricted to `platform_admin`).
   *
   * @param {object} [options]
   * @param {{ role: string }} options.actor
   */
  listUsers({ actor } = {}) {
    this._assertAdmin(actor);
    const rows = this.db
      .prepare(
        'SELECT user_id, email, role, business_id, is_active, created_at FROM users ORDER BY created_at ASC'
      )
      .all();
    return rows.map((r) => this._sanitizeUser(r));
  }

  /**
   * Assigns or updates the `business_id` for a `business_owner` account.
   * Restricted strictly to `platform_admin`.
   *
   * @param {string} userId
   * @param {string} businessId
   * @param {object} options
   * @param {{ role: string }} options.actor
   */
  assignOwnerToBusiness(userId, businessId, { actor } = {}) {
    this._assertAdmin(actor);

    const cleanUserId = String(userId || '').trim();
    const cleanBusinessId = String(businessId || '').trim();

    if (!cleanBusinessId) {
      throw new ValidationError('business_id is required', 'MISSING_BUSINESS_ID');
    }

    if (this.businessStore && !this.businessStore.hasBusiness(cleanBusinessId)) {
      throw new ValidationError(
        `Business "${cleanBusinessId}" does not exist`,
        'UNKNOWN_BUSINESS_ID'
      );
    }

    const user = this.getUserById(cleanUserId);
    if (!user) {
      throw new ValidationError(`User "${cleanUserId}" not found`, 'USER_NOT_FOUND');
    }
    if (user.role !== 'business_owner') {
      throw new ValidationError(
        'Only business_owner accounts can be assigned to a specific business_id',
        'INVALID_ROLE_ASSIGNMENT'
      );
    }

    this.db
      .prepare('UPDATE users SET business_id = ? WHERE user_id = ?')
      .run(cleanBusinessId, cleanUserId);

    return this.getUserById(cleanUserId);
  }

  /**
   * Enables or disables a user account.
   * When disabled (`isActive = false`), all active sessions for that user are immediately revoked.
   * Restricted strictly to `platform_admin`.
   *
   * @param {string} userId
   * @param {boolean} isActive
   * @param {object} options
   * @param {{ role: string }} options.actor
   */
  setUserStatus(userId, isActive, { actor } = {}) {
    this._assertAdmin(actor);

    const cleanUserId = String(userId || '').trim();
    const user = this.getUserById(cleanUserId);
    if (!user) {
      throw new ValidationError(`User "${cleanUserId}" not found`, 'USER_NOT_FOUND');
    }

    this.db
      .prepare('UPDATE users SET is_active = ? WHERE user_id = ?')
      .run(isActive ? 1 : 0, cleanUserId);

    if (!isActive) {
      this.db
        .prepare('DELETE FROM sessions WHERE user_id = ?')
        .run(cleanUserId);
    }

    return this.getUserById(cleanUserId);
  }

  /**
   * Authenticates a user by email and password and creates a new server-side session.
   * Returns generic safe error codes on invalid credentials so attackers cannot enumerate emails.
   *
   * @param {string} email
   * @param {string} password
   * @param {number} [now=Date.now()]
   */
  authenticateAndCreateSession(email, password, now = Date.now()) {
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      throw new ValidationError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const cleanEmail = email.trim().toLowerCase();
    const row = this.db
      .prepare(
        'SELECT user_id, email, password_hash, role, business_id, is_active, created_at FROM users WHERE email = ?'
      )
      .get(cleanEmail);

    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new ValidationError('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    if (!row.is_active) {
      throw new ValidationError(
        'This account has been disabled. Please contact the platform administrator.',
        'ACCOUNT_DISABLED'
      );
    }

    const sessionId = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = now + this.sessionTtlMs;

    this.db
      .prepare(
        `INSERT INTO sessions (session_id, user_id, csrf_token, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(sessionId, row.user_id, csrfToken, expiresAt, now);

    return {
      sessionId,
      csrfToken,
      expiresAt,
      user: this._sanitizeUser(row),
    };
  }

  /**
   * Looks up and validates an active server-side session by `sessionId`.
   * Automatically deletes expired sessions or sessions belonging to disabled users.
   *
   * @param {string} sessionId
   * @param {number} [now=Date.now()]
   * @returns {{ sessionId: string, csrfToken: string, expiresAt: number, user: object } | null}
   */
  getValidSession(sessionId, now = Date.now()) {
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT
           s.session_id,
           s.csrf_token,
           s.expires_at,
           u.user_id,
           u.email,
           u.role,
           u.business_id,
           u.is_active,
           u.created_at
         FROM sessions s
         JOIN users u ON s.user_id = u.user_id
         WHERE s.session_id = ?`
      )
      .get(sessionId.trim());

    if (!row) {
      return null;
    }

    if (now >= row.expires_at || !row.is_active) {
      this.deleteSession(sessionId);
      return null;
    }

    return {
      sessionId: row.session_id,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      user: this._sanitizeUser(row),
    };
  }

  /**
   * Deletes a session (logout).
   *
   * @param {string} sessionId
   */
  deleteSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return;
    this.db
      .prepare('DELETE FROM sessions WHERE session_id = ?')
      .run(sessionId.trim());
  }

  /**
   * Purges all expired sessions from SQLite.
   *
   * @param {number} [now=Date.now()]
   */
  purgeExpiredSessions(now = Date.now()) {
    const res = this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(now);
    return Number(res.changes || 0);
  }

  /**
   * Closes the SQLite database connection cleanly.
   */
  close() {
    if (this.db && this.db.isOpen) {
      this.db.close();
    }
  }
}

