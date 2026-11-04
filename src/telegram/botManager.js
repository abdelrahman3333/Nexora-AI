import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { createTelegramBot } from './bot.js';

/**
 * Multi-Bot Runtime Manager for the Nexora AI platform.
 *
 * Responsibilities:
 * - Starts and manages multiple independent Telegram bot clients simultaneously.
 * - Strictly associates each bot with its verified `business_id` from `BotRegistry` + `BusinessStore`.
 * - Prevents duplicate bot instances (`bot_id` or Telegram token collisions).
 * - Allows stopping or restarting a single bot without affecting other running bots.
 * - Isolates Telegram polling/runtime errors per bot so one failing bot never crashes the central app.
 */
export class TelegramBotManager {
  /**
   * @param {object} options
   * @param {import('../config/botRegistry.js').BotRegistry} options.botRegistry
   * @param {import('../config/businessStore.js').BusinessStore} options.businessStore
   * @param {import('../services/supportService.js').SupportService} options.supportService
   * @param {Function} [options.botFactory] - Optional custom factory for creating bot instances (used in tests)
   * @param {import('pino').Logger} [options.log]
   */
  constructor({
    botRegistry,
    businessStore,
    supportService,
    botFactory = createTelegramBot,
    log = logger,
  }) {
    if (!botRegistry || !businessStore || !supportService) {
      throw new Error(
        'TelegramBotManager requires botRegistry, businessStore, and supportService'
      );
    }

    this.botRegistry = botRegistry;
    this.businessStore = businessStore;
    this.supportService = supportService;
    this.botFactory = botFactory;
    this.log = log;

    /**
     * Map of running bot_id -> { botId, businessId, botUsername, botInstance, startedAt }
     * @type {Map<string, { botId: string, businessId: string, botUsername: string, botInstance: import('grammy').Bot, startedAt: number }>}
     */
    this.runningBots = new Map();

    /**
     * Set of currently active tokens (kept internally in memory to prevent duplicate polling on the same token)
     * @type {Set<string>}
     */
    this.#activeTokens = new Set();
  }

  /** @type {Set<string>} */
  #activeTokens;

  /**
   * Starts a specific registered Telegram bot by `bot_id`.
   * Validates bot ownership, active status, business association, and prevents duplicate instances.
   *
   * @param {string} botId
   * @param {object} [options]
   * @param {boolean} [options.startPolling=true] - Set to false in unit tests using `bot.handleUpdate`
   * @param {object} [options.botConfig] - Optional grammY botConfig override
   * @returns {Promise<{ botId: string, businessId: string, botUsername: string, status: 'running' }>}
   */
  async startBot(botId, { startPolling = true, botConfig = undefined } = {}) {
    const cleanId = String(botId || '').trim();

    if (this.runningBots.has(cleanId)) {
      throw new ValidationError(
        `Bot "${cleanId}" is already running`,
        'DUPLICATE_RUNNING_BOT'
      );
    }

    const credentials = this.botRegistry.getBotRuntimeCredentials(cleanId);

    if (credentials.status !== 'active') {
      throw new ValidationError(
        `Cannot start bot "${cleanId}" because its registry status is "${credentials.status}"`,
        'BOT_INACTIVE'
      );
    }

    if (!this.businessStore.hasBusiness(credentials.business_id)) {
      throw new ValidationError(
        `Cannot start bot "${cleanId}": associated business "${credentials.business_id}" does not exist`,
        'INVALID_BUSINESS_ASSOCIATION'
      );
    }

    if (this.#activeTokens.has(credentials.token)) {
      throw new ValidationError(
        `Cannot start bot "${cleanId}": another running bot instance is already using this Telegram token`,
        'DUPLICATE_BOT_TOKEN_RUNTIME'
      );
    }

    const { businessConfig } = this.businessStore.getPromptContext(
      credentials.business_id
    );

    const botInstance = this.botFactory({
      token: credentials.token,
      supportService: this.supportService,
      businessConfig,
      businessId: credentials.business_id,
      botId: credentials.bot_id,
      log: this.log,
      botConfig,
    });

    this.runningBots.set(cleanId, {
      botId: credentials.bot_id,
      businessId: credentials.business_id,
      botUsername: credentials.bot_username,
      botInstance,
      tokenRef: credentials.token,
      startedAt: Date.now(),
    });
    this.#activeTokens.add(credentials.token);

    if (startPolling) {
      // Launch non-blocking long-polling with isolated error catching so one bot failure never crashes other bots
      Promise.resolve()
        .then(() =>
          botInstance.start({
            onStart: (botInfo) => {
              this.log.info(
                {
                  botId: credentials.bot_id,
                  businessId: credentials.business_id,
                  botUsername: botInfo?.username || credentials.bot_username,
                },
                'Telegram bot instance is online and polling'
              );
            },
          })
        )
        .catch((err) => {
          this.log.error(
            {
              botId: credentials.bot_id,
              businessId: credentials.business_id,
              err,
            },
            'Telegram bot polling loop terminated with an error (isolated from other bots)'
          );
          this.runningBots.delete(cleanId);
          this.#activeTokens.delete(credentials.token);
        });
    }

    this.log.info(
      {
        botId: credentials.bot_id,
        businessId: credentials.business_id,
        botUsername: credentials.bot_username,
      },
      'Started Telegram bot client'
    );

    return {
      botId: credentials.bot_id,
      businessId: credentials.business_id,
      botUsername: credentials.bot_username,
      status: 'running',
    };
  }

