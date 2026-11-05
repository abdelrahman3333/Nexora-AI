import crypto from 'node:crypto';
import { buildSystemPrompt } from '../ai/promptBuilder.js';
import { validateAndSanitizeInput } from '../middleware/inputValidator.js';
import { getSafeUserMessage, RateLimitError, ValidationError } from '../utils/errors.js';
import { detectLanguage } from '../utils/localization.js';
import { logger } from '../utils/logger.js';

/**
 * Platform-agnostic Multi-Business Customer Support & Sales Engine for Nexora AI.
 *
 * This service does NOT depend on Telegram, WhatsApp, or Instagram SDKs.
 * Supports multiple isolated businesses via `businessStore` (keyed by `businessId` / `tenantId`),
 * while preserving backward compatibility when a static `businessConfig` + `knowledge` is passed.
 */
export class SupportService {
  /**
   * @param {object} options
   * @param {import('../ai/geminiProvider.js').GeminiProvider} options.aiProvider
   * @param {import('../memory/conversationStore.js').ConversationStore} options.conversationStore
   * @param {import('../middleware/rateLimiter.js').RateLimiter} options.rateLimiter
   * @param {import('../config/businessStore.js').BusinessStore} [options.businessStore]
   * @param {string} [options.defaultBusinessId]
   * @param {object} [options.businessConfig]
   * @param {object} [options.knowledge]
   * @param {number} [options.maxMessageLength=1500]
   * @param {number} [options.dedupCacheSize=500]
   * @param {import('pino').Logger} [options.log]
   */
  constructor({
    aiProvider,
    conversationStore,
    rateLimiter,
    businessStore = null,
    defaultBusinessId = '',
    businessConfig = null,
    knowledge = null,
    maxMessageLength = 1500,
    dedupCacheSize = 500,
    log = logger,
  }) {
    if (!aiProvider || !conversationStore || !rateLimiter) {
      throw new Error(
        'SupportService requires aiProvider, conversationStore, and rateLimiter'
      );
    }

    this.aiProvider = aiProvider;
    this.conversationStore = conversationStore;
    this.rateLimiter = rateLimiter;
    this.businessStore = businessStore;
    this.businessConfig = businessConfig;
    this.knowledge = knowledge;
    this.defaultBusinessId =
      defaultBusinessId ||
      businessConfig?.businessId ||
      businessConfig?.tenantId ||
      (businessStore ? businessStore.listBusinesses()[0]?.business_id : 'default-gcc-store');
    this.maxMessageLength = maxMessageLength;
    this.dedupCacheSize = dedupCacheSize;
    this.log = log;
    /** @type {Set<string>} */
    this.processedMessageIds = new Set();
  }

  /**
   * Resolves the active `{ businessId, businessConfig, knowledge }` dynamically from `businessStore`
   * before every answer so that price/product updates take effect immediately and businesses never leak.
   *
   * @param {string} [requestedBusinessId]
   * @returns {{ businessId: string, businessConfig: object, knowledge: object }}
   */
  resolveBusinessContext(requestedBusinessId) {
    const targetId = String(
      requestedBusinessId || this.defaultBusinessId || 'default-gcc-store'
    ).trim();

    if (this.businessStore) {
      if (this.businessStore.hasBusiness(targetId)) {
        const ctx = this.businessStore.getPromptContext(targetId);
        return {
          businessId: targetId,
          businessConfig: ctx.businessConfig,
          knowledge: ctx.knowledge,
        };
      }

      // If requested ID is the legacy env default ('default-gcc-store') and not explicitly in businessStore,
      // fall back to `this.defaultBusinessId` if valid in store, otherwise throw to prevent cross-business leakage.
      if (
        targetId === 'default-gcc-store' &&
        this.businessStore.hasBusiness(this.defaultBusinessId)
      ) {
        const ctx = this.businessStore.getPromptContext(this.defaultBusinessId);
        return {
          businessId: this.defaultBusinessId,
          businessConfig: ctx.businessConfig,
          knowledge: ctx.knowledge,
        };
      }

      // Throw when an unknown business_id is requested on a multi-business instance
      this.businessStore.getBusiness(targetId);
    }

    if (!this.businessConfig || !this.knowledge) {
      throw new Error(`No business configuration found for "${targetId}"`);
    }

    return {
      businessId: targetId,
      businessConfig: {
        ...this.businessConfig,
        businessId: targetId,
        tenantId: targetId,
      },
      knowledge: this.knowledge,
    };
  }

