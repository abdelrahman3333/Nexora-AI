import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

export const SUPPORTED_COUNTRIES = ['SA', 'AE', 'KW', 'QA', 'BH', 'OM'];
export const SUPPORTED_CURRENCIES = ['SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR'];
export const SUPPORTED_DIALECTS = [
  'saudi',
  'uae',
  'kuwaiti',
  'qatari',
  'bahraini',
  'omani',
  'gulf_general',
  'msa',
];
export const SUPPORTED_LANGUAGES = ['auto', 'ar', 'en'];
export const SUPPORTED_TONES = [
  'polite_professional_gulf',
  'formal_gulf',
  'friendly_gulf',
];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  TELEGRAM_BOT_TOKEN: z
    .string({ error: 'TELEGRAM_BOT_TOKEN is required' })
    .trim()
    .min(20, 'TELEGRAM_BOT_TOKEN appears invalid or too short')
    .refine(
      (val) => !val.includes('ABCdefGHIjklMNOpqrsTUVwxyz'),
      'TELEGRAM_BOT_TOKEN cannot be the placeholder token from .env.example'
    ),

  GEMINI_API_KEY: z
    .string({ error: 'GEMINI_API_KEY is required' })
    .trim()
    .min(15, 'GEMINI_API_KEY appears invalid or too short')
    .refine(
      (val) => val !== 'your_gemini_api_key_here',
      'GEMINI_API_KEY cannot be the placeholder value from .env.example'
    ),

  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash-lite'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),

  TENANT_ID: z.string().trim().min(1).default('default-gcc-store'),
  BUSINESS_NAME: z
    .string()
    .trim()
    .min(1)
    .default('متجر نيكسورا الخليج (Nexora Gulf Store)'),
  BUSINESS_COUNTRY: z.enum(SUPPORTED_COUNTRIES).default('SA'),
  BUSINESS_CURRENCY: z.enum(SUPPORTED_CURRENCIES).default('SAR'),
  BUSINESS_TIMEZONE: z.string().trim().min(1).default('Asia/Riyadh'),
  DEFAULT_DIALECT: z.enum(SUPPORTED_DIALECTS).default('saudi'),
  LANGUAGE_PREFERENCE: z.enum(SUPPORTED_LANGUAGES).default('auto'),
  BUSINESS_TONE: z.enum(SUPPORTED_TONES).default('polite_professional_gulf'),
  BUSINESS_KNOWLEDGE_PATH: z.string().trim().optional().default(''),

  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(2).max(100).default(20),
  CONVERSATION_TTL_MS: z.coerce
    .number()
    .int()
    .min(60000)
    .default(24 * 60 * 60 * 1000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(200).default(10),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().min(50).max(4096).default(1500),

  API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  AUTH_DB_PATH: z.string().trim().optional().default(''),
  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .min(60000)
    .default(24 * 60 * 60 * 1000),
});

/**
 * Validates raw environment variables against the strict Nexora AI schema.
 * Never logs raw secret values on failure.
 *
 * @param {Record<string, string | undefined>} rawEnv
 * @returns {z.infer<typeof envSchema>}
 */
export function loadEnvConfig(rawEnv = process.env) {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const formattedErrors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Environment validation failed:\n${formattedErrors}\nPlease check your .env file against .env.example.`
    );
  }

  return Object.freeze(result.data);
}

