/**
 * Fantia adapter.
 *
 * Measured in 2026-09:
 *  1. Public JSON search — no page scraping and no private proxy:
 *     GET https://fantia.jp/api/v1/search/posts?q=<keyword>
 *       -> {"posts":[{"id":…,"title":"…"}, …]}
 *  2. A post page (https://fantia.jp/posts/<id>) answers 200 without a session.
 *  3. Fantia has no HTML search route (`/search?q=` is 404), so the API above is
 *     the only entry point.
 *  4. Adult posts may be hidden behind an age confirmation; requests therefore
 *     use credentials: 'include' (like FANZA) to reuse the browser's state, and
 *     an age-check page is reported as such instead of "no results".
 */

import { StoreAdapter } from './store-adapter.js';

const FANTIA_ORIGIN = 'https://fantia.jp';

function encodeKeyword(query) {
  return encodeURIComponent(String(query ?? '').trim());
}

export class FantiaAdapter extends StoreAdapter {
  constructor() {
    super({ id: 'fantia', label: 'Fantia', homeUrl: FANTIA_ORIGIN });
    // Reuse the browser's Fantia session so age-restricted posts stay visible.
    this.fetchOptions = { credentials: 'include' };
    this.ageCheckUrl = `${FANTIA_ORIGIN}/age_check`;
    this.emptyResultNote = 'Fantia 的成人向内容可能需要先在浏览器里完成年龄确认，插件才能搜到。';
  }

  buildSearchUrl(query) {
    return `${FANTIA_ORIGIN}/api/v1/search/posts?q=${encodeKeyword(query)}`;
  }

  buildHumanSearchUrl(query) {
    // Fantia has no search page, so the manual fallback is a site-wide keyword
    // search through the same API endpoint (the browser renders the JSON).
    return this.buildSearchUrl(query);
  }

  searchPlan(query) {
    return [{
      id: 'search',
      tier: 1,
      label: this.label,
      url: this.buildSearchUrl(query),
      query
    }];
  }

  parseResults(text, ctx = {}) {
    const base = { ok: false, reason: 'no-items-parsed', items: [], step: ctx.id };
    const raw = String(text ?? '');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      // Not JSON: an age confirmation page is the common reason.
      if (/age_check|年齢確認|18歳以上/.test(raw)) {
        return { ...base, reason: 'age-check', needsAgeCheck: true, ageCheckUrl: this.ageCheckUrl };
      }
      if (/<html/i.test(raw)) return { ...base, reason: 'blocked' };
      return { ...base, reason: 'invalid-json' };
    }

    const posts = payload?.posts || payload?.body?.posts;
    if (!Array.isArray(posts)) return base;

    const items = posts
      .filter((post) => post && (post.id || post.post_id))
      .map((post) => ({
        productId: String(post.id || post.post_id),
        store: 'fantia',
        title: String(post.title || '').trim(),
        url: `${FANTIA_ORIGIN}/posts/${post.id || post.post_id}`,
        author: String(post.fanclub?.name || post.fanclub_name || '').trim(),
        maker: String(post.fanclub?.name || post.fanclub_name || '').trim(),
        imageUrl: String(post.thumbnail || post.main_image || ''),
        // Fantia posts can be free or supporters-only; the search API exposes no
        // price, so nothing is claimed about it.
        isFree: false,
        price: null,
        priceText: '',
        category: 'fantia'
      }))
      .filter((item) => item.title);

    if (!items.length) return { ...base, ok: true, reason: 'not-found' };
    return { ok: true, reason: 'ok', items, total: items.length, step: ctx.id };
  }
}

export { encodeKeyword as encodeFantiaKeyword };
