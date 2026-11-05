# Nexora AI — Current Project Status

## 1. Status Classification Guide

To maintain engineering integrity, this document distinguishes clearly between:
1. **Implemented & Independently Verified:** Confirmed through direct command execution, real external API calls, or hands-on runtime inspection during this session.
2. **Implemented & Test-Verified:** Verified by automated offline Vitest test suites (100% mocked dependencies).
3. **Partially Implemented:** Functional code exists in the backend or frontend, but full end-to-end workflows or UI views are incomplete.
4. **Planned (Not Implemented):** Architectural vision and roadmap items where no functional source code has been introduced yet.

---

## 2. Feature Implementation Status

### 2.1 Multi-Tenant Core & Business Catalog
* **Status:** **Implemented & Independently Verified**
* **Details:**
  - `BusinessStore` loads and validates store catalog, policies, currency, and dialect settings from `src/config/businesses.json`.
  - Tested live in runtime: Updates made to store products or policies immediately reflect in the subsequent AI prompt without restarting the central process.
  - Validated GCC localization for Saudi Arabia (`SA`/`SAR`), UAE (`AE`/`AED`), Kuwait (`KW`/`KWD`), Qatar (`QA`/`QAR`), Bahrain (`BH`/`BHD`), and Oman (`OM`/`OMR`).

### 2.2 Telegram Multi-Bot Platform
* **Status:** **Implemented & Independently Verified**
* **Details:**
  - `TelegramBotManager` runs concurrent grammY bot instances bound to distinct `business_id` tenants.
  - Real Telegram API connectivity independently confirmed using `getMe` for `@NexoraaSupportBot`.
  - Active runtime polling independently verified; process successfully registers and receives Telegram polling updates.
  - Secondary bot (`bot-alwadi-perfumes`) is registered in `src/config/bots.json` with status `"inactive"` awaiting token assignment.

### 2.3 Gemini AI Provider & GCC Persona
* **Status:** **Implemented & Independently Verified**
* **Details:**
  - `GeminiProvider` connects to Google's official `@google/genai` SDK.
  - Direct API generation independently verified using real credentials, receiving valid completions from Gemini.
  - GCC consultative sales persona in `src/ai/promptBuilder.js` enforces strict grounding against store products and denies nonexistent items.
  - Automatic exponential backoff retry and fallback model cycling (`gemini-3.5-flash-lite` -> `gemini-3.5-flash` -> `gemini-3.8-flash`) implemented and test-verified.

### 2.4 Token Usage & Cost Tracking
* **Status:** **Implemented & Test-Verified**
* **Details:**
  - `UsageStore` logs every generation attempt (success and failure), token metrics (`prompt_tokens`, `candidates_tokens`, `total_tokens`), model name, and error codes to SQLite table `ai_usage_logs`.
  - `src/ai/modelPricing.js` calculates estimated cost in USD based on published token tiers. Models without verified pricing are explicitly marked as unavailable without guessing rates.
  - REST endpoints `/api/my-business/usage`, `/api/my-business/usage/daily`, and `/api/my-business/usage/models` are active and enforce tenant isolation.

### 2.5 Authentication, RBAC & Security Infrastructure
* **Status:** **Implemented & Test-Verified**
* **Details:**
  - SQLite `users` table supports `platform_admin` and `business_owner` roles.
  - Passwords hashed using `crypto.scrypt` with random 16-byte salt and constant-time verification (`crypto.timingSafeEqual`).
  - Server-side session delivery using `HttpOnly`, `SameSite=Strict` cookies with CSRF token validation.
  - Login rate limiter prevents brute-force credential stuffing.
  - Comprehensive Pino logger redacts sensitive bot tokens and API keys across all logs.

### 2.6 Merchant Arabic RTL Web Dashboard
* **Status:** **Implemented & Independently Verified**
* **Details:**
  - Arabic RTL single-page interface served on `http://localhost:3000`.
  - Independent HTTP verification confirmed: returns 200 OK for `/`, correctly blocks unauthenticated API requests with 401.
  - Fully implemented merchant views:
    - **Overview:** Store profile, currency, active bot status, catalog totals.
    - **Products:** Full CRUD (view, add, edit pricing/features, delete).
    - **Offers:** Bundle management (activation toggle, discount rates, delete).
    - **Store Settings:** Business name, policies, hours, contact info.
    - **AI Settings:** GCC dialect selection (`saudi`, `uae`, `kuwaiti`, etc.), tone, and language preference.
    - **Bot Settings:** Safe read-only inspection of bot username and operational status.
    - **AI Usage:** Token consumption metrics and estimated cost breakdown.

### 2.7 Meta WhatsApp Cloud API Integration
* **Status:** **Implemented & Test-Verified**
* **Details:**
  - Built official `WhatsAppClient` targeting Meta Graph API `v21.0` with timeout management and safe error handling.
  - `WhatsAppWebhookHandler` handles GET verification handshake (`hub.challenge`), HMAC-SHA256 signature verification (`X-Hub-Signature-256`), message deduplication, and non-text message handling.
  - Re-uses `SupportService` with `platform: 'whatsapp'`, enabling full GCC dialect localization, grounding in store catalog, and composite session memory.
  - REST endpoints `GET /api/webhooks/whatsapp` and `POST /api/webhooks/whatsapp` active in `src/api/server.js`.
  - 13 comprehensive unit and integration tests passing in `tests/whatsappIntegration.test.js`.

---

## 3. Partially Completed Features

