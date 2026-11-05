# Nexora AI — Project Overview

## 1. Executive Summary

**Nexora AI** is a modular, multi-tenant Software-as-a-Service (SaaS) platform engineered to power automated AI Sales and Customer Support Agents for e-commerce and retail businesses. Built with Node.js (ES Modules), the platform seamlessly connects messaging channels (starting with Telegram) to Google's Gemini generative AI models, customized specifically for the cultural, dialectal, and commercial nuances of the Gulf Cooperation Council (GCC) market.

---

## 2. Business Purpose & Problem Statement

### The Problem
E-commerce merchants in the GCC region face distinct customer communication challenges:
* **High Expectation of Immediacy:** Shoppers frequently inquire through messaging apps (Telegram, Instagram, WhatsApp) rather than email or contact forms, demanding instant responses day and night.
* **Cultural & Dialectal Nuance:** Standard Arabic or generic English chatbots often feel robotic, disconnected, or fail to understand local Gulf phrasing and colloquial terminology (Saudi, Emirati, Kuwaiti, Qatari, Bahraini, Omani).
* **Hallucination & Inaccurate Pricing:** Generic AI implementations invent stock availability, guess shipping policies, or quote inaccurate discounts, eroding merchant credibility.
* **Complex Multi-Store Operations:** Retailers managing multiple brand lines or agencies running support for multiple merchants struggle with fragmented bot setups and lack central cost visibility.

### The Nexora AI Solution
Nexora AI addresses these challenges through:
1. **Dialect-Aware Persona Engine:** System prompt architecture configured for Saudi, Emirati, Kuwaiti, and general Gulf dialects with polite, hospitable sales etiquette.
2. **Strict Catalog Grounding:** Guardrails ensuring the AI only recommends items, offers, and policies that exist in the merchant's verified store knowledge base.
3. **Centralized Multi-Tenant Engine:** A single backend instance capable of operating independent bots for distinct business tenants with complete data isolation.
4. **Token Cost & Usage Transparency:** Per-business token tracking and cost calculation based on published Gemini pricing tiers.

---

## 3. Target Customers & Markets

### Geographic Focus
* **Primary Markets:** Saudi Arabia (KSA), United Arab Emirates (UAE).
* **Extended GCC Markets:** Kuwait (KW), Qatar (QA), Bahrain (BH), Oman (OM).

### Target Customer Segments
* **Direct-to-Consumer (D2C) Brands:** Specialty coffee roasters, luxury perfume houses, fashion boutiques, and beauty brands operating in the Gulf.
* **Digital Commerce Agencies:** Marketing and operations agencies that manage customer support and conversational sales on behalf of multiple client brands.
* **Enterprise Retailers:** GCC retail businesses seeking 24/7 first-line inquiry handling, order tracking guidance, and consultative cross-selling.

---

## 4. Main Features

### Multi-Tenant Architecture
* **Tenant Isolation:** Every business (`business_id`) maintains an independent catalog of products, active bundles/offers, return and shipping policies, and operational hours.
* **Bot-to-Business Binding:** Telegram bots are registered in an administrative registry and strictly bound to exactly one business ID.
* **Role-Based Access Control (RBAC):** Distinct roles for `platform_admin` (system provisioning) and `business_owner` (isolated store administration).

### Consultative GCC AI Sales Persona
* **Strict Anti-Hallucination Guardrails:** AI responses are grounded strictly in the business store context. When information is missing, the AI politely advises the customer to contact human support rather than inventing details.
* **GCC Localization:** Automatic Arabic/English detection, GCC currency formatting (SAR, AED, KWD, QAR, BHD, OMR), and localized polite Gulf phrasing.
* **Turn-Based Context Memory:** Sliding-window conversation history ensuring coherent multi-turn sales dialogues.

### Central Multi-Bot Management
* **Simultaneous Long-Polling:** Runs multiple independent Telegram bot clients concurrently in a single Node.js runtime.
* **Fault Isolation:** An error or network failure on one bot does not terminate or affect other running bots.
* **Zero-Downtime Catalog Sync:** Updates made via the web dashboard or REST API to products, prices, and offers immediately reflect in subsequent AI responses without restarting running bots.

### AI Usage & Cost Analytics
* **Token Tracking:** Captures prompt tokens, candidate tokens, and total tokens directly from Gemini API `usageMetadata`.
* **Cost Estimation Registry:** Evaluates token consumption against verified public Google AI pricing tiers.
* **Business Analytics API & Dashboard:** Aggregates daily usage, per-model breakdowns, and success/failure rates per business tenant.

### Merchant Web Dashboard
* **Arabic RTL Single-Page Application (SPA):** Lightweight, responsive frontend built with native ES Modules and modern CSS variables.
* **Self-Service Catalog Management:** Merchants can view and update their business profile, product list, promotional offers, and AI dialect/tone settings.
* **Security First:** Communicates via session cookies with CSRF protection; secrets and API keys are never exposed to the frontend.

---

## 5. Supported Platforms & Channel Status

| Channel / Interface | Implementation Status | Notes |
| :--- | :--- | :--- |
| **Telegram** | **Supported & Verified** | Built on `grammy`. Central multi-bot manager running with error isolation and token protection. |
| **Web Dashboard** | **Supported & Verified** | Arabic RTL web frontend served directly by the backend for authenticated store owners. |
| **REST API** | **Supported & Verified** | Node.js native HTTP server with cookie sessions, RBAC, and rate limiting. |
| **Instagram Direct** | **Planned (Next Priority)** | Webhook routing and Meta Graph API messaging planned for direct message customer inquiries. |
| **WhatsApp Cloud API** | **Planned** | Meta Cloud API integration planned for WhatsApp Business numbers. |
| **Website Chat Widget** | **Planned** | Embeddable web chat widget for merchant storefronts. |

---

## 6. Main Product Goals

1. **Enterprise Reliability:** Guarantee high availability, automated retries with exponential backoff, and graceful model failover on AI rate limits.
2. **Complete Data Isolation:** Enforce tenant separation across conversation memory, database logs, and administrative APIs to eliminate IDOR/BOLA vulnerabilities.
3. **Frictionless Onboarding:** Allow an administrator to configure a new store and attach a new bot in minutes via declarative JSON configuration or REST API.
4. **Actionable Merchant Intelligence:** Provide store owners with real-time visibility into customer conversation patterns, popular products, and AI operating costs.

