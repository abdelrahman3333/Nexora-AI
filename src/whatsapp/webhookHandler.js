import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export const DEDUPLICATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Handles WhatsApp Cloud API Webhook verification, signature validation,
 * deduplication, and message routing to SupportService and Gemini AI.
 */
export class WhatsAppWebhookHandler {
  /**
   * @param {object} options
   * @param {string} [options.verifyToken] - Verification token configured in Meta App Dashboard
   * @param {string} [options.appSecret] - Meta App Secret (for X-Hub-Signature-256 verification)
   * @param {import('../services/supportService.js').SupportService} options.supportService - Core AI support service
   * @param {import('./whatsappClient.js').WhatsAppClient} options.whatsappClient - Client to dispatch replies
   * @param {string} [options.defaultBusinessId='nexora-coffee-sa'] - Default business tenant fallback
   * @param {Record<string, string>} [options.phoneBusinessMap={}] - Mapping of phone_number_id -> business_id
   * @param {import('pino').Logger} [options.log]
   */
  constructor({
    verifyToken = '',
    appSecret = '',
    supportService,
    whatsappClient,
    defaultBusinessId = 'nexora-coffee-sa',
    phoneBusinessMap = {},
    log = logger,
  } = {}) {
    let cleanVerify = String(verifyToken || '').trim();
    if (cleanVerify.startsWith('WHATSAPP_VERIFY_TOKEN=')) {
      cleanVerify = cleanVerify.replace(/^WHATSAPP_VERIFY_TOKEN=/, '').trim();
    }
    if (
      (cleanVerify.startsWith('"') && cleanVerify.endsWith('"')) ||
      (cleanVerify.startsWith("'") && cleanVerify.endsWith("'"))
    ) {
      cleanVerify = cleanVerify.slice(1, -1).trim();
    }

    this.verifyToken = cleanVerify;
    this.appSecret = String(appSecret || '').trim();
    this.supportService = supportService;
    this.whatsappClient = whatsappClient;
    this.defaultBusinessId =
      defaultBusinessId || supportService?.defaultBusinessId || 'nexora-coffee-sa';
    this.phoneBusinessMap = { ...phoneBusinessMap };
    this.log = log;

    /**
     * Map of processed message IDs to their reception timestamp for deduplication.
     * @type {Map<string, number>}
     */
    this.processedMessageIds = new Map();
  }

  /**
   * Verifies the Meta Webhook setup challenge (GET request).
   *
   * @param {object} params
   * @param {string} [params.mode] - Expected to be 'subscribe'
   * @param {string} [params.token] - Provided token to match against verifyToken
   * @param {string} [params.challenge] - Meta challenge string
   * @returns {{ valid: boolean, challenge?: string, status: number, message: string }}
   */
  verifyChallenge({ mode, token, challenge }) {
    if (!this.verifyToken) {
      this.log.warn('WHATSAPP_VERIFY_TOKEN is not configured on server');
      return {
        valid: false,
        status: 500,
        message: 'WHATSAPP_VERIFY_TOKEN is not configured',
      };
    }

    let cleanToken = String(token || '').trim();
    if (cleanToken.startsWith('WHATSAPP_VERIFY_TOKEN=')) {
      cleanToken = cleanToken.replace(/^WHATSAPP_VERIFY_TOKEN=/, '').trim();
    }
    if (
      (cleanToken.startsWith('"') && cleanToken.endsWith('"')) ||
      (cleanToken.startsWith("'") && cleanToken.endsWith("'"))
    ) {
      cleanToken = cleanToken.slice(1, -1).trim();
    }

    const cleanMode = String(mode || '').trim();
    const cleanChallenge = String(challenge || '').trim();

    // Constant-time token comparison
    const bufA = Buffer.from(cleanToken, 'utf-8');
    const bufB = Buffer.from(this.verifyToken, 'utf-8');
    const isTokenMatch =
      bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);

    if (cleanMode === 'subscribe' && isTokenMatch) {
      this.log.info(
        {
          mode: cleanMode,
          hasChallenge: Boolean(cleanChallenge),
          challengeLength: cleanChallenge.length,
        },
        'Meta WhatsApp webhook verification challenge succeeded'
      );
      return {
        valid: true,
        challenge: cleanChallenge,
        status: 200,
        message: 'Verified',
      };
    }

    this.log.warn(
      {
        mode: cleanMode,
        receivedTokenLength: cleanToken.length,
        expectedTokenLength: this.verifyToken.length,
        isTokenMatch,
      },
      'Meta WhatsApp webhook verification challenge failed (token or mode mismatch)'
    );

