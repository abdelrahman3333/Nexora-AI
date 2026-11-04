import { detectLanguage } from '../utils/localization.js';
import { logger } from '../utils/logger.js';

/**
 * Infers user language preference from a Telegram context (`ctx.from.language_code`
 * or message text). Defaults to Arabic ('ar') for the GCC market.
 *
 * @param {import('grammy').Context} ctx
 * @returns {'ar' | 'en'}
 */
export function inferTelegramUserLanguage(ctx) {
  const msgText = ctx.message?.text || ctx.message?.caption || '';
  if (msgText.trim().length > 0 && !msgText.trim().startsWith('/')) {
    return detectLanguage(msgText.trim(), 'ar');
  }

  const tgLangCode = String(ctx.from?.language_code || '').toLowerCase();
  if (tgLangCode.startsWith('en')) {
    return 'en';
  }

  return 'ar';
}

/**
 * Registers all Telegram command and message handlers on a grammY Bot instance.
 *
 * Security & Multi-Tenant Isolation:
 * - Each Telegram bot instance is strictly bound to its verified `boundBusinessId` and `botId`.
 * - Ordinary Telegram users CANNOT switch businesses, supply a custom `business_id`, or manage bots.
 *
 * @param {import('grammy').Bot} bot
 * @param {object} deps
 * @param {import('../services/supportService.js').SupportService} deps.supportService
 * @param {object} [deps.businessConfig]
 * @param {string} [deps.boundBusinessId]
 * @param {string} [deps.botId='default']
 * @param {import('pino').Logger} [deps.log]
 */
export function registerTelegramHandlers(
  bot,
  {
    supportService,
    businessConfig,
    boundBusinessId = '',
    botId = 'default',
    log = logger,
  }
) {
  const lockedBusinessId =
    boundBusinessId ||
    businessConfig?.businessId ||
    businessConfig?.tenantId ||
    supportService?.defaultBusinessId ||
    'nexora-coffee-sa';

  const getBoundBusiness = () => {
    try {
      if (typeof supportService?.resolveBusinessContext === 'function') {
        return supportService.resolveBusinessContext(lockedBusinessId);
      }
    } catch {
      // Fallback to static businessConfig if provided
    }
    return {
      businessId: lockedBusinessId,
      businessConfig: businessConfig || {
        businessName: 'متجر نيكسورا الخليج',
        tenantId: lockedBusinessId,
      },
    };
  };

  // /start command — Welcome message in both Gulf Arabic and English
  bot.command('start', async (ctx) => {
    const active = getBoundBusiness();
    const businessName =
      active.businessConfig?.businessName || 'متجر نيكسورا الخليج';

    const welcomeText = `حياك الله في خدمة عملاء *${businessName}*! 🇸🇦✨
أنا المساعد الذكي، حاضر لخدمتك والإجابة على استفساراتك حول المنتجات، الأسعار، الشحن، وسياسات المتجر.

Welcome to *${businessName}* Customer Support!
I am your AI assistant. Feel free to ask your questions in Arabic or English.

📌 الأوامر المتاحة / Commands:
• /reset - بدء محادثة جديدة (Reset conversation history)
• /help - عرض المساعدة (Help & instructions)`;

    await ctx.reply(welcomeText, { parse_mode: 'Markdown' }).catch(async () => {
      await ctx.reply(welcomeText.replace(/\*/g, ''));
    });
  });

  // Security guard: Reject any attempt by an ordinary Telegram user to switch business_id or manage bots
  bot.command(['business', 'admin', 'register_bot'], async (ctx) => {
    const lang = inferTelegramUserLanguage(ctx);
    const msg =
      lang === 'en'
        ? 'This command is restricted. This bot is dedicated exclusively to serving customers of this store.'
        : 'عذراً، هذا الأمر غير متاح للعملاء. هذا البوت مخصص حصرياً لخدمة عملاء هذا المتجر.';
    await ctx.reply(msg);
  });

  // /help command
  bot.command('help', async (ctx) => {
    const active = getBoundBusiness();
    const businessName =
      active.businessConfig?.businessName || 'متجر نيكسورا الخليج';
    const lang = inferTelegramUserLanguage(ctx);

    const helpText =
      lang === 'en'
        ? `How to use ${businessName} Support Bot:\n- Simply type your question in Arabic or English.\n- Use /reset at any time to clear your conversation history and start fresh.`
        : `طريقة استخدام بوت خدمة عملاء ${businessName}:\n- اكتب استفسارك مباشرة باللغة العربية أو الإنجليزية وبنجاوبك فوراً.\n- يمكنك إرسال الأمر /reset في أي وقت لمسح المحادثة السابقة والبدء من جديد.`;

    await ctx.reply(helpText);
  });

  // /reset command — Clears isolated conversation history for the calling Telegram user on this bot
  bot.command('reset', async (ctx) => {
    const userId = String(ctx.from?.id || ctx.chat?.id || '');
    if (!userId) return;

    const lang = inferTelegramUserLanguage(ctx);
    const result = supportService.resetConversation({
      businessId: lockedBusinessId,
      tenantId: lockedBusinessId,
      botId,
      platform: 'telegram',
      userId,
      language: lang,
    });

    await ctx.reply(result.text);
  });

  // Standard text messages — Strictly routed to `lockedBusinessId` and isolated by `botId`
  bot.on('message:text', async (ctx) => {
    const userId = String(ctx.from?.id || ctx.chat?.id || '');
    const messageId = ctx.message?.message_id;
    const text = ctx.message?.text || '';

    if (!userId) return;

    // Best-effort typing indicator
    ctx.replyWithChatAction('typing').catch((err) => {
      log.debug({ botId, err }, 'Could not send typing chat action');
    });

    const result = await supportService.handleIncomingMessage({
      businessId: lockedBusinessId,
      tenantId: lockedBusinessId,
      botId,
      platform: 'telegram',
      userId,
      text,
      messageId,
    });

    if (result.duplicate || !result.text) {
      return;
    }

    await ctx.reply(result.text);
  });

  // Any other non-text message types (stickers, voice notes, photos, videos, files, locations, etc.)
  bot.on('message', async (ctx) => {
    const lang = inferTelegramUserLanguage(ctx);
    const result = supportService.handleUnsupportedMessage({ language: lang });
    await ctx.reply(result.text);
  });
}
