/**
 * FANZA (DMM) adapter.
 *
 * Measured (2026-09):
 *  1. Keyword search entry point: https://www.dmm.co.jp/search/=/searchstr/<keyword>/
 *     (the doujin section's own /dc/doujin/-/search/ 302s to a 404 page and is unusable)
 *  2. FANZA gates everything behind an age check: without an `age_check_done=1`
 *     cookie it 302s to /age_check/=/?rurl=…, so requests use
 *     credentials: 'include' to reuse the browser's existing confirmation.
 *     When it is missing we report "age-check" and let the UI ask the user.
 *  3. Result items look like:
 *     <a href="https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_000000/?...">
 *       …<p class="text-sm font-bold line-clamp-2">work title</p>
 *       …<p class="text-[#b42f59]"><span class="font-bold text-lg">000円</span></p>
 *       …<p class="text-xs text-gray-500 line-clamp-1">サークル：circle name</p>
 */

import { CONFIG } from '../lib/config.js';
import { collapseSpaces, decodeEntities, stripTags } from '../lib/text.js';
import { StoreAdapter } from './store-adapter.js';

const DMM_ORIGIN = 'https://www.dmm.co.jp';

function decodeKeyword(query) {
  return encodeURIComponent(String(query ?? '').trim());
}

function absolutize(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${DMM_ORIGIN}${value}`;
  return value.replace(/&amp;/g, '&');
}

function isAgeCheckPage(text, finalUrl) {
  if (/\/age_check\//.test(String(finalUrl || ''))) return true;
  return /id="agecheck"|年齢認証|18歳以上/.test(String(text || '').slice(0, 4000));
}

function parseItem(block) {
  const cidMatch = String(block).match(/cid=([a-z0-9_]+)/i);
  if (!cidMatch) return null;
  const cid = cidMatch[1];

  const titleMatch = String(block).match(/<p class="text-sm font-bold[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  if (!titleMatch) return null;
  const title = collapseSpaces(decodeEntities(stripTags(titleMatch[1])));
  if (!title) return null;

  const priceMatch = String(block).match(/<p class="text-\[#b42f59\][^"]*">[\s\S]*?<span class="font-bold[^"]*">([\d,]+)\s*円<\/span>/);
  const price = priceMatch ? Number.parseInt(priceMatch[1].replace(/[^\d]/g, ''), 10) : null;

  const circleMatch = String(block).match(/サークル[：:]\s*([^<]{1,60})</);
  const maker = circleMatch ? collapseSpaces(decodeEntities(circleMatch[1])) : '';

  const serviceMatch = String(block).match(/<span class="inline-block text-white[^"]*">([^<]+)<\/span>/);
  const service = serviceMatch ? collapseSpaces(stripTags(serviceMatch[1])) : '';

  const detailMatch = String(block).match(/href="(https?:\/\/www\.dmm\.co\.jp\/[^"]*?\/-\/detail\/=\/cid=[^"]+)"/);
  const url = detailMatch ? absolutize(detailMatch[1].split('?')[0]) : '';
  if (!url) return null;

  return {
    productId: cid,
    title,
    url,
    maker,
    author: '',
    category: service,
    price,
    priceText: price === null ? '' : `¥${price.toLocaleString('ja-JP')}`,
    currency: 'JPY',
    isFree: price === 0,
    originalPrice: null,
    originalPriceText: '',
    discountLabel: '',
    labels: [],
    /**
     * FANZA does not publish a CNY price, so no estimate is stored here: the
     * pipeline converts it when the card is built, using the rate from
     * CONFIG.currency / the user's setting (src/lib/currency.js).
     */
    approxCny: null,
    imageUrl: '',
    store: 'fanza'
  };
}

function extractItems(scope) {
  // One product has several cid links (image / title / price), so consecutive
  // links that share a cid are merged into one item block, and the title, price
  // and circle are read from that block.
  const matches = [...String(scope).matchAll(/\/-\/detail\/=\/cid=([a-z0-9_]+)/gi)];
  const blocks = [];
  let current = null;
  for (const match of matches) {
    const cid = match[1];
    if (current && current.cid === cid) {
      current.end = match.index;
      continue;
    }
    if (current) blocks.push(current);
    current = { cid, start: Math.max(0, match.index - 900), end: match.index };
  }
  if (current) blocks.push(current);

  const items = [];
  const seen = new Set();
  blocks.forEach((block, index) => {
    const nextStart = blocks[index + 1] ? blocks[index + 1].start : scope.length;
    const slice = scope.slice(block.start, Math.min(nextStart, block.end + 1600));
    const item = parseItem(slice);
    if (!item || seen.has(item.productId)) return;
    seen.add(item.productId);
    items.push(item);
  });
  return items.slice(0, CONFIG.search.maxItemsPerStep);
}

export class FanzaAdapter extends StoreAdapter {
  constructor() {
    super({
      id: 'fanza',
      label: 'FANZA',
      homeUrl: 'https://www.dmm.co.jp/',
      hostPatterns: ['dmm.co.jp']
    });
    // Reuse the browser's existing age-check cookie
    this.fetchOptions = { credentials: 'include' };
    this.ageCheckUrl = 'https://www.dmm.co.jp/age_check/=/?rurl=https%3A%2F%2Fwww.dmm.co.jp%2Fdc%2Fdoujin%2F';
  }

  buildSearchUrl(query) {
    return `${DMM_ORIGIN}/search/=/searchstr=${decodeKeyword(query)}/`;
  }

  searchPlan(query) {
    return [{
      id: 'search',
      tier: 1,
      label: 'FANZA',
      query,
      url: this.buildSearchUrl(query)
    }];
  }

  parseResults(html, step = {}) {
    const text = String(html ?? '');
    if (!text.trim()) return { ok: false, reason: 'empty-response', items: [], step: step.id };
    if (isAgeCheckPage(text, step.finalUrl)) {
      return { ok: false, reason: 'age-check', items: [], step: step.id, needsAgeCheck: true };
    }
    if (/\b(404|403|429)\b/.test((text.match(/<title>[^<]*<\/title>/i) || [''])[0])) {
      return { ok: false, reason: 'blocked', items: [], step: step.id };
    }

    const items = extractItems(text);
    if (!items.length) {
      const noResult = /該当する|見つかりません|0\s*件/.test(text);
      return { ok: noResult, reason: noResult ? 'not-found' : 'no-items-parsed', items: [], step: step.id };
    }
    return { ok: true, reason: 'ok', items, step: step.id };
  }
}

export const __test__ = { parseItem, extractItems, buildSearchUrl: (q) => new FanzaAdapter().buildSearchUrl(q) };
