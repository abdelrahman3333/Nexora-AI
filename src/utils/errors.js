export class AppError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.code]
   * @param {boolean} [options.isRetryable]
   * @param {number} [options.statusCode]
   */
  constructor(message, { code = 'APP_ERROR', isRetryable = false, statusCode = 500 } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.isRetryable = isRetryable;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends AppError {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(message, { code, isRetryable: false, statusCode: 400 });
  }
}

export class RateLimitError extends AppError {
  /**
   * @param {string} message
   * @param {number} retryAfterSeconds
   */
  constructor(message, retryAfterSeconds = 60) {
    super(message, { code: 'RATE_LIMIT_EXCEEDED', isRetryable: false, statusCode: 429 });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AIProviderError extends AppError {
  constructor(message, { code = 'AI_PROVIDER_ERROR', isRetryable = false, statusCode = 502 } = {}) {
    super(message, { code, isRetryable, statusCode });
  }
}

/**
 * Returns a localized, customer-safe error message in Gulf Arabic or English.
 * Never exposes stack traces, internal codes, or API keys.
 *
 * @param {'ar' | 'en'} language
 * @param {'general' | 'rate_limit' | 'too_long' | 'empty' | 'unsupported_media'} type
 * @param {object} [meta]
 * @returns {string}
 */
export function getSafeUserMessage(language = 'ar', type = 'general', meta = {}) {
  const isEnglish = language === 'en';

  switch (type) {
    case 'rate_limit': {
      const waitSec = meta.retryAfterSeconds || 60;
      return isEnglish
        ? `You have sent too many messages in a short time. Please wait ${waitSec} seconds and try again.`
        : `عذراً منك، تم إرسال عدد كبير من الرسائل خلال وقت قصير. يرجى الانتظار ${waitSec} ثانية والمحاولة مرة أخرى، وحاضرين لخدمتك.`;
    }
    case 'too_long': {
      const maxLen = meta.maxLength || 1500;
      return isEnglish
        ? `Your message is too long. Please shorten it to under ${maxLen} characters so I can assist you properly.`
        : `عذراً، رسالتك طويلة جداً. يرجى اختصارها لأقل من ${maxLen} حرف عشان نقدر نخدمك بشكل أفضل.`;
    }
    case 'empty':
      return isEnglish
        ? 'Please send a clear text message so I can help you.'
        : 'حياك الله، يرجى كتابة استفسارك في رسالة نصية واضحة وأبشر بالمساعدة.';
    case 'unsupported_media':
      return isEnglish
        ? 'I currently support text messages only. Could you please write your inquiry as text? I would be happy to assist you.'
        : 'حياك الله! حالياً أستقبل الرسائل النصية فقط. يا ليت تكتب استفسارك نصياً وأبشر بسعدك.';
    case 'general':
    default:
      return isEnglish
        ? 'Apologies, we are experiencing a temporary technical delay. Please try again in a few moments.'
        : 'نعتذر منك، نواجه حالياً ضغطاً أو خللاً تقنياً مؤقتاً. يرجى المحاولة مرة ثانية بعد قليل، وفالك طيب.';
  }
}

