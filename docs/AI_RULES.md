# Nexora AI — Engineering Rules for AI Coding Agents

> [!IMPORTANT]
> **Mandatory Guidelines for AI Agents:**
> These instructions are binding for any automated AI agent, assistant, or engineer modifying or extending the Nexora AI codebase. Read and follow these rules prior to modifying code or proposing architecture changes.

---

## 1. Documentation-First Onboarding

Before initiating any refactoring, feature implementation, or bug fix:
1. **Read the Core Documentation:**
   - [`PROJECT.md`](file:///c:/Users/RDP/Desktop/Nexora-AI-main/docs/PROJECT.md): Understand the business model, GCC target market, and product goals.
   - [`ARCHITECTURE.md`](file:///c:/Users/RDP/Desktop/Nexora-AI-main/docs/ARCHITECTURE.md): Understand the component graph, Telegram message flow, and storage layout.
   - [`CURRENT_STATUS.md`](file:///c:/Users/RDP/Desktop/Nexora-AI-main/docs/CURRENT_STATUS.md): Know what is already built, verified, partially built, or known technical debt.
   - [`ROADMAP.md`](file:///c:/Users/RDP/Desktop/Nexora-AI-main/docs/ROADMAP.md): Align your task with established priorities and avoid working against active phases.
2. **Inspect Existing Code First:**
   - Always inspect relevant source files before proposing new designs.
   - Check existing utilities (`src/utils/errors.js`, `src/utils/localization.js`, `src/utils/logger.js`) to avoid duplicating functionality.

---

## 2. Preserve Existing Functionality & Avoid Rewrites

* **Zero Unsolicited Rewrites:** Do not rewrite functioning modules simply because a different pattern exists. The existing codebase is tested and verified.
* **Preserve Comments & Docstrings:** Retain existing JSDoc comments, architecture notes, and explanatory documentation.
* **Backward Compatibility:** When modifying core services (such as `SupportService` or `GeminiProvider`), ensure all existing consumers (including Telegram bots and unit tests) continue working without breaking changes.
* **Conservative Dependency Management:** Avoid adding third-party NPM packages when standard Node.js built-ins (`node:crypto`, `node:sqlite`, `node:http`, `node:fs`, `node:path`) can cleanly solve the problem.

---

## 3. Strict Multi-Tenant Data Isolation

Nexora AI is a multi-tenant platform. A data leak between tenants is a critical security vulnerability:
* **Never Trust Client-Supplied Tenant IDs:**
  - For store-owner routes (`/api/my-business/*`), **never** accept `business_id` from client-side route params, query strings, or JSON request bodies.
  - The `business_id` must **always** be derived from the authenticated, server-side session verified by `AuthStore`.
* **Preserve Composite Memory Keys:**
  - In `ConversationStore`, keys must always be built via `_buildKey(tenantId, userId, platform, botId)`. Never query or clear conversations globally across tenants.
* **Strict Bot Binding:**
  - Every Telegram bot instance must remain bound to exactly one registered `business_id`. Telegram customer handlers must never accept commands to switch or view other stores.

---

## 4. Secret Protection & Environment Hygiene

* **Never Hardcode Secrets:**
  - Never commit real Telegram bot tokens, Google Gemini API keys, session secrets, or passwords into source code, test files, documentation, or JSON stores.
* **Maintain Separation Between Tokens & Config:**
  - `src/config/bots.json` must only store the *name* of the environment variable (e.g. `"token_env_var": "TELEGRAM_BOT_TOKEN"`), never the plaintext token itself.
  - Plaintext tokens belong exclusively in untracked `.env` files or in-memory runtime vaults.
* **Preserve Redaction in Logs:**
  - Any new log statements must route through `src/utils/logger.js`, which automatically redacts API keys and bot tokens before output.
* **Maintain `.env.example` Consistency:**
  - If a new environment variable is introduced, immediately document it in `.env.example` with safe placeholder values and update `src/config/env.js`.

---

## 5. Server-Side Authorization & Defensive Security

* **Never Rely Exclusively on Frontend Checks:**
  - Hiding a button or tab in `public/js/app.js` is not security. All authorization checks must be strictly enforced on the server in `src/api/server.js`.
* **Enforce CSRF Protection on Mutating Endpoints:**
  - All state-changing endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) after authentication must validate the `X-CSRF-Token` header using constant-time comparison (`crypto.timingSafeEqual`).
* **Enforce Scrypt Password Hashing:**
  - Passwords must always be hashed with `crypto.scrypt` and unique random salts via `src/auth/passwordHasher.js`.
  - The `password_hash` field must never be included in any API response or logged.
* **Sanitize Inputs & Restrict Payloads:**
  - Always enforce `inputValidator` on user-facing text inputs.
  - Maintain the 64 KB JSON body size restriction on incoming API requests to mitigate Denial of Service attacks.

---

## 6. Rigorous Testing & Honest Reporting

* **Add Tests for Meaningful Changes:**
  - When introducing new routes, stores, or AI capabilities, create corresponding Vitest suites under `tests/`.
* **Honest Execution Reporting:**
  - **Never** claim that tests passed unless you actually ran them (`npm test`) in the active environment and observed zero failures.
  - If tests fail, report the exact error, fix the root cause, and re-run until green.
* **Mock External Services in Unit Tests:**
  - Unit and integration tests must run 100% offline. Mock external HTTP calls (Telegram Bot API, Gemini API) so test suites can run without internet connectivity or consuming billable API tokens.

---

## 7. Synchronized Documentation Maintenance

Documentation that diverges from code is technical debt. When you change the application:
* **Update `CURRENT_STATUS.md`:** When a feature moves from planned to implemented, or when new technical debt is discovered.
* **Update `ROADMAP.md`:** When an item is completed, reprioritized, or blocked by a new dependency.
* **Update `ARCHITECTURE.md`:** When folder structures, data flows, database schemas, or component graphs are modified.
* **Update `PROJECT.md`:** When supported channels, target platforms, or core business rules evolve.

