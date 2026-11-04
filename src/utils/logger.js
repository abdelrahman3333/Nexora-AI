import pino from 'pino';

/**
 * Redacts potential API keys, Telegram bot tokens, and authorization secrets
 * from any string before logging.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecretsFromString(text) {
  if (typeof text !== 'string') return text;
  return text
    // Redact Telegram Bot Tokens (e.g., 123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789)
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,50}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
    // Redact Google API Keys (AIza...)
    .replace(/\bAIza[0-9A-Za-z-_]{30,45}\b/g, '[REDACTED_GOOGLE_API_KEY]')
    // Redact generic Bearer tokens
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Creates a structured Pino logger configured with secret redaction paths.
 *
 * @param {object} [options]
 * @param {string} [options.level]
 * @returns {import('pino').Logger}
 */
export function createLogger(options = {}) {
  const level =
    options.level ||
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

  return pino({
    level,
    redact: {
      paths: [
        'TELEGRAM_BOT_TOKEN',
        'GEMINI_API_KEY',
        'apiKey',
        'token',
        'botToken',
        'headers.authorization',
        '*.TELEGRAM_BOT_TOKEN',
        '*.GEMINI_API_KEY',
        '*.apiKey',
        '*.token',
        'err.config.headers',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    hooks: {
      logMethod(inputArgs, method) {
        const sanitizedArgs = inputArgs.map((arg) => {
          if (typeof arg === 'string') {
            return redactSecretsFromString(arg);
          }
          if (arg instanceof Error) {
            return {
              type: arg.name,
              message: redactSecretsFromString(arg.message),
              code: arg.code,
              status: arg.status,
            };
          }
          if (arg && typeof arg === 'object' && arg.err instanceof Error) {
            return {
              ...arg,
              err: {
                type: arg.err.name,
                message: redactSecretsFromString(arg.err.message),
                code: arg.err.code,
                status: arg.err.status,
              },
            };
          }
          return arg;
        });
        return method.apply(this, sanitizedArgs);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = createLogger();

