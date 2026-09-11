import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FantiaAdapter } from '../src/stores/fantia.js';

const adapter = new FantiaAdapter();
const sample = readFileSync(new URL('../src/stores/fixtures/fantia-search-sample.json', import.meta.url), 'utf8');

test('Fantia：搜索走公开的 JSON 接口，关键词正确编码', () => {
  const url = adapter.buildSearchUrl('サンプル作品 第2話');
  assert.ok(url.startsWith('https://fantia.jp/api/v1/search/posts?q='));
  assert.ok(url.includes(encodeURIComponent('サンプル作品 第2話')));
});

test('Fantia：搜索计划只有一个分区（Fantia 没有分区索引）', () => {
  const plan = adapter.searchPlan('サンプル作品');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].tier, 1);
});

test('Fantia：解析搜索结果（标题 / 社团 / 文章页链接）', () => {
  const result = adapter.parseResults(sample, { id: 'search' });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  const first = result.items[0];
  assert.equal(first.productId, '30000001');
  assert.equal(first.store, 'fantia');
  assert.equal(first.title, 'サンプル作品ファンティア 本編');
  assert.equal(first.url, 'https://fantia.jp/posts/30000001');
  assert.equal(first.author, 'サンプルサークルF');
});

test('Fantia：不声称作品免费（可能是支援者限定），价格字段留空', () => {
  const result = adapter.parseResults(sample, { id: 'search' });
  assert.equal(result.items[0].isFree, false);
  assert.equal(result.items[0].price, null);
  assert.equal(result.items[0].priceText, '');
});

test('Fantia：空结果是 not-found，而不是解析失败', () => {
  const result = adapter.parseResults(JSON.stringify({ posts: [] }), { id: 'search' });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not-found');
});

test('Fantia：年龄确认页会被识别为 age-check，而不是「没有结果」', () => {
  const html = '<!doctype html><html><head><title>年齢確認 - Fantia</title></head><body>18歳以上ですか？</body></html>';
  const result = adapter.parseResults(html, { id: 'search' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'age-check');
  assert.equal(result.needsAgeCheck, true);
  assert.ok(result.ageCheckUrl.includes('age_check'));
});

test('Fantia：被拦截或结构变化时返回 ok:false，不会静默当成「没有结果」', () => {
  assert.equal(adapter.parseResults('<html><body>403</body></html>', { id: 'search' }).reason, 'blocked');
  assert.equal(adapter.parseResults('not json', { id: 'search' }).reason, 'invalid-json');
  assert.equal(adapter.parseResults(JSON.stringify({ body: {} }), { id: 'search' }).reason, 'no-items-parsed');
  assert.equal(adapter.fetchOptions.credentials, 'include');
});
