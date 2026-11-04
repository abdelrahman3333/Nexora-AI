import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/geminiProvider.js';
import { BusinessStore, DEFAULT_BUSINESSES_FILE } from '../src/config/businessStore.js';
import { ConversationStore } from '../src/memory/conversationStore.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { SupportService } from '../src/services/supportService.js';
import { createTelegramBot } from '../src/telegram/bot.js';

describe('Multi-Business Platform Milestone — Isolation, Price Updates, Missing Info & Telegram Regressions', () => {
  let tempDir;
  let tempBusinessesFile;
  /** @type {BusinessStore} */
  let businessStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-multibiz-'));
    tempBusinessesFile = path.join(tempDir, 'businesses.json');
    fs.copyFileSync(DEFAULT_BUSINESSES_FILE, tempBusinessesFile);
    businessStore = new BusinessStore({ filePath: tempBusinessesFile });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads two distinct sample businesses with different products, services, offers, and prices', () => {
    const businesses = businessStore.listBusinesses();
    expect(businesses.length).toBeGreaterThanOrEqual(2);

    const coffeeBiz = businessStore.getBusiness('nexora-coffee-sa');
    const perfumeBiz = businessStore.getBusiness('alwadi-perfumes-sa');

    expect(coffeeBiz.business_id).toBe('nexora-coffee-sa');
    expect(perfumeBiz.business_id).toBe('alwadi-perfumes-sa');
    expect(coffeeBiz.name).toBeTruthy();
    expect(perfumeBiz.name).toContain('دار الوادي للعطور');

    expect(coffeeBiz.products.length).toBeGreaterThan(0);
    expect(perfumeBiz.products.length).toBeGreaterThan(0);
    expect(coffeeBiz.products[0].price).toBeGreaterThan(0);
    expect(perfumeBiz.products.some((p) => p.price === 290)).toBe(true);
    expect(coffeeBiz.offers.length).toBeGreaterThan(0);
    expect(perfumeBiz.services.length).toBeGreaterThan(0);
  });

  it('strictly isolates system prompts, product data, and conversation history between businesses', async () => {
    const coffeeBiz = businessStore.getBusiness('nexora-coffee-sa');
    const capturedCalls = [];
    const mockGenerateContent = vi.fn().mockImplementation(async (payload) => {
      capturedCalls.push(payload);
      const sysPrompt = payload.config.systemInstruction;
      if (sysPrompt.includes('nexora-coffee-sa')) {
        return { text: `عندنا ${coffeeBiz.products[0].nameAr} بـ ${coffeeBiz.products[0].price} ر.س.` };
      }
      if (sysPrompt.includes('alwadi-perfumes-sa')) {
        return { text: 'عندنا عطر عود الوادي الملكي بـ 290 ر.س.' };
      }
      return { text: 'رد عام' };
    });

    const supportService = new SupportService({
      aiProvider: new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
      }),
      conversationStore: new ConversationStore({ maxMessages: 20 }),
      rateLimiter: new RateLimiter({ windowMs: 60000, maxRequests: 20 }),
      businessStore,
      defaultBusinessId: 'nexora-coffee-sa',
    });

    // Same userId chatting with Business 1 (Coffee Store)
    const replyCoffee = await supportService.handleIncomingMessage({
      businessId: 'nexora-coffee-sa',
      userId: 'customer-100',
      text: 'وش عندكم منتجات؟',
      messageId: 1,
    });

    // Same userId chatting with Business 2 (Perfumes Store)
    const replyPerfume = await supportService.handleIncomingMessage({
      businessId: 'alwadi-perfumes-sa',
      userId: 'customer-100',
      text: 'وش عندكم عطور؟',
      messageId: 2,
    });

    expect(replyCoffee.text).toContain(String(coffeeBiz.products[0].price));
    expect(replyPerfume.text).toContain('290 ر.س');

    // Verify prompt isolation: Coffee prompt must NEVER contain Perfume products and vice versa
    const coffeePrompt = capturedCalls[0].config.systemInstruction;
    const perfumePrompt = capturedCalls[1].config.systemInstruction;

    expect(coffeePrompt).toContain(coffeeBiz.products[0].nameAr);
    expect(coffeePrompt).not.toContain('عطر عود الوادي الملكي');
    expect(coffeePrompt).not.toContain('alwadi-perfumes-sa');

    expect(perfumePrompt).toContain('عطر عود الوادي الملكي');
    expect(perfumePrompt).not.toContain(coffeeBiz.products[0].nameAr);
    expect(perfumePrompt).not.toContain('nexora-coffee-sa');

    // Verify conversation history isolation: Coffee conversation history was NOT sent to Perfume call
    expect(capturedCalls[1].contents).toHaveLength(1);
    expect(capturedCalls[1].contents[0].parts[0].text).toBe('وش عندكم عطور؟');

    const coffeeHistory = supportService.conversationStore.getHistory(
      'nexora-coffee-sa',
      'customer-100'
    );
    const perfumeHistory = supportService.conversationStore.getHistory(
      'alwadi-perfumes-sa',
      'customer-100'
    );

    expect(coffeeHistory).toHaveLength(2);
    expect(perfumeHistory).toHaveLength(2);
    expect(coffeeHistory[1].text).not.toEqual(perfumeHistory[1].text);
  });

  it('persists product price updates to disk and immediately loads the updated price in Gemini prompt', async () => {
    let lastSystemPrompt = '';
    const mockGenerateContent = vi.fn().mockImplementation(async (payload) => {
      lastSystemPrompt = payload.config.systemInstruction;
      return { text: 'تم تحديث السعر' };
    });

    const supportService = new SupportService({
      aiProvider: new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
      }),
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter(),
      businessStore,
      defaultBusinessId: 'nexora-coffee-sa',
    });

    // Update PRD-01 price from 450 to 399 SAR in nexora-coffee-sa
    const updatedProduct = businessStore.updateProductPrice(
      'nexora-coffee-sa',
      'PRD-01',
      399
    );
    expect(updatedProduct.price).toBe(399);

    // Verify persistence on disk by creating a fresh BusinessStore reading the same file
    const reloadedStore = new BusinessStore({ filePath: tempBusinessesFile });
    const persistedBiz = reloadedStore.getBusiness('nexora-coffee-sa');
    expect(persistedBiz.products.find((p) => p.id === 'PRD-01').price).toBe(399);

    // Ensure alwadi-perfumes-sa was untouched
    const otherBiz = reloadedStore.getBusiness('alwadi-perfumes-sa');
    expect(otherBiz.products.find((p) => p.id === 'OUD-01').price).toBe(290);

    // Verify SupportService immediately injects 399 SAR (and not 450 SAR) into Gemini prompt
    await supportService.handleIncomingMessage({
      businessId: 'nexora-coffee-sa',
      userId: 'user-price-check',
      text: 'كم سعر مطحنة نيكسورا برو الآن؟',
      messageId: 50,
    });

    expect(lastSystemPrompt).toContain('399 ر.س (SAR)');
    expect(lastSystemPrompt).not.toContain('450 ر.س (SAR)');
  });

  it('enforces missing product and anti-hallucination rules in the business prompt', async () => {
    let capturedPrompt = '';
    const mockGenerateContent = vi.fn().mockImplementation(async (payload) => {
      capturedPrompt = payload.config.systemInstruction;
      return {
        text: 'ما يتوفر عندنا هالمنتج حالياً في دار الوادي للعطور والعود.',
      };
    });

    const supportService = new SupportService({
      aiProvider: new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
      }),
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter(),
      businessStore,
      defaultBusinessId: 'alwadi-perfumes-sa',
    });

    const res = await supportService.handleIncomingMessage({
      businessId: 'alwadi-perfumes-sa',
      userId: 'user-missing-prod',
      text: 'عندكم مطحنة قهوة؟',
      messageId: 77,
    });

    expect(capturedPrompt).toContain('MISSING / UNAVAILABLE PRODUCTS');
    expect(capturedPrompt).toContain('EXCLUSIVE BUSINESS SCOPE');
    expect(res.text).toContain('ما يتوفر عندنا');
  });

  it('preserves existing Telegram bot functionality (/start, text, security guard on /business, and /reset)', async () => {
    const mockGenerateContent = vi.fn().mockImplementation(async (payload) => {
      if (payload.config.systemInstruction.includes('alwadi-perfumes-sa')) {
        return { text: 'هلا بك في دار الوادي! سعر عطر عود الوادي الملكي 290 ر.س.' };
      }
      return { text: 'هلا بك في نيكسورا للقهوة! سعر المطحنة 450 ر.س.' };
    });

    const supportService = new SupportService({
      aiProvider: new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
      }),
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter(),
      businessStore,
      defaultBusinessId: 'nexora-coffee-sa',
    });

    const { businessConfig } = businessStore.getPromptContext('nexora-coffee-sa');

    const bot = createTelegramBot({
      token: '123456789:ZYXwvuTSRqpoNMLkjiHGFedcBA987654321',
      supportService,
      businessConfig,
      businessId: 'nexora-coffee-sa',
      botId: 'bot-nexora-coffee',
      botConfig: {
        botInfo: {
          id: 999999,
          is_bot: true,
          first_name: 'NexoraTestBot',
          username: 'NexoraTestBot',
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      },
    });

    const outgoingMessages = [];
    bot.api.config.use((prev, method, payload) => {
      if (method === 'sendMessage') {
        outgoingMessages.push(payload.text);
        return Promise.resolve({
          ok: true,
          result: {
            message_id: outgoingMessages.length,
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

    const makeTextUpdate = (updateId, text, entities = undefined) => ({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 555, type: 'private', first_name: 'Fahad' },
        from: { id: 555, is_bot: false, first_name: 'Fahad', language_code: 'ar' },
        text,
        ...(entities ? { entities } : {}),
      },
    });

    // 1. Test /start command on bound business (Coffee store)
    await bot.handleUpdate(
      makeTextUpdate(1, '/start', [{ offset: 0, length: 6, type: 'bot_command' }])
    );
    expect(outgoingMessages.at(-1)).toContain(businessStore.getBusiness('nexora-coffee-sa').name);

    // 2. Test normal text message on bound business
    await bot.handleUpdate(makeTextUpdate(2, 'بكم المطحنة؟'));
    expect(outgoingMessages.at(-1)).toContain('450 ر.س');

    // 3. Test security guard: ordinary Telegram customer CANNOT switch business_id via /business
    await bot.handleUpdate(
      makeTextUpdate(3, '/business alwadi-perfumes-sa', [
        { offset: 0, length: 9, type: 'bot_command' },
      ])
    );
    expect(outgoingMessages.at(-1)).toContain('غير متاح للعملاء');

    // 4. Subsequent messages still route strictly to nexora-coffee-sa
    await bot.handleUpdate(makeTextUpdate(4, 'كم سعرها؟'));
    expect(outgoingMessages.at(-1)).toContain('450 ر.س');

    // 5. Test /reset command
    await bot.handleUpdate(
      makeTextUpdate(5, '/reset', [{ offset: 0, length: 6, type: 'bot_command' }])
    );
    expect(outgoingMessages.at(-1)).toContain('تم مسح سجل المحادثة');
  });
});

