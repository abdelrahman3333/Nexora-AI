import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { formatCurrency } from '../utils/localization.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_KNOWLEDGE_FILE = path.join(__dirname, 'defaultKnowledge.json');

export const productSchema = z.object({
  id: z.string().min(1),
  nameAr: z.string().min(1),
  nameEn: z.string().optional().default(''),
  price: z.number().nonnegative(),
  inStock: z.boolean().default(true),
  featuresAr: z.string().optional().default(''),
  featuresEn: z.string().optional().default(''),
  description: z.string().optional().default(''),
  imageUrl: z.string().url().or(z.literal('')).optional().default(''),
});

export const serviceSchema = z.object({
  id: z.string().min(1),
  nameAr: z.string().min(1),
  nameEn: z.string().optional().default(''),
  price: z.number().nonnegative().default(0),
  detailsAr: z.string().optional().default(''),
  detailsEn: z.string().optional().default(''),
});

export const offerSchema = z.object({
  id: z.string().min(1),
  titleAr: z.string().min(1),
  titleEn: z.string().optional().default(''),
  price: z.number().nonnegative().optional(),
  detailsAr: z.string().min(1),
  detailsEn: z.string().optional().default(''),
  discount: z.string().optional().default(''),
  isActive: z.boolean().default(true),
});

export const faqSchema = z.object({
  questionAr: z.string().min(1),
  answerAr: z.string().min(1),
  questionEn: z.string().optional().default(''),
  answerEn: z.string().optional().default(''),
});

export const businessKnowledgeSchema = z.object({
  companyOverview: z.object({
    descriptionAr: z.string().min(1),
    descriptionEn: z.string().optional().default(''),
  }),
  industry: z.string().optional().default('التجارة الإلكترونية (E-Commerce)'),
  contactInfo: z
    .object({
      supportEmail: z.string().optional(),
      whatsappNumber: z.string().optional(),
      website: z.string().optional(),
    })
    .optional(),
  workingHours: z
    .object({
      scheduleAr: z.string().optional(),
      scheduleEn: z.string().optional(),
    })
    .optional(),
  shippingPolicy: z
    .object({
      detailsAr: z.string().optional(),
      detailsEn: z.string().optional(),
    })
    .optional(),
  deliveryPolicy: z
    .object({
      detailsAr: z.string().optional(),
      detailsEn: z.string().optional(),
    })
    .optional(),
  returnPolicy: z
    .object({
      detailsAr: z.string().optional(),
      detailsEn: z.string().optional(),
    })
    .optional(),
  paymentMethods: z.array(z.string()).optional().default([]),
  products: z.array(productSchema).optional().default([]),
  services: z.array(serviceSchema).optional().default([]),
  offers: z.array(offerSchema).optional().default([]),
  faqs: z.array(faqSchema).optional().default([]),
});

/**
 * Loads and validates a single business knowledge JSON file (legacy/default support).
 *
 * @param {string} [customFilePath]
 * @returns {z.infer<typeof businessKnowledgeSchema>}
 */
