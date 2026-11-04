const ARABIC_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g;
const LATIN_CHAR_REGEX = /[A-Za-z]/g;

/**
 * Currency formatting metadata for GCC markets.
 */
export const GCC_CURRENCIES = Object.freeze({
  SAR: { code: 'SAR', symbolAr: 'ر.س', nameAr: 'ريال سعودي', decimals: 2 },
  AED: { code: 'AED', symbolAr: 'د.إ', nameAr: 'درهم إماراتي', decimals: 2 },
  KWD: { code: 'KWD', symbolAr: 'د.ك', nameAr: 'دينار كويتي', decimals: 3 },
  QAR: { code: 'QAR', symbolAr: 'ر.ق', nameAr: 'ريال قطري', decimals: 2 },
  BHD: { code: 'BHD', symbolAr: 'د.ب', nameAr: 'دينار بحريني', decimals: 3 },
  OMR: { code: 'OMR', symbolAr: 'ر.ع', nameAr: 'ريال عماني', decimals: 3 },
});

export const GCC_COUNTRIES = Object.freeze({
  SA: { nameAr: 'المملكة العربية السعودية', nameEn: 'Saudi Arabia', defaultCurrency: 'SAR' },
  AE: { nameAr: 'الإمارات العربية المتحدة', nameEn: 'United Arab Emirates', defaultCurrency: 'AED' },
  KW: { nameAr: 'دولة الكويت', nameEn: 'Kuwait', defaultCurrency: 'KWD' },
  QA: { nameAr: 'دولة قطر', nameEn: 'Qatar', defaultCurrency: 'QAR' },
  BH: { nameAr: 'مملكة البحرين', nameEn: 'Bahrain', defaultCurrency: 'BHD' },
  OM: { nameAr: 'سلطنة عُمان', nameEn: 'Oman', defaultCurrency: 'OMR' },
});

/**
 * Detects whether a user message is primarily Arabic ('ar') or English ('en').
 * Defaults to 'ar' for Gulf market when ambiguous or mixed equally.
 *
 * @param {string} text
 * @param {'ar' | 'en'} [fallback='ar']
 * @returns {'ar' | 'en'}
 */
export function detectLanguage(text, fallback = 'ar') {
  if (typeof text !== 'string' || !text.trim()) {
    return fallback;
  }

  const arabicMatches = text.match(ARABIC_CHAR_REGEX) || [];
  const latinMatches = text.match(LATIN_CHAR_REGEX) || [];

  if (arabicMatches.length === 0 && latinMatches.length === 0) {
    return fallback;
  }

  if (arabicMatches.length >= latinMatches.length) {
    return 'ar';
  }

  return 'en';
}

/**
 * Formats a numeric price according to the business's configured GCC currency
 * and target language ('ar' or 'en').
 *
 * @param {number} amount
 * @param {string} [currencyCode='SAR']
 * @param {'ar' | 'en'} [language='ar']
 * @returns {string}
 */
export function formatCurrency(amount, currencyCode = 'SAR', language = 'ar') {
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    throw new TypeError('Amount must be a valid number');
  }

  const normalizedCode = String(currencyCode).toUpperCase();
  const currencyMeta = GCC_CURRENCIES[normalizedCode] || {
    code: normalizedCode,
    symbolAr: normalizedCode,
    nameAr: normalizedCode,
    decimals: 2,
  };

  const isWholeNumber = Number.isInteger(amount);
  const formattedNumber = isWholeNumber
    ? amount.toLocaleString('en-US')
    : amount.toLocaleString('en-US', {
        minimumFractionDigits: currencyMeta.decimals,
        maximumFractionDigits: currencyMeta.decimals,
      });

  if (language === 'en') {
    return `${formattedNumber} ${currencyMeta.code}`;
  }

  return `${formattedNumber} ${currencyMeta.symbolAr} (${currencyMeta.code})`;
}

