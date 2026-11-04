import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/geminiProvider.js';
import { BotRegistry, DEFAULT_BOTS_FILE } from '../src/config/botRegistry.js';
import { BusinessStore, DEFAULT_BUSINESSES_FILE } from '../src/config/businessStore.js';
import { ConversationStore } from '../src/memory/conversationStore.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { SupportService } from '../src/services/supportService.js';
import { createTelegramBot } from '../src/telegram/bot.js';
import { TelegramBotManager } from '../src/telegram/botManager.js';
import { redactSecretsFromString } from '../src/utils/logger.js';

const MOCK_TOKEN_COFFEE = '111111111:AAAbbbCCCdddEEEfffGGGhhhIIIjjj111111';
const MOCK_TOKEN_PERFUME = '222222222:ZZZyyyXXXwwwVVVuuuTTTsssRRRqqq222222';

function createMockedTelegramBotInstance({
  token,
  supportService,
  businessConfig,
  businessId,
  botId,
  log,
}) {
  const bot = createTelegramBot({
    token,
    supportService,
    businessConfig,
    businessId,
    botId,
    log,
    botConfig: {
      botInfo: {
        id: botId === 'bot-nexora-coffee' ? 1001 : 2002,
        is_bot: true,
        first_name: botId,
        username: botId === 'bot-nexora-coffee' ? 'NexoraaSupportBot' : 'AlWadiPerfumesBot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
    },
  });

  bot.outgoingMessages = [];
  bot.stop = vi.fn().mockResolvedValue(true);

  bot.api.config.use((prev, method, payload) => {
    if (method === 'sendMessage') {
      bot.outgoingMessages.push({
        chatId: payload.chat_id,
        text: payload.text,
      });
      return Promise.resolve({
        ok: true,
        result: {
          message_id: bot.outgoingMessages.length,
          date: Math.floor(Date.now() / 1000),
          chat: { id: payload.chat_id, type: 'private' },
          text: payload.text,
        },
      });
    }
    if (method === 'sendChatAction') {
      return Promise.resolve({ ok: true, result: true });
    }
    return prev(method, payload);
  });

  return bot;
}

describe('Multi-Bot Platform Runtime & Security (BotRegistry + TelegramBotManager)', () => {
  let tempDir;
  let tempBusinessesFile;
  let tempBotsFile;
  /** @type {BusinessStore} */
  let businessStore;
  /** @type {BotRegistry} */
  let botRegistry;
  /** @type {SupportService} */
  let supportService;
  /** @type {TelegramBotManager} */
  let botManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-multibot-'));
    tempBusinessesFile = path.join(tempDir, 'businesses.json');
    tempBotsFile = path.join(tempDir, 'bots.json');

    fs.copyFileSync(DEFAULT_BUSINESSES_FILE, tempBusinessesFile);
    fs.copyFileSync(DEFAULT_BOTS_FILE, tempBotsFile);

    businessStore = new BusinessStore({ filePath: tempBusinessesFile });
    botRegistry = new BotRegistry({
      filePath: tempBotsFile,
      businessStore,
      env: {
        TELEGRAM_BOT_TOKEN: MOCK_TOKEN_COFFEE,
        TELEGRAM_BOT_TOKEN_ALWADI: MOCK_TOKEN_PERFUME,
      },
    });

    // Activate the second bot for multi-bot tests
    botRegistry.setBotStatus('bot-alwadi-perfumes', 'active', {
      actor: { role: 'platform_admin' },
    });

    const mockGenerateContent = vi.fn().mockImplementation(async (payload) => {
      const sysPrompt = payload.config.systemInstruction;
      if (sysPrompt.includes('nexora-coffee-sa')) {
        return { text: 'حياك في نيكسورا للقهوة! مطحنة نيكسورا برو بـ 450 ر.س.' };
      }
      if (sysPrompt.includes('alwadi-perfumes-sa')) {
        return { text: 'حياك في دار الوادي للعطور! عطر عود الوادي بـ 290 ر.س.' };
      }
      return { text: 'رد عام' };
    });

    supportService = new SupportService({
      aiProvider: new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
      }),
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter(),
      businessStore,
      defaultBusinessId: 'nexora-coffee-sa',
    });

    botManager = new TelegramBotManager({
      botRegistry,
      businessStore,
      supportService,
      botFactory: createMockedTelegramBotInstance,
    });
  });

  afterEach(async () => {
    await botManager.stopAllBots();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts two independent Telegram bot clients simultaneously and routes each to its exact business_id', async () => {
    const { started, skipped } = await botManager.startAllActiveBots({
      startPolling: false,
    });

    expect(started).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    expect(botManager.listRunningBots()).toHaveLength(2);

    const coffeeBot = botManager.getRunningBotInstance('bot-nexora-coffee');
    const perfumeBot = botManager.getRunningBotInstance('bot-alwadi-perfumes');

    expect(coffeeBot).toBeDefined();
    expect(perfumeBot).toBeDefined();

    // Send customer inquiry to Coffee Bot (@NexoraaSupportBot)
    await coffeeBot.handleUpdate({
      update_id: 101,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 888, type: 'private', first_name: 'Saad' },
        from: { id: 888, is_bot: false, first_name: 'Saad', language_code: 'ar' },
        text: 'بكم المطحنة؟',
      },
    });

    // Send customer inquiry from the SAME Telegram user ID (888) to Perfume Bot (@AlWadiPerfumesBot)
    await perfumeBot.handleUpdate({
      update_id: 202,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 888, type: 'private', first_name: 'Saad' },
        from: { id: 888, is_bot: false, first_name: 'Saad', language_code: 'ar' },
        text: 'بكم عطر العود؟',
      },
    });

    expect(coffeeBot.outgoingMessages).toHaveLength(1);
    expect(coffeeBot.outgoingMessages[0].text).toContain('450 ر.س');

    expect(perfumeBot.outgoingMessages).toHaveLength(1);
    expect(perfumeBot.outgoingMessages[0].text).toContain('290 ر.س');
  });

  it('maintains strict conversation isolation between bots even for the same customer userId', async () => {
    await botManager.startAllActiveBots({ startPolling: false });

    const coffeeBot = botManager.getRunningBotInstance('bot-nexora-coffee');
    const perfumeBot = botManager.getRunningBotInstance('bot-alwadi-perfumes');

    await coffeeBot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 777, type: 'private' },
        from: { id: 777, is_bot: false, first_name: 'Customer' },
        text: 'أبي مطحنة قهوة',
      },
    });

    await perfumeBot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 20,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 777, type: 'private' },
        from: { id: 777, is_bot: false, first_name: 'Customer' },
        text: 'أبي عطر رسمي',
      },
    });

    const coffeeHistory = supportService.conversationStore.getHistory(
      'nexora-coffee-sa',
      '777',
      'telegram',
      'bot-nexora-coffee'
    );
    const perfumeHistory = supportService.conversationStore.getHistory(
      'alwadi-perfumes-sa',
      '777',
      'telegram',
      'bot-alwadi-perfumes'
    );

    expect(coffeeHistory).toHaveLength(2);
    expect(coffeeHistory[0].text).toBe('أبي مطحنة قهوة');

    expect(perfumeHistory).toHaveLength(2);
    expect(perfumeHistory[0].text).toBe('أبي عطر رسمي');

    // Resetting conversation on Coffee Bot must NOT clear Perfume Bot conversation
    await coffeeBot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 11,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 777, type: 'private' },
        from: { id: 777, is_bot: false, first_name: 'Customer' },
        text: '/reset',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });

    expect(
      supportService.conversationStore.getHistory(
        'nexora-coffee-sa',
        '777',
        'telegram',
        'bot-nexora-coffee'
      )
    ).toHaveLength(0);

    expect(
      supportService.conversationStore.getHistory(
        'alwadi-perfumes-sa',
        '777',
        'telegram',
        'bot-alwadi-perfumes'
      )
    ).toHaveLength(2);
  });

  it('stops or restarts one bot safely without affecting other running bots', async () => {
    await botManager.startAllActiveBots({ startPolling: false });
    expect(botManager.listRunningBots()).toHaveLength(2);

    // Stop only the perfume bot
    const stopped = await botManager.stopBot('bot-alwadi-perfumes');
    expect(stopped).toBe(true);
    expect(botManager.listRunningBots()).toHaveLength(1);
    expect(botManager.listRunningBots()[0].botId).toBe('bot-nexora-coffee');

    // Coffee bot continues answering normally
    const coffeeBot = botManager.getRunningBotInstance('bot-nexora-coffee');
    await coffeeBot.handleUpdate({
      update_id: 50,
      message: {
        message_id: 50,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 900, type: 'private' },
        from: { id: 900, is_bot: false, first_name: 'Ali' },
        text: 'عندكم مطحنة؟',
      },
    });
    expect(coffeeBot.outgoingMessages).toHaveLength(1);

    // Restart the perfume bot
    await botManager.restartBot('bot-alwadi-perfumes', { startPolling: false });
    expect(botManager.listRunningBots()).toHaveLength(2);
  });

  it('rejects invalid, unauthorized, or duplicate bot registrations and enforces business ownership', async () => {
    // 1. Ordinary customer or business_owner cannot register bots
    expect(() =>
      botRegistry.registerBot(
        {
          bot_id: 'bot-unauthorized',
          business_id: 'nexora-coffee-sa',
          bot_username: 'UnauthBot',
          token: '333333333:AAAbbbCCCdddEEEfffGGGhhhIIIjjj333333',
        },
        { actor: { role: 'customer' } }
      )
    ).toThrow(/Only a platform_admin/);

    expect(() =>
      botRegistry.registerBot(
        {
          bot_id: 'bot-owner-attempt',
          business_id: 'nexora-coffee-sa',
          bot_username: 'OwnerBot',
          token: '333333333:AAAbbbCCCdddEEEfffGGGhhhIIIjjj333333',
        },
        { actor: { role: 'business_owner', business_id: 'nexora-coffee-sa' } }
      )
    ).toThrow(/Only a platform_admin/);

    // 2. Duplicate bot_id rejected
    expect(() =>
      botRegistry.registerBot(
        {
          bot_id: 'bot-nexora-coffee',
          business_id: 'nexora-coffee-sa',
          bot_username: 'AnotherUsernameBot',
          token: '333333333:AAAbbbCCCdddEEEfffGGGhhhIIIjjj333333',
        },
        { actor: { role: 'platform_admin' } }
      )
    ).toThrow(/already registered/);

    // 3. Duplicate token rejected
    expect(() =>
      botRegistry.registerBot(
        {
          bot_id: 'bot-duplicate-token',
          business_id: 'nexora-coffee-sa',
          bot_username: 'UniqueDupTokenBot',
          token: MOCK_TOKEN_COFFEE,
        },
        { actor: { role: 'platform_admin' } }
      )
    ).toThrow(/already in use/);

    // 4. Non-existent business_id rejected
    expect(() =>
      botRegistry.registerBot(
        {
          bot_id: 'bot-ghost-biz',
          business_id: 'non-existent-store',
          bot_username: 'GhostStoreBot',
          token: '444444444:AAAbbbCCCdddEEEfffGGGhhhIIIjjj444444',
        },
        { actor: { role: 'platform_admin' } }
      )
    ).toThrow(/does not exist/);

    // 5. Starting an already running bot is prevented
    await botManager.startBot('bot-nexora-coffee', { startPolling: false });
    await expect(
      botManager.startBot('bot-nexora-coffee', { startPolling: false })
    ).rejects.toThrow(/already running/);

    // 6. Business owner can only update their own business, never another business
    expect(() =>
      businessStore.updateProductPrice('alwadi-perfumes-sa', 'OUD-01', 100, {
        actor: { role: 'business_owner', business_id: 'nexora-coffee-sa' },
      })
    ).toThrow(/Unauthorized/);

    // 7. Storing plaintext bot tokens inside businesses.json is strictly blocked
    expect(() =>
      businessStore.upsertBusiness({
        ...businessStore.getBusiness('nexora-coffee-sa'),
        token: MOCK_TOKEN_COFFEE,
      })
    ).toThrow(/Plaintext bot tokens must never be stored in businesses\.json/);
  });

  it('never leaks bot tokens in BotRegistry responses, disk files, running bot lists, or logs', async () => {
    await botManager.startAllActiveBots({ startPolling: false });

    const serializedRegistry = JSON.stringify(botRegistry.listBots());
    const serializedRunning = JSON.stringify(botManager.listRunningBots());
    const diskBotsJson = fs.readFileSync(tempBotsFile, 'utf-8');
    const diskBusinessesJson = fs.readFileSync(tempBusinessesFile, 'utf-8');

    for (const payload of [
      serializedRegistry,
      serializedRunning,
      diskBotsJson,
      diskBusinessesJson,
    ]) {
      expect(payload).not.toContain(MOCK_TOKEN_COFFEE);
      expect(payload).not.toContain(MOCK_TOKEN_PERFUME);
    }

    const simulatedErrorLog = `Telegram API error for token ${MOCK_TOKEN_COFFEE} and ${MOCK_TOKEN_PERFUME}`;
    const redacted = redactSecretsFromString(simulatedErrorLog);
    expect(redacted).not.toContain(MOCK_TOKEN_COFFEE);
    expect(redacted).not.toContain(MOCK_TOKEN_PERFUME);
    expect(redacted).toContain('[REDACTED_TELEGRAM_TOKEN]');
  });
});