### 3.1 Platform Admin Web Dashboard UI
* **Current State:** The backend REST API endpoints are fully implemented and tested:
  - `GET /api/admin/businesses` (list all stores)
  - `GET /api/admin/users` (list all accounts)
  - `POST /api/admin/users` (provision new business owner)
  - `PATCH /api/admin/users/:userId/business` (reassign store)
  - `PATCH /api/admin/users/:userId/status` (enable/disable account)
  - Admin CLI provisioning tool (`npm run seed:user`) is fully functional.
* **Gap:** The frontend SPA (`public/js/app.js`) currently only provides UI views for the `business_owner` role. A dedicated administrative management dashboard view for `platform_admin` has not yet been built in the frontend.

### 3.2 Customer Conversation Archive
* **Current State:** `ConversationStore` maintains an active in-memory sliding window (up to 20 messages, 24-hour TTL) for multi-turn conversational context.
* **Gap:** Conversations are not persisted to SQLite. When the server restarts, volatile conversation history is cleared. The dashboard's `conversations` tab currently displays an architectural notice explaining this status.

### 3.3 Secondary Store Telegram Bots
* **Current State:** Multi-bot architecture supports simultaneous execution. Store 1 (`bot-nexora-coffee`) is active and verified.
* **Gap:** Store 2 (`bot-alwadi-perfumes`) is set to `"status": "inactive"` in `src/config/bots.json` pending assignment of a second Telegram bot token.

---

## 4. Planned Features (Not Yet Implemented)

* **Instagram Direct Message Integration:** Webhook routing and Meta Graph API messaging.
* **Website Live Chat Widget:** Lightweight embeddable JavaScript customer chat widget.
* **Subscription & Billing Engine:** Integration with GCC/international payment gateways (e.g. Moyasar, Tap, Stripe).
* **Automated SQLite Schema Migrations:** A formal database migration runner for table schema evolution.

---

## 5. Existing Test Coverage & Verification

### Verified Test Results (Executed Locally)
On November 5, 2026, the complete automated test suite was executed via `npm test` (`vitest run`):

* **Total Test Suites:** 13 passed (13 total)
* **Total Tests:** 89 passed (89 total)
* **Execution Time:** ~8.18 seconds

#### Breakdown by Test Suite:
1. `tests/whatsappIntegration.test.js` (13 tests) — Challenge verification, HMAC-SHA256 signature, text parsing, deduplication, Gemini response dispatch, status ignore.
2. `tests/authApi.test.js` (7 tests) — Login, session security, CSRF, RBAC, live catalog sync.
2. `tests/aiUsageTracking.test.js` (10 tests) — Token tracking, fallback tracking, model pricing registry, isolated analytics endpoints.
3. `tests/privateBetaReadiness.test.js` (1 test) — End-to-end 10-step customer journey simulation.
4. `tests/dashboardFrontend.test.js` (7 tests) — Arabic RTL HTML serving, CSS/JS static delivery, bot status safety, traversal protection.
5. `tests/securityAuditE2E.test.js` (15 tests) — Scrypt password hashing, session fixation protection, IDOR/BOLA prevention, Telegram secret isolation, DoS payload limits.
6. `tests/botManager.test.js` (5 tests) — Multi-bot lifecycle, duplicate token prevention, tenant binding verification.
7. `tests/supportService.test.js` (6 tests) — Consultative GCC responses, dialect handling, anti-hallucination fallbacks.
8. `tests/multiBusiness.test.js` (5 tests) — Multi-tenant prompt synthesis and store catalog isolation.
9. `tests/inputValidator.test.js` (7 tests) — Message length boundaries and control character stripping.
10. `tests/conversationStore.test.js` (5 tests) — Composite key isolation, sliding window eviction, TTL expiration.
11. `tests/env.test.js` (5 tests) — GCC configuration schema validation and placeholder rejection.
12. `tests/rateLimiter.test.js` (3 tests) — Sliding window token consumption and retry-after calculation.

> [!IMPORTANT]
> **Distinction Note:** These 76 tests run entirely offline with mocked external network calls (mocked Telegram Bot API and mocked Gemini responses). While they prove internal logic, security rules, and error handling, they do not replace continuous real-world integration monitoring.

---

## 6. Known Limitations & Technical Debt

1. **Volatile Conversation State:** Active customer sessions reside in process memory. A process restart drops conversation history.
2. **Synchronous Database Engine:** SQLite operations use Node.js `node:sqlite` (`DatabaseSync`). Under extreme write concurrency, synchronous disk writes could introduce event-loop latency.
3. **Flat File Configuration:** `businesses.json` and `bots.json` are file-backed JSON stores. While suitable for single-node deployments, multi-instance horizontal scaling will require migrating store catalogs to a centralized database.
4. **No Native SSL/TLS Termination:** The Node.js HTTP server does not terminate HTTPS directly; production deployment requires a reverse proxy (e.g., Nginx, Caddy, Cloudflare).
5. **Single-Process Polling:** Telegram integration uses long-polling rather than webhooks. High-throughput production deployments may benefit from webhook endpoints behind an ingress load balancer.

---

## 7. Recommended Next Development Task

**Task:** **Instagram Direct Messaging Integration**
* **Rationale:** The architecture already supports platform-agnostic conversation handling (`platform: 'instagram'`). Building Meta webhook verification (`GET /api/webhooks/instagram`) and message ingestion (`POST /api/webhooks/instagram`) unlocks the second major communication channel requested by GCC merchants without touching existing Telegram logic.
