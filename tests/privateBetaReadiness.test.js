import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/geminiProvider.js';
import { createApiServer } from '../src/api/server.js';
import { AuthStore } from '../src/auth/authStore.js';
import { BotRegistry } from '../src/config/botRegistry.js';
import { BusinessStore, DEFAULT_BUSINESSES_FILE } from '../src/config/businessStore.js';
import { ConversationStore } from '../src/memory/conversationStore.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { SupportService } from '../src/services/supportService.js';
import { createTelegramBot } from '../src/telegram/bot.js';
import { TelegramBotManager } from '../src/telegram/botManager.js';

describe('Nexora AI — Private Beta Customer Journey & Readiness Audit', () => {
  let tempDir;
  let tempDbPath;
  let tempBizFile;
  let tempBotsFile;
  let authStore;
  let businessStore;
  let botRegistry;
  let apiServer;
  let serverUrl;
  let capturedPrompts = [];
  let supportService;

  beforeEach(async () => {
    capturedPrompts = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-beta-readiness-'));
    tempDbPath = path.join(tempDir, 'beta-auth.sqlite');
    tempBizFile = path.join(tempDir, 'businesses.json');
    tempBotsFile = path.join(tempDir, 'bots.json');

    // Clone base data
    fs.copyFileSync(DEFAULT_BUSINESSES_FILE, tempBizFile);
    businessStore = new BusinessStore({ filePath: tempBizFile });

    fs.writeFileSync(
      tempBotsFile,
      JSON.stringify(
        {
          bots: [
            {
              bot_id: 'bot-coffee',
              business_id: 'nexora-coffee-sa',
              bot_username: 'NexoraCoffeeBot',
              token_env_var: 'TG_TOKEN_COFFEE',
              status: 'active',
            },
          ],
        },
        null,
        2
      )
    );

    botRegistry = new BotRegistry({
      filePath: tempBotsFile,
      businessStore,
      env: {
        TG_TOKEN_COFFEE: '111111:AAABBBcccDDDeeeFFFggghhhiii111222',
        TG_TOKEN_JEWELRY: '222222:ZZZYYYxxxWWWvvvUUUtttsssrqq333444',
      },
    });

    authStore = new AuthStore({
      dbPath: tempDbPath,
      businessStore,
      sessionTtlMs: 3600000,
    });

    // Seed platform admin
    authStore.createUser({
      email: 'admin@nexora.ai',
      password: 'AdminSuperPass123!',
      role: 'platform_admin',
    });

    const mockAiClient = {
      models: {
        generateContent: vi.fn().mockImplementation(async (payload) => {
          capturedPrompts.push(payload);
          const sys = payload.config.systemInstruction;
          if (sys.includes('saad-jewelry-sa')) {
            return { text: 'حياك الله في مجوهرات السعد! خاتم الألماس متوفر بسعر 3500 ر.س.' };
          }
          return { text: 'أهلاً بك، كيف أقدر أساعدك؟' };
        }),
      },
    };

    const aiProvider = new GeminiProvider({
      client: mockAiClient,
      model: 'gemini-3.5-flash-lite',
    });

    supportService = new SupportService({
      aiProvider,
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter({ windowMs: 1000, maxRequests: 100 }),
      businessStore,
      defaultBusinessId: 'nexora-coffee-sa',
    });

    apiServer = createApiServer({
      authStore,
      businessStore,
      botRegistry,
      isProduction: true,
    });

    await new Promise((resolve) => {
      apiServer.listen(0, '127.0.0.1', () => {
        const addr = apiServer.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (apiServer) {
      await new Promise((resolve) => apiServer.close(() => resolve()));
    }
    if (authStore) {
      authStore.close();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs complete 10-step customer journey for the first private beta customer end-to-end', async () => {
    // -----------------------------------------------------------------------
    // Step 1: Create a new test business with isolated business data
    // -----------------------------------------------------------------------
    const newBusinessProfile = {
      business_id: 'saad-jewelry-sa',
      name: 'دار السعد للمجوهرات الفاخرة',
      industry: 'مجوهرات وساعات ثمينة (Luxury Jewelry)',
      country: 'SA',
      currency: 'SAR',
      timezone: 'Asia/Riyadh',
      dialect: 'saudi',
      languagePreference: 'auto',
      tone: 'polite_professional_gulf',
      companyOverview: {
        descriptionAr: 'علامة سعودية متخصصة في صياغة الذهب الخالص والألماس الطبيعي المعتمد عالمياً.',
        descriptionEn: 'Saudi luxury brand specializing in fine jewelry and certified diamonds.',
      },
      contactInfo: {
        supportEmail: 'care@saad-jewelry.sa',
        whatsappNumber: '+966551234567',
        website: 'https://saad-jewelry.sa',
      },
      workingHours: {
        scheduleAr: 'يومياً من 4:00 عصراً حتى 11:00 مساءً.',
      },
      deliveryPolicy: {
        detailsAr: 'توصيل مصفح ومؤمن بالكامل لجميع مناطق المملكة خلال 48 ساعة مجاناً.',
      },
      returnPolicy: {
        detailsAr: 'استرجاع خلال 3 أيام مع فحص وتدقيق العيار في فروعنا.',
      },
      paymentMethods: ['مدى', 'Apple Pay', 'فيزا', 'تحويل بنكي'],
      products: [
        {
          id: 'JWL-01',
          nameAr: 'خاتم سوليتير ألماس عيار 18',
          nameEn: '18K Diamond Solitaire Ring',
          price: 3500,
          inStock: true,
          featuresAr: 'ذهب أبيض عيار 18 مع ماسة نقية بوزن نصف قيراط وشهادة GIA.',
        },
      ],
      offers: [
        {
          id: 'OFF-JWL-1',
          titleAr: 'عرض الموسم: خصم 500 ريال على أطقم الزواج',
          price: 9500,
          detailsAr: 'خصم مباشر عند طلب طقم الزواج الكامل.',
          isActive: true,
        },
      ],
      services: [],
      faqs: [],
    };

    businessStore.upsertBusiness(newBusinessProfile);
    expect(businessStore.hasBusiness('saad-jewelry-sa')).toBe(true);

    // Register Telegram bot for the new business
    botRegistry.registerBot(
      {
        bot_id: 'bot-jewelry',
        business_id: 'saad-jewelry-sa',
        bot_username: 'SaadJewelryBot',
        token_env_var: 'TG_TOKEN_JEWELRY',
        status: 'active',
      },
      { actor: { role: 'platform_admin' } }
    );
    expect(botRegistry.getBot('bot-jewelry').business_id).toBe('saad-jewelry-sa');

    // -----------------------------------------------------------------------
    // Step 2: Create a business_owner account linked only to that business
    // -----------------------------------------------------------------------
    const ownerAccount = authStore.createUser({
      email: 'owner@saad-jewelry.sa',
      password: 'BetaCustomerPass2026!',
      role: 'business_owner',
      business_id: 'saad-jewelry-sa',
    });

    expect(ownerAccount.email).toBe('owner@saad-jewelry.sa');
    expect(ownerAccount.role).toBe('business_owner');
    expect(ownerAccount.business_id).toBe('saad-jewelry-sa');

    // -----------------------------------------------------------------------
    // Step 3: Verify the owner can log in and access the dashboard
    // -----------------------------------------------------------------------
    const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@saad-jewelry.sa',
        password: 'BetaCustomerPass2026!',
      }),
    });

    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly');
    const cookieHeader = setCookie.split(';')[0];
    const loginData = await loginRes.json();
    const csrfToken = loginData.csrfToken;

    // Verify /api/auth/me
    const meRes = await fetch(`${serverUrl}/api/auth/me`, {
      headers: { Cookie: cookieHeader },
    });
    expect(meRes.status).toBe(200);
    const meData = await meRes.json();
    expect(meData.user.business_id).toBe('saad-jewelry-sa');

    // Verify /api/my-business
    const myBizRes = await fetch(`${serverUrl}/api/my-business`, {
      headers: { Cookie: cookieHeader },
    });
    expect(myBizRes.status).toBe(200);
    const myBizData = await myBizRes.json();
    expect(myBizData.business.name).toBe('دار السعد للمجوهرات الفاخرة');
    expect(myBizData.business.products).toHaveLength(1);

    // -----------------------------------------------------------------------
    // Step 4: Verify the owner can add, edit, and delete products and offers
    // -----------------------------------------------------------------------
    // Add product
    const addProdRes = await fetch(`${serverUrl}/api/my-business/products`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'JWL-02',
        nameAr: 'عقد ذهب عيار 21 ملكي',
        price: 2200,
        inStock: true,
        featuresAr: 'صياغة يدوية فاخرة بوزن 8 جرام.',
      }),
    });
    expect(addProdRes.status).toBe(201);

    // Edit product price
    const editProdRes = await fetch(`${serverUrl}/api/my-business/products/JWL-02`, {
      method: 'PUT',
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price: 2400,
      }),
    });
    expect(editProdRes.status).toBe(200);
    const updatedProd = (await editProdRes.json()).product;
    expect(updatedProd.price).toBe(2400);

    // Add and delete offer
    const addOfferRes = await fetch(`${serverUrl}/api/my-business/offers`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'OFF-TEMP',
        titleAr: 'عرض عطلة نهاية الأسبوع',
        price: 1500,
        detailsAr: 'خصم مؤقت',
        isActive: true,
      }),
    });
    expect(addOfferRes.status).toBe(201);

    const delOfferRes = await fetch(`${serverUrl}/api/my-business/offers/OFF-TEMP`, {
      method: 'DELETE',
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken,
      },
    });
    expect(delOfferRes.status).toBe(200);

    // -----------------------------------------------------------------------
    // Step 5 & 6: Verify Telegram bot responses reflect changes & Gemini receives correct context
    // -----------------------------------------------------------------------
    const outgoingMessages = [];
    const jewelryBot = createTelegramBot({
      token: '222222:ZZZYYYxxxWWWvvvUUUtttsssrqq333444',
      supportService,
      businessId: 'saad-jewelry-sa',
      botId: 'bot-jewelry',
      botConfig: {
        botInfo: {
          id: 8888,
          is_bot: true,
          first_name: 'SaadJewelryBot',
          username: 'SaadJewelryBot',
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      },
    });

    jewelryBot.api.config.use((prev, method, payload) => {
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

    // Customer sends message on Telegram
    await jewelryBot.handleUpdate({
      update_id: 101,
      message: {
        message_id: 101,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false, first_name: 'Reem', language_code: 'ar' },
        text: 'بكم خاتم الألماس عندكم؟',
      },
    });

    expect(outgoingMessages.at(-1)).toContain('مجوهرات السعد');
    expect(outgoingMessages.at(-1)).toContain('3500 ر.س');

    // Inspect the exact prompt delivered to Gemini
    expect(capturedPrompts.length).toBeGreaterThan(0);
    const lastPrompt = capturedPrompts.at(-1).config.systemInstruction;
    expect(lastPrompt).toContain('دار السعد للمجوهرات الفاخرة');
    expect(lastPrompt).toContain('JWL-01');
    expect(lastPrompt).toContain('خاتم سوليتير ألماس عيار 18');
    expect(lastPrompt).toContain('JWL-02');
    expect(lastPrompt).toContain('2,400'); // updated price with locale formatting reflected immediately!
    expect(lastPrompt).toContain('Saudi');
    // Ensure strict isolation: No coffee or perfume products in the prompt
    expect(lastPrompt).not.toContain('nexora-coffee-sa');
    expect(lastPrompt).not.toContain('alwadi-perfumes-sa');

    // -----------------------------------------------------------------------
    // Step 7: Verify another business cannot access this business's products or data
    // -----------------------------------------------------------------------
    // Create and login as coffee owner
    authStore.createUser({
      email: 'owner@coffee.sa',
      password: 'CoffeePassword123!',
      role: 'business_owner',
      business_id: 'nexora-coffee-sa',
    });

    const otherLoginRes = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@coffee.sa',
        password: 'CoffeePassword123!',
      }),
    });
    const otherCookie = otherLoginRes.headers.get('set-cookie').split(';')[0];
    const otherCsrf = (await otherLoginRes.json()).csrfToken;

    // Coffee owner attempts to read jewelry business data
    const queryTamperRes = await fetch(
      `${serverUrl}/api/my-business?business_id=saad-jewelry-sa`,
      { headers: { Cookie: otherCookie } }
    );
    expect(queryTamperRes.status).toBe(403);

    // Coffee owner attempts to edit jewelry product JWL-01
    const productTamperRes = await fetch(
      `${serverUrl}/api/my-business/products/JWL-01`,
      {
        method: 'PUT',
        headers: {
          Cookie: otherCookie,
          'X-CSRF-Token': otherCsrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ price: 10 }),
      }
    );
    expect(productTamperRes.status).toBe(404); // Not found in coffee store catalog

    // -----------------------------------------------------------------------
    // Step 8: Verify Telegram bot failures do not interrupt other bots
    // -----------------------------------------------------------------------
    const failingBot = {
      start: vi.fn().mockRejectedValue(new Error('Telegram 409 Conflict')),
    };
    const healthyBot = {
      start: vi.fn().mockResolvedValue(undefined),
    };

    const manager = new TelegramBotManager({
      botRegistry,
      businessStore,
      supportService,
      botFactory: ({ botId }) => {
        if (botId === 'bot-coffee') return failingBot;
        return healthyBot;
      },
    });

    const botResults = await manager.startAllActiveBots({ startPolling: true });
    expect(botResults.started.some((b) => b.botId === 'bot-jewelry')).toBe(true);
    expect(manager.runningBots.has('bot-jewelry')).toBe(true);

    // -----------------------------------------------------------------------
    // Step 9: Verify API errors are handled safely
    // -----------------------------------------------------------------------
    // Invalid JSON payload
    const badJsonRes = await fetch(`${serverUrl}/api/my-business/products`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      body: '{"invalid_json": true,',
    });
    expect(badJsonRes.status).toBe(400);
    const badJson = await badJsonRes.json();
    expect(badJson.error).toBe('INVALID_JSON');
    expect(badJson.message).toBe('Invalid JSON payload.');

    // 404 on nonexistent route
    const notFoundRes = await fetch(`${serverUrl}/api/nonexistent-route`, {
      headers: { Cookie: cookieHeader },
    });
    expect(notFoundRes.status).toBe(404);

    // -----------------------------------------------------------------------
    // Step 10: Verify the application still works after restarting the server
    // -----------------------------------------------------------------------
    // Close current server and stores
    await new Promise((resolve) => apiServer.close(() => resolve()));
    authStore.close();

    // Reopen from same persistent disk files
    const restartedBusinessStore = new BusinessStore({ filePath: tempBizFile });
    const restartedAuthStore = new AuthStore({
      dbPath: tempDbPath,
      businessStore: restartedBusinessStore,
    });

    const restartedApiServer = createApiServer({
      authStore: restartedAuthStore,
      businessStore: restartedBusinessStore,
      botRegistry,
      isProduction: true,
    });

    let restartedUrl;
    await new Promise((resolve) => {
      restartedApiServer.listen(0, '127.0.0.1', () => {
        const addr = restartedApiServer.address();
        restartedUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    try {
      // Login with beta customer account after restart
      const restartLoginRes = await fetch(`${restartedUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@saad-jewelry.sa',
          password: 'BetaCustomerPass2026!',
        }),
      });
      expect(restartLoginRes.status).toBe(200);

      const restartCookie = restartLoginRes.headers.get('set-cookie').split(';')[0];
      const restartBizRes = await fetch(`${restartedUrl}/api/my-business`, {
        headers: { Cookie: restartCookie },
      });
      expect(restartBizRes.status).toBe(200);
      const reloadedBiz = (await restartBizRes.json()).business;
      expect(reloadedBiz.name).toBe('دار السعد للمجوهرات الفاخرة');
      expect(reloadedBiz.products.some((p) => p.id === 'JWL-02' && p.price === 2400)).toBe(true);
    } finally {
      await new Promise((resolve) => restartedApiServer.close(() => resolve()));
      restartedAuthStore.close();
    }
  });
});
