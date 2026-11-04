# Nexora AI — Multi-Tenant GCC Telegram AI Sales & Support Platform

A production-minded, modular, multi-tenant AI Sales & Customer Support Bot platform built with **Node.js (ES Modules)**, **grammY (Official Telegram Bot API)**, and the **Official Google Gen AI SDK (`@google/genai`)**.

Designed for e-commerce businesses across the **Gulf Cooperation Council (GCC)**: **Saudi Arabia (KSA), United Arab Emirates (UAE), Kuwait, Qatar, Bahrain, and Oman**.

---

## 1. Central Multi-Bot Architecture

Nexora AI runs **multiple independent Telegram bots simultaneously** from a single central Node.js application, where each Telegram bot is strictly bound to one verified `business_id`:

```text
src/
  config/
    env.js                  # Startup environment validation with Zod
    businesses.json         # Persistent multi-business store (products, services, offers, policies, FAQs)
    businessStore.js        # Validated CRUD & ownership access control for businesses
    bots.json               # Bot Registry metadata (NO plaintext tokens stored here!)
    botRegistry.js          # Admin-only Bot Registry resolving tokens securely from .env
    businessKnowledge.js    # Schema validator & currency-aware prompt formatter
    defaultKnowledge.json   # Legacy/fallback single-store knowledge file
  telegram/
    botManager.js           # Central Multi-Bot Runtime Manager (start, stop, restart, error isolation)
    bot.js                  # grammY Telegram bot factory bound to a specific business_id & botId
    handlers.js             # Telegram commands (/start, /help, /reset) & strict tenant lock
  ai/
    geminiProvider.js       # Official @google/genai wrapper with timeout, retries & model failover
    promptBuilder.js        # Consultative Saudi sales persona & strict anti-hallucination prompt builder
  services/
    supportService.js       # Platform-agnostic multi-business support & sales engine
  memory/
    conversationStore.js    # Isolated conversation memory keyed by businessId:platform:botId:userId
  middleware/
    rateLimiter.js          # Per-business, per-bot, per-user sliding-window rate limiter
    inputValidator.js       # Input length & control-character sanitization
  utils/
    logger.js               # Structured Pino logger with automatic secret/token redaction
    errors.js               # Custom error hierarchy & localized customer-safe messages
    localization.js         # Arabic/English detection & GCC currency formatting (SAR, AED, KWD, QAR, BHD, OMR)
  app.js                    # Central application bootstrap & graceful shutdown (SIGINT / SIGTERM)
tests/                      # Automated Vitest test suites (100% mocked, no real API keys required)
```

### How the Central Bot Manager Works
1. **`BusinessStore` (`src/config/businesses.json`)**: Holds the verified catalog, prices, offers, services, dialect, currency, and policies for each registered business (`business_id`). Plaintext bot tokens are strictly forbidden in `businesses.json`.
2. **`BotRegistry` (`src/config/bots.json` + `src/config/botRegistry.js`)**: Maps each `bot_id` and `bot_username` to exactly one `business_id`, a `status` (`active` or `inactive`), and a `token_env_var` pointer (e.g., `TELEGRAM_BOT_TOKEN`). Raw tokens live only in `.env` (or the in-memory vault) and are never written to `bots.json` or exposed in logs.
3. **`TelegramBotManager` (`src/telegram/botManager.js`)**: At startup, iterates over all `active` bots in `BotRegistry`, validates that their associated `business_id` exists in `BusinessStore`, verifies that no duplicate bot IDs or tokens are running, and launches independent long-polling clients.
4. **Strict Isolation**:
   - Every incoming message on a bot is locked to that bot's registered `business_id` and `bot_id`.
   - Ordinary Telegram customers cannot switch businesses or supply a `business_id`.
   - Conversation history is isolated by `businessId:platform:botId:userId`.

---

## 2. How the Existing Bot (`@NexoraaSupportBot`) is Registered

In `src/config/bots.json`, the existing bot is pre-registered and active:
```json
{
  "bot_id": "bot-nexora-coffee",
  "business_id": "nexora-coffee-sa",
  "bot_username": "NexoraaSupportBot",
  "token_env_var": "TELEGRAM_BOT_TOKEN",
  "status": "active"
}
```
It reads its secret token from `TELEGRAM_BOT_TOKEN` in your `.env` file and serves customers of **`nexora-coffee-sa`** (*متجر نيكسورا للقهوة المختصة*).