    return {
      valid: false,
      status: 403,
      message: 'Forbidden: Invalid verification token',
    };
  }

  /**
   * Verifies the SHA256 HMAC signature of the raw request payload.
   *
   * @param {Buffer} rawBody - Raw request body buffer
   * @param {string} [signatureHeader] - Value of 'x-hub-signature-256' header
   * @returns {boolean}
   */
  verifySignature(rawBody, signatureHeader) {
    if (!this.appSecret) {
      // If no app secret is configured, bypass signature verification (useful in local dev / mocking)
      return true;
    }

    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return false;
    }

    const parts = signatureHeader.trim().split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') {
      return false;
    }

    const remoteHash = parts[1];
    const localHash = crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');

    const bufRemote = Buffer.from(remoteHash, 'utf-8');
    const bufLocal = Buffer.from(localHash, 'utf-8');

    if (bufRemote.length !== bufLocal.length) {
      return false;
    }

    return crypto.timingSafeEqual(bufRemote, bufLocal);
  }

  /**
   * Checks whether a message ID has already been received within the deduplication window.
   * Cleans up expired entries periodically.
   *
   * @param {string} messageId
   * @returns {boolean}
   */
  isDuplicate(messageId) {
    if (!messageId) return false;

    const now = Date.now();

    // Lazy cleanup of entries older than DEDUPLICATION_WINDOW_MS
    if (this.processedMessageIds.size > 1000) {
      for (const [id, timestamp] of this.processedMessageIds.entries()) {
        if (now - timestamp > DEDUPLICATION_WINDOW_MS) {
          this.processedMessageIds.delete(id);
        }
      }
    }

    if (this.processedMessageIds.has(messageId)) {
      return true;
    }

    this.processedMessageIds.set(messageId, now);
    return false;
  }

  /**
   * Resolves the associated business tenant ID for a given WhatsApp phone number ID.
   *
   * @param {string} [phoneNumberId]
   * @returns {string}
   */
  resolveBusinessId(phoneNumberId) {
    if (phoneNumberId && this.phoneBusinessMap[phoneNumberId]) {
      return this.phoneBusinessMap[phoneNumberId];
    }
    return this.defaultBusinessId;
  }

  /**
   * Processes an incoming WhatsApp webhook payload.
   * Acknowledges delivery promptly and generates AI replies asynchronously.
   *
   * @param {object} payload - Parsed JSON webhook body from Meta
   * @returns {Promise<{ processedMessages: number, status: string }>}
   */
  async handleWebhookPayload(payload) {
    if (payload?.object !== 'whatsapp_business_account') {
      return { processedMessages: 0, status: 'ignored_object' };
    }

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    let count = 0;

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;

        const value = change.value || {};
        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id || null;
        const messages = Array.isArray(value.messages) ? value.messages : [];

        // If this change only contains delivery/read statuses, acknowledge without processing
        if (messages.length === 0 && Array.isArray(value.statuses)) {
          this.log.debug(
            { statusesCount: value.statuses.length },
            'Received WhatsApp message status updates (safe acknowledge)'
          );
          continue;
        }

        for (const msg of messages) {
          const messageId = msg.id;
          const from = msg.from;
          const type = msg.type;

          if (this.isDuplicate(messageId)) {
            this.log.info({ messageId, from }, 'Ignoring duplicate WhatsApp message event');
            continue;
          }

          count += 1;
          const businessId = this.resolveBusinessId(phoneNumberId);

          // Mark message as read in the background (fire-and-forget)
          if (this.whatsappClient && messageId) {
            this.whatsappClient
              .markMessageAsRead({ messageId, phoneNumberId })
              .catch(() => {});
          }

          // Process and reply asynchronously
          this._processIncomingMessage({
            businessId,
            phoneNumberId,
            messageId,
            from,
            type,
            msg,
          }).catch((err) => {
            this.log.error(
              { err, businessId, from, messageId },
              'Error processing incoming WhatsApp message'
            );
          });
        }
      }
    }

    return { processedMessages: count, status: 'ok' };
  }

  /**
   * Internal worker method to process an individual incoming message and dispatch the AI reply.
   *
   * @private
   */
  async _processIncomingMessage({
    businessId,
    phoneNumberId,
    messageId,
    from,
    type,
    msg,
  }) {
    if (!this.supportService) {
      this.log.error('SupportService is not available; cannot generate AI reply');
      return;
    }

    // Handle non-text messages politely
    if (type !== 'text') {
      this.log.info(
        { from, type, messageId },
        'Received unsupported WhatsApp message type (non-text)'
      );

      if (this.whatsappClient && this.whatsappClient.isConfigured()) {
        await this.whatsappClient.sendTextMessage({
          to: from,
          text: 'أهلاً بك! نعتذر، نستطيع حالياً استقبال الرسائل النصية فقط عبر واتساب. تفضل بكتابة استفسارك وسأساعدك فوراً.',
          phoneNumberId,
        });
      }
      return;
    }

    const messageText = msg.text?.body || '';
    if (!messageText.trim()) return;

    this.log.info(
      { businessId, from, messageId },
      'Generating Gemini AI response for incoming WhatsApp message'
    );

    let replyText = '';
    if (typeof this.supportService.generateResponse === 'function') {
      replyText = await this.supportService.generateResponse({
        businessId,
        botId: 'whatsapp',
        userId: from,
        message: messageText,
        platform: 'whatsapp',
      });
    } else if (typeof this.supportService.handleIncomingMessage === 'function') {
      const result = await this.supportService.handleIncomingMessage({
        businessId,
        botId: 'whatsapp',
        userId: from,
        text: messageText,
        messageId,
        platform: 'whatsapp',
      });
      replyText = typeof result === 'string' ? result : (result?.text || '');
    }

    if (this.whatsappClient && this.whatsappClient.isConfigured()) {
      await this.whatsappClient.sendTextMessage({
        to: from,
        text: replyText,
        phoneNumberId,
      });
    } else {
      this.log.warn(
        { businessId, from, replyText },
        'WhatsApp client is not configured; AI reply was generated but not dispatched'
      );
    }
  }
}

