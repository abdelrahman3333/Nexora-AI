import { pathToFileURL } from 'node:url';
import { GeminiProvider } from './ai/geminiProvider.js';
import { UsageStore } from './analytics/usageStore.js';
import { createApiServer } from './api/server.js';
import { AuthStore, DEFAULT_AUTH_DB_PATH } from './auth/authStore.js';
import { BotRegistry } from './config/botRegistry.js';
import { loadBusinessKnowledge } from './config/businessKnowledge.js';
import { BusinessStore } from './config/businessStore.js';
import { loadEnvConfig } from './config/env.js';
import { ConversationStore } from './memory/conversationStore.js';
import { RateLimiter } from './middleware/rateLimiter.js';
import { SupportService } from './services/supportService.js';
import { createTelegramBot } from './telegram/bot.js';
import { TelegramBotManager } from './telegram/botManager.js';
import { createLogger } from './utils/logger.js';
import { WhatsAppClient } from './whatsapp/whatsappClient.js';
import { WhatsAppWebhookHandler } from './whatsapp/webhookHandler.js';

/**
 * Assembles the full Nexora AI central multi-bot & REST API application dependency graph
 * from validated environment configuration, `BusinessStore`, `BotRegistry`, and `AuthStore`.
 *
 * @param {Record<string, string | undefined>} [rawEnv=process.env]
 */
export function buildApplication(rawEnv = process.env) {
  const env = loadEnvConfig(rawEnv);
  const log = createLogger({ level: env.LOG_LEVEL });

  const businessStore = new BusinessStore();
  const availableBusinesses = businessStore.listBusinesses();

  // Resolve active default business_id from TENANT_ID if registered, otherwise first registered business
  const defaultBusinessId = businessStore.hasBusiness(env.TENANT_ID)
    ? env.TENANT_ID
    : availableBusinesses[0].business_id;

  const { businessConfig, knowledge } = env.BUSINESS_KNOWLEDGE_PATH
    ? {
        businessConfig: Object.freeze({
          businessId: env.TENANT_ID,
          tenantId: env.TENANT_ID,
          businessName: env.BUSINESS_NAME,
          businessCountry: env.BUSINESS_COUNTRY,
          businessCurrency: env.BUSINESS_CURRENCY,
          businessTimezone: env.BUSINESS_TIMEZONE,
          defaultDialect: env.DEFAULT_DIALECT,
          languagePreference: env.LANGUAGE_PREFERENCE,
          businessTone: env.BUSINESS_TONE,
        }),
        knowledge: loadBusinessKnowledge(env.BUSINESS_KNOWLEDGE_PATH),
      }
    : businessStore.getPromptContext(defaultBusinessId);

  const authStore = new AuthStore({
    dbPath: env.AUTH_DB_PATH || DEFAULT_AUTH_DB_PATH,
    businessStore,
    sessionTtlMs: env.SESSION_TTL_MS,
  });

  const botRegistry = new BotRegistry({
    businessStore,
    env: rawEnv,
  });

  const conversationStore = new ConversationStore({
    maxMessages: env.MAX_HISTORY_MESSAGES,
    ttlMs: env.CONVERSATION_TTL_MS,
  });

  const rateLimiter = new RateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
  });

  const usageStore = new UsageStore({
    db: authStore.db,
    log,
  });

  const aiProvider = new GeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    maxRetries: env.AI_MAX_RETRIES,
    temperature: env.AI_TEMPERATURE,
    usageTracker: usageStore,
    log,
  });

  const supportService = new SupportService({
    aiProvider,
    conversationStore,
    rateLimiter,
    businessStore: env.BUSINESS_KNOWLEDGE_PATH ? null : businessStore,
    defaultBusinessId,
    businessConfig,
    knowledge,
    maxMessageLength: env.MAX_MESSAGE_LENGTH,
    log,
  });

  const botManager = new TelegramBotManager({
    botRegistry,
    businessStore,
    supportService,
    log,
  });

  const whatsappClient = new WhatsAppClient({
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    log,
  });

  const whatsappWebhookHandler = new WhatsAppWebhookHandler({
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET,
    supportService,
    whatsappClient,
    defaultBusinessId,
    log,
  });

  const apiServer = createApiServer({
    authStore,
    businessStore,
    botRegistry,
    usageStore,
    whatsappWebhookHandler,
    isProduction: env.NODE_ENV === 'production',
    log,
  });

  // Legacy single-bot reference for backward compatibility with existing callers
  const bot = createTelegramBot({
    token: env.TELEGRAM_BOT_TOKEN,
    supportService,
    businessConfig,
    businessId: defaultBusinessId,
    botId: 'bot-nexora-coffee',
    log,
  });

  return {
    env,
    log,
    businessStore,
    authStore,
    usageStore,
    botRegistry,
    botManager,
    apiServer,
    defaultBusinessId,
    knowledge,
    businessConfig,
    conversationStore,
    rateLimiter,
    aiProvider,
    supportService,
    whatsappClient,
    whatsappWebhookHandler,
    bot,
  };
}

/**
 * Starts the central Nexora AI Multi-Bot Manager and REST API Server,
 * launching all active registered Telegram bots simultaneously with periodic session cleanup
 * and graceful shutdown.
 */
export async function startApp() {
  let app;
  try {
    app = buildApplication(process.env);
  } catch (err) {
    console.error(`[Nexora AI Startup Error] ${err.message}`);
    process.exit(1);
  }

  const {
    botManager,
    botRegistry,
    businessStore,
    authStore,
    apiServer,
    conversationStore,
    log,
    env,
  } = app;

  // Periodic background cleanup of expired conversation and auth sessions (every 30 minutes)
  const cleanupInterval = setInterval(() => {
    const evictedConvos = conversationStore.purgeExpired();
    const evictedSessions = authStore.purgeExpiredSessions();
    if (evictedConvos > 0 || evictedSessions > 0) {
      log.debug(
        { evictedConvos, evictedSessions },
        'Purged expired conversation and auth sessions'
      );
    }
  }, 30 * 60 * 1000);
  cleanupInterval.unref();

  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    clearInterval(cleanupInterval);
    log.info(
      { signal },
      'Graceful shutdown initiated. Stopping API server and all active Telegram bots...'
    );

    try {
      await new Promise((resolve) => apiServer.close(() => resolve()));
      await botManager.stopAllBots();
      authStore.close();
      log.info('API server and Telegram bots stopped cleanly. Goodbye!');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error while shutting down application');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(env.API_PORT, () => {
      log.info(
        { port: env.API_PORT },
        'Nexora AI REST API server is listening'
      );
      resolve();
    });
  });

  log.info(
    {
      registeredBusinesses: businessStore
        .listBusinesses()
        .map((b) => b.business_id),
      registeredBots: botRegistry.listBots().map((b) => ({
        botId: b.bot_id,
        businessId: b.business_id,
        username: b.bot_username,
        status: b.status,
      })),
      model: env.GEMINI_MODEL,
    },
    'Starting Nexora AI Central Multi-Bot Platform...'
  );

  const { started, skipped } = await botManager.startAllActiveBots({
    startPolling: true,
  });

  log.info(
    {
      activeRunningBots: started,
      skippedBots: skipped,
    },
    'Nexora AI Central Multi-Bot Manager startup complete'
  );
}

// Execute startApp() only when src/app.js is run directly as the entry point
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startApp().catch((err) => {
    console.error('[Nexora AI Fatal Error]', err.message);
    process.exit(1);
  });
}
