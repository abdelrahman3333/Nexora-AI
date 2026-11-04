import { describe, expect, it } from 'vitest';
import { validateAndSanitizeInput } from '../src/middleware/inputValidator.js';
import { ValidationError } from '../src/utils/errors.js';
import { detectLanguage, formatCurrency } from '../src/utils/localization.js';
import { redactSecretsFromString } from '../src/utils/logger.js';

describe('Input Validation & Gulf Localization Utilities', () => {
  it('validates normal Gulf Arabic and English customer inquiries', () => {
    const ar = validateAndSanitizeInput('  السلام عليكم، بكم مطحنة القهوة؟  ');
    expect(ar).toBe('السلام عليكم، بكم مطحنة القهوة؟');

    const en = validateAndSanitizeInput('Do you ship to Jeddah?');
    expect(en).toBe('Do you ship to Jeddah?');
  });

  it('strips non-printable ASCII control characters safely', () => {
    const dirty = 'مرحبا\u0000\u0007 بكم السعر؟';
    expect(validateAndSanitizeInput(dirty)).toBe('مرحبا بكم السعر؟');
  });

  it('rejects empty or whitespace-only messages', () => {
    expect(() => validateAndSanitizeInput('   \n\t  ')).toThrow(ValidationError);
    expect(() => validateAndSanitizeInput('')).toThrow(ValidationError);
  });

  it('rejects messages exceeding the configured maxLength', () => {
    const oversized = 'أ'.repeat(201);
    expect(() =>
      validateAndSanitizeInput(oversized, { maxLength: 200 })
    ).toThrow(/exceeds maximum limit/);
  });

  it('detects Arabic and English language accurately', () => {
    expect(detectLanguage('السلام عليكم، ابي استفسر عن الطلب')).toBe('ar');
    expect(detectLanguage('Hello, how much is the coffee grinder?')).toBe('en');
    // Defaults to 'ar' for numbers/symbols only
    expect(detectLanguage('12345 ???')).toBe('ar');
  });

  it('formats GCC currencies properly for SAR, AED, and KWD', () => {
    expect(formatCurrency(450, 'SAR', 'ar')).toBe('450 ر.س (SAR)');
    expect(formatCurrency(450, 'SAR', 'en')).toBe('450 SAR');
    expect(formatCurrency(320, 'AED', 'ar')).toBe('320 د.إ (AED)');
    expect(formatCurrency(15.5, 'KWD', 'ar')).toBe('15.500 د.ك (KWD)');
  });

  it('redacts Telegram bot tokens and Google API keys from log strings', () => {
    const leakyLog =
      'Failed request with token 123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789 and key AIzaSyD1234567890abcdefghijklmnopqrstuv';
    const sanitized = redactSecretsFromString(leakyLog);

    expect(sanitized).not.toContain('ABCdefGHIjklMNOpqrsTUVwxyz123456789');
    expect(sanitized).not.toContain('AIzaSyD1234567890abcdefghijklmnopqrstuv');
    expect(sanitized).toContain('[REDACTED_TELEGRAM_TOKEN]');
    expect(sanitized).toContain('[REDACTED_GOOGLE_API_KEY]');
  });
});

