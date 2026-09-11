/**
 * Fantia adapter.
 *
 * Measured in 2026-09:
 *  1. The real search entry point is the post search page:
 *     https://fantia.jp/posts?brand_type=0&keyword=<word>&stock=all&category=…
 *     Anonymous requests get 302 -> https://fantia.jp/sessions/signin, so the
 *     page only answers for a signed-in visitor; requests therefore reuse the
 *     browser session (credentials: 'include', like FANZA).
 *  2. https://fantia.jp/api/v1/search/posts?q=… looks like a search API but
 *     ignores `q` and returns an unrelated default list — using it produced
 *     false "no results". It is deliberately NOT used.
 *  3. A result card contains a link to the post (/posts/<id>, whose accessible
 *     name is `<creator>の投稿「<title>」`) and, next to it, a link to the
 *     creator's fanclub (/fanclubs/<id>) carrying the circle name.
 */

import { StoreAdapter } from './store-adapter.js';
import { collapseSpaces, decodeEntities, stripTags } from '../lib/text.js';

const FANTIA_ORIGIN = 'https://fantia.jp';
/** The category list the site itself puts in its search URL. */
const CATEGORIES = [
  'illust', 'comic', 'vtuber', 'voice', 'voiceactor', '3d', '2d_anime', 'game', 'music',
  'novel', 'doll', 'art', 'program', 'handmade', 'history', 'railroad', 'shop', 'other',
  'fortune', 'cosplay', 'idol', 'youtuber', 'photo_movie', 'other_real'
].join(',');

function encodeKeyword(query) {
  return encodeURIComponent(String(query ?? '').trim());
}

export class FantiaAdapter extends StoreAdapter {
  constructor() {
    super({ id: 'fantia', label: 'Fantia', homeUrl: FANTIA_ORIGIN });
    // The search page needs a session; reuse the browser's, so age-confirmed
    // accounts see the same results they would see in a tab.
    this.fetchOptions = { credentials: 'include' };
    this.loginUrl = `${FANTIA_ORIGIN}/sessions/signin`;
    this.ageCheckUrl = `${FANTIA_ORIGIN}/age_check`;
    this.emptyResultNote = 'Fantia 的搜索需要登录（成人向内容还可能需要先确认年龄），插件复用你浏览器的登录状态。';
  }

  buildSearchUrl(query) {
    return `${FANTIA_ORIGIN}/posts?brand_type=0&keyword=${encodeKeyword(query)}`
      + `&stock=all&category=${encodeURIComponent(CATEGORIES)}`;
  }

  /** Same page, opened in a tab (the user's own session renders it). */
  buildHumanSearchUrl(query) {
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

    // A signed-out response is a redirect into the sign-in page: report it as a
    // session problem instead of "this work does not exist".
    if (/\/sessions\/signin|ログインしてください|sign in to fantia/i.test(raw)) {
      return { ...base, reason: 'login-required', needsLogin: true, loginUrl: this.loginUrl };
    }
    if (/age_check|年齢確認|18歳以上/.test(raw)) {
      return { ...base, reason: 'age-check', needsAgeCheck: true, ageCheckUrl: this.ageCheckUrl };
    }

    const items = parseCards(raw);
    if (items.length) return { ok: true, reason: 'ok', items, total: items.length, step: ctx.id };
    // No cards and no sign-in marker: either a genuine empty result page or a
    // markup change. Both are reported without pretending we found something.
    if (/検索結果|の投稿/.test(raw)) return { ...base, ok: true, reason: 'not-found' };
    return base;
  }
}

/** One card = a post link whose text is `<creator>の投稿「<title>」`. */
function parseCards(html) {
  const items = [];
  const seen = new Set();
  const link = /href="\/posts\/(\d+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  for (const match of html.matchAll(link)) {
    const id = match[1];
    if (seen.has(id)) continue;
    let title = collapseSpaces(decodeEntities(stripTags(match[2])));
    const quoted = title.match(/「([^」]+)」/);
    if (quoted) title = quoted[1];
    title = collapseSpaces(title);
    if (title.length < 2) continue;

    // The circle link sits right after the post link inside the same card.
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 900);
    const club = after.match(/href="\/fanclubs\/\d+"[^>]*>([\s\S]{0,140}?)<\/a>/i);
    const author = club ? collapseSpaces(decodeEntities(stripTags(club[1]))) : '';

    seen.add(id);
    items.push({
      productId: id,
      store: 'fantia',
      title,
      url: `${FANTIA_ORIGIN}/posts/${id}`,
      author,
      maker: author,
      imageUrl: '',
      // A post can be free or supporters-only and the search page exposes no
      // price, so nothing is claimed about it.
      isFree: false,
      price: null,
      priceText: '',
      category: 'fantia'
    });
  }
  return items;
}

export { encodeKeyword as encodeFantiaKeyword, parseCards as parseFantiaCards };
