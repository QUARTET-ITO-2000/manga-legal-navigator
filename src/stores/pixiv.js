/**
 * Pixiv adapter.
 *
 * Measured in 2026-09:
 *  1. Search endpoint (JSON, no page scraping):
 *     https://www.pixiv.net/ajax/search/artworks/<word>?word=…&order=date_d
 *       &mode=all&p=1&s_mode=s_tag&type=all&lang=ja
 *     `s_mode=s_tag` searches tags, `s_mode=s_tc` searches title + caption.
 *  2. R-18 works are hidden from logged-out visitors: with a control tag that
 *     has hundreds of thousands of hits, the anonymous response only contains
 *     items with xRestrict === 0, even with mode=r18. Requests therefore use
 *     credentials: 'include', reusing the browser's logged-in, age-confirmed
 *     session. The extension never logs in on its own, and it never pretends
 *     that an empty search means "this work does not exist".
 *  3. Every hit in body.illustManga.data looks like
 *     { id, title, userName, xRestrict, url } and the public work page is
 *     https://www.pixiv.net/artworks/<id>.
 *  4. A response carrying {"error":true,…} means the request itself failed
 *     (bad query, blocked, rate limited) and must not be shown as "no results".
 */

import { StoreAdapter } from './store-adapter.js';

const PIXIV_ORIGIN = 'https://www.pixiv.net';

/** Search modes, tried in order: exact tags first, then title/caption. */
const SEARCH_MODES = [
  { id: 'tag', sMode: 's_tag', tier: 1 },
  { id: 'title-caption', sMode: 's_tc', tier: 2 }
];

function encodeKeyword(query) {
  return encodeURIComponent(String(query ?? '').trim());
}

export class PixivAdapter extends StoreAdapter {
  constructor() {
    super({ id: 'pixiv', label: 'Pixiv', homeUrl: PIXIV_ORIGIN });
    // Reuse the browser's Pixiv session, including its age confirmation.
    this.fetchOptions = { credentials: 'include' };
    this.emptyResultNote = 'Pixiv 的 R-18 作品需要先登录并确认年龄，插件才能搜到；没有登录时这里只会返回全年龄结果。';
  }

  buildSearchUrl(query, { sMode = 's_tag' } = {}) {
    const encoded = encodeKeyword(query);
    return `${PIXIV_ORIGIN}/ajax/search/artworks/${encoded}?word=${encoded}`
      + `&order=date_d&mode=all&p=1&s_mode=${sMode}&type=all&lang=ja`;
  }

  /** Human-readable search page (used for the "search manually" buttons). */
  buildHumanSearchUrl(query) {
    return `${PIXIV_ORIGIN}/search.php?word=${encodeKeyword(query)}&order=date_d&s_mode=s_tag`;
  }

  /**
   * Pixiv's user search, handed to the user instead of being searched here:
   * its API only returns a few preview works per artist, so letting the user
   * open the artist's own page is both cheaper and more reliable.
   */
  buildArtistSearchUrl(artist) {
    return `${PIXIV_ORIGIN}/search/users?word=${encodeKeyword(artist)}`;
  }

  searchPlan(query) {
    return SEARCH_MODES.map((mode) => ({
      id: mode.id,
      tier: mode.tier,
      label: `${this.label} (${mode.id})`,
      url: this.buildSearchUrl(query, { sMode: mode.sMode }),
      query
    }));
  }

  parseResults(text, ctx = {}) {
    const base = { ok: false, reason: 'no-items-parsed', items: [], step: ctx.id };
    let payload;
    try {
      payload = JSON.parse(String(text ?? ''));
    } catch {
      return { ...base, reason: 'invalid-json' };
    }

    if (!payload || payload.error) {
      return { ...base, reason: payload?.message ? 'blocked' : 'unexpected-payload' };
    }

    const block = payload.body?.illustManga || payload.body?.manga;
    if (!block || !Array.isArray(block.data)) return base;
    const total = Number(block.total) || 0;

    const items = block.data.filter((entry) => entry && entry.id).map((entry) => toItem(entry, entry.userName));

    if (!items.length) {
      return {
        ...base,
        ok: total === 0,
        reason: total === 0 ? 'not-found' : 'no-items-parsed',
        total
      };
    }
    return { ok: true, reason: 'ok', items, total, step: ctx.id };
  }

}

export { encodeKeyword as encodePixivKeyword };

/** Map one Pixiv work (from either search shape) to a store item. */
function toItem(entry, userName) {
  return {
    productId: String(entry.id),
    store: 'pixiv',
    title: String(entry.title || '').trim(),
    url: `${PIXIV_ORIGIN}/artworks/${entry.id}`,
    author: String(entry.userName || userName || '').trim(),
    maker: String(entry.userName || userName || '').trim(),
    imageUrl: String(entry.url || ''),
    // Being able to open a work on Pixiv does not mean it is free: posts can be
    // supporters-only or behind a paid plan, and the search API exposes no
    // price — so no price is claimed at all.
    isFree: false,
    price: null,
    priceText: '',
    category: 'pixiv',
    /** 0 = all ages, 1 = R-18, 2 = R-18G */
    ageRating: Number(entry.xRestrict) || 0
  };
}
