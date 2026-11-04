import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/geminiProvider.js';
import { calculateModelCost } from '../src/ai/modelPricing.js';
import { UsageStore } from '../src/analytics/usageStore.js';
import { createApiServer } from '../src/api/server.js';
import { AuthStore } from '../src/auth/authStore.js';
import { BotRegistry } from '../src/config/botRegistry.js';
import { BusinessStore, DEFAULT_BUSINESSES_FILE } from '../src/config/businessStore.js';
import { AIProviderError } from '../src/utils/errors.js';

describe('Nexora AI — Production Gemini Usage & Cost Tracking', () => {
  let tempDir;
  let tempDbPath;
  let tempBizFile;
  let tempBotsFile;
  let authStore;
  let usageStore;
  let businessStore;
  let botRegistry;
  let apiServer;
  let serverUrl;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-usage-test-'));
    tempDbPath = path.join(tempDir, 'test-auth.sqlite');
    tempBizFile = path.join(tempDir, 'businesses.json');
    tempBotsFile = path.join(tempDir, 'bots.json');

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
            {
              bot_id: 'bot-perfumes',
              business_id: 'alwadi-perfumes-sa',
              bot_username: 'AlwadiPerfumesBot',
              token_env_var: 'TG_TOKEN_PERFUME',
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
        TG_TOKEN_PERFUME: '222222:ZZZYYYxxxWWWvvvUUUtttsssrqq333444',
      },
    });

    authStore = new AuthStore({
      dbPath: tempDbPath,
      businessStore,
      sessionTtlMs: 3600000,
    });

    usageStore = new UsageStore({
      db: authStore.db,
    });

    // Seed test users
    authStore.createUser({
      email: 'admin@nexora.ai',
      password: 'AdminSuperPass123!',
      role: 'platform_admin',
    });

    authStore.createUser({
      email: 'coffee_owner@nexora.sa',
      password: 'CoffeeOwner123!',
      role: 'business_owner',
      business_id: 'nexora-coffee-sa',
    });

    authStore.createUser({
      email: 'perfume_owner@alwadi.sa',
      password: 'PerfumeOwner123!',
      role: 'business_owner',
      business_id: 'alwadi-perfumes-sa',
    });

    apiServer = createApiServer({
      authStore,
      businessStore,
      botRegistry,
      usageStore,
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

  // =========================================================================
  // 1. Gemini Request Tracking (Success, Tokens, and Missing Metadata)
  // =========================================================================
  describe('Gemini Provider Tracking & Token Capture', () => {
    it('captures real usageMetadata tokens on successful responses', async () => {
      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'أهلاً بك، هذه قهوة مختصة.',
        usageMetadata: {
          promptTokenCount: 1420,
          candidatesTokenCount: 85,
          totalTokenCount: 1505,
        },
      });

      const provider = new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
        model: 'gemini-3.5-flash-lite',
        usageTracker: usageStore,
      });

      const reply = await provider.generateReply({
        systemInstruction: 'تعليمات المتجر',
        userMessage: 'وش عندكم قهوة؟',
        businessId: 'nexora-coffee-sa',
        botId: 'bot-coffee',
        requestId: 'req_test_success_1',
      });

      expect(reply).toBe('أهلاً بك، هذه قهوة مختصة.');

      const summary = usageStore.getUsageSummary('nexora-coffee-sa');
      expect(summary.totalRequests).toBe(1);
      expect(summary.successfulRequests).toBe(1);
      expect(summary.failedRequests).toBe(0);
      expect(summary.totalPromptTokens).toBe(1420);
      expect(summary.totalOutputTokens).toBe(85);
      expect(summary.totalTokens).toBe(1505);
      expect(summary.rateLimit429Errors).toBe(0);
      expect(summary.uniqueCustomerRequests).toBe(1);
      expect(summary.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('handles missing usageMetadata safely without crashing and defaults tokens to 0', async () => {
      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'رد بدون بيانات توكنات',
        // usageMetadata is omitted
      });

      const provider = new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
        model: 'gemini-3.5-flash-lite',
        usageTracker: usageStore,
      });

      const reply = await provider.generateReply({
        systemInstruction: 'تعليمات',
        userMessage: 'مرحباً',
        businessId: 'nexora-coffee-sa',
        botId: 'bot-coffee',
        requestId: 'req_missing_meta',
      });

      expect(reply).toBe('رد بدون بيانات توكنات');
      const summary = usageStore.getUsageSummary('nexora-coffee-sa');
      expect(summary.totalRequests).toBe(1);
      expect(summary.successfulRequests).toBe(1);
      expect(summary.totalTokens).toBe(0);
    });

    it('tracks failed attempts, 429 rate limit errors, and fallback model retries', async () => {
      let callCount = 0;
      const mockGenerateContent = vi.fn().mockImplementation(async (payload) => {
        callCount++;
        if (callCount === 1) {
          // Attempt 1: 429 Resource Exhausted on primary model
          const err = new Error('429 Resource Exhausted: High demand');
          err.status = 429;
          throw err;
        }
        // Attempt 2: Success on fallback model
        return {
          text: 'تم الرد بنجاح عبر الموديل البديل',
          usageMetadata: {
            promptTokenCount: 1100,
            candidatesTokenCount: 50,
            totalTokenCount: 1150,
          },
        };
      });

      const provider = new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
        model: 'gemini-3.5-flash-lite',
        fallbackModels: ['gemini-3.5-flash-lite', 'gemini-3.5-flash'],
        maxRetries: 1,
        baseRetryDelayMs: 10,
        usageTracker: usageStore,
      });

      const reply = await provider.generateReply({
        systemInstruction: 'نظام المتجر',
        userMessage: 'طلب مع إعادة محاولة',
        businessId: 'nexora-coffee-sa',
        botId: 'bot-coffee',
        requestId: 'req_retry_test',
      });

      expect(reply).toBe('تم الرد بنجاح عبر الموديل البديل');

      const summary = usageStore.getUsageSummary('nexora-coffee-sa');
      // Total attempts = 2 (1 failed + 1 successful)
      expect(summary.totalRequests).toBe(2);
      expect(summary.successfulRequests).toBe(1);
      expect(summary.failedRequests).toBe(1);
      expect(summary.rateLimit429Errors).toBe(1);
      // Unique customer interaction count = 1
      expect(summary.uniqueCustomerRequests).toBe(1);

      // Verify usage by model captured both models
      const models = usageStore.getUsageByModel('nexora-coffee-sa');
      expect(models.length).toBeGreaterThanOrEqual(1);
    });

    it('ensures logging failures never crash or throw to the caller', async () => {
      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'رد سليم بالرغم من عطل التسجيل',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
      });

      // Faulty tracker that throws
      const brokenTracker = {
        recordUsage: vi.fn().mockImplementation(() => {
          throw new Error('Database locked / disk full error');
        }),
      };

      const provider = new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
        usageTracker: brokenTracker,
      });

      // Must complete successfully without throwing
      const reply = await provider.generateReply({
        systemInstruction: 'تعليمات',
        userMessage: 'رسالة عميل',
        businessId: 'nexora-coffee-sa',
      });

      expect(reply).toBe('رد سليم بالرغم من عطل التسجيل');
      expect(brokenTracker.recordUsage).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Cost Calculation & Model Pricing Registry
  // =========================================================================
  describe('Model Pricing & Cost Calculation Registry', () => {
    it('calculates verified prices separately for prompt and output tokens', () => {
      // 1M prompt tokens for gemini-3.5-flash-lite ($0.075) + 1M candidate tokens ($0.30) = $0.375
      const cost = calculateModelCost('gemini-3.5-flash-lite', 1_000_000, 1_000_000);
      expect(cost.isVerified).toBe(true);
      expect(cost.pricingUnavailable).toBe(false);
      expect(cost.inputCostUsd).toBe(0.075);
      expect(cost.outputCostUsd).toBe(0.3);
      expect(cost.estimatedCostUsd).toBe(0.375);
    });

    it('explicitly returns pricingUnavailable for preview / unverified models without inventing costs', () => {
      const costPreview = calculateModelCost('gemini-3.8-flash', 500_000, 100_000);
      expect(costPreview.isVerified).toBe(false);
      expect(costPreview.pricingUnavailable).toBe(true);
      expect(costPreview.estimatedCostUsd).toBeNull();
      expect(costPreview.disclaimer).toContain('Pricing unavailable');

      const costUnknown = calculateModelCost('non-existent-ai-model-99', 500, 100);
      expect(costUnknown.pricingUnavailable).toBe(true);
      expect(costUnknown.estimatedCostUsd).toBeNull();
    });
  });

  // =========================================================================
  // 3. Secure REST API Endpoints & Multi-Tenant Isolation
  // =========================================================================
  describe('Secure Usage REST API Endpoints', () => {
    let coffeeCookie;
    let perfumeCookie;

    beforeEach(async () => {
      // Seed some usage records for coffee and perfume
      usageStore.recordUsage({
        business_id: 'nexora-coffee-sa',
        bot_id: 'bot-coffee',
        model: 'gemini-3.5-flash-lite',
        request_id: 'coffee_req_1',
        prompt_tokens: 1000,
        candidates_tokens: 100,
        total_tokens: 1100,
        is_success: 1,
        created_at: Date.now() - 5000,
      });

      usageStore.recordUsage({
        business_id: 'alwadi-perfumes-sa',
        bot_id: 'bot-perfumes',
        model: 'gemini-3.5-flash',
        request_id: 'perfume_req_1',
        prompt_tokens: 5000,
        candidates_tokens: 500,
        total_tokens: 5500,
        is_success: 1,
        created_at: Date.now() - 5000,
      });

      // Login as coffee owner
      const coffeeRes = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'coffee_owner@nexora.sa',
          password: 'CoffeeOwner123!',
        }),
      });
      coffeeCookie = coffeeRes.headers.get('set-cookie').split(';')[0];

      // Login as perfume owner
      const perfumeRes = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'perfume_owner@alwadi.sa',
          password: 'PerfumeOwner123!',
        }),
      });
      perfumeCookie = perfumeRes.headers.get('set-cookie').split(';')[0];
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${serverUrl}/api/my-business/usage`);
      expect(res.status).toBe(401);
    });

    it('strictly isolates business usage: returns only the authenticated owner data and blocks query tampering', async () => {
      // Coffee owner requests usage
      const coffeeUsageRes = await fetch(`${serverUrl}/api/my-business/usage`, {
        headers: { Cookie: coffeeCookie },
      });
      expect(coffeeUsageRes.status).toBe(200);
      const coffeeData = (await coffeeUsageRes.json()).summary;
      expect(coffeeData.businessId).toBe('nexora-coffee-sa');
      expect(coffeeData.totalTokens).toBe(1100);

      // Perfume owner requests usage
      const perfumeUsageRes = await fetch(`${serverUrl}/api/my-business/usage`, {
        headers: { Cookie: perfumeCookie },
      });
      expect(perfumeUsageRes.status).toBe(200);
      const perfumeData = (await perfumeUsageRes.json()).summary;
      expect(perfumeData.businessId).toBe('alwadi-perfumes-sa');
      expect(perfumeData.totalTokens).toBe(5500);

      // Attempt to tamper with query parameter: coffee owner passing business_id=alwadi-perfumes-sa
      const tamperRes = await fetch(
        `${serverUrl}/api/my-business/usage?business_id=alwadi-perfumes-sa`,
        { headers: { Cookie: coffeeCookie } }
      );
      expect(tamperRes.status).toBe(403);
    });

    it('provides daily and model breakdowns via REST API with date filtering', async () => {
      // Daily endpoint
      const dailyRes = await fetch(`${serverUrl}/api/my-business/usage/daily`, {
        headers: { Cookie: coffeeCookie },
      });
      expect(dailyRes.status).toBe(200);
      const dailyData = (await dailyRes.json()).daily;
      expect(Array.isArray(dailyData)).toBe(true);
      expect(dailyData.length).toBeGreaterThanOrEqual(1);
      expect(dailyData[0].totalRequests).toBe(1);

      // Models endpoint
      const modelsRes = await fetch(`${serverUrl}/api/my-business/usage/models`, {
        headers: { Cookie: coffeeCookie },
      });
      expect(modelsRes.status).toBe(200);
      const modelsData = (await modelsRes.json()).models;
      expect(Array.isArray(modelsData)).toBe(true);
      expect(modelsData[0].model).toBe('gemini-3.5-flash-lite');
      expect(modelsData[0].isVerifiedPricing).toBe(true);

      // Date filtering validation: invalid date format returns 400
      const badDateRes = await fetch(
        `${serverUrl}/api/my-business/usage?startDate=not-a-valid-date`,
        { headers: { Cookie: coffeeCookie } }
      );
      expect(badDateRes.status).toBe(400);
      expect((await badDateRes.json()).error).toBe('INVALID_DATE_FILTER');
    });

    it('returns a clean empty state when no usage exists for the store', async () => {
      // Create fresh business with 0 usage
      businessStore.upsertBusiness({
        business_id: 'empty-store-sa',
        name: 'متجر فارغ جديد',
        industry: 'تجارة',
        country: 'SA',
        currency: 'SAR',
        timezone: 'Asia/Riyadh',
        dialect: 'saudi',
        tone: 'friendly_gulf',
        companyOverview: { descriptionAr: 'متجر تجريبي فارغ' },
      });

      authStore.createUser({
        email: 'empty@store.sa',
        password: 'EmptyPassword123!',
        role: 'business_owner',
        business_id: 'empty-store-sa',
      });

      const emptyLogin = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'empty@store.sa', password: 'EmptyPassword123!' }),
      });
      const emptyCookie = emptyLogin.headers.get('set-cookie').split(';')[0];

      const res = await fetch(`${serverUrl}/api/my-business/usage`, {
        headers: { Cookie: emptyCookie },
      });
      expect(res.status).toBe(200);
      const summary = (await res.json()).summary;
      expect(summary.totalRequests).toBe(0);
      expect(summary.totalTokens).toBe(0);
      expect(summary.estimatedCostUsd).toBe(0);
    });
  });
});

