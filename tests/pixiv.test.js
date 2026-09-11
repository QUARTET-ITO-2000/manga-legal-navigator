import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PixivAdapter } from '../src/stores/pixiv.js';

const adapter = new PixivAdapter();
const sample = readFileSync(new URL('../src/stores/fixtures/pixiv-search-sample.json', import.meta.url), 'utf8');

test('Pixiv：搜索 URL 指向 JSON 接口，关键词正确编码', () => {
  const url = adapter.buildSearchUrl('サンプル作品アルファ 第2巻');
  assert.ok(url.startsWith('https://www.pixiv.net/ajax/search/artworks/'));
  assert.ok(url.includes(encodeURIComponent('サンプル作品アルファ 第2巻')));
  assert.ok(url.includes('s_mode=s_tag'));
  assert.ok(!url.includes('%20') === false || url.includes('%20'), url);
});

test('Pixiv：搜索计划先按标签、再按标题/正文', () => {
  const plan = adapter.searchPlan('サンプル作品アルファ');
  assert.equal(plan.length, 2);
  assert.equal(plan[0].id, 'tag');
  assert.equal(plan[0].tier, 1);
  assert.ok(plan[0].url.includes('s_mode=s_tag'));
  assert.equal(plan[1].id, 'title-caption');
  assert.ok(plan[1].url.includes('s_mode=s_tc'));
});

test('Pixiv：解析搜索结果（标题 / 作者 / 作品页链接 / 年龄分级）', () => {
  const result = adapter.parseResults(sample, { id: 'tag' });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 3);
  const first = result.items[0];
  assert.equal(first.productId, '10000001');
  assert.equal(first.store, 'pixiv');
  assert.equal(first.title, 'サンプル作品ピクシブ 第1話');
  assert.equal(first.url, 'https://www.pixiv.net/artworks/10000001');
  assert.equal(first.author, 'サンプル作者ピー');
  assert.equal(first.ageRating, 0);
  assert.equal(result.items[1].ageRating, 1);
});

test('Pixiv：不声称作品免费（能打开不等于免费），价格字段留空', () => {
  const result = adapter.parseResults(sample, { id: 'tag' });
  assert.equal(result.items[0].isFree, false);
  assert.equal(result.items[0].price, null);
  assert.equal(result.items[0].priceText, '');
});

test('Pixiv：空结果是 not-found，而不是解析失败', () => {
  const empty = JSON.stringify({ error: false, body: { illustManga: { data: [], total: 0 } } });
  const result = adapter.parseResults(empty, { id: 'tag' });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not-found');
  assert.equal(result.items.length, 0);
});

test('Pixiv：接口报错（未登录 / 被限流 / 结构变化）不会被当成「没有结果」', () => {
  const blocked = JSON.stringify({ error: true, message: 'rate limited' });
  const result = adapter.parseResults(blocked, { id: 'tag' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');

  const broken = adapter.parseResults('<html>not json</html>', { id: 'tag' });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'invalid-json');

  const reshaped = adapter.parseResults(JSON.stringify({ error: false, body: { something: {} } }), { id: 'tag' });
  assert.equal(reshaped.ok, false);
  assert.equal(reshaped.reason, 'no-items-parsed');
});

test('Pixiv：未找到时给出 R-18 需要登录 / 年龄确认的说明', () => {
  assert.ok(adapter.emptyResultNote.includes('登录'));
  assert.equal(adapter.fetchOptions.credentials, 'include', '需要复用浏览器里的 Pixiv 会话');
});

test('Pixiv：作者不靠抓取，而是给用户一个作者搜索链接', () => {
  const url = adapter.buildArtistSearchUrl('サンプルサークルA');
  assert.ok(url.startsWith('https://www.pixiv.net/search/users?word='));
  assert.ok(url.includes(encodeURIComponent('サンプルサークルA')));
  // Artist names are not turned into extra search steps any more: Pixiv's user
  // search only returns a few preview works, so the user looks it up directly.
  assert.equal(adapter.searchPlan('サンプル作品アルファ').length, 2);
});
