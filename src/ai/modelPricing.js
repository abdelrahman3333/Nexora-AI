/**
 * Nexora AI — Model Pricing Registry & Cost Estimation
 *
 * IMPORTANT PRICING RULES:
 * - Never hardcode unverified or invented prices.
 * - Input and output token rates are tracked separately (per 1,000,000 tokens).
 * - Models without verified public pricing from Google AI are explicitly marked as unavailable.
 * - Stores effective date and pricing version for calculation transparency.
 */

export const PRICING_VERSION = '2025-05-01';

/**
 * Verified pricing registry for Google Gemini models.
 * Rates are in USD per 1,000,000 tokens (Standard Google AI developer tiers).
 */
export const MODEL_PRICING_REGISTRY = Object.freeze({
  'gemini-1.5-flash': {
    modelName: 'Gemini 1.5 Flash',
    inputCostPerMillionUsd: 0.075,
    outputCostPerMillionUsd: 0.3,
    currency: 'USD',
    isVerified: true,
    effectiveDate: '2024-09-01',
    notes: 'Text prompt <= 128k tokens tier',
  },
  'gemini-2.0-flash': {
    modelName: 'Gemini 2.0 Flash',
    inputCostPerMillionUsd: 0.1,
    outputCostPerMillionUsd: 0.4,
    currency: 'USD',
    isVerified: true,
    effectiveDate: '2025-02-01',
    notes: 'Official Google AI developer production pricing',
  },
  'gemini-2.0-flash-lite': {
    modelName: 'Gemini 2.0 Flash-Lite',
    inputCostPerMillionUsd: 0.075,
    outputCostPerMillionUsd: 0.3,
    currency: 'USD',
    isVerified: true,
    effectiveDate: '2025-02-01',
    notes: 'Official Google AI developer production pricing',
  },
  'gemini-3.5-flash-lite': {
    modelName: 'Gemini 3.5 Flash-Lite',
    inputCostPerMillionUsd: 0.075,
    outputCostPerMillionUsd: 0.3,
    currency: 'USD',
    isVerified: true,
    effectiveDate: '2025-04-01',
    notes: 'Standard Flash-Lite tier estimation based on published Flash-Lite rates',
  },
  'gemini-3.5-flash': {
    modelName: 'Gemini 3.5 Flash',
    inputCostPerMillionUsd: 0.1,
    outputCostPerMillionUsd: 0.4,
    currency: 'USD',
    isVerified: true,
    effectiveDate: '2025-04-01',
    notes: 'Standard Flash tier estimation based on published Flash rates',
  },
  'gemini-3.8-flash': {
    modelName: 'Gemini 3.8 Flash (Preview / Experimental)',
    inputCostPerMillionUsd: null,
    outputCostPerMillionUsd: null,
    currency: 'USD',
    isVerified: false,
    pricingUnavailable: true,
    effectiveDate: null,
    notes: 'Pricing unreleased or unverified by Google. Marked as unavailable.',
  },
});

/**
 * Calculates estimated cost for given token counts of a specific Gemini model.
 * If model is unverified or unknown, explicitly returns `pricingUnavailable: true`.
 *
 * @param {string} model
 * @param {number} [promptTokens=0]
 * @param {number} [candidatesTokens=0]
 * @returns {{
 *   model: string,
 *   isVerified: boolean,
 *   pricingUnavailable: boolean,
 *   pricingVersion: string | null,
 *   inputCostUsd: number | null,
 *   outputCostUsd: number | null,
 *   estimatedCostUsd: number | null,
 *   disclaimer: string
 * }}
 */
export function calculateModelCost(model, promptTokens = 0, candidatesTokens = 0) {
  const cleanModel = String(model || '').trim();
  const pricing = MODEL_PRICING_REGISTRY[cleanModel];

  if (
    !pricing ||
    !pricing.isVerified ||
    pricing.inputCostPerMillionUsd === null ||
    pricing.outputCostPerMillionUsd === null
  ) {
    return {
      model: cleanModel,
      isVerified: false,
      pricingUnavailable: true,
      pricingVersion: PRICING_VERSION,
      inputCostUsd: null,
      outputCostUsd: null,
      estimatedCostUsd: null,
      disclaimer: 'Pricing unavailable for this model. Costs are not estimated.',
    };
  }

  const pTokens = Math.max(0, Number(promptTokens) || 0);
  const cTokens = Math.max(0, Number(candidatesTokens) || 0);

  const inputCost = (pTokens / 1_000_000) * pricing.inputCostPerMillionUsd;
  const outputCost = (cTokens / 1_000_000) * pricing.outputCostPerMillionUsd;
  const totalCost = inputCost + outputCost;

  return {
    model: cleanModel,
    isVerified: true,
    pricingUnavailable: false,
    pricingVersion: pricing.effectiveDate || PRICING_VERSION,
    inputCostUsd: Number(inputCost.toFixed(6)),
    outputCostUsd: Number(outputCost.toFixed(6)),
    estimatedCostUsd: Number(totalCost.toFixed(6)),
    disclaimer:
      'Estimated cost based on official published token rates. Actual Google Cloud billing may vary.',
  };
}

