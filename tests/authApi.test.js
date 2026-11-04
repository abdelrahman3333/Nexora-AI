import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/geminiProvider.js';
import { createApiServer } from '../src/api/server.js';
import { AuthStore } from '../src/auth/authStore.js';
import { BusinessStore, DEFAULT_BUSINESSES_FILE } from '../src/config/businessStore.js';
import { ConversationStore } from '../src/memory/conversationStore.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { SupportService } from '../src/services/supportService.js';

/**
 * Helper to make HTTP requests against the local test server and capture cookies.
 */
async function apiRequest(baseUrl, routePath, { method = 'GET', body, cookie, csrfToken } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const setCookieHeader = res.headers.get('set-cookie') || '';
  const data = await res.json().catch(() => ({}));

  return {
    status: res.status,
    data,
    setCookie: setCookieHeader,
    cookiePair: setCookieHeader ? setCookieHeader.split(';')[0] : '',
  };
}

describe('Phase 1 Web Dashboard — AuthStore, Session Security, CSRF, RBAC & Live SupportService Sync', () => {
  let tempDir;
  let tempBusinessesFile;
  let tempDbFile;
  /** @type {BusinessStore} */
  let businessStore;
  /** @type {AuthStore} */
  let authStore;
  /** @type {import('node:http').Server} */
  let server;
  let baseUrl;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-auth-api-'));
    tempBusinessesFile = path.join(tempDir, 'businesses.json');
    tempDbFile = path.join(tempDir, 'auth.sqlite');

    fs.copyFileSync(DEFAULT_BUSINESSES_FILE, tempBusinessesFile);

    businessStore = new BusinessStore({ filePath: tempBusinessesFile });
    authStore = new AuthStore({
      dbPath: tempDbFile,
      businessStore,
      sessionTtlMs: 60 * 60 * 1000,
    });

    // Seed initial platform_admin and two business_owners
    authStore.createUser({
      email: 'admin@nexora.ai',
      password: 'AdminStrongPassword123!',
      role: 'platform_admin',
    });

    authStore.createUser({
      email: 'coffee-owner@nexora.sa',
      password: 'CoffeeOwnerPassword123!',
      role: 'business_owner',
      business_id: 'nexora-coffee-sa',
    });

    authStore.createUser({
      email: 'perfume-owner@alwadi.sa',
      password: 'PerfumeOwnerPassword123!',
      role: 'business_owner',
      business_id: 'alwadi-perfumes-sa',
    });

    server = createApiServer({
      authStore,
      businessStore,
      loginRateLimiter: new RateLimiter({ windowMs: 60000, maxRequests: 5 }),
      isProduction: true,
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    authStore.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('logs in successfully, sets HttpOnly/SameSite/Secure cookie, never exposes password_hash, and logs out', async () => {
    const loginRes = await apiRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: 'coffee-owner@nexora.sa',
        password: 'CoffeeOwnerPassword123!',
      },
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.data.user.email).toBe('coffee-owner@nexora.sa');
    expect(loginRes.data.user.role).toBe('business_owner');
    expect(loginRes.data.user.business_id).toBe('nexora-coffee-sa');
    expect(loginRes.data.user.password_hash).toBeUndefined();
    expect(JSON.stringify(loginRes.data)).not.toContain('scrypt$');
    expect(loginRes.data.csrfToken).toBeDefined();

    // Verify secure cookie attributes
    expect(loginRes.setCookie).toContain('nexora_session=');
    expect(loginRes.setCookie).toContain('HttpOnly');
    expect(loginRes.setCookie).toContain('SameSite=Strict');
    expect(loginRes.setCookie).toContain('Secure');

    // GET /api/auth/me works with session cookie
    const meRes = await apiRequest(baseUrl, '/api/auth/me', {
      cookie: loginRes.cookiePair,
    });
    expect(meRes.status).toBe(200);
    expect(meRes.data.user.email).toBe('coffee-owner@nexora.sa');

    // POST /api/auth/logout with CSRF token clears session
    const logoutRes = await apiRequest(baseUrl, '/api/auth/logout', {
      method: 'POST',
      cookie: loginRes.cookiePair,
      csrfToken: loginRes.data.csrfToken,
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.setCookie).toContain('Max-Age=0');

    // Subsequent GET /api/auth/me is rejected with 401
    const afterLogout = await apiRequest(baseUrl, '/api/auth/me', {
      cookie: loginRes.cookiePair,
    });
    expect(afterLogout.status).toBe(401);
  });

  it('rejects incorrect passwords, blocks public registration, and enforces login rate limiting', async () => {
    // Public registration disabled
    const regRes = await apiRequest(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { email: 'hacker@example.com', password: 'Password123!' },
    });
    expect(regRes.status).toBe(403);
    expect(regRes.data.error).toBe('PUBLIC_REGISTRATION_DISABLED');

    // Incorrect password attempts (up to rate limit of 5)
    for (let i = 0; i < 5; i++) {
      const badLogin = await apiRequest(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: {
          email: 'coffee-owner@nexora.sa',
          password: 'WrongPassword999!',
        },
      });
      expect(badLogin.status).toBe(401);
      expect(badLogin.data.error).toBe('INVALID_CREDENTIALS');
    }

    // 6th attempt is rate-limited with 429
    const rateLimitedRes = await apiRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: 'coffee-owner@nexora.sa',
        password: 'CoffeeOwnerPassword123!',
      },
    });
    expect(rateLimitedRes.status).toBe(429);
    expect(rateLimitedRes.data.error).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('rejects unauthorized requests and enforces CSRF protection on state-changing requests', async () => {
    // Unauthenticated request to protected endpoint
    const unauth = await apiRequest(baseUrl, '/api/my-business');
    expect(unauth.status).toBe(401);

    // Login as coffee owner
    const loginRes = await apiRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: 'coffee-owner@nexora.sa',
        password: 'CoffeeOwnerPassword123!',
      },
    });

    // Attempt PUT /api/my-business WITHOUT X-CSRF-Token header
    const noCsrf = await apiRequest(baseUrl, '/api/my-business', {
      method: 'PUT',
      cookie: loginRes.cookiePair,
      body: { name: 'اسم جديد' },
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.data.error).toBe('INVALID_CSRF_TOKEN');

    // Attempt POST /api/my-business/products with wrong X-CSRF-Token
    const badCsrf = await apiRequest(baseUrl, '/api/my-business/products', {
      method: 'POST',
      cookie: loginRes.cookiePair,
      csrfToken: 'wrong-csrf-token-value',
      body: { id: 'PRD-99', nameAr: 'قهوة', price: 50 },
    });
    expect(badCsrf.status).toBe(403);
    expect(badCsrf.data.error).toBe('INVALID_CSRF_TOKEN');
  });

  it('expires sessions accurately after TTL elapses', async () => {
    const now = Date.now();
    const session = authStore.authenticateAndCreateSession(
      'coffee-owner@nexora.sa',
      'CoffeeOwnerPassword123!',
      now
    );

    // Valid before expiration
    expect(
      authStore.getValidSession(session.sessionId, now + 1000)
    ).not.toBeNull();

    // Expired after sessionTtlMs (1 hour)
    expect(
      authStore.getValidSession(session.sessionId, now + 60 * 60 * 1000 + 1)
    ).toBeNull();
  });

  it('allows business owner to manage their own business, products, and offers, while strictly blocking cross-business or admin access', async () => {
    const loginRes = await apiRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: 'coffee-owner@nexora.sa',
        password: 'CoffeeOwnerPassword123!',
      },
    });
    const { cookiePair } = loginRes;
    const { csrfToken } = loginRes.data;

    // 1. GET /api/my-business returns coffee business
    const myBiz = await apiRequest(baseUrl, '/api/my-business', {
      cookie: cookiePair,
    });
    expect(myBiz.status).toBe(200);
    expect(myBiz.data.business.business_id).toBe('nexora-coffee-sa');

    // 2. Owner attempting to pass another business_id in query or body is rejected with 403
    const crossQuery = await apiRequest(
      baseUrl,
      '/api/my-business?business_id=alwadi-perfumes-sa',
      { cookie: cookiePair }
    );
    expect(crossQuery.status).toBe(403);
    expect(crossQuery.data.error).toBe('CROSS_BUSINESS_ACCESS_DENIED');

    const crossBody = await apiRequest(baseUrl, '/api/my-business', {
      method: 'PUT',
      cookie: cookiePair,
      csrfToken,
      body: {
        business_id: 'alwadi-perfumes-sa',
        name: 'محاولة اختراق متجر العطور',
      },
    });
    expect(crossBody.status).toBe(403);

    // 3. Owner attempting to access /api/admin/* endpoints is rejected with 403
    const adminAttempt = await apiRequest(baseUrl, '/api/admin/businesses', {
      cookie: cookiePair,
    });
    expect(adminAttempt.status).toBe(403);
    expect(adminAttempt.data.error).toBe('FORBIDDEN_ADMIN_ONLY');

    // 4. Create a new product (POST /api/my-business/products)
    const createProd = await apiRequest(baseUrl, '/api/my-business/products', {
      method: 'POST',
      cookie: cookiePair,
      csrfToken,
      body: {
        id: 'PRD-V60-FILTERS',
        nameAr: 'فلاتر ورقية V60 (100 حبة)',
        nameEn: 'V60 Paper Filters (100 pack)',
        price: 35,
        inStock: true,
        featuresAr: 'ورق ياباني طبيعي بدون طعم ورقي.',
      },
    });
    expect(createProd.status).toBe(201);
    expect(createProd.data.product.price).toBe(35);

    // 5. Reject invalid product input (negative price)
    const badProd = await apiRequest(baseUrl, '/api/my-business/products', {
      method: 'POST',
      cookie: cookiePair,
      csrfToken,
      body: {
        id: 'PRD-BAD',
        nameAr: 'منتج خاطئ',
        price: -90,
      },
    });
    expect(badProd.status).toBe(400);

    // 6. Update product price (PUT /api/my-business/products/:productId)
    const updateProd = await apiRequest(
      baseUrl,
      '/api/my-business/products/PRD-01',
      {
        method: 'PUT',
        cookie: cookiePair,
        csrfToken,
        body: { price: 410 },
      }
    );
    expect(updateProd.status).toBe(200);
    expect(updateProd.data.product.price).toBe(410);

    // 7. Create, update, and delete an offer
    const createOffer = await apiRequest(baseUrl, '/api/my-business/offers', {
      method: 'POST',
      cookie: cookiePair,
      csrfToken,
      body: {
        id: 'OFF-WINTER',
        titleAr: 'عرض الشتاء للقهوة المختصة',
        price: 499,
        detailsAr: 'مطحنة يدوية مع غلاية ذكية وفلاتر مجانية.',
      },
    });
    expect(createOffer.status).toBe(201);

    const updateOffer = await apiRequest(
      baseUrl,
      '/api/my-business/offers/OFF-WINTER',
      {
        method: 'PUT',
        cookie: cookiePair,
        csrfToken,
        body: { price: 475 },
      }
    );
    expect(updateOffer.status).toBe(200);
    expect(updateOffer.data.offer.price).toBe(475);

    const deleteOffer = await apiRequest(
      baseUrl,
      '/api/my-business/offers/OFF-WINTER',
      {
        method: 'DELETE',
        cookie: cookiePair,
        csrfToken,
      }
    );
    expect(deleteOffer.status).toBe(200);

    // Verify alwadi-perfumes-sa was completely untouched
    const perfumeBiz = businessStore.getBusiness('alwadi-perfumes-sa');
    expect(
      perfumeBiz.products.some((p) => p.id === 'PRD-V60-FILTERS')
    ).toBe(false);
  });

  it('allows platform_admin to create owner accounts, assign businesses, view businesses, and disable/enable accounts', async () => {
    const adminLogin = await apiRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: 'admin@nexora.ai',
        password: 'AdminStrongPassword123!',
      },
    });
    expect(adminLogin.status).toBe(200);
    const { cookiePair } = adminLogin;
    const { csrfToken } = adminLogin.data;

    // 1. View all registered businesses
    const bizList = await apiRequest(baseUrl, '/api/admin/businesses', {
      cookie: cookiePair,
    });
    expect(bizList.status).toBe(200);
    expect(bizList.data.businesses.length).toBeGreaterThanOrEqual(2);

    // 2. Create a new business_owner account
    const createOwner = await apiRequest(baseUrl, '/api/admin/users', {
      method: 'POST',
      cookie: cookiePair,
      csrfToken,
      body: {
        email: 'new-owner@nexora.sa',
        password: 'NewOwnerStrongPass123!',
        role: 'business_owner',
        business_id: 'nexora-coffee-sa',
      },
    });
    expect(createOwner.status).toBe(201);
    expect(createOwner.data.user.password_hash).toBeUndefined();
    const newUserId = createOwner.data.user.user_id;

    // 3. Reassign owner to alwadi-perfumes-sa
    const assignRes = await apiRequest(
      baseUrl,
      `/api/admin/users/${newUserId}/business`,
      {
        method: 'PATCH',
        cookie: cookiePair,
        csrfToken,
        body: { business_id: 'alwadi-perfumes-sa' },
      }
    );
    expect(assignRes.status).toBe(200);
    expect(assignRes.data.user.business_id).toBe('alwadi-perfumes-sa');

    // 4. New owner logs in
    const newOwnerLogin = await apiRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: 'new-owner@nexora.sa',
        password: 'NewOwnerStrongPass123!',
      },
    });
    expect(newOwnerLogin.status).toBe(200);

    // 5. Admin disables the new owner account -> immediately revokes their active session
    const disableRes = await apiRequest(
      baseUrl,
      `/api/admin/users/${newUserId}/status`,
      {
        method: 'PATCH',
        cookie: cookiePair,
        csrfToken,
        body: { is_active: false },
      }
    );
    expect(disableRes.status).toBe(200);
    expect(disableRes.data.user.is_active).toBe(false);

    // Disabled owner's existing session is immediately invalidated
    const checkRevoked = await apiRequest(baseUrl, '/api/my-business', {
      cookie: newOwnerLogin.cookiePair,
    });
    expect(checkRevoked.status).toBe(401);
  });

  it('immediately reflects API product & price updates in subsequent Gemini SupportService responses without bot restart', async () => {
    let lastSystemInstruction = '';
    const mockGenerateContent = vi.fn().mockImplementation(async (payload) => {
      lastSystemInstruction = payload.config.systemInstruction;
      return { text: 'سعر مطحنة نيكسورا برو الآن 380 ر.س بعد التحديث.' };
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

    // Log in as coffee store owner via REST API
    const loginRes = await apiRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: 'coffee-owner@nexora.sa',
        password: 'CoffeeOwnerPassword123!',
      },
    });

    // Update PRD-01 price to 380 SAR via PUT /api/my-business/products/PRD-01
    const updateRes = await apiRequest(
      baseUrl,
      '/api/my-business/products/PRD-01',
      {
        method: 'PUT',
        cookie: loginRes.cookiePair,
        csrfToken: loginRes.data.csrfToken,
        body: { price: 380 },
      }
    );
    expect(updateRes.status).toBe(200);

    // Immediately send a customer message through SupportService (no restart)
    await supportService.handleIncomingMessage({
      businessId: 'nexora-coffee-sa',
      botId: 'bot-nexora-coffee',
      userId: 'tg-customer-live-sync',
      text: 'كم سعر مطحنة نيكسورا برو؟',
      messageId: 901,
    });

    expect(lastSystemInstruction).toContain('380 ر.س (SAR)');
    expect(lastSystemInstruction).not.toContain('450 ر.س (SAR)');
  });
});

