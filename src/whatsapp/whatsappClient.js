import { logger } from '../utils/logger.js';

export const DEFAULT_GRAPH_API_VERSION = 'v21.0';
export const GRAPH_API_BASE_URL = 'https://graph.facebook.com';

/**
 * Official Meta WhatsApp Cloud API Client.
 * Handles dispatching outbound text messages and read receipts with strict timeout
 * controls, non-crashing error handling, and zero token leakage in logs.
 */
export class WhatsAppClient {
  /**
   * @param {object} options
   * @param {string} [options.accessToken] - Meta System User or WhatsApp Business Access Token
   * @param {string} [options.phoneNumberId] - Meta Phone Number ID
   * @param {string} [options.apiVersion='v21.0'] - Meta Graph API Version
   * @param {string} [options.baseUrl='https://graph.facebook.com'] - Base URL (overridable for testing)
   * @param {number} [options.timeoutMs=15000] - Request timeout in milliseconds
   * @param {Function} [options.fetchFn] - Pluggable fetch function (for unit tests)
   * @param {import('pino').Logger} [options.log]
   */
  constructor({
    accessToken = '',
    phoneNumberId = '',
    apiVersion = DEFAULT_GRAPH_API_VERSION,
    baseUrl = GRAPH_API_BASE_URL,
    timeoutMs = 15000,
    fetchFn = globalThis.fetch,
    log = logger,
  } = {}) {
    this.accessToken = String(accessToken || '').trim();
    this.phoneNumberId = String(phoneNumberId || '').trim();
    this.apiVersion = String(apiVersion || DEFAULT_GRAPH_API_VERSION).trim();
    this.baseUrl = String(baseUrl || GRAPH_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
    this.log = log;
  }

  /**
   * Checks whether the client has the minimal credentials required to send messages.
   *
   * @returns {boolean}
   */
  isConfigured() {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  /**
   * Dispatches an outbound text message to a WhatsApp user.
   *
   * @param {object} params
   * @param {string} params.to - Recipient phone number in international format without '+' (e.g. 966500000000)
   * @param {string} params.text - The message body text
   * @param {boolean} [params.previewUrl=false] - Whether to show link preview
   * @param {string} [params.phoneNumberId] - Optional phone number ID override (for multi-tenant setups)
   * @returns {Promise<{ success: boolean, messageId?: string, raw?: any }>}
   */
  async sendTextMessage({ to, text, previewUrl = false, phoneNumberId = null }) {
    const cleanTo = String(to || '').replace(/[^\d]/g, '');
    const cleanText = String(text || '').trim();
    const activePhoneId = String(phoneNumberId || this.phoneNumberId).trim();

    if (!cleanTo) {
      throw new Error('Recipient phone number ("to") is required for WhatsApp message dispatch');
    }
    if (!cleanText) {
      throw new Error('Message text cannot be empty for WhatsApp message dispatch');
    }
    if (!this.accessToken) {
      throw new Error('WHATSAPP_ACCESS_TOKEN is missing or not configured');
    }
    if (!activePhoneId) {
      throw new Error('WHATSAPP_PHONE_NUMBER_ID is missing or not configured');
    }

    const endpoint = `${this.baseUrl}/${this.apiVersion}/${activePhoneId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: Boolean(previewUrl),
        body: cleanText,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorInfo = data?.error || {};
        const errorMsg = errorInfo.message || `Meta Graph API responded with status ${response.status}`;
        const errorCode = errorInfo.code || response.status;
        const errorSubcode = errorInfo.error_subcode || null;

        this.log.error(
          {
            status: response.status,
            errorCode,
            errorSubcode,
            type: errorInfo.type,
            recipient: cleanTo,
          },
          'Failed to send WhatsApp message via Meta Cloud API'
        );

        const error = new Error(`WhatsApp API Error [${errorCode}]: ${errorMsg}`);
        error.status = response.status;
        error.code = errorCode;
        error.details = errorInfo;
        throw error;
      }

      const messageId = data?.messages?.[0]?.id || null;
      this.log.info(
        { recipient: cleanTo, messageId },
        'Successfully dispatched WhatsApp text message'
      );

      return {
        success: true,
        messageId,
        raw: data,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        this.log.error(
          { timeoutMs: this.timeoutMs, recipient: cleanTo },
          'WhatsApp Cloud API request timed out'
        );
        throw new Error(`WhatsApp API request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Marks an incoming WhatsApp message as read.
   * Recommended by Meta to notify users that their inquiry is being processed.
   *
   * @param {object} params
   * @param {string} params.messageId - The incoming message ID (wamid.HBgL...)
   * @param {string} [params.phoneNumberId] - Optional phone number ID override
   * @returns {Promise<{ success: boolean }>}
   */
  async markMessageAsRead({ messageId, phoneNumberId = null }) {
    const cleanId = String(messageId || '').trim();
    const activePhoneId = String(phoneNumberId || this.phoneNumberId).trim();

    if (!cleanId || !this.accessToken || !activePhoneId) {
      return { success: false };
    }

    const endpoint = `${this.baseUrl}/${this.apiVersion}/${activePhoneId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: cleanId,
    };

    try {
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      return { success: response.ok };
    } catch (err) {
      this.log.debug({ err, messageId: cleanId }, 'Failed to mark WhatsApp message as read (safe ignore)');
      return { success: false };
    }
  }
}

