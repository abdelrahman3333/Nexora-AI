# Nexora AI — Product & Engineering Roadmap

This document outlines the prioritized strategic engineering roadmap for Nexora AI. Items are scheduled across immediate milestones and future capability horizons based on business impact, architectural readiness, and technical dependencies.

---

## 1. Roadmap Overview & Priority Matrix

| Feature / Initiative | Current Status | Priority | Target Phase | Core Dependencies |
| :--- | :--- | :--- | :--- | :--- |
| **1. Persistent Conversation History** | Planned | **P1 (Immediate)** | Phase 3 | `AuthStore` SQLite DB, `ConversationStore` |
| **2. Instagram Direct Messaging Integration** | Planned | **P1 (Immediate)** | Phase 3 | `api/server.js`, Meta Developer App, `SupportService` |
| **3. Platform Admin Web Dashboard UI** | Partially Implemented | **P2 (High)** | Phase 3 | Existing Admin REST API, `public/js/app.js` |
| **4. Production Deployment & HTTPS Hardening** | Partially Implemented | **P2 (High)** | Phase 4 | Reverse Proxy (Nginx/Caddy), Domain & SSL |
| **5. WhatsApp Cloud API Integration** | **Implemented & Test-Verified** | **P2 (Completed)** | Phase 3 | Meta Cloud API Webhooks, SupportService |
| **6. Advanced Gemini Cost Controls & Budgets** | Partially Implemented | **P3 (Medium)** | Phase 4 | Existing `UsageStore`, `modelPricing.js` |
| **7. Multi-Tenant Security & Concurrency Audit** | Partially Implemented | **P3 (Medium)** | Phase 5 | Load testing tools (k6/autocannon) |
| **8. Subscription, Quotas & Billing Infrastructure** | Planned | **P3 (Medium)** | Phase 5 | Payment Gateway (Moyasar / Stripe) |
| **9. Real-Time Telemetry & Error Alerting** | Partially Implemented | **P4 (Future)** | Phase 6 | Structured Pino logger, Sentry / OpenTelemetry |

---

## 2. Detailed Milestone Specifications

### 2.1 Persistent Conversation History in SQLite
* **Current Status:** Planned (Conversations currently reside in volatile in-memory sliding window).
* **Priority:** **P1 (Critical / Immediate)**
* **Dependencies:** `AuthStore` SQLite database (`data/nexora-auth.sqlite`).
* **Implementation Plan:**
  1. Add a new `conversation_messages` table to `src/auth/authStore.js`:
     ```sql
     CREATE TABLE IF NOT EXISTS conversation_messages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       business_id TEXT NOT NULL,
       platform TEXT NOT NULL,
       bot_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       role TEXT NOT NULL CHECK(role IN ('user', 'model')),
       content TEXT NOT NULL,
       created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_conv_lookup ON conversation_messages(business_id, platform, bot_id, user_id, created_at);
     ```
  2. Update `ConversationStore` to read active sliding-window turns from SQLite on cache miss and write new turns asynchronously.
  3. Expose authenticated REST endpoints (`GET /api/my-business/conversations` and `GET /api/my-business/conversations/:userId`) for store owners.
  4. Enable the merchant dashboard `conversations` tab to browse customer message transcripts.

---

