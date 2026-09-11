/**
 * DLsite adapter.
 *
 * The URL shapes and HTML selectors below were confirmed against the real
 * search pages in 2026-09 (see the README and tools/probe-dlsite.mjs, which can
 * re-verify them at any time).
 *
 * Measured behaviour:
 *  1. Search pages look like https://www.dlsite.com/<section>/fsr/=/language/jp/keyword/<keyword>
 *  2. Spaces in the keyword must be `+`; `%20` is rejected by the WAF with 403
 *  3. Keywords shorter than 3 characters always return 0 results
 *  4. books / maniax / pro return identical results; girls (がるまに) is a separate index
 *  5. A "no results" page contains <div class="work_not_found">
 *  6. Every result is a <li data-list_item_product_id="RJ...">
 */

import { CONFIG } from '../lib/config.js';
import { collapseSpaces, decodeEntities, stripTags } from '../lib/text.js';
import { StoreAdapter } from './store-adapter.js';

const PRODUCT_SECTIONS = {
  primary: 'books',
  female: 'girls'
};

/** Measured: DLsite's WAF rejects %20 with 403, so spaces must be encoded as + */
export function encodeKeyword(query) {
  return encodeURIComponent(String(query ?? '').trim()).replace(/%20/g, '+');
}

function attr(attrs, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = String(attrs || '').match(pattern);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? '');
}

function absolutize(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://www.dlsite.com${value}`;
  return value;
}

function parsePriceParts(html) {
  const base = String(html || '').match(/class="work_price_base"[^>]*>([^<]*)</);
  if (!base) return null;
  const digits = String(base[1]).replace(/[^\d]/g, '');
  if (!digits) return null;
  const suffixMatch = String(html).match(/class="work_price_suffix"[^>]*>([^<]*)</);
  const prefixMatch = String(html).match(/class="work_price_prefix"[^>]*>([^<]*)</);
  const currency = suffixMatch ? collapseSpaces(stripTags(suffixMatch[1])) : '円';
  const prefix = prefixMatch ? collapseSpaces(stripTags(prefixMatch[1])) : '';
  const value = Number.parseInt(digits, 10);
  return {
    value,
    currency,
    prefix,
    text: `${prefix}${collapseSpaces(base[1])}${currency}`,
    isFree: value === 0
  };
}

function parseCurrencyTable(block) {
  const match = String(block || '').match(/data-currency_price='([^']+)'/);
  if (!match) return null;
  try {
    return JSON.parse(decodeEntities(match[1]));
  } catch {
    return null;
  }
}

function parseItem(block) {
  const idMatch = String(block).match(/data-list_item_product_id="([^"]+)"/);
  if (!idMatch) return null;
  const productId = idMatch[1];

  const nameBlock = String(block).match(/<dd class="work_name">([\s\S]*?)<\/dd>/);
  const nameHtml = nameBlock ? nameBlock[1] : '';
  const anchor = nameHtml.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
  if (!anchor) return null;

  const href = absolutize(attr(anchor[1], 'href'));
  // Real product links look like https://www.dlsite.com/maniax/work/=/product_id/RJ00000000.html
  if (!href || !href.includes(productId)) return null;
  const titleAttr = attr(anchor[1], 'title');
  const title = collapseSpaces(titleAttr || stripTags(anchor[2]));
  if (!title) return null;

  const makerBlock = String(block).match(/<dd class="maker_name">([\s\S]*?)<\/dd>/);
  const makerHtml = makerBlock ? makerBlock[1] : '';
  const makerAnchor = makerHtml.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
  const maker = makerAnchor ? collapseSpaces(stripTags(makerAnchor[1])) : '';
  const authorMatch = makerHtml.match(/<span class="author[^"]*">([\s\S]*?)<\/span>/);
  const author = authorMatch ? collapseSpaces(stripTags(authorMatch[1])) : '';

  const categoryBlock = String(block).match(/<dd class="work_category[^"]*">([\s\S]*?)<\/dd>/);
  const categoryAnchor = categoryBlock ? categoryBlock[1].match(/<a\b[^>]*>([\s\S]*?)<\/a>/) : null;
  const category = categoryAnchor ? collapseSpaces(stripTags(categoryAnchor[1])) : '';

  const priceWrap = String(block).match(/<dd class="work_price_wrap">([\s\S]*?)<\/dd>/);
  const priceHtml = priceWrap ? priceWrap[1] : '';
  const strikeIndex = priceHtml.search(/class="[^"]*\bstrike\b/);
  const currentHtml = strikeIndex >= 0 ? priceHtml.slice(0, strikeIndex) : priceHtml;
  const price = parsePriceParts(currentHtml) || parsePriceParts(priceHtml);
  const originalPrice = strikeIndex >= 0 ? parsePriceParts(priceHtml.slice(strikeIndex)) : null;

  const saleMatch = String(block).match(/class="[^"]*type_sale[^"]*"[^>]*>([^<]*)</);
  const discountLabel = saleMatch ? collapseSpaces(stripTags(saleMatch[1])) : '';

  const currency = parseCurrencyTable(block);
  const cny = currency && Number.isFinite(Number(currency.CNY)) ? Number(currency.CNY) : null;

  const thumbMatch = String(block).match(/thumb-candidates="\[([^\]]*)\]/);
  const imageUrl = thumbMatch
    ? absolutize((thumbMatch[1].split(',')[0] || '').replace(/^['\s]+|['\s]+$/g, '').replace(/^'|'$/g, ''))
    : '';

  const labelMatch = String(block).match(/<dd class="work_deals work_labels">([\s\S]*?)<\/dd>/);
  const labels = labelMatch
    ? (labelMatch[1].match(/>([^<>]+)</g) || []).map((piece) => collapseSpaces(stripTags(piece))).filter(Boolean)
    : [];

  return {
    productId,
    title,
    url: href,
    maker,
    author,
    category,
    price: price ? price.value : null,
    priceText: price ? price.text : '',
    currency: price ? price.currency : '',
    isFree: price ? price.isFree : false,
    originalPrice: originalPrice ? originalPrice.value : null,
    originalPriceText: originalPrice ? originalPrice.text : '',
    discountLabel,
    labels,
    approxCny: cny === null ? null : (cny > 0 ? Math.max(1, Math.round(cny)) : 0),
    imageUrl,
    store: 'dlsite'
  };
}

