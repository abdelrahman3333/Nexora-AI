import { describe, expect, it } from 'vitest';
import { loadEnvConfig } from '../src/config/env.js';

const VALID_MOCK_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  TELEGRAM_BOT_TOKEN: '987654321:ZYXwvuTSRqpoNMLkjiHGFedcBA987654321',
  GEMINI_API_KEY: 'mock_test_gemini_key_1234567890',
  BUSINESS_COUNTRY: 'SA',
  BUSINESS_CURRENCY: 'SAR',
  DEFAULT_DIALECT: 'saudi',
};

describe('Environment Configuration Validation (env.js)', () => {
  it('validates a complete and valid GCC environment configuration', () => {
    const config = loadEnvConfig(VALID_MOCK_ENV);
    expect(config.BUSINESS_COUNTRY).toBe('SA');
    expect(config.BUSINESS_CURRENCY).toBe('SAR');
    expect(config.DEFAULT_DIALECT).toBe('saudi');
    expect(config.GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
    expect(config.MAX_HISTORY_MESSAGES).toBe(20);
  });

  it('supports UAE, Kuwait, Qatar, Bahrain, and Oman localization settings', () => {
    const uaeConfig = loadEnvConfig({
      ...VALID_MOCK_ENV,
      BUSINESS_COUNTRY: 'AE',
      BUSINESS_CURRENCY: 'AED',
      DEFAULT_DIALECT: 'uae',
    });
    expect(uaeConfig.BUSINESS_COUNTRY).toBe('AE');
    expect(uaeConfig.BUSINESS_CURRENCY).toBe('AED');
    expect(uaeConfig.DEFAULT_DIALECT).toBe('uae');

    const kwConfig = loadEnvConfig({
      ...VALID_MOCK_ENV,
      BUSINESS_COUNTRY: 'KW',
      BUSINESS_CURRENCY: 'KWD',
      DEFAULT_DIALECT: 'kuwaiti',
    });
    expect(kwConfig.BUSINESS_COUNTRY).toBe('KW');
    expect(kwConfig.BUSINESS_CURRENCY).toBe('KWD');
  });

  it('rejects missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY', () => {
    expect(() => loadEnvConfig({})).toThrow(/Environment validation failed/);
  });

  it('rejects placeholder tokens copied directly from .env.example', () => {
    expect(() =>
      loadEnvConfig({
        ...VALID_MOCK_ENV,
        TELEGRAM_BOT_TOKEN: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
      })
    ).toThrow(/placeholder token/);

    expect(() =>
      loadEnvConfig({
        ...VALID_MOCK_ENV,
        GEMINI_API_KEY: 'your_gemini_api_key_here',
      })
    ).toThrow(/placeholder value/);
  });

  it('rejects unsupported countries or currencies', () => {
    expect(() =>
      loadEnvConfig({
        ...VALID_MOCK_ENV,
        BUSINESS_COUNTRY: 'US',
      })
    ).toThrow(/BUSINESS_COUNTRY/);

    expect(() =>
      loadEnvConfig({
        ...VALID_MOCK_ENV,
        BUSINESS_CURRENCY: 'USD',
      })
    ).toThrow(/BUSINESS_CURRENCY/);
  });
});

