import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FanzaAdapter } from '../src/stores/fanza.js';
import { MelonbooksAdapter } from '../src/stores/melonbooks.js';

/**
 * Parser tests for the FANZA and Melonbooks adapters.
 * NOTE: the product names / ids / URLs in the assertions mirror the snapshots
 * under `src/stores/fixtures/` ("snapshot content = expected value"). Those
 * snapshots use placeholder data.
 */

const fanza = new FanzaAdapter();
const melon = new MelonbooksAdapter();
const fanzaSample = readFileSync(new URL('../src/stores/fixtures/fanza-search-sample.html', import.meta.url), 'utf8');
const fanzaAgeCheck = readFileSync(new URL('../src/stores/fixtures/fanza-age-check-sample.html', import.meta.url), 'utf8');
const melonSample = readFileSync(new URL('../src/stores/fixtures/melonbooks-search-sample.html', import.meta.url), 'utf8');

test('FANZA：搜索 URL 走全站关键词搜索（同人专区自己的入口会 404）', () => {
  const url = fanza.buildSearchUrl('サンプル作品');
  assert.ok(url.startsWith('https://www.dmm.co.jp/search/=/searchstr='));
  assert.ok(url.includes(encodeURIComponent('サンプル作品')));
});

test('FANZA：需要复用浏览器 Cookie 才能过年龄确认', () => {
  assert.equal(fanza.fetchOptions.credentials, 'include');
  assert.ok(fanza.ageCheckUrl.includes('age_check'));
});

test('FANZA：解析搜索结果快照（cid / 标题 / 价格 / サークル）', () => {
  const result = fanza.parseResults(fanzaSample, { id: 'search' });
  assert.equal(result.ok, true);
  assert.ok(result.items.length >= 1);
  const first = result.items[0];
  assert.equal(first.productId, 'd_00000001');
  assert.equal(first.title, 'サンプル作品F 図書室のテスト');
  assert.equal(first.price, 770);
  assert.equal(first.priceText, '¥770');
  assert.equal(first.maker, 'サンプルサークルF');
  assert.ok(first.url.startsWith('https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_00000001/'));
  assert.ok(!first.url.includes('i3_ref'), 'URL 里的跟踪参数应被去掉');
});

test('FANZA：年龄确认页会被识别为 age-check 而不是「没有结果」', () => {
  const result = fanza.parseResults(fanzaAgeCheck, { id: 'search', finalUrl: 'https://www.dmm.co.jp/age_check/=/?rurl=x' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'age-check');
  assert.equal(result.needsAgeCheck, true);
});

test('FANZA：改版导致解析不到条目时返回 no-items-parsed', () => {
  const mutated = `<html><head><title>検索結果 - FANZA</title></head><body>${'y'.repeat(5000)}</body></html>`;
  const result = fanza.parseResults(mutated, { id: 'search' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-items-parsed');
});

test('Melonbooks：搜索 URL 带 adult_check_flg', () => {
  const url = melon.buildSearchUrl('サンプル作品');
  assert.ok(url.startsWith('https://www.melonbooks.co.jp/search/search.php?name='));
  assert.ok(url.includes('adult_check_flg=1'));
});

test('Melonbooks：解析搜索结果快照（标题 / 价格 / 社团 / 链接）', () => {
  const result = melon.parseResults(melonSample, { id: 'search' });
  assert.equal(result.ok, true);
  assert.ok(result.items.length >= 1);
  const first = result.items[0];
  assert.equal(first.productId, '1000001');
  assert.equal(first.title, '～サンプル作品F～図書室のテスト');
  assert.equal(first.price, 990);
  assert.equal(first.priceText, '¥990');
  assert.equal(first.maker, 'サンプルサークルF');
  assert.equal(first.url, 'https://www.melonbooks.co.jp/detail/detail.php?product_id=1000001');
});