### 2.2 Instagram Direct Messaging Integration
* **Current Status:** Planned (Channel architecture is designed; endpoint not yet created).
* **Priority:** **P1 (Critical / Immediate)**
* **Dependencies:** Meta Developer App credentials, Meta Graph API v21.0, HTTPS ingress.
* **Implementation Plan:**
  1. Add environment configuration: `INSTAGRAM_VERIFY_TOKEN`, `INSTAGRAM_PAGE_ACCESS_TOKEN`, `INSTAGRAM_APP_SECRET`.
  2. Implement verification handshake in `src/api/server.js`:
     - `GET /api/webhooks/instagram` validating `hub.verify_token` and returning `hub.challenge`.
  3. Implement message receiver:
     - `POST /api/webhooks/instagram` verifying Meta HMAC signature (`X-Hub-Signature-256`).
     - Parse sender ID and message text, pass to `SupportService.generateResponse({ platform: 'instagram' })`.
  4. Dispatch replies via Meta Graph API:
     $$\text{POST } \text{https://graph.facebook.com/v21.0/me/messages}$$
  5. Add test suite `tests/instagramIntegration.test.js`.

---

### 2.3 Platform Admin Web Dashboard UI
* **Current Status:** Partially Implemented (All backend admin REST APIs exist; frontend view is missing).
* **Priority:** **P2 (High)**
* **Dependencies:** Existing `/api/admin/businesses` and `/api/admin/users` endpoints.
* **Implementation Plan:**
  1. Enhance `public/js/app.js` to inspect `state.user.role`.
  2. If role is `platform_admin`, render dedicated administrator views:
     - **Stores Overview:** Table of all registered stores, active bot counts, and total token usage.
     - **Merchant Account Provisioning:** Web form to create new `business_owner` accounts and bind them to a `business_id`.
     - **Tenant Reassignment & Disabling:** Instant account suspension with immediate session termination.
  3. Add automated UI tests in `tests/dashboardFrontend.test.js` validating role-based view switching.

---

### 2.4 Production Deployment, Reverse Proxy & HTTPS Hardening
* **Current Status:** Partially Implemented (App runs via Node.js HTTP; security headers and cookie flags implemented).
* **Priority:** **P2 (High)**
* **Dependencies:** Linux VM / Container environment, domain name, automated SSL certificate provider.
* **Implementation Plan:**
  1. Configure Nginx or Caddy reverse proxy to terminate TLS 1.3 with Let's Encrypt certificates.
  2. Forward `X-Forwarded-For` and `X-Forwarded-Proto` headers to ensure accurate client IP rate limiting.
  3. Enforce HTTP Strict Transport Security (HSTS) headers.
  4. Create a systemd service unit file (`nexora.service`) for automated restart on failure.
  5. Verify cookie `Secure` flag activates seamlessly in production mode.

---

### 2.5 WhatsApp Cloud API Integration
* **Current Status:** **Implemented & Test-Verified** (13 tests in `tests/whatsappIntegration.test.js`).
* **Priority:** **P2 (Completed Core Integration)**
* **Delivered Capabilities:**
  1. Official Meta Graph API v21.0 client (`WhatsAppClient`) for text messages and read receipts.
  2. Webhook verification endpoint (`GET /api/webhooks/whatsapp`) with `hub.challenge`.
  3. Secure event receiver (`POST /api/webhooks/whatsapp`) with `X-Hub-Signature-256` HMAC validation.
  4. Deduplication engine preventing double-replies on Meta retransmissions.
  5. Multi-tenant message routing via `SupportService` with `platform: 'whatsapp'`.

---

### 2.6 Advanced Gemini API Cost Controls & Merchant Budgets
* **Current Status:** Partially Implemented (Token capture, pricing registry, and daily breakdowns implemented).
* **Priority:** **P3 (Medium)**
* **Dependencies:** Existing `UsageStore` and `modelPricing.js`.
* **Implementation Plan:**
  1. Add configurable monthly spend budget caps per tenant (e.g., `MAX_MONTHLY_AI_BUDGET_USD`).
  2. Implement real-time budget check in `SupportService` prior to dispatching Gemini API calls.
  3. If tenant budget is exceeded, gracefully fall back to a localized polite message instructing customer to reach out via phone/human agent.
  4. Add budget alerts and warning indicators inside the merchant dashboard overview tab.

---

### 2.7 Multi-Tenant Security & Concurrency Load Audit
* **Current Status:** Partially Implemented (76 automated unit/integration tests verified; real load test needed).
* **Priority:** **P3 (Medium)**
* **Dependencies:** Staging environment and load generation tooling (k6).
* **Implementation Plan:**
  1. Develop k6 stress testing script simulating 50 concurrent customer conversations across 5 different stores.
  2. Verify that SQLite database locks and synchronous writes do not cause thread starvation or request timeouts.
  3. Audit IDOR/BOLA protections under randomized high-frequency request fuzzing.
  4. Validate rate limiter behavior under distributed IP rotation.

---

### 2.8 Subscription, Quotas & Billing Infrastructure
* **Current Status:** Planned.
* **Priority:** **P3 (Medium)**
* **Dependencies:** GCC-compliant payment gateway (Moyasar for KSA, Tap for GCC, or Stripe).
* **Implementation Plan:**
  1. Define subscription tiers (e.g. Starter, Growth, Enterprise) with quotas for active bots and monthly tokens.
  2. Implement billing tables in SQLite: `subscriptions`, `invoices`, `payment_methods`.
  3. Webhook integration for subscription renewal, payment failure, and auto-downgrade.
  4. Merchant billing dashboard view for downloading tax invoices (ZATCA e-invoicing compliance for Saudi Arabia).

---

### 2.9 Real-Time Telemetry & Alerting
* **Current Status:** Partially Implemented (Structured Pino logging with secret redaction implemented).
* **Priority:** **P4 (Future)**
* **Dependencies:** Monitoring infrastructure (Prometheus, Grafana, or Sentry).
* **Implementation Plan:**
  1. Expose an authenticated health and metrics endpoint (`GET /api/health` and `GET /api/metrics`).
  2. Track application uptime, active Telegram bot connection status, and AI failure rates.
  3. Configure alert webhooks (to Slack or an administrative Telegram group) on persistent Gemini 503/429 spikes or bot crashes.