function extractItems(scope) {
  const starts = [];
  const pattern = /data-list_item_product_id="/g;
  let match;
  while ((match = pattern.exec(scope)) !== null) starts.push(match.index);

  const items = [];
  const seen = new Set();
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : Math.min(scope.length, start + 15000);
    const item = parseItem(scope.slice(start, end));
    if (!item || seen.has(item.productId)) continue;
    seen.add(item.productId);
    items.push(item);
    if (items.length >= CONFIG.search.maxItemsPerStep) break;
  }
  return items;
}

export class DLsiteAdapter extends StoreAdapter {
  constructor() {
    super({
      id: 'dlsite',
      label: 'DLsite',
      homeUrl: 'https://www.dlsite.com/',
      hostPatterns: ['dlsite.com']
    });
  }

  buildSearchUrl(query, section = PRODUCT_SECTIONS.primary) {
    const keyword = encodeKeyword(query);
    return `https://www.dlsite.com/${section}/fsr/=/language/jp/keyword/${keyword}/`;
  }

  buildHumanSearchUrl(query) {
    return this.buildSearchUrl(query);
  }

  searchPlan(query) {
    return [
      {
        id: 'primary',
        tier: 1,
        label: 'DLsite',
        section: PRODUCT_SECTIONS.primary,
        query,
        url: this.buildSearchUrl(query, PRODUCT_SECTIONS.primary)
      },
      {
        id: 'female',
        tier: 2,
        label: 'DLsite（がるまに / 女性向）',
        section: PRODUCT_SECTIONS.female,
        query,
        url: this.buildSearchUrl(query, PRODUCT_SECTIONS.female)
      }
    ];
  }

  parseResults(html, step = {}) {
    const text = String(html ?? '');
    if (!text.trim()) return { ok: false, reason: 'empty-response', items: [], step: step.id };
    if (/<title>[^<]*\b(403|404|429|50\d)\b[^<]*<\/title>/i.test(text)) {
      return { ok: false, reason: 'blocked', items: [], step: step.id };
    }
    if (text.length < 3000) return { ok: false, reason: 'unexpected-page', items: [], step: step.id };

    const listIndex = text.lastIndexOf('id="search_result_list"');
    const scope = listIndex >= 0 ? text.slice(listIndex) : text;
    const notFoundMarker = /work_not_found/.test(scope) || /条件に一致する作品は見つかりませんでした/.test(scope);
    const items = extractItems(scope);

    if (!items.length) {
      // Only an explicit "not found" marker counts as empty; anything else may be a block or a markup change, so the caller is told it failed
      return {
        ok: notFoundMarker,
        reason: notFoundMarker ? 'not-found' : 'no-items-parsed',
        items: [],
        step: step.id
      };
    }

    return { ok: true, reason: 'ok', notFound: false, items, step: step.id };
  }

  /** Optional: read a more precise title and price from a product page (unused by the MVP flow) */
  async getProductInfo(url, ctx) {
    const response = await ctx.fetchText(url, { timeoutMs: CONFIG.search.timeoutMs });
    const text = String(response.text || '');
    if (!response.ok || text.length < 3000) return null;
    const heading = text.match(/<h1[^>]*id="work_name"[^>]*>([\s\S]*?)<\/h1>/);
    const price = parsePriceParts(text);
    return {
      url,
      title: heading ? collapseSpaces(stripTags(heading[1])) : null,
      price: price ? price.value : null,
      priceText: price ? price.text : ''
    };
  }
}

export const __test__ = { parseItem, extractItems, parsePriceParts };