---

## 3. How an Administrator Adds Another Store Bot

To add and run a second Telegram bot (for example, for the pre-configured **`alwadi-perfumes-sa`** *دار الوادي للعطور والعود* store, or a brand-new store):

### Step 1: Add the Business in `src/config/businesses.json`
Ensure the store exists in `src/config/businesses.json` with a unique `business_id` (e.g. `alwadi-perfumes-sa`), along with its products, prices, currency, and policies.

### Step 2: Create the Bot on Telegram & Safely Configure its Token in `.env`
1. Open **[@BotFather](https://t.me/BotFather)** on Telegram and send `/newbot` to create the new store's bot.
2. Copy the new token and add it to your local `.env` file under a dedicated environment variable name (never put the raw token in `businesses.json` or `bots.json`):
   ```dotenv
   TELEGRAM_BOT_TOKEN_ALWADI=222222222:YourSecondBotActualSecretTokenHere
   ```

### Step 3: Register or Activate the Bot in `src/config/bots.json`
In `src/config/bots.json`, set the bot entry's `token_env_var` to match the variable in `.env` and set `"status": "active"`:
```json
{
  "bot_id": "bot-alwadi-perfumes",
  "business_id": "alwadi-perfumes-sa",
  "bot_username": "AlWadiPerfumesBot",
  "token_env_var": "TELEGRAM_BOT_TOKEN_ALWADI",
  "status": "active"
}
```
*(Or register programmatically as a platform administrator via `botRegistry.registerBot(..., { actor: { role: 'platform_admin' } })`.)*

---

## 4. Starting, Stopping, and Managing Bots

### Starting All Active Bots
```bash
npm start
```
*(Or `npm run dev` for watch mode).* All bots with `"status": "active"` in `src/config/bots.json` will start simultaneously. Pressing `Ctrl + C` triggers `botManager.stopAllBots()` for a clean shutdown.

### Programmatic Lifecycle Control (`TelegramBotManager`)
- **Start a single bot**: `await botManager.startBot('bot-alwadi-perfumes')`
- **Stop a single bot (without affecting other bots)**: `await botManager.stopBot('bot-alwadi-perfumes')`
- **Restart a single bot**: `await botManager.restartBot('bot-alwadi-perfumes')`
- **Inspect running bots**: `botManager.listRunningBots()`

---

## 5. Phase 1 Web Dashboard Authentication & REST API

The platform includes a secure REST API (default port `3000`, configurable via `API_PORT` in `.env`) backed by **SQLite (`node:sqlite`)** and **`crypto.scrypt`** password hashing.

### Security Architecture
- **Password Hashing**: `crypto.scrypt` with random 16-byte salts and constant-time verification (`crypto.timingSafeEqual`). Plaintext passwords are never stored, and password hashes are never returned in API responses.
- **Server-Side Sessions**: Stored in SQLite (`data/nexora-auth.sqlite`) and delivered via `HttpOnly; SameSite=Strict` cookies (`Secure` enabled in production). No tokens or passwords are ever stored in `localStorage`.
- **CSRF Protection**: Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) after login must include the `X-CSRF-Token` header matching the session's `csrfToken`.
- **Strict Tenant Isolation**: Every `/api/my-business/*` endpoint derives `business_id` **exclusively from the authenticated server-side session**, rejecting any attempt to pass another store's `business_id`.
- **Live Bot Sync**: Product, price, offer, and store updates made via the API update the shared `BusinessStore` and take effect immediately in the next Gemini response without restarting the Telegram bots.

### How the Platform Administrator Creates the First Admin & Owner Accounts Securely

Public self-registration is disabled for security. The platform administrator can provision the initial `platform_admin` account and the first `business_owner` account using the built-in CLI seed tool:

1. **Create the Platform Administrator account**:
   ```bash
   npm run seed:user -- admin@nexora.ai YourStrongAdminPass123! platform_admin
   ```
