/**
 * Store adapter interface (requirements doc §17).
 * Adding bookwalker / amazon / kobo later should not require changes in the
 * layers above this one.
 */

import { CONFIG } from '../lib/config.js';
import { normalizeForMatch } from '../lib/text.js';

export class StoreAdapter {
  constructor({ id, label, homeUrl, hostPatterns = [] }) {
    if (!id || !label) throw new Error('StoreAdapter requires id and label');
    this.id = id;
    this.label = label;
    this.homeUrl = homeUrl || '';
    this.hostPatterns = hostPatterns;
    /** Extra fetch options, e.g. FANZA needs credentials: 'include' to reuse the age-check cookie */
    this.fetchOptions = {};
  }

  /** Machine-readable search URL */
  buildSearchUrl() {
    throw new Error(`${this.id}: buildSearchUrl() is not implemented`);
  }

  /** Search URL shown to the user (same as the machine-readable one by default) */
  buildHumanSearchUrl(query) {
    return this.buildSearchUrl(query);
  }

  /** Search plan: executed step by step, so "try one section first, then another" is possible */
  searchPlan(query) {
    return [{ id: 'default', tier: 1, label: this.label, url: this.buildSearchUrl(query), query }];
  }

  async searchStep(step, ctx) {
    const response = await ctx.fetchText(step.url, {
      timeoutMs: CONFIG.search.timeoutMs,
      ...this.fetchOptions
    });
    const parsed = this.parseResults(response.text, {
      ...step,
      httpStatus: response.status,
      ok: response.ok,
      finalUrl: response.url
    });
    return { ...parsed, step: step.id, url: step.url, httpStatus: response.status };
  }

  parseResults() {
    throw new Error(`${this.id}: parseResults() 未实现`);
  }

  /** Optional: read product details (unused by the MVP flow, kept for later versions) */
  async getProductInfo() {
    return null;
  }
}

export function normalizeSearchKey(query) {
  return normalizeForMatch(query);
}
