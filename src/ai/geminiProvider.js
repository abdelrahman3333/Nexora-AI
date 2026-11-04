import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { AIProviderError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
];

/**
 * Determines whether an error thrown during a Gemini API call is transient
 * (e.g., timeout, network glitch, 429 rate limit, 500/502/503/504 server error)
 * and safe to retry or fail over to a fallback model.
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isTransientAIError(error) {
  if (!error) return false;
  if (error.isRetryable === true) return true;

  const status = Number(error.status || error.statusCode || error.code);
  if ([408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const msg = String(error.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('resource_exhausted')
  );
}

/**
 * Platform-agnostic Gemini AI Provider using the official @google/genai SDK.
 * Supports timeouts, controlled exponential backoff retries, automatic model
 * failover on 503/429 spikes, and dependency injection for unit testing.
 */
export class GeminiProvider {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.model='gemini-3.5-flash']
   * @param {string[]} [options.fallbackModels]
   * @param {number} [options.timeoutMs=20000]
   * @param {number} [options.maxRetries=2]
   * @param {number} [options.temperature=0.2]
   * @param {number} [options.baseRetryDelayMs=300]
   * @param {object} [options.client] - Optional pre-configured GoogleGenAI client (for testing)
   * @param {object} [options.usageTracker] - Optional usage tracking store (records tokens and attempts)
   * @param {import('pino').Logger} [options.log]
   */
  constructor({
    apiKey,
    model = 'gemini-3.5-flash',
    fallbackModels = DEFAULT_FALLBACK_MODELS,
    timeoutMs = 20000,
    maxRetries = 2,
    temperature = 0.2,
    baseRetryDelayMs = 300,
    client = null,
    usageTracker = null,
    log = logger,
  }) {
    if (!client && (!apiKey || typeof apiKey !== 'string')) {
      throw new Error('GeminiProvider requires a valid apiKey or injected client');
    }

    this.model = model;
    this.fallbackModels = Array.from(new Set([model, ...(fallbackModels || [])]));
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.temperature = temperature;
    this.baseRetryDelayMs = baseRetryDelayMs;
    this.usageTracker = usageTracker;
    this.log = log;
    this.client = client || new GoogleGenAI({ apiKey });
  }

  /**
   * Converts conversation history turns and the latest user message into the
   * `contents` array format required by `@google/genai`.
   *
   * @param {Array<{role: 'user'|'model', text: string}>} history
   * @param {string} currentMessage
   * @returns {Array<{role: 'user'|'model', parts: Array<{text: string}>}>}
   */
  _buildContents(history = [], currentMessage) {
    const contents = history.map((turn) => ({
      role: turn.role === 'model' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    }));

    contents.push({
      role: 'user',
      parts: [{ text: currentMessage }],
    });

    return contents;
  }

  /**
   * Executes a single generateContent request wrapped with a strict timeout.
   *
   * @param {object} payload
   * @returns {Promise<any>}
   */
  async _callWithTimeout(payload) {
    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(
          new AIProviderError(`Gemini API request timed out after ${this.timeoutMs}ms`, {
            code: 'AI_TIMEOUT',
            isRetryable: true,
            statusCode: 504,
          })
        );
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.client.models.generateContent(payload),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timerId);
    }
  }

  /**
   * Generates an AI response given system instructions, conversation history,
   * and the user's current message. Includes controlled retry logic and model
   * failover for transient failures.
   *
   * @param {object} params
   * @param {string} params.systemInstruction
   * @param {Array<{role: 'user'|'model', text: string}>} [params.history=[]]
   * @param {string} params.userMessage
   * @param {string} [params.businessId='default']
   * @param {string} [params.botId='default']
   * @param {string} [params.requestId]
   * @returns {Promise<string>}
   */
  async generateReply({
    systemInstruction,
    history = [],
    userMessage,
    businessId = 'default',
    botId = 'default',
    requestId = undefined,
  }) {
    const contents = this._buildContents(history, userMessage);
    const baseRequestId =
      requestId || `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    let attempt = 0;
    let lastError = null;

    while (attempt <= this.maxRetries) {
      const candidateModel =
        this.fallbackModels[attempt % this.fallbackModels.length] || this.model;
      const attemptNumber = attempt + 1;
      const attemptRequestId = `${baseRequestId}_a${attemptNumber}`;

      const payload = {
        model: candidateModel,
        contents,
        config: {
          systemInstruction,
          temperature: this.temperature,
        },
      };

      try {
        const response = await this._callWithTimeout(payload);
        const replyText =
          typeof response?.text === 'string' ? response.text.trim() : '';

        if (!replyText) {
          throw new AIProviderError('Gemini returned an empty response', {
            code: 'AI_EMPTY_RESPONSE',
            isRetryable: false,
            statusCode: 502,
          });
        }

        // Extract usageMetadata safely from Gemini response
        const usageMetadata = response?.usageMetadata || {};
        const promptTokens = Math.max(
          0,
          Number(usageMetadata.promptTokenCount ?? usageMetadata.promptTokens ?? 0)
        );
        const candidatesTokens = Math.max(
          0,
          Number(
            usageMetadata.candidatesTokenCount ??
              usageMetadata.candidatesTokens ??
              0
          )
        );
        const totalTokens = Math.max(
          0,
          Number(
            usageMetadata.totalTokenCount ??
              usageMetadata.totalTokens ??
              promptTokens + candidatesTokens
          )
        );

        if (this.usageTracker && typeof this.usageTracker.recordUsage === 'function') {
          try {
            this.usageTracker.recordUsage({
              business_id: businessId,
              bot_id: botId,
              model: candidateModel,
              request_id: attemptRequestId,
              prompt_tokens: promptTokens,
              candidates_tokens: candidatesTokens,
              total_tokens: totalTokens,
              is_success: 1,
              error_code: null,
              attempt_number: attemptNumber,
              created_at: Date.now(),
            });
          } catch (trackerErr) {
            this.log.warn({ trackerErr }, 'Failed to record AI usage log (safe failover)');
          }
        }

        return replyText;
      } catch (err) {
        lastError = err;
        const retryable = isTransientAIError(err);
        const status = Number(err.status || err.statusCode || err.code);
        const errorCode = status
          ? String(status)
          : String(err.code || (err.message?.includes('429') ? '429' : 'AI_ERROR'));

        // Track failed attempt (is_success = 0)
        if (this.usageTracker && typeof this.usageTracker.recordUsage === 'function') {
          try {
            this.usageTracker.recordUsage({
              business_id: businessId,
              bot_id: botId,
              model: candidateModel,
              request_id: attemptRequestId,
              prompt_tokens: 0,
              candidates_tokens: 0,
              total_tokens: 0,
              is_success: 0,
              error_code: errorCode,
              attempt_number: attemptNumber,
              created_at: Date.now(),
            });
          } catch (trackerErr) {
            this.log.warn({ trackerErr }, 'Failed to record failed AI attempt log');
          }
        }

        if (!retryable || attempt >= this.maxRetries) {
          this.log.error(
            {
              model: candidateModel,
              attempt: attemptNumber,
              maxRetries: this.maxRetries,
              retryable,
              err,
            },
            'Gemini AI generation failed permanently'
          );
          break;
        }

        const backoffMs = this.baseRetryDelayMs * Math.pow(2, attempt);
        this.log.warn(
          {
            failedModel: candidateModel,
            attempt: attemptNumber,
            maxRetries: this.maxRetries,
            backoffMs,
            err,
          },
          'Transient Gemini AI error encountered; retrying with backoff/fallback...'
        );

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        attempt += 1;
      }
    }

    if (lastError instanceof AIProviderError) {
      throw lastError;
    }

    throw new AIProviderError('Failed to generate AI response from Gemini', {
      code: lastError?.code || 'AI_GENERATION_FAILED',
      isRetryable: isTransientAIError(lastError),
      statusCode: Number(lastError?.status || lastError?.statusCode) || 502,
    });
  }
}