2. **Create a Business Owner account linked to a specific `business_id`**:
   ```bash
   npm run seed:user -- owner@nexora-coffee.sa YourStrongOwnerPass123! business_owner nexora-coffee-sa
   ```
3. Once logged in via `POST /api/auth/login`, the `platform_admin` can also create and manage business owner accounts via the Admin REST API:
   - `POST /api/admin/users` — Create a new `business_owner` account and assign a `business_id`.
   - `PATCH /api/admin/users/:userId/business` — Reassign an owner to a `business_id`.
   - `PATCH /api/admin/users/:userId/status` — Disable or enable a user account (disabling immediately revokes active sessions).
   - `GET /api/admin/businesses` — View all registered businesses.

### Business Owner Protected Endpoints
- `POST /api/auth/login` | `POST /api/auth/logout` | `GET /api/auth/me`
- `GET /api/my-business` | `PUT /api/my-business`
- `GET /api/my-business/products` | `POST /api/my-business/products` | `PUT /api/my-business/products/:productId` | `DELETE /api/my-business/products/:productId`
- `GET /api/my-business/offers` | `POST /api/my-business/offers` | `PUT /api/my-business/offers/:offerId` | `DELETE /api/my-business/offers/:offerId`

---

## 6. Phase 2: Nexora AI Business Owner Dashboard (Web Frontend)

Nexora AI includes a lightweight, responsive, and secure **Arabic RTL Web Dashboard** built with vanilla ES Modules and CSS variables, served directly by the central Node.js application (default: `http://localhost:3000`).

### Features & Pages
1. **Overview (نظرة عامة)**: Business profile, currency, country, live bot connection status, and aggregate product/offer counts.
2. **Products (إدارة المنتجات والأسعار)**: List products, add new products, edit pricing/features/stock status, and delete items. All updates sync immediately to subsequent Gemini bot inquiries without restarting the bot.
3. **Offers (العروض والباقات)**: Create, edit, activate/deactivate, and delete promotional bundles and discounts.
4. **Business Settings (إعدادات وسياسات المتجر)**: Manage store name, industry, description, currency, country, delivery policy, return policy, and working hours.
5. **AI Assistant Settings (مساعد المبيعات الذكي)**: Configure Gemini's preferred GCC dialect (`saudi`, `uae`, `kuwaiti`, etc.), tone (`polite_professional_gulf`, `friendly_gulf`, `formal_gulf`), and language matching.
6. **Bot Settings (إعدادات البوت)**: Displays the connected Telegram bot username and online status. Bot tokens are never exposed to owners.
7. **Conversations (المحادثات)**: Displays session memory architecture status and notes on the upcoming database archive integration.

### How to Run Locally on Windows
1. Ensure your `.env` has valid credentials (`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, etc.).
2. Seed or use an existing business owner account:
   ```bash
   npm run seed:user -- owner@nexora-coffee.sa StrongOwnerPass123! business_owner nexora-coffee-sa
   ```
3. Start the application:
   ```bash
   npm start
   ```
4. Open your browser and navigate to:
   ```text
   http://localhost:3000
   ```
5. Log in with your business owner credentials to access the dashboard.

---

## 7. Running Automated Tests

All automated tests run offline using **Vitest** with mocked Gemini and Telegram clients (no real API keys are used):

```bash
npm test
```

---

## 6. Troubleshooting Individual Bots

| Symptom / Log Message | Cause | Solution |
| :--- | :--- | :--- |
| `Skipped starting bot due to configuration or token error` | A bot is marked `"status": "active"` in `bots.json`, but its `token_env_var` is missing in `.env`. | Add the token variable to `.env` or set `"status": "inactive"` in `src/config/bots.json` until the token is ready. Other active bots will continue running normally. |
| `DUPLICATE_BOT_TOKEN` or `409 Conflict` | Two bots are configured with the same Telegram token, or another terminal is polling the same bot. | Ensure each bot in `.env` has its own unique token from `@BotFather` and only one central process is running. |
| `INVALID_BUSINESS_ASSOCIATION` | `business_id` in `bots.json` does not match any `business_id` in `businesses.json`. | Verify that the exact `business_id` exists in `src/config/businesses.json`. |
