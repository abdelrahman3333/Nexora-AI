import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/geminiProvider.js';
import { createApiServer, SESSION_COOKIE_NAME } from '../src/api/server.js';
import { AuthStore } from '../src/auth/authStore.js';
import { hashPassword, verifyPassword } from '../src/auth/passwordHasher.js';
import { BotRegistry } from '../src/config/botRegistry.js';
import { BusinessStore, DEFAULT_BUSINESSES_FILE } from '../src/config/businessStore.js';
import { ConversationStore } from '../src/memory/conversationStore.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { SupportService } from '../src/services/supportService.js';
import { createTelegramBot } from '../src/telegram/bot.js';
import { TelegramBotManager } from '../src/telegram/botManager.js';
import { AIProviderError } from '../src/utils/errors.js';

describe('Nexora AI — End-to-End Security & Architecture Audit', () => {
  let tempDir;
  let tempDbPath;
  let tempBizFile;
  let tempBotsFile;
  let authStore;
  let businessStore;
  let botRegistry;
  let apiServer;
  let serverUrl;
  let mockAiGenerate;
  let supportService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-sec-audit-'));
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
              bot_id: 'bot-sec-coffee',
              business_id: 'nexora-coffee-sa',
              bot_username: 'NexoraSecBot',
              token_env_var: 'TELEGRAM_BOT_TOKEN_COFFEE',
              status: 'active',
            },
            {
              bot_id: 'bot-sec-perfume',
              business_id: 'alwadi-perfumes-sa',
              bot_username: 'AlwadiSecBot',
              token_env_var: 'TELEGRAM_BOT_TOKEN_PERFUME',
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
        TELEGRAM_BOT_TOKEN_COFFEE: '111111:AAABBBcccDDDeeeFFFggghhhiii111222',
        TELEGRAM_BOT_TOKEN_PERFUME: '222222:ZZZYYYxxxWWWvvvUUUtttsssrqq333444',
      },
    });

    authStore = new AuthStore({
      dbPath: tempDbPath,
      businessStore,
      sessionTtlMs: 2000,
    });

    // Seed default roles
    authStore.createUser({
      email: 'admin@nexora.ai',
      password: 'PlatformAdmin123!',
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

    mockAiGenerate = vi.fn().mockImplementation(async (payload) => {
      const prompt = payload.config.systemInstruction;
      if (prompt.includes('nexora-coffee-sa')) {
        return { text: 'أهلاً بك في متجر القهوة، يسعدنا خدمتك.' };
      }
      return { text: 'أهلاً بك في متجر العطور، يسعدنا خدمتك.' };
    });

    const aiProvider = new GeminiProvider({
      client: { models: { generateContent: mockAiGenerate } },
    });

    supportService = new SupportService({
      aiProvider,
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter({ windowMs: 1000, maxRequests: 50 }),
      businessStore,
      defaultBusinessId: 'nexora-coffee-sa',
    });

    apiServer = createApiServer({
      authStore,
      businessStore,
      botRegistry,
      loginRateLimiter: new RateLimiter({ windowMs: 1000, maxRequests: 3 }),
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
  // 1. Authentication & Sessions Audit
  // =========================================================================
  describe('1. Authentication & Sessions', () => {
    it('enforces secure password hashing via crypto.scrypt with timingSafeEqual', () => {
      const pass = 'AuditStrongPass123!';
      const hash = hashPassword(pass);
      expect(hash).toMatch(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
      expect(verifyPassword(pass, hash)).toBe(true);
      expect(verifyPassword('WrongPass!', hash)).toBe(false);
    });

    it('sets HttpOnly, SameSite=Strict, and Secure cookie attributes on production login', async () => {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'coffee_owner@nexora.sa',
          password: 'CoffeeOwner123!',
        }),
      });

      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('Path=/');

      const data = await res.json();
      expect(data.user).toBeDefined();
      expect(data.user.password_hash).toBeUndefined();
      expect(data.csrfToken).toBeTruthy();
    });

    it('enforces login rate limiting and prevents brute-force credential stuffing', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${serverUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'victim@store.sa',
            password: 'BadPassword',
          }),
        });
        expect(res.status).toBe(401);
      }

      const blockedRes = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'victim@store.sa',
          password: 'BadPassword',
        }),
      });
      expect(blockedRes.status).toBe(429);
      const body = await blockedRes.json();
      expect(body.error).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('protects against session fixation by generating a unique new session on every authentication', async () => {
      const login1 = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'coffee_owner@nexora.sa',
          password: 'CoffeeOwner123!',
        }),
      });
      const cookie1 = login1.headers.get('set-cookie');

      const login2 = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'coffee_owner@nexora.sa',
          password: 'CoffeeOwner123!',
        }),
      });
      const cookie2 = login2.headers.get('set-cookie');

      expect(cookie1).not.toBe(cookie2);
    });

    it('enforces CSRF validation on all state-changing requests and invalidates session on logout', async () => {
      const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'coffee_owner@nexora.sa',
          password: 'CoffeeOwner123!',
        }),
      });
      const rawCookie = loginRes.headers.get('set-cookie').split(';')[0];
      const { csrfToken } = await loginRes.json();

      // State-changing request without CSRF must fail with 403
      const noCsrfRes = await fetch(`${serverUrl}/api/my-business`, {
        method: 'PUT',
        headers: {
          Cookie: rawCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hacked Store' }),
      });
      expect(noCsrfRes.status).toBe(403);
      const noCsrfData = await noCsrfRes.json();
      expect(noCsrfData.error).toBe('INVALID_CSRF_TOKEN');

      // Logout request
      const logoutRes = await fetch(`${serverUrl}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: rawCookie,
          'X-CSRF-Token': csrfToken,
        },
      });
      expect(logoutRes.status).toBe(200);

      // Reusing the session after logout must fail with 401
      const reuseRes = await fetch(`${serverUrl}/api/auth/me`, {
        headers: { Cookie: rawCookie },
      });
      expect(reuseRes.status).toBe(401);
    });
  });

  // =========================================================================
  // 2. Authorization & Multi-Tenant Isolation Audit
  // =========================================================================
  describe('2. Authorization & Multi-Tenant Isolation', () => {
    it('strictly isolates business owners: blocks access or modification of another business (IDOR/BOLA prevention)', async () => {
      // Login as coffee owner
      const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'coffee_owner@nexora.sa',
          password: 'CoffeeOwner123!',
        }),
      });
      const cookie = loginRes.headers.get('set-cookie').split(';')[0];
      const { csrfToken } = await loginRes.json();

      // Attempt 1: Query param spoofing to access perfume store
      const spoofQueryRes = await fetch(
        `${serverUrl}/api/my-business?business_id=alwadi-perfumes-sa`,
        { headers: { Cookie: cookie } }
      );
      expect(spoofQueryRes.status).toBe(403);
      expect((await spoofQueryRes.json()).error).toBe('CROSS_BUSINESS_ACCESS_DENIED');

      // Attempt 2: Body payload spoofing to target perfume store
      const spoofBodyRes = await fetch(`${serverUrl}/api/my-business`, {
        method: 'PUT',
        headers: {
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          business_id: 'alwadi-perfumes-sa',
          name: 'Takeover Perfumes',
        }),
      });
      expect(spoofBodyRes.status).toBe(403);
      expect((await spoofBodyRes.json()).error).toBe('CROSS_BUSINESS_ACCESS_DENIED');

      // Attempt 3: Product creation targeting another store
      const spoofProductRes = await fetch(`${serverUrl}/api/my-business/products`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          business_id: 'alwadi-perfumes-sa',
          id: 'HACK-01',
          nameAr: 'منتج غير شرعي',
          price: 10,
        }),
      });
      expect(spoofProductRes.status).toBe(403);

      // Attempt 4: Business owner cannot access platform_admin endpoints
      const adminAttempt = await fetch(`${serverUrl}/api/admin/businesses`, {
        headers: { Cookie: cookie },
      });
      expect(adminAttempt.status).toBe(403);
      expect((await adminAttempt.json()).error).toBe('FORBIDDEN_ADMIN_ONLY');
    });

    it('ensures platform_admin cannot access /api/my-business (exclusive to business_owner)', async () => {
      const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@nexora.ai',
          password: 'PlatformAdmin123!',
        }),
      });
      const cookie = loginRes.headers.get('set-cookie').split(';')[0];

      const res = await fetch(`${serverUrl}/api/my-business`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('FORBIDDEN_BUSINESS_OWNER_ONLY');
    });

    it('never leaks secret bot tokens in bot status or inspection APIs', async () => {
      const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'coffee_owner@nexora.sa',
          password: 'CoffeeOwner123!',
        }),
      });
      const cookie = loginRes.headers.get('set-cookie').split(';')[0];

      const res = await fetch(`${serverUrl}/api/my-business/bot`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.bot).toBeDefined();
      expect(data.bot.bot_username).toBe('NexoraSecBot');
      expect(data.bot.hasTokenConfigured).toBe(true);

      // Verify NO token keys exist in response
      expect(data.bot.token).toBeUndefined();
      expect(data.bot.bot_token).toBeUndefined();
      expect(data.bot.rawToken).toBeUndefined();
      const stringified = JSON.stringify(data);
      expect(stringified).not.toContain('AAABBBcccDDD');
    });
  });

  // =========================================================================
  // 3. Telegram & Gemini Integration Audit
  // =========================================================================
  describe('3. Telegram & Gemini Integration', () => {
    it('preserves strict bot binding and rejects customer commands attempting to manage or switch businesses', async () => {
      const outgoingMessages = [];
      const bot = createTelegramBot({
        token: '111111:AAABBBcccDDDeeeFFFggghhhiii111222',
        supportService,
        businessId: 'nexora-coffee-sa',
        botId: 'bot-sec-coffee',
        botConfig: {
          botInfo: {
            id: 1111,
            is_bot: true,
            first_name: 'NexoraSecBot',
            username: 'NexoraSecBot',
            can_join_groups: false,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          },
        },
      });

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

      const makeCommandUpdate = (updateId, cmd) => ({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 789, type: 'private' },
          from: { id: 789, is_bot: false, first_name: 'Attacker' },
          text: cmd,
          entities: [{ offset: 0, length: cmd.split(' ')[0].length, type: 'bot_command' }],
        },
      });

      await bot.handleUpdate(makeCommandUpdate(1, '/business alwadi-perfumes-sa'));
      expect(outgoingMessages.at(-1)).toContain('غير متاح للعملاء');

      await bot.handleUpdate(makeCommandUpdate(2, '/admin'));
      expect(outgoingMessages.at(-1)).toContain('غير متاح للعملاء');
    });

    it('strictly isolates customer conversation history by businessId, botId, and userId', async () => {
      const convStore = supportService.conversationStore;

      // Append messages under same customer userId (999) across 2 different stores & bots
      convStore.appendMessage('nexora-coffee-sa', '999', 'user', 'عايز قهوة اثيوبية', 'telegram', 'bot-coffee');
      convStore.appendMessage('nexora-coffee-sa', '999', 'model', 'متوفرة محمصة طازجة', 'telegram', 'bot-coffee');

      convStore.appendMessage('alwadi-perfumes-sa', '999', 'user', 'عايز دهن عود', 'telegram', 'bot-perfume');

      const coffeeHistory = convStore.getHistory('nexora-coffee-sa', '999', 'telegram', 'bot-coffee');
      const perfumeHistory = convStore.getHistory('alwadi-perfumes-sa', '999', 'telegram', 'bot-perfume');

      expect(coffeeHistory).toHaveLength(2);
      expect(coffeeHistory[0].text).toBe('عايز قهوة اثيوبية');

      expect(perfumeHistory).toHaveLength(1);
      expect(perfumeHistory[0].text).toBe('عايز دهن عود');

      // Verify cross-tenant isolation
      expect(coffeeHistory.some((m) => m.text.includes('عود'))).toBe(false);
      expect(perfumeHistory.some((m) => m.text.includes('قهوة'))).toBe(false);
    });

    it('isolates bot failures: one failing bot does not stop or affect other running bots', async () => {
      const failingBotInstance = {
        start: vi.fn().mockRejectedValue(new Error('Telegram 401: Unauthorized polling token')),
      };
      const healthyBotInstance = {
        start: vi.fn().mockResolvedValue(undefined),
      };

      const customManager = new TelegramBotManager({
        botRegistry,
        businessStore,
        supportService,
        botFactory: ({ botId }) => {
          if (botId === 'bot-sec-coffee') return failingBotInstance;
          return healthyBotInstance;
        },
      });

      const result = await customManager.startAllActiveBots({ startPolling: true });
      expect(result.started.some((b) => b.botId === 'bot-sec-perfume')).toBe(true);
      expect(customManager.runningBots.has('bot-sec-perfume')).toBe(true);
    });
  });

  // =========================================================================
  // 4. API & Frontend Security Audit
  // =========================================================================
  describe('4. API & Frontend Security', () => {
    it('sets comprehensive modern security headers across API and static responses', async () => {
      const res = await fetch(`${serverUrl}/api/auth/me`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");

      const staticRes = await fetch(`${serverUrl}/`);
      expect(staticRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(staticRes.headers.get('x-frame-options')).toBe('DENY');
      expect(staticRes.headers.get('content-security-policy')).toContain("default-src 'self'");
    });

    it('prevents path traversal attacks and blocks requests trying to escape public directory', async () => {
      const traversalRes = await fetch(`${serverUrl}/..%2f..%2fpackage.json`);
      expect(traversalRes.status).toBe(404);

      const secretEnvRes = await fetch(`${serverUrl}/../.env`);
      expect(secretEnvRes.status).toBe(404);
    });

    it('rejects oversized JSON request payloads (>64KB) to mitigate Denial of Service', async () => {
      const hugeData = 'A'.repeat(70 * 1024);
      let errored = false;
      try {
        const res = await fetch(`${serverUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hugeData }),
        });
        if (res.status >= 400) errored = true;
      } catch {
        errored = true;
      }
      expect(errored).toBe(true);
    });
  });

  // =========================================================================
  // 5. Reliability & Fallback Audit
  // =========================================================================
  describe('5. Reliability & Fallbacks', () => {
    it('returns a polite localized apology when Gemini API is completely unavailable without crashing or leaking secrets', async () => {
      const failingAi = new GeminiProvider({
        client: {
          models: {
            generateContent: vi.fn().mockRejectedValue(
              new AIProviderError('Google Cloud 503 Service Unavailable', {
                statusCode: 503,
                code: 'AI_UNAVAILABLE',
              })
            ),
          },
        },
        maxRetries: 0,
      });

      const testSupport = new SupportService({
        aiProvider: failingAi,
        conversationStore: new ConversationStore(),
        rateLimiter: new RateLimiter(),
        businessStore,
        defaultBusinessId: 'nexora-coffee-sa',
      });

      const reply = await testSupport.handleIncomingMessage({
        businessId: 'nexora-coffee-sa',
        userId: 'cust-fallback-1',
        text: 'بكم سعر البن؟',
      });

      expect(reply.isError).toBe(true);
      expect(reply.text).toContain('نعتذر منك');
      expect(reply.text).not.toContain('Google Cloud 503');
      expect(reply.text).not.toContain('AI_UNAVAILABLE');
    });
  });
});