export function loadBusinessKnowledge(customFilePath = '') {
  const resolvedPath =
    customFilePath && customFilePath.trim().length > 0
      ? path.resolve(customFilePath)
      : DEFAULT_KNOWLEDGE_FILE;

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Business knowledge file not found at: ${resolvedPath}`);
  }

  const rawContent = fs.readFileSync(resolvedPath, 'utf-8');
  let parsedJson;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(
      `Failed to parse business knowledge JSON at ${resolvedPath}: ${err.message}`
    );
  }

  return businessKnowledgeSchema.parse(parsedJson);
}

/**
 * Formats verified business knowledge (products, services, offers, delivery policies, FAQs)
 * into a structured, currency-aware reference block for the AI system prompt.
 *
 * @param {z.infer<typeof businessKnowledgeSchema>} knowledge
 * @param {string} currencyCode
 * @returns {string}
 */
export function formatKnowledgeForPrompt(knowledge, currencyCode = 'SAR') {
  const sections = [];

  sections.push(
    `[COMPANY OVERVIEW & INDUSTRY]\n- Industry: ${knowledge.industry || 'التجارة الإلكترونية'}\n- Arabic: ${knowledge.companyOverview.descriptionAr}\n- English: ${knowledge.companyOverview.descriptionEn || 'N/A'}`
  );

  if (knowledge.workingHours?.scheduleAr || knowledge.workingHours?.scheduleEn) {
    sections.push(
      `[VERIFIED WORKING HOURS]\n- Arabic: ${knowledge.workingHours.scheduleAr || 'غير محدد'}\n- English: ${knowledge.workingHours.scheduleEn || 'Not specified'}`
    );
  } else {
    sections.push(`[VERIFIED WORKING HOURS]\n- Not provided by business owner.`);
  }

  const deliveryDetails = knowledge.deliveryPolicy || knowledge.shippingPolicy;
  if (deliveryDetails?.detailsAr || deliveryDetails?.detailsEn) {
    sections.push(
      `[VERIFIED DELIVERY & SHIPPING POLICY (All amounts in ${currencyCode})]\n- Arabic: ${deliveryDetails.detailsAr || 'غير محدد'}\n- English: ${deliveryDetails.detailsEn || 'Not specified'}`
    );
  } else {
    sections.push(`[VERIFIED DELIVERY & SHIPPING POLICY]\n- Not provided by business owner.`);
  }

  if (knowledge.returnPolicy?.detailsAr || knowledge.returnPolicy?.detailsEn) {
    sections.push(
      `[VERIFIED RETURN & EXCHANGE POLICY]\n- Arabic: ${knowledge.returnPolicy.detailsAr || 'غير محدد'}\n- English: ${knowledge.returnPolicy.detailsEn || 'Not specified'}`
    );
  } else {
    sections.push(`[VERIFIED RETURN & EXCHANGE POLICY]\n- Not provided by business owner.`);
  }

  if (knowledge.paymentMethods && knowledge.paymentMethods.length > 0) {
    sections.push(`[VERIFIED PAYMENT METHODS]\n- ${knowledge.paymentMethods.join(', ')}`);
  }

  if (knowledge.contactInfo) {
    const { supportEmail, whatsappNumber, website } = knowledge.contactInfo;
    sections.push(
      `[VERIFIED CONTACT DETAILS]\n- Support Email: ${supportEmail || 'N/A'}\n- WhatsApp / Phone: ${whatsappNumber || 'N/A'}\n- Website: ${website || 'N/A'}`
    );
  }

  if (knowledge.products && knowledge.products.length > 0) {
    const productLines = knowledge.products.map((p) => {
      const priceAr = formatCurrency(p.price, currencyCode, 'ar');
      const priceEn = formatCurrency(p.price, currencyCode, 'en');
      const statusAr = p.inStock ? 'متوفر (In Stock)' : 'غير متوفر حالياً (Out of Stock)';
      return `  * [${p.id}] ${p.nameAr}${p.nameEn ? ` / ${p.nameEn}` : ''}
    - Price: ${priceAr} | ${priceEn}
    - Availability: ${statusAr}
    - Specs/Benefits (AR): ${p.featuresAr}
    - Specs/Benefits (EN): ${p.featuresEn}`;
    });
    sections.push(`[VERIFIED PRODUCT CATALOG]\n${productLines.join('\n')}`);
  } else {
    sections.push(`[VERIFIED PRODUCT CATALOG]\n- No products listed.`);
  }

  if (knowledge.services && knowledge.services.length > 0) {
    const serviceLines = knowledge.services.map((s) => {
      const priceStr =
        s.price === 0
          ? 'مجاني (Free)'
          : `${formatCurrency(s.price, currencyCode, 'ar')} | ${formatCurrency(s.price, currencyCode, 'en')}`;
      return `  * [${s.id}] ${s.nameAr}${s.nameEn ? ` / ${s.nameEn}` : ''}
    - Service Fee: ${priceStr}
    - Details (AR): ${s.detailsAr}`;
    });
    sections.push(`[VERIFIED SERVICES]\n${serviceLines.join('\n')}`);
  }

  if (knowledge.offers && knowledge.offers.length > 0) {
    const offerLines = knowledge.offers.map((o) => {
      const offerPrice =
        typeof o.price === 'number'
          ? ` — Offer Price: ${formatCurrency(o.price, currencyCode, 'ar')}`
          : '';
      return `  * [${o.id}] ${o.titleAr}${offerPrice}\n    - Details: ${o.detailsAr}`;
    });
    sections.push(`[VERIFIED ACTIVE OFFERS & BUNDLES]\n${offerLines.join('\n')}`);
  }

  if (knowledge.faqs && knowledge.faqs.length > 0) {
    const faqLines = knowledge.faqs.map(
      (f, idx) =>
        `  Q${idx + 1} (AR): ${f.questionAr}\n  A${idx + 1} (AR): ${f.answerAr}${f.questionEn ? `\n  Q${idx + 1} (EN): ${f.questionEn}\n  A${idx + 1} (EN): ${f.answerEn}` : ''}`
    );
    sections.push(`[VERIFIED FAQs]\n${faqLines.join('\n\n')}`);
  }

  return sections.join('\n\n');
}
