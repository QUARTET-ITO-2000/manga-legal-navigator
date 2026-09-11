import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DLsiteAdapter, encodeKeyword } from '../src/stores/dlsite.js';

/**
 * NOTE: the expected values below (product name / product id / product URL)
 * mirror the contents of `src/stores/fixtures/dlsite-search-sample.html`, i.e.
 * "snapshot content = parser output". The fixture uses placeholder data, and so
 * does every other test and document in this repository.
 */

const adapter = new DLsiteAdapter();
const sampleHtml = readFileSync(new URL('../src/stores/fixtures/dlsite-search-sample.html', import.meta.url), 'utf8');
const notFoundHtml = readFileSync(new URL('../src/stores/fixtures/dlsite-not-found-sample.html', import.meta.url), 'utf8');

test('搜索 URL：空格必须编码成 +（%20 会被 DLsite 返回 403）', () => {
  const url = adapter.buildSearchUrl('作品名称 第12話');
  assert.ok(!url.includes('%20'), `URL 里不应出现 %20：${url}`);
  assert.ok(url.includes('%E4%BD%9C%E5%93%81%E5%90%8D%E7%A7%B0+%E7%AC%AC12'), url);
  assert.ok(url.startsWith('https://www.dlsite.com/books/fsr/=/language/jp/keyword/'));
  assert.equal(encodeKeyword('a b'), 'a+b');
});

test('搜索计划：主分区 + 女性向分区（girls 是独立索引，实测与 books 不重叠）', () => {
  const plan = adapter.searchPlan('サンプル作品名');
  assert.equal(plan.length, 2);
  assert.equal(plan[0].section, 'books');
  assert.equal(plan[1].section, 'girls');
});

test('从搜索结果快照里解析商品名 / 价格 / 链接', () => {
  const result = adapter.parseResults(sampleHtml, { id: 'primary' });
  assert.equal(result.ok, true);
  assert.ok(result.items.length >= 5, `至少应解析出 5 条，实际 ${result.items.length}`);

  const first = result.items[0];
  assert.equal(first.productId, 'RJ00000001');
  assert.equal(first.title, 'サンプル作品アルファ');
  assert.equal(first.url, 'https://www.dlsite.com/maniax/work/=/product_id/RJ00000001.html');
  assert.equal(first.price, 1980);
  assert.equal(first.priceText, '1,980円');
  assert.equal(first.maker, 'サンプルサークルA');
  assert.ok(first.approxCny === null || typeof first.approxCny === 'number');
});

test('带折扣的商品会同时解析出原价与折扣标签', () => {
  const result = adapter.parseResults(sampleHtml, { id: 'primary' });
  const discounted = result.items.find((item) => item.discountLabel);
  assert.ok(discounted, '快照里应至少有一条打折商品');
  assert.ok(/OFF/i.test(discounted.discountLabel));
  assert.ok(typeof discounted.originalPrice === 'number');
  assert.ok(discounted.originalPrice > discounted.price);
  assert.ok(discounted.originalPriceText.endsWith('円'));
});

test('商品类型与作者等可选字段也能解析出来', () => {
  const result = adapter.parseResults(sampleHtml, { id: 'primary' });
  assert.ok(result.items.some((item) => item.category));
  assert.ok(result.items.some((item) => item.author));
});

test('无结果页面会被识别为 not-found，而不是解析失败', () => {
  const result = adapter.parseResults(notFoundHtml, { id: 'primary' });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not-found');
  assert.equal(result.items.length, 0);
});

test('被 WAF 拦截（403）时返回 blocked，交给上层提示搜索失败', () => {
  const blocked = '<!doctype html><html><head><title>403 Forbidden</title></head><body>403</body></html>';
  const result = adapter.parseResults(blocked, { id: 'primary' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');
});

test('页面结构大变时会返回 ok:false（no-items-parsed），不会静默当成「没有结果」', () => {
  const mutated = `<html><head><title>検索結果</title></head><body>${'x'.repeat(4000)}
    <div id="search_result_list"><div class="whatever"><p>该网站已改版</p></div></div></body></html>`;
  const result = adapter.parseResults(mutated, { id: 'primary' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-items-parsed');
});

test('HTML 实体（&amp;）会被正确解码', () => {
  const block = `<li data-list_item_product_id="RJ00000008">
    <dd class="work_name"><a href="https://www.dlsite.com/maniax/work/=/product_id/RJ00000008.html" title="サンプル作品A&amp;B第14話">サンプル作品A&amp;B第14話</a></dd>
    <dd class="work_price_wrap"><span class="work_price"><span class="work_price_parts"><span class="work_price_base">990</span><span class="work_price_suffix">円</span></span></span></dd>
  </li>`;
  const html = `<html><head><title>検索結果</title></head><body>${'x'.repeat(4000)}<div id="search_result_list">${block}</div></body></html>`;
  const result = adapter.parseResults(html, { id: 'primary' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'サンプル作品A&B第14話');
  assert.equal(result.items[0].price, 990);
});
