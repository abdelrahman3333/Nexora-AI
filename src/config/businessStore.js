import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';
import {
  businessKnowledgeSchema,
  faqSchema,
  offerSchema,
  productSchema,
  serviceSchema,
} from './businessKnowledge.js';
import {
  SUPPORTED_COUNTRIES,
  SUPPORTED_CURRENCIES,
  SUPPORTED_DIALECTS,
  SUPPORTED_LANGUAGES,
  SUPPORTED_TONES,
} from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_BUSINESSES_FILE = path.join(__dirname, 'businesses.json');

/**
 * Enforces business ownership access control when an `actor` context is provided.
 * - `platform_admin` can manage any business.
 * - `business_owner` can ONLY manage their own `actor.business_id`.
 * - Ordinary customers (`customer`) or unauthenticated roles are rejected.
 *
 * @param {string} targetBusinessId
 * @param {object} [actor]
 */
export function assertBusinessWriteAccess(targetBusinessId, actor) {
  if (!actor) return; // Internal trusted system call
  if (actor.role === 'platform_admin') return;
  if (
    actor.role === 'business_owner' &&
    String(actor.business_id || '').trim() === String(targetBusinessId || '').trim()
  ) {
    return;
  }
  throw new ValidationError(
    `Unauthorized: Actor with role "${actor.role}" cannot modify business "${targetBusinessId}"`,
    'UNAUTHORIZED_BUSINESS_ACCESS'
  );
}

export const businessProfileSchema = businessKnowledgeSchema.extend({
  business_id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  industry: z.string().trim().min(1).default('التجارة الإلكترونية (E-Commerce)'),
  country: z.enum(SUPPORTED_COUNTRIES).default('SA'),
  currency: z.enum(SUPPORTED_CURRENCIES).default('SAR'),
  timezone: z.string().trim().min(1).default('Asia/Riyadh'),
  dialect: z.enum(SUPPORTED_DIALECTS).default('saudi'),
  languagePreference: z.enum(SUPPORTED_LANGUAGES).default('auto'),
  tone: z.enum(SUPPORTED_TONES).default('polite_professional_gulf'),
  products: z.array(productSchema).default([]),
  services: z.array(serviceSchema).default([]),
  offers: z.array(offerSchema).default([]),
  faqs: z.array(faqSchema).default([]),
});

const businessesFileSchema = z.object({
  businesses: z.array(businessProfileSchema).min(1),
});

/**
 * Persistent JSON-backed store for managing multiple independent businesses on Nexora AI.
 * Ensures strict isolation between business configurations, products, prices, and policies.
 */
