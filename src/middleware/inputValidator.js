import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';

// Matches ASCII and Unicode control characters except standard whitespace (\t, \n, \r)
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Strips non-printable control characters and normalizes excessive blank lines.
 *
 * @param {string} rawText
 * @returns {string}
 */
export function sanitizeUserText(rawText) {
  if (typeof rawText !== 'string') return '';
  return rawText
    .replace(CONTROL_CHARS_REGEX, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/**
 * Validates and sanitizes an incoming customer text message.
 * Throws a ValidationError with a specific code ('EMPTY_MESSAGE' | 'MESSAGE_TOO_LONG')
 * if validation fails.
 *
 * @param {unknown} rawText
 * @param {object} [options]
 * @param {number} [options.maxLength=1500]
 * @returns {string} Sanitized valid text
 */
export function validateAndSanitizeInput(rawText, { maxLength = 1500 } = {}) {
  if (typeof rawText !== 'string') {
    throw new ValidationError('Message must be a text string', 'EMPTY_MESSAGE');
  }

  const sanitized = sanitizeUserText(rawText);

  if (sanitized.length === 0) {
    throw new ValidationError('Message cannot be empty', 'EMPTY_MESSAGE');
  }

  if (sanitized.length > maxLength) {
    throw new ValidationError(
      `Message length (${sanitized.length}) exceeds maximum limit of ${maxLength}`,
      'MESSAGE_TOO_LONG'
    );
  }

  const schema = z.string().min(1).max(maxLength);
  return schema.parse(sanitized);
}