  /**
   * Checks if a platform messageId was already processed to prevent duplicate replies.
   *
   * @param {string} businessId
   * @param {string} platform
   * @param {string} botId
   * @param {string | number | undefined} messageId
   * @returns {boolean} True if duplicate
   */
  _isDuplicateMessage(businessId, platform, botId, messageId) {
    if (messageId === undefined || messageId === null || messageId === '') {
      return false;
    }

    const dedupKey = `${businessId}:${platform}:${botId || 'default'}:${String(messageId)}`;
    if (this.processedMessageIds.has(dedupKey)) {
      return true;
    }

    this.processedMessageIds.add(dedupKey);
    if (this.processedMessageIds.size > this.dedupCacheSize) {
      const oldestKey = this.processedMessageIds.values().next().value;
      this.processedMessageIds.delete(oldestKey);
    }

    return false;
  }

  /**
   * Resolves the effective response language ('ar' or 'en') based on business preference
   * and incoming text detection.
   *
   * @param {string} text
   * @param {object} activeBusinessConfig
   * @returns {'ar' | 'en'}
   */
  _resolveLanguage(text, activeBusinessConfig) {
    const pref = activeBusinessConfig?.languagePreference || 'auto';
    if (pref === 'ar' || pref === 'en') {
      return pref;
    }
    return detectLanguage(text, 'ar');
  }

  /**
   * Handles a customer text inquiry end-to-end for a specific business (`businessId` / `tenantId`):
   * 1. Dynamic business resolution (ensures latest prices/products & strict business isolation)
   * 2. Deduplication check scoped to businessId
   * 3. Language detection
   * 4. Input validation & sanitization
   * 5. Per-business, per-user rate limiting
   * 6. Isolated conversation history retrieval (`businessId:platform:userId`)
   * 7. Dynamic GCC system prompt assembly
   * 8. AI response generation & isolated history update
   *
   * @param {object} params
   * @param {string} [params.businessId]
   * @param {string} [params.tenantId]
   * @param {string} [params.botId='default']
   * @param {string} [params.platform='telegram']
   * @param {string} params.userId
   * @param {string} params.text
   * @param {string | number} [params.messageId]
   * @returns {Promise<{ text: string, language: 'ar'|'en', businessId: string, botId: string, duplicate?: boolean, isError?: boolean }>}
   */
  async handleIncomingMessage({
    businessId,
    tenantId,
    botId = 'default',
    platform = 'telegram',
    userId,
    text,
    messageId,
  }) {
    if (!userId) {
      throw new Error('userId is required to handle incoming message');
    }

    const resolved = this.resolveBusinessContext(businessId || tenantId);
    const activeBusinessId = resolved.businessId;
    const activeBotId = String(botId || 'default').trim();

    if (this._isDuplicateMessage(activeBusinessId, platform, activeBotId, messageId)) {
      this.log.debug(
        { businessId: activeBusinessId, botId: activeBotId, platform, userId, messageId },
        'Duplicate message ignored'
      );
      return {
        text: '',
        language: 'ar',
        businessId: activeBusinessId,
        botId: activeBotId,
        duplicate: true,
      };
    }

    const detectedLanguage = this._resolveLanguage(
      typeof text === 'string' ? text : '',
      resolved.businessConfig
    );

    // 1. Input Validation
    let sanitizedText;
    try {
      sanitizedText = validateAndSanitizeInput(text, {
        maxLength: this.maxMessageLength,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        const msgType = err.code === 'MESSAGE_TOO_LONG' ? 'too_long' : 'empty';
        return {
          text: getSafeUserMessage(detectedLanguage, msgType, {
            maxLength: this.maxMessageLength,
          }),
          language: detectedLanguage,
          businessId: activeBusinessId,
          botId: activeBotId,
          isError: true,
        };
      }
      throw err;
    }

    // 2. Per-Business, Per-Bot, Per-User Rate Limiting
    try {
      this.rateLimiter.consume(`${activeBusinessId}:${activeBotId}`, userId);
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.log.warn(
          {
            businessId: activeBusinessId,
            botId: activeBotId,
            platform,
            userId,
            retryAfterSeconds: err.retryAfterSeconds,
          },
          'User rate limit exceeded'
        );
        return {
          text: getSafeUserMessage(detectedLanguage, 'rate_limit', {
            retryAfterSeconds: err.retryAfterSeconds,
          }),
          language: detectedLanguage,
          businessId: activeBusinessId,
          botId: activeBotId,
          isError: true,
        };
      }
      throw err;
    }

    // 3. Isolated Conversation History & Dynamic System Prompt Assembly
    const history = this.conversationStore.getHistory(
      activeBusinessId,
      userId,
      platform,
      activeBotId
    );
    const systemInstruction = buildSystemPrompt({
      businessConfig: resolved.businessConfig,
      knowledge: resolved.knowledge,
      detectedUserLanguage: detectedLanguage,
    });

    // 4. Generate AI Reply via Gemini Provider
    try {
      const uniqueRequestId = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const aiReply = await this.aiProvider.generateReply({
        systemInstruction,
        history,
        userMessage: sanitizedText,
        businessId: activeBusinessId,
        botId: activeBotId,
        requestId: uniqueRequestId,
      });

      this.conversationStore.appendMessage(
        activeBusinessId,
        userId,
        'user',
        sanitizedText,
        platform,
        activeBotId
      );
      this.conversationStore.appendMessage(
        activeBusinessId,
        userId,
        'model',
        aiReply,
        platform,
        activeBotId
      );

      return {
        text: aiReply,
        language: detectedLanguage,
        businessId: activeBusinessId,
        botId: activeBotId,
        isError: false,
      };
    } catch (err) {
      this.log.error(
        { businessId: activeBusinessId, botId: activeBotId, platform, userId, err },
        'Error generating AI customer support reply'
      );
      return {
        text: getSafeUserMessage(detectedLanguage, 'general'),
        language: detectedLanguage,
        businessId: activeBusinessId,
        botId: activeBotId,
        isError: true,
      };
    }
  }