export class BusinessStore {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath] - Path to businesses JSON file
   */
  constructor({ filePath = DEFAULT_BUSINESSES_FILE } = {}) {
    this.filePath = path.resolve(filePath);
    /** @type {Map<string, z.infer<typeof businessProfileSchema>>} */
    this.businesses = new Map();
    this.reload();
  }

  /**
   * Loads and validates all businesses from the persistent JSON file on disk.
   */
  reload() {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`Businesses store file not found at: ${this.filePath}`);
    }

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in businesses file (${this.filePath}): ${err.message}`
      );
    }

    const validated = businessesFileSchema.parse(parsed);
    const nextMap = new Map();

    for (const biz of validated.businesses) {
      if (nextMap.has(biz.business_id)) {
        throw new Error(`Duplicate business_id found: "${biz.business_id}"`);
      }
      nextMap.set(biz.business_id, structuredClone(biz));
    }

    this.businesses = nextMap;
  }

  /**
   * Persists the current state of all businesses back to the JSON file on disk.
   */
  saveToDisk() {
    const payload = {
      businesses: Array.from(this.businesses.values()),
    };
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  /**
   * Lists all registered businesses (returns deep copies to prevent external mutation).
   *
   * @returns {Array<z.infer<typeof businessProfileSchema>>}
   */
  listBusinesses() {
    return Array.from(this.businesses.values()).map((b) => structuredClone(b));
  }

  /**
   * Retrieves a specific business by `business_id`.
   * Returns a deep copy so callers cannot accidentally mutate shared state across businesses.
   *
   * @param {string} businessId
   * @returns {z.infer<typeof businessProfileSchema>}
   */
  getBusiness(businessId) {
    const id = String(businessId || '').trim();
    const biz = this.businesses.get(id);
    if (!biz) {
      throw new Error(
        `Unknown business_id "${id}". Available businesses: ${Array.from(this.businesses.keys()).join(', ')}`
      );
    }
    return structuredClone(biz);
  }

  /**
   * Checks whether a `business_id` exists in the store.
   *
   * @param {string} businessId
   * @returns {boolean}
   */
  hasBusiness(businessId) {
    return this.businesses.has(String(businessId || '').trim());
  }

  /**
   * Returns the normalized `{ businessConfig, knowledge }` pair expected by `buildSystemPrompt`.
   *
   * @param {string} businessId
   * @returns {{ businessConfig: object, knowledge: object }}
   */
  getPromptContext(businessId) {
    const biz = this.getBusiness(businessId);
    const businessConfig = Object.freeze({
      tenantId: biz.business_id,
      businessId: biz.business_id,
      businessName: biz.name,
      industry: biz.industry,
      businessCountry: biz.country,
      businessCurrency: biz.currency,
      businessTimezone: biz.timezone,
      defaultDialect: biz.dialect,
      languagePreference: biz.languagePreference,
      businessTone: biz.tone,
    });

    const knowledge = Object.freeze({
      industry: biz.industry,
      companyOverview: biz.companyOverview,
      contactInfo: biz.contactInfo,
      workingHours: biz.workingHours,
      deliveryPolicy: biz.deliveryPolicy || biz.shippingPolicy,
      shippingPolicy: biz.shippingPolicy || biz.deliveryPolicy,
      returnPolicy: biz.returnPolicy,
      paymentMethods: biz.paymentMethods,
      products: biz.products,
      services: biz.services,
      offers: biz.offers,
      faqs: biz.faqs,
    });

    return { businessConfig, knowledge };
  }

  /**
   * Adds or updates a business profile and persists the change to disk.
   * Rejects any payload containing a raw bot token (`token` / `bot_token` / `TELEGRAM_BOT_TOKEN`).
   *
   * @param {object} rawProfile
   * @param {object} [options]
   * @param {boolean} [options.persist=true]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @returns {z.infer<typeof businessProfileSchema>}
   */
  upsertBusiness(rawProfile, { persist = true, actor = undefined } = {}) {
    if (
      rawProfile &&
      typeof rawProfile === 'object' &&
      ('token' in rawProfile ||
        'bot_token' in rawProfile ||
        'TELEGRAM_BOT_TOKEN' in rawProfile)
    ) {
      throw new ValidationError(
        'Security policy violation: Plaintext bot tokens must never be stored in businesses.json',
        'FORBIDDEN_TOKEN_IN_BUSINESS'
      );
    }

    assertBusinessWriteAccess(rawProfile?.business_id, actor);

    const validated = businessProfileSchema.parse(rawProfile);
    this.businesses.set(validated.business_id, structuredClone(validated));
    if (persist) {
      this.saveToDisk();
    }
    return structuredClone(validated);
  }

  /**
   * Updates the price (and optionally stock status) of a specific product within a business
   * and persists the change to disk immediately.
   *
   * @param {string} businessId
   * @param {string} productId
   * @param {number} newPrice
   * @param {object} [options]
   * @param {boolean} [options.inStock]
   * @param {boolean} [options.persist=true]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @returns {z.infer<typeof productSchema>}
   */
  updateProductPrice(
    businessId,
    productId,
    newPrice,
    { inStock = undefined, persist = true, actor = undefined } = {}
  ) {
    assertBusinessWriteAccess(businessId, actor);

    if (typeof newPrice !== 'number' || Number.isNaN(newPrice) || newPrice < 0) {
      throw new Error('newPrice must be a non-negative number');
    }

    const biz = this.getBusiness(businessId);
    const productIndex = biz.products.findIndex((p) => p.id === productId);
    if (productIndex === -1) {
      throw new Error(
        `Product "${productId}" not found in business "${businessId}"`
      );
    }

    biz.products[productIndex].price = newPrice;
    if (typeof inStock === 'boolean') {
      biz.products[productIndex].inStock = inStock;
    }

    this.businesses.set(biz.business_id, biz);
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(biz.products[productIndex]);
  }

  /**
   * Updates allowed business profile settings for `businessId` while preserving its `business_id`.
   * Never allows overwriting `business_id` or injecting bot tokens.
   *
   * @param {string} businessId
   * @param {object} patch
   * @param {object} [options]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @param {boolean} [options.persist=true]
   */
  updateBusinessSettings(businessId, patch, { actor = undefined, persist = true } = {}) {
    assertBusinessWriteAccess(businessId, actor);

    if (!patch || typeof patch !== 'object') {
      throw new ValidationError('Invalid business update payload', 'INVALID_PAYLOAD');
    }

    if (
      'token' in patch ||
      'bot_token' in patch ||
      'TELEGRAM_BOT_TOKEN' in patch
    ) {
      throw new ValidationError(
        'Security policy violation: Plaintext bot tokens must never be stored in businesses.json',
        'FORBIDDEN_TOKEN_IN_BUSINESS'
      );
    }

    const current = this.getBusiness(businessId);
    const merged = {
      ...current,
      ...patch,
      business_id: current.business_id, // Lock business_id so it can never be mutated
    };

    const parsed = businessProfileSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        'INVALID_BUSINESS_DATA'
      );
    }

    this.businesses.set(current.business_id, structuredClone(parsed.data));
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(parsed.data);
  }

  /**
   * Adds a new product to a business's catalog.
   *
   * @param {string} businessId
   * @param {object} rawProduct
   * @param {object} [options]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @param {boolean} [options.persist=true]
   */
  addProduct(businessId, rawProduct, { actor = undefined, persist = true } = {}) {
    assertBusinessWriteAccess(businessId, actor);

    const parsed = productSchema.safeParse(rawProduct);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        'INVALID_PRODUCT_DATA'
      );
    }

    const biz = this.getBusiness(businessId);
    if (biz.products.some((p) => p.id === parsed.data.id)) {
      throw new ValidationError(
        `Product with id "${parsed.data.id}" already exists in business "${businessId}"`,
        'DUPLICATE_PRODUCT_ID'
      );
    }

    biz.products.push(parsed.data);
    this.businesses.set(biz.business_id, biz);
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(parsed.data);
  }

  /**
   * Updates an existing product in a business's catalog.
   *
   * @param {string} businessId
   * @param {string} productId
   * @param {object} patch
   * @param {object} [options]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @param {boolean} [options.persist=true]
   */
  updateProduct(
    businessId,
    productId,
    patch,
    { actor = undefined, persist = true } = {}
  ) {
    assertBusinessWriteAccess(businessId, actor);

    const biz = this.getBusiness(businessId);
    const idx = biz.products.findIndex((p) => p.id === productId);
    if (idx === -1) {
      throw new ValidationError(
        `Product "${productId}" not found in business "${businessId}"`,
        'PRODUCT_NOT_FOUND'
      );
    }

    const merged = {
      ...biz.products[idx],
      ...patch,
      id: biz.products[idx].id,
    };

    const parsed = productSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        'INVALID_PRODUCT_DATA'
      );
    }

    biz.products[idx] = parsed.data;
    this.businesses.set(biz.business_id, biz);
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(parsed.data);
  }

  /**
   * Deletes a product from a business's catalog.
   *
   * @param {string} businessId
   * @param {string} productId
   * @param {object} [options]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @param {boolean} [options.persist=true]
   */
  deleteProduct(businessId, productId, { actor = undefined, persist = true } = {}) {
    assertBusinessWriteAccess(businessId, actor);

    const biz = this.getBusiness(businessId);
    const idx = biz.products.findIndex((p) => p.id === productId);
    if (idx === -1) {
      throw new ValidationError(
        `Product "${productId}" not found in business "${businessId}"`,
        'PRODUCT_NOT_FOUND'
      );
    }

    const [removed] = biz.products.splice(idx, 1);
    this.businesses.set(biz.business_id, biz);
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(removed);
  }

  /**
   * Adds a new offer to a business's catalog.
   *
   * @param {string} businessId
   * @param {object} rawOffer
   * @param {object} [options]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @param {boolean} [options.persist=true]
   */
  addOffer(businessId, rawOffer, { actor = undefined, persist = true } = {}) {
    assertBusinessWriteAccess(businessId, actor);

    const parsed = offerSchema.safeParse(rawOffer);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        'INVALID_OFFER_DATA'
      );
    }

    const biz = this.getBusiness(businessId);
    if (biz.offers.some((o) => o.id === parsed.data.id)) {
      throw new ValidationError(
        `Offer with id "${parsed.data.id}" already exists in business "${businessId}"`,
        'DUPLICATE_OFFER_ID'
      );
    }

    biz.offers.push(parsed.data);
    this.businesses.set(biz.business_id, biz);
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(parsed.data);
  }

  /**
   * Updates an existing offer in a business's catalog.
   *
   * @param {string} businessId
   * @param {string} offerId
   * @param {object} patch
   * @param {object} [options]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @param {boolean} [options.persist=true]
   */
  updateOffer(
    businessId,
    offerId,
    patch,
    { actor = undefined, persist = true } = {}
  ) {
    assertBusinessWriteAccess(businessId, actor);

    const biz = this.getBusiness(businessId);
    const idx = biz.offers.findIndex((o) => o.id === offerId);
    if (idx === -1) {
      throw new ValidationError(
        `Offer "${offerId}" not found in business "${businessId}"`,
        'OFFER_NOT_FOUND'
      );
    }

    const merged = {
      ...biz.offers[idx],
      ...patch,
      id: biz.offers[idx].id,
    };

    const parsed = offerSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        'INVALID_OFFER_DATA'
      );
    }

    biz.offers[idx] = parsed.data;
    this.businesses.set(biz.business_id, biz);
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(parsed.data);
  }

  /**
   * Deletes an offer from a business's catalog.
   *
   * @param {string} businessId
   * @param {string} offerId
   * @param {object} [options]
   * @param {{ role: string, business_id?: string }} [options.actor]
   * @param {boolean} [options.persist=true]
   */
  deleteOffer(businessId, offerId, { actor = undefined, persist = true } = {}) {
    assertBusinessWriteAccess(businessId, actor);

    const biz = this.getBusiness(businessId);
    const idx = biz.offers.findIndex((o) => o.id === offerId);
    if (idx === -1) {
      throw new ValidationError(
        `Offer "${offerId}" not found in business "${businessId}"`,
        'OFFER_NOT_FOUND'
      );
    }

    const [removed] = biz.offers.splice(idx, 1);
    this.businesses.set(biz.business_id, biz);
    if (persist) {
      this.saveToDisk();
    }

    return structuredClone(removed);
  }
}

