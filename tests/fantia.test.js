import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FantiaAdapter } from '../src/stores/fantia.js';

const adapter = new FantiaAdapter();
const sample = readFileSync(new URL('../src/stores/fixtures/fantia-search-sample.html', import.meta.url), 'utf8');

test('Fantia：搜索走 /posts?keyword=（带会话），不是那个忽略关键词的 API', () => {
  const url = adapter.buildSearchUrl('サンプル作品 第2話');
  assert.ok(url.startsWith('https://fantia.jp/posts?brand_type=0&keyword='));
  assert.ok(url.includes(encodeURIComponent('サンプル作品 第2話')));
  assert.ok(url.includes('stock=all'));
  assert.ok(url.includes('category='));
  assert.equal(url.includes('/api/v1/search/posts'), false, '不使用忽略 q 的 API');
});

test('Fantia：解析搜索结果卡片（标题 / 文章链接 / 社团）', () => {
  const result = adapter.parseResults(sample, { id: 'search' });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 3);
  const first = result.items[0];
  assert.equal(first.productId, '30000001');
  assert.equal(first.store, 'fantia');
  assert.equal(first.title, 'サンプル作品ファンティア 本編');
  assert.equal(first.url, 'https://fantia.jp/posts/30000001');
  assert.equal(first.author, 'サンプルサークルF');
  assert.equal(result.items[2].author, 'サンプルサークルG');
});

test('Fantia：不声称作品免费（可能是支援者限定），价格字段留空', () => {
  const result = adapter.parseResults(sample, { id: 'search' });
  assert.equal(result.items[0].isFree, false);
  assert.equal(result.items[0].price, null);
  assert.equal(result.items[0].priceText, '');
});

test('Fantia：未登录时会话被重定向到登录页 → 报「需要登录」而不是「未找到」', () => {
  const result = adapter.parseResults('<html><body><a href="/sessions/signin">ログイン</a></body></html>', { id: 'search' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'login-required');
  assert.equal(result.needsLogin, true);
  assert.ok(result.loginUrl.includes('/sessions/signin'));
});

test('Fantia：年龄确认页会被识别为 age-check', () => {
  const result = adapter.parseResults('<html><body>18歳以上ですか？ 年齢確認</body></html>', { id: 'search' });
  assert.equal(result.reason, 'age-check');
  assert.equal(result.needsAgeCheck, true);
});

test('Fantia：真正没有结果时是 not-found，结构变化时是解析失败', () => {
  const empty = adapter.parseResults('<html><body><h1>「サンプル」の投稿検索結果</h1><p>該当する投稿がありません</p></body></html>', { id: 'search' });
  assert.equal(empty.ok, true);
  assert.equal(empty.reason, 'not-found');

  const reshaped = adapter.parseResults('<html><body>something else</body></html>', { id: 'search' });
  assert.equal(reshaped.ok, false);
  assert.equal(reshaped.reason, 'no-items-parsed');
  assert.equal(adapter.fetchOptions.credentials, 'include');
});