  /**
   * Convenience alias for handleIncomingMessage returning the reply text string directly.
   *
   * @param {object} params
   * @param {string} [params.businessId]
   * @param {string} [params.tenantId]
   * @param {string} [params.botId='default']
   * @param {string} [params.platform='telegram']
   * @param {string} params.userId
   * @param {string} params.message
   * @returns {Promise<string>}
   */
  async generateResponse({
    businessId,
    tenantId,
    botId = 'default',
    platform = 'telegram',
    userId,
    message,
  }) {
    const res = await this.handleIncomingMessage({
      businessId,
      tenantId,
      botId,
      platform,
      userId,
      text: message,
    });
    return res.text;
  }

  /**
   * Resets a customer's conversation history for a specific business and bot.
   *
   * @param {object} params
   * @param {string} [params.businessId]
   * @param {string} [params.tenantId]
   * @param {string} [params.botId='default']
   * @param {string} [params.platform='telegram']
   * @param {string} params.userId
   * @param {'ar' | 'en'} [params.language='ar']
   * @returns {{ text: string, language: 'ar'|'en', businessId: string, botId: string }}
   */
  resetConversation({
    businessId,
    tenantId,
    botId = 'default',
    platform = 'telegram',
    userId,
    language = 'ar',
  }) {
    const resolved = this.resolveBusinessContext(businessId || tenantId);
    const activeBusinessId = resolved.businessId;
    const activeBotId = String(botId || 'default').trim();

    this.conversationStore.clearHistory(
      activeBusinessId,
      userId,
      platform,
      activeBotId
    );
    this.log.info(
      { businessId: activeBusinessId, botId: activeBotId, platform, userId },
      'User conversation history reset'
    );

    const reply =
      language === 'en'
        ? 'Your conversation history has been cleared. How can I help you today?'
        : 'تم مسح سجل المحادثة وبدء جلسة جديدة بنجاح. حياك الله، كيف أقدر أخدمك اليوم؟';

    return {
      text: reply,
      language,
      businessId: activeBusinessId,
      botId: activeBotId,
    };
  }

  /**
   * Returns a polite localized response when a customer sends an unsupported
   * message type (e.g., sticker, voice note, video, photo, location).
   *
   * @param {object} [params]
   * @param {'ar' | 'en'} [params.language='ar']
   * @returns {{ text: string, language: 'ar'|'en' }}
   */
  handleUnsupportedMessage({ language = 'ar' } = {}) {
    return {
      text: getSafeUserMessage(language, 'unsupported_media'),
      language,
    };
  }
}
