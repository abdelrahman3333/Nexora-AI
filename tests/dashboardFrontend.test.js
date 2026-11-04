import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/server.js';
import { AuthStore } from '../src/auth/authStore.js';
import { BotRegistry, DEFAULT_BOTS_FILE } from '../src/config/botRegistry.js';
import { BusinessStore, DEFAULT_BUSINESSES_FILE } from '../src/config/businessStore.js';

describe('Phase 2 Web Dashboard — Static Frontend Serving, RTL, Responsive Assets & Business Owner Experience', () => {
  let tempDir;
  let tempBusinessesFile;
  let tempBotsFile;
  let tempDbFile;
  /** @type {BusinessStore} */
  let businessStore;
  /** @type {BotRegistry} */
  let botRegistry;
  /** @type {AuthStore} */
  let authStore;
  /** @type {import('node:http').Server} */
  let server;
  let baseUrl;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-dashboard-frontend-'));
    tempBusinessesFile = path.join(tempDir, 'businesses.json');
    tempBotsFile = path.join(tempDir, 'bots.json');
    tempDbFile = path.join(tempDir, 'auth.sqlite');

    fs.copyFileSync(DEFAULT_BUSINESSES_FILE, tempBusinessesFile);
    fs.copyFileSync(DEFAULT_BOTS_FILE, tempBotsFile);

    businessStore = new BusinessStore({ filePath: tempBusinessesFile });
    botRegistry = new BotRegistry({
      filePath: tempBotsFile,
      businessStore,
      env: {
        TELEGRAM_BOT_TOKEN: '111111111:AAAbbbCCCdddEEEfffGGGhhhIIIjjj111111',
      },
    });

    authStore = new AuthStore({
      dbPath: tempDbFile,
      businessStore,
    });

    authStore.createUser({
      email: 'owner@coffee.sa',
      password: 'OwnerPassword123!',
      role: 'business_owner',
      business_id: 'nexora-coffee-sa',
    });

    authStore.createUser({
      email: 'owner@perfumes.sa',
      password: 'PerfumePassword123!',
      role: 'business_owner',
      business_id: 'alwadi-perfumes-sa',
    });

    server = createApiServer({
      authStore,
      businessStore,
      botRegistry,
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

  it('serves the single-page dashboard HTML with proper Arabic RTL direction and viewport tags', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('/css/style.css');
    expect(html).toContain('/js/app.js');
    expect(html).toContain('Nexora AI');
  });

  it('serves responsive CSS stylesheet with media queries and RTL styles', async () => {
    const res = await fetch(`${baseUrl}/css/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');

    const css = await res.text();
    expect(css).toContain('direction: rtl');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('--accent: #10b981');
    expect(css).toContain('.sidebar');
  });

  it('serves dashboard application JavaScript file', async () => {
    const res = await fetch(`${baseUrl}/js/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');

    const js = await res.text();
    expect(js).toContain('loadBusinessData');
    expect(js).toContain('/api/auth/login');
    expect(js).toContain('/api/my-business');
    expect(js).toContain('openProductModal');
    expect(js).toContain('openOfferModal');
  });

  it('provides safe bot status endpoint without leaking secret tokens', async () => {
    // Login as coffee owner
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@coffee.sa',
        password: 'OwnerPassword123!',
      }),
    });
    const cookieHeader = loginRes.headers.get('set-cookie').split(';')[0];

    // GET /api/my-business/bot
    const botRes = await fetch(`${baseUrl}/api/my-business/bot`, {
      headers: { Cookie: cookieHeader },
    });
    expect(botRes.status).toBe(200);
    const botData = await botRes.json();

    expect(botData.bot).toBeDefined();
    expect(botData.bot.bot_username).toBe('NexoraaSupportBot');
    expect(botData.bot.business_id).toBe('nexora-coffee-sa');
    expect(botData.bot.token).toBeUndefined();
    expect(botData.bot.token_env_var).toBeUndefined();
    expect(botData.bot.hasTokenConfigured).toBe(true);
    expect(JSON.stringify(botData)).not.toContain('111111111:');
  });

  it('prevents directory traversal and returns 404 for non-existent files', async () => {
    const res = await fetch(`${baseUrl}/../../../package.json`);
    expect(res.status).toBe(404);
  });

  it('regression: index.html shows a no-JS fallback hint if app.js never loads (e.g. opened via file://)', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain('nx-load-hint');
    expect(html).toContain('http://localhost:3000');
    expect(html).toContain('@keyframes nx-show-hint');
    // CSP must remain intact
    const res = await fetch(`${baseUrl}/`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('regression: clears loading state and reliably displays the login screen when unauthenticated or when API returns 401', async () => {
    // 1. Verify GET /api/auth/me returns 401 UNAUTHORIZED when no session exists
    const authRes = await fetch(`${baseUrl}/api/auth/me`);
    expect(authRes.status).toBe(401);
    const authJson = await authRes.json();
    expect(authJson.error).toBe('UNAUTHORIZED');

    // 2. Verify static assets (index.html, app.js, style.css) are served cleanly
    const indexRes = await fetch(`${baseUrl}/`);
    expect(indexRes.status).toBe(200);
    const indexHtml = await indexRes.text();
    expect(indexHtml).toContain('id="app"');
    expect(indexHtml).toContain('جاري تحميل لوحة تحكم Nexora AI...');

    const appJsRes = await fetch(`${baseUrl}/js/app.js`);
    expect(appJsRes.status).toBe(200);
    const appJs = await appJsRes.text();

    // 3. Verify app.js contains DOM readiness guards, credentials: 'same-origin', and safe fallback to renderAuth()
    expect(appJs).toContain("DOMContentLoaded");
    expect(appJs).toContain("credentials: 'same-origin'");
    expect(appJs).toContain("if (!app) return;");

    // 4. Simulate app execution in an unauthenticated browser context
    let renderedHtml = indexHtml;
    const mockAppElement = {
      get innerHTML() { return renderedHtml; },
      set innerHTML(val) { renderedHtml = val; }
    };

    const mockDocument = {
      readyState: 'complete',
      getElementById(id) {
        if (id === 'app') return mockAppElement;
        if (id === 'login-form') return { addEventListener() {} };
        return null;
      },
      addEventListener() {}
    };

    const mockGlobal = {
      document: mockDocument,
      fetch: async (url) => {
        if (url === '/api/auth/me') {
          return {
            status: 401,
            ok: false,
            json: async () => ({ error: 'UNAUTHORIZED' })
          };
        }
        return { status: 404, ok: false, json: async () => ({}) };
      }
    };
    mockGlobal.window = mockGlobal;

    // Run the app.js code in mock browser sandbox
    const runScript = new Function('window', 'document', 'fetch', appJs);
    runScript(mockGlobal, mockDocument, mockGlobal.fetch);

    // Wait for async initApp() to resolve and clear the loading state
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(renderedHtml).not.toContain('جاري تحميل لوحة تحكم Nexora AI...');
    expect(renderedHtml).toContain('تسجيل الدخول للمتجر');
    expect(renderedHtml).toContain('login-form');
    expect(renderedHtml).toContain('login-email');
    expect(renderedHtml).toContain('login-password');
  });
});

