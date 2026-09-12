/**
 * JPY -> CNY estimate for the stores that do not provide one themselves
 * (FANZA / Melonbooks).
 *
 * Design notes:
 *  - No exchange-rate API is called. The default rate lives in CONFIG.currency
 *    with its measurement date and source, and the user can override it in the
 *    popup (`settings.cnyPerJpy`).
 *  - The conversion happens while the card is built (src/lib/pipeline.js), not
 *    inside the store adapters, so changing the rate takes effect immediately —
 *    even for search results that are already cached.
 *  - DLsite ships its own CNY price in the search HTML; that value has priority
 *    and never goes through this estimate.
 */

import { CONFIG } from './config.js';

/** The rate a user typed, or the built-in default when it is empty / invalid */
export function resolveCnyPerJpy(settings = {}) {
  const raw = settings?.cnyPerJpy;
  const value = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return CONFIG.currency.jpyToCny;
  if (value < CONFIG.currency.minRate || value > CONFIG.currency.maxRate) return CONFIG.currency.jpyToCny;
  // Keep a sane number of decimals so "0.0437000000001" style input still works
  return Number(value.toFixed(6));
}

/** Is the user overriding the built-in rate? (used to show "自定义" in the UI) */
export function isCustomRate(settings = {}) {
  return resolveCnyPerJpy(settings) !== CONFIG.currency.jpyToCny;
}

/**
 * Estimate CNY from a JPY price.
 * Free (0) stays free, an unknown price stays unknown, and a paid item is at
 * least 1 元 so the UI never shows "约 0 元".
 */
export function estimateCny(price, rate = CONFIG.currency.jpyToCny) {
  // An unknown price must stay unknown — Number(null) would be a silent 0
  if (price === null || price === undefined || price === '') return null;
  const value = Number(price);
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  return Math.max(1, Math.round(value * rate));
}
