/**
 * Melonbooks (メロンブックス) adapter.
 *
 * Measured (2026-09):
 *  1. Search entry point: https://www.melonbooks.co.jp/search/search.php?name=<keyword>&adult_check_flg=1
 *     `adult_check_flg=1` is required to see adult items; no login and no cookie needed.
 *  2. Result items: <li class="product_1000001"> … <p class="item-ttl product_title">work title</p>
 *     … <p class="item-price">&yen;990</p> … <a href="/circle/index.php?circle_id=…" title="circle name">
 */

import { CONFIG } from '../lib/config.js';
import { collapseSpaces, decodeEntities, stripTags } from '../lib/text.js';
import { StoreAdapter } from './store-adapter.js';

const MELON_ORIGIN = 'https://www.melonbooks.co.jp';

function parseItem(block) {
  const idMatch = String(block).match(/product_(\d{4,})/);
  if (!idMatch) return null;
  const productId = idMatch[1];

  const titleMatch = String(block).match(/class="item-ttl product_title"[^>]*>([\s\S]*?)<\/p>/);
  const title = titleMatch ? collapseSpaces(decodeEntities(stripTags(titleMatch[1]))) : '';
  if (!title) return null;

  const priceMatch = String(block).match(/class="item-price"[^>]*>([\s\S]*?)<\/p>/);
  const priceText = priceMatch ? collapseSpaces(decodeEntities(stripTags(priceMatch[1]))) : '';
  const priceDigits = priceText.replace(/[^\d]/g, '');
  const price = priceDigits ? Number.parseInt(priceDigits, 10) : null;

  const circleMatch = String(block).match(/href="\/circle\/index\.php\?circle_id=\d+"[^>]*title="([^"]*)"/);
  const maker = circleMatch ? collapseSpaces(decodeEntities(circleMatch[1])) : '';
  const authorMatch = String(block).match(/text_type=author&name=[^"]*"[^>]*title="([^"]*)"/);
  const author = authorMatch ? collapseSpaces(decodeEntities(authorMatch[1])) : '';
  const categoryMatch = String(block).match(/<a href="[^"]*category_id=\d+"[^>]*title="([^"]*)"/);
  const category = categoryMatch ? collapseSpaces(decodeEntities(categoryMatch[1])) : '';

  return {
    productId,
    title,
    url: `${MELON_ORIGIN}/detail/detail.php?product_id=${productId}`,
    maker,
    author,
    category,
    price,
    priceText,
    currency: 'JPY',
    isFree: price === 0,
    originalPrice: null,
    originalPriceText: '',
    discountLabel: '',
    labels: [],
    approxCny: price === null ? null : Math.max(1, Math.round(price * 0.05)),
    imageUrl: '',
    store: 'melonbooks'
  };
}

function extractItems(scope) {
  const starts = [];
  const pattern = /<li class="product_\d+"/g;
  let match;
  while ((match = pattern.exec(scope)) !== null) starts.push(match.index);

  const items = [];
  const seen = new Set();
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : Math.min(scope.length, start + 12000);
    const item = parseItem(scope.slice(start, end));
    if (!item || seen.has(item.productId)) continue;
    seen.add(item.productId);
    items.push(item);
    if (items.length >= CONFIG.search.maxItemsPerStep) break;
  }
  return items;
}

export class MelonbooksAdapter extends StoreAdapter {
  constructor() {
    super({
      id: 'melonbooks',
      label: 'Melonbooks',
      homeUrl: 'https://www.melonbooks.co.jp/',
      hostPatterns: ['melonbooks.co.jp']
    });
  }

  buildSearchUrl(query) {
    const keyword = encodeURIComponent(String(query ?? '').trim());
    return `${MELON_ORIGIN}/search/search.php?name=${keyword}&adult_check_flg=1`;
  }

  searchPlan(query) {
    return [{
      id: 'search',
      tier: 1,
      label: 'Melonbooks',
      query,
      url: this.buildSearchUrl(query)
    }];
  }

  parseResults(html, step = {}) {
    const text = String(html ?? '');
    if (!text.trim()) return { ok: false, reason: 'empty-response', items: [], step: step.id };
    if (text.length < 3000) return { ok: false, reason: 'unexpected-page', items: [], step: step.id };

    const items = extractItems(text);
    if (!items.length) {
      const noResult = /該当する商品|見つかりませんでした|0\s*件/.test(text);
      return { ok: noResult, reason: noResult ? 'not-found' : 'no-items-parsed', items: [], step: step.id };
    }
    return { ok: true, reason: 'ok', items, step: step.id };
  }
}

export const __test__ = { parseItem, extractItems };
