import { Bot, GrammyError, HttpError } from 'grammy';
import { logger } from '../utils/logger.js';
import { registerTelegramHandlers } from './handlers.js';

/**
 * Creates and configures a grammY Telegram Bot instance strictly bound to a single `businessId`
 * and `botId`, with centralized non-crashing error handling.
 *
 * @param {object} options
 * @param {string} options.token - Telegram Bot Token
 * @param {import('../services/supportService.js').SupportService} options.supportService
 * @param {object} [options.businessConfig]
 * @param {string} [options.businessId]
 * @param {string} [options.botId='default']
 * @param {import('pino').Logger} [options.log]
 * @param {object} [options.botConfig] - Optional grammY BotConfig (e.g. botInfo for testing)
 * @returns {import('grammy').Bot}
 */
export function createTelegramBot({
  token,
  supportService,
  businessConfig,
  businessId = '',
  botId = 'default',
  log = logger,
  botConfig = undefined,
}) {
  if (!token || typeof token !== 'string') {
    throw new Error('Telegram bot token is required');
  }

  const boundBusinessId =
    businessId ||
    businessConfig?.businessId ||
    businessConfig?.tenantId ||
    supportService?.defaultBusinessId ||
    'nexora-coffee-sa';

  const bot = new Bot(token, botConfig);

  registerTelegramHandlers(bot, {
    supportService,
    businessConfig,
    boundBusinessId,
    botId,
    log,
  });

  // Centralized Telegram Error Handler — logs safely without exposing tokens or crashing other bots
  bot.catch((botError) => {
    const ctx = botError.ctx;
    const err = botError.error;

    if (err instanceof GrammyError) {
      log.error(
        {
          botId,
          businessId: boundBusinessId,
          updateId: ctx?.update?.update_id,
          errorCode: err.error_code,
          description: err.description,
        },
        'Telegram API GrammyError encountered'
      );
    } else if (err instanceof HttpError) {
      log.error(
        {
          botId,
          businessId: boundBusinessId,
          updateId: ctx?.update?.update_id,
          err,
        },
        'Telegram network HttpError encountered'
      );
    } else {
      log.error(
        {
          botId,
          businessId: boundBusinessId,
          updateId: ctx?.update?.update_id,
          err,
        },
        'Unexpected error inside Telegram update handler'
      );
    }
  });

  return bot;
}
