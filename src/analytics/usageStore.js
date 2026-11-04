import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { calculateModelCost, PRICING_VERSION } from '../ai/modelPricing.js';
import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Validates optional date filter parameters (ISO strings or millisecond timestamps).
 *
 * @param {string | number | undefined} val
 * @param {string} paramName
 * @returns {number | null} Milliseconds timestamp
 */
export function parseDateFilter(val, paramName) {
  if (val === undefined || val === null || val === '') {
    return null;
  }

  if (typeof val === 'number') {
    if (Number.isNaN(val) || val < 0) {
      throw new ValidationError(`Invalid timestamp for ${paramName}`, 'INVALID_DATE_FILTER');
    }
    return val;
  }

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;

    // Check if numeric string
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isNaN(num) || num < 0) {
        throw new ValidationError(`Invalid timestamp for ${paramName}`, 'INVALID_DATE_FILTER');
      }
      return num;
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      throw new ValidationError(`Invalid ISO date format for ${paramName}`, 'INVALID_DATE_FILTER');
    }
    return parsed;
  }

  throw new ValidationError(`Invalid date parameter ${paramName}`, 'INVALID_DATE_FILTER');
}

/**
 * SQLite-backed store for AI Usage Logs, Token Consumption, and Analytics.
 */
export class UsageStore {
  /**
   * @param {object} [options]
   * @param {DatabaseSync} [options.db] - Existing shared SQLite database instance
   * @param {string} [options.dbPath] - Path to SQLite database file
   * @param {import('pino').Logger} [options.log]
   */
  constructor({ db = null, dbPath = undefined, log = logger } = {}) {
    this.log = log;

    if (db) {
      this.db = db;
      this._ownsDb = false;
    } else if (dbPath) {
      if (dbPath !== ':memory:') {
        const dir = path.dirname(path.resolve(dbPath));
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(dbPath);
      this._ownsDb = true;
    } else {
      throw new Error('UsageStore requires either an existing db instance or dbPath');
    }

    this._initSchema();
  }

  /**
   * Initializes the `ai_usage_logs` schema safely with appropriate indexes.
   */
  _initSchema() {
    this.db.exec(`
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
   * Records a single Gemini AI attempt (successful or failed).
   *
   * @param {object} params
   * @param {string} params.business_id
   * @param {string} params.bot_id
   * @param {string} params.model
   * @param {string} params.request_id
   * @param {number} [params.prompt_tokens=0]
   * @param {number} [params.candidates_tokens=0]
   * @param {number} [params.total_tokens=0]
   * @param {number} params.is_success - 1 for success, 0 for failure
   * @param {string | null} [params.error_code=null]
   * @param {number} [params.attempt_number=1]
   * @param {number} [params.created_at=Date.now()]
   */
  recordUsage({
    business_id,
    bot_id,
    model,
    request_id,
    prompt_tokens = 0,
    candidates_tokens = 0,
    total_tokens = 0,
    is_success,
    error_code = null,
    attempt_number = 1,
    created_at = Date.now(),
  }) {
    if (!business_id || !model || !request_id) {
      throw new ValidationError(
        'business_id, model, and request_id are required to log AI usage',
        'INVALID_USAGE_PARAMS'
      );
    }

    const cleanBiz = String(business_id).trim();
    const cleanBot = String(bot_id || 'default').trim();
    const cleanModel = String(model).trim();
    const cleanReqId = String(request_id).trim();
    const cleanErrorCode = error_code ? String(error_code).slice(0, 100) : null;

    const pTokens = Math.max(0, Math.floor(Number(prompt_tokens) || 0));
    const cTokens = Math.max(0, Math.floor(Number(candidates_tokens) || 0));
    const tTokens = Math.max(0, Math.floor(Number(total_tokens) || (pTokens + cTokens)));

    const stmt = this.db.prepare(`
      INSERT INTO ai_usage_logs (
        business_id, bot_id, model, request_id,
        prompt_tokens, candidates_tokens, total_tokens,
        is_success, error_code, attempt_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      cleanBiz,
      cleanBot,
      cleanModel,
      cleanReqId,
      pTokens,
      cTokens,
      tTokens,
      is_success ? 1 : 0,
      cleanErrorCode,
      Math.max(1, Math.floor(Number(attempt_number) || 1)),
      Number(created_at) || Date.now()
    );
  }

  /**
   * Retrieves overall usage summary for a business within an optional date range.
   *
   * @param {string} businessId
   * @param {object} [options]
   * @param {string | number} [options.startDate]
   * @param {string | number} [options.endDate]
   */
  getUsageSummary(businessId, { startDate, endDate } = {}) {
    const cleanBiz = String(businessId || '').trim();
    if (!cleanBiz) {
      throw new ValidationError('business_id is required', 'MISSING_BUSINESS_ID');
    }

    const startTs = parseDateFilter(startDate, 'startDate');
    const endTs = parseDateFilter(endDate, 'endDate');

    let query = `
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END), 0) AS successful_requests,
        COALESCE(SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END), 0) AS failed_requests,
        COALESCE(SUM(CASE WHEN error_code = '429' OR error_code LIKE '%429%' OR error_code LIKE '%RESOURCE_EXHAUSTED%' THEN 1 ELSE 0 END), 0) AS rate_limit_429_errors,
        COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(candidates_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COUNT(DISTINCT CASE WHEN attempt_number = 1 THEN request_id END) AS unique_customer_requests
      FROM ai_usage_logs
      WHERE business_id = ?
    `;

    const params = [cleanBiz];

    if (startTs !== null) {
      query += ' AND created_at >= ?';
      params.push(startTs);
    }
    if (endTs !== null) {
      query += ' AND created_at <= ?';
      params.push(endTs);
    }

    const row = this.db.prepare(query).get(...params);

    // Compute estimated cost by grouping successful model usage
    const modelRows = this.getUsageByModel(cleanBiz, { startDate, endDate });
    let totalEstimatedCostUsd = 0;
    let hasUnpricedModels = false;

    for (const m of modelRows) {
      if (m.estimatedCostUsd !== null) {
        totalEstimatedCostUsd += m.estimatedCostUsd;
      } else {
        hasUnpricedModels = true;
      }
    }

    return {
      businessId: cleanBiz,
      startDate: startTs,
      endDate: endTs,
      totalRequests: Number(row.total_requests || 0),
      successfulRequests: Number(row.successful_requests || 0),
      failedRequests: Number(row.failed_requests || 0),
      rateLimit429Errors: Number(row.rate_limit_429_errors || 0),
      totalPromptTokens: Number(row.total_prompt_tokens || 0),
      totalOutputTokens: Number(row.total_output_tokens || 0),
      totalTokens: Number(row.total_tokens || 0),
      uniqueCustomerRequests: Number(row.unique_customer_requests || 0),
      estimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(6)),
      hasUnpricedModels,
      pricingVersion: PRICING_VERSION,
      pricingDisclaimer:
        'Estimated costs are calculated exclusively using published token pricing. Preview or unverified models are marked as unavailable.',
    };
  }

  /**
   * Retrieves usage grouped by model for a specific business.
   *
   * @param {string} businessId
   * @param {object} [options]
   * @param {string | number} [options.startDate]
   * @param {string | number} [options.endDate]
   */
  getUsageByModel(businessId, { startDate, endDate } = {}) {
    const cleanBiz = String(businessId || '').trim();
    const startTs = parseDateFilter(startDate, 'startDate');
    const endTs = parseDateFilter(endDate, 'endDate');

    let query = `
      SELECT
        model,
        COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END), 0) AS successful_requests,
        COALESCE(SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END), 0) AS failed_requests,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(candidates_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM ai_usage_logs
      WHERE business_id = ?
    `;

    const params = [cleanBiz];

    if (startTs !== null) {
      query += ' AND created_at >= ?';
      params.push(startTs);
    }
    if (endTs !== null) {
      query += ' AND created_at <= ?';
      params.push(endTs);
    }

    query += ' GROUP BY model ORDER BY total_requests DESC';

    const rows = this.db.prepare(query).all(...params);

    return rows.map((r) => {
      const costInfo = calculateModelCost(
        r.model,
        Number(r.prompt_tokens || 0),
        Number(r.output_tokens || 0)
      );

      return {
        model: r.model,
        totalRequests: Number(r.total_requests || 0),
        successfulRequests: Number(r.successful_requests || 0),
        failedRequests: Number(r.failed_requests || 0),
        promptTokens: Number(r.prompt_tokens || 0),
        outputTokens: Number(r.output_tokens || 0),
        totalTokens: Number(r.total_tokens || 0),
        isVerifiedPricing: costInfo.isVerified,
        pricingUnavailable: costInfo.pricingUnavailable,
        estimatedCostUsd: costInfo.estimatedCostUsd,
        pricingVersion: costInfo.pricingVersion,
      };
    });
  }

  /**
   * Retrieves daily usage timeseries for a specific business.
   *
   * @param {string} businessId
   * @param {object} [options]
   * @param {string | number} [options.startDate]
   * @param {string | number} [options.endDate]
   * @param {number} [options.limit=30]
   */
  getDailyUsage(businessId, { startDate, endDate, limit = 30 } = {}) {
    const cleanBiz = String(businessId || '').trim();
    const startTs = parseDateFilter(startDate, 'startDate');
    const endTs = parseDateFilter(endDate, 'endDate');
    const maxRows = Math.min(100, Math.max(1, Math.floor(Number(limit) || 30)));

    let query = `
      SELECT
        date(created_at / 1000, 'unixepoch') AS date,
        COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END), 0) AS successful_requests,
        COALESCE(SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END), 0) AS failed_requests,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(candidates_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM ai_usage_logs
      WHERE business_id = ?
    `;

    const params = [cleanBiz];

    if (startTs !== null) {
      query += ' AND created_at >= ?';
      params.push(startTs);
    }
    if (endTs !== null) {
      query += ' AND created_at <= ?';
      params.push(endTs);
    }

    query += ' GROUP BY date ORDER BY date DESC LIMIT ?';
    params.push(maxRows);

    const rows = this.db.prepare(query).all(...params);

    return rows.map((r) => ({
      date: r.date,
      totalRequests: Number(r.total_requests || 0),
      successfulRequests: Number(r.successful_requests || 0),
      failedRequests: Number(r.failed_requests || 0),
      promptTokens: Number(r.prompt_tokens || 0),
      outputTokens: Number(r.output_tokens || 0),
      totalTokens: Number(r.total_tokens || 0),
    }));
  }

  /**
   * Closes the database if owned by this instance.
   */
  close() {
    if (this._ownsDb && this.db && this.db.isOpen) {
      this.db.close();
    }
  }
}