  /**
   * Starts all registered bots that have `status === 'active'` and a valid configured token.
   * Isolates startup errors per bot so one misconfigured bot does not block valid bots from starting.
   *
   * @param {object} [options]
   * @param {boolean} [options.startPolling=true]
   * @returns {Promise<{ started: Array<object>, skipped: Array<object> }>}
   */
  async startAllActiveBots({ startPolling = true } = {}) {
    const allBots = this.botRegistry.listBots();
    const started = [];
    const skipped = [];

    for (const botMeta of allBots) {
      if (botMeta.status !== 'active') {
        skipped.push({
          botId: botMeta.bot_id,
          businessId: botMeta.business_id,
          reason: 'inactive',
        });
        continue;
      }

      try {
        const res = await this.startBot(botMeta.bot_id, { startPolling });
        started.push(res);
      } catch (err) {
        this.log.error(
          {
            botId: botMeta.bot_id,
            businessId: botMeta.business_id,
            err,
          },
          'Skipped starting bot due to configuration or token error'
        );
        skipped.push({
          botId: botMeta.bot_id,
          businessId: botMeta.business_id,
          reason: err.message,
        });
      }
    }

    return { started, skipped };
  }

  /**
   * Safely stops a specific running bot without affecting any other running bots.
   *
   * @param {string} botId
   * @returns {Promise<boolean>}
   */
  async stopBot(botId) {
    const cleanId = String(botId || '').trim();
    const entry = this.runningBots.get(cleanId);
    if (!entry) {
      return false;
    }

    try {
      await entry.botInstance.stop();
    } catch (err) {
      this.log.warn(
        { botId: cleanId, businessId: entry.businessId, err },
        'Warning while stopping Telegram bot instance'
      );
    } finally {
      this.runningBots.delete(cleanId);
      this.#activeTokens.delete(entry.tokenRef);
    }

    this.log.info(
      { botId: cleanId, businessId: entry.businessId },
      'Stopped Telegram bot client cleanly'
    );
    return true;
  }

  /**
   * Safely restarts a specific bot without affecting other running bots.
   *
   * @param {string} botId
   * @param {object} [options]
   * @param {boolean} [options.startPolling=true]
   * @param {object} [options.botConfig]
   */
  async restartBot(botId, { startPolling = true, botConfig = undefined } = {}) {
    await this.stopBot(botId);
    return this.startBot(botId, { startPolling, botConfig });
  }

  /**
   * Gracefully stops all currently running bots.
   */
  async stopAllBots() {
    const runningIds = Array.from(this.runningBots.keys());
    for (const id of runningIds) {
      await this.stopBot(id);
    }
  }

  /**
   * Returns safe status summaries of all currently running bots (never exposes tokens).
   */
  listRunningBots() {
    return Array.from(this.runningBots.values()).map((entry) =>
      Object.freeze({
        botId: entry.botId,
        businessId: entry.businessId,
        botUsername: entry.botUsername,
        startedAt: entry.startedAt,
        status: 'running',
      })
    );
  }

  /**
   * Retrieves the underlying grammY Bot instance for a running `botId`.
   *
   * @param {string} botId
   * @returns {import('grammy').Bot | undefined}
   */
  getRunningBotInstance(botId) {
    return this.runningBots.get(String(botId || '').trim())?.botInstance;
  }
}

