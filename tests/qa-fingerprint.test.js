/**
 * Page fingerprint + novelty scoring (requirements doc §10 / §11 / §12).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFeatures,
  categoryDirOf,
  categoryOf,
  fingerprintLines,
  fingerprintOf,
  noveltyMessage,
  noveltyScore,
  pageTypeOf,
  scriptOf,
  shortHash,
  urlPatternOf
} from '../src/qa/fingerprint.js';

const galleryPage = {
  url: 'https://doujin.example/g/000123/',
  host: 'doujin.example',
  title: '【サンプル作品アルファ】第1話 - 免费漫画 - 示例漫画网',
  h1: ['サンプル作品アルファ 第1話'],
  ogTitle: 'サンプル作品アルファ',
  imageCount: 46,
  infoText: 'Parodies: original Tags: sample Languages: japanese Categories: doujinshi Pages: 46'
};

test('指纹：图库页 = G-H1-OG-NJ-IMG40-INFO-STATIC，SPA 会换成 SPA', () => {
  const features = buildFeatures(galleryPage);
  assert.equal(fingerprintOf(features), 'G-H1-OG-NJ-IMG40-INFO-STATIC');
  assert.equal(fingerprintOf(buildFeatures({ ...galleryPage, navigationType: 'spa' })), 'G-H1-OG-NJ-IMG40-INFO-SPA');
  assert.deepEqual(fingerprintLines(features).slice(0, 3), ['gallery', 'h1=yes', 'og=yes']);
});

test('指纹：没有 H1 / og / jsonld / 信息块的特征位都会反映出来', () => {
  const features = buildFeatures({
    url: 'https://reader.example/comic/1/2',
    title: 'サンプル作品ベータ 第2話 - 在线漫画',
    imageCount: 12,
    navigationType: 'spa'
  });
  assert.equal(features.h1, false);
  assert.equal(features.ogTitle, false);
  assert.equal(features.galleryInfo, false);
  assert.equal(fingerprintOf(features), 'R-NH1-NOG-NJ-IMG8-NOINFO-SPA');
});

test('urlPattern：id / slug 会被遮掉，query 不进入指纹', () => {
  assert.equal(urlPatternOf('https://doujin.example/g/000123/'), '/g/:id/');
  assert.equal(urlPatternOf('https://hitomi.example/doujinshi/some-title-japanese-123456-654321.html#1'), '/doujinshi/:slug.html');
  assert.equal(urlPatternOf('https://doujin.example/search?q=sample&page=2'), '/search');
  assert.equal(urlPatternOf('https://doujin.example/comic/1/2'), '/comic/:id/:id');
  assert.equal(urlPatternOf('not a url'), '');
});

test('页面类型：gallery / reader / article / listing 都能区分', () => {
  assert.equal(pageTypeOf(galleryPage), 'gallery');
  assert.equal(pageTypeOf({ url: 'https://reader.example/comic/1/2', title: 'サンプル作品 第2話', imageCount: 14 }), 'reader');
  assert.equal(pageTypeOf({ url: 'https://blog.example/posts/1', ogType: 'article', title: '一篇文章', imageCount: 1 }), 'article');
  assert.equal(pageTypeOf({ url: 'https://doujin.example/search?q=x', title: '搜索结果', imageCount: 0 }), 'listing');
});

test('新颖度：结构相同的页面得 0 分，并提示「已有测试案例」', () => {
  const features = buildFeatures(galleryPage);
  const same = noveltyScore(features, [features]);
  assert.equal(same.score, 0);
  assert.equal(same.verdict, 'duplicate');
  assert.match(noveltyMessage(same.score), /similar to an existing test case/);
  assert.equal(same.similarTo.length, 1);
});

test('新颖度：SPA + 没有 H1 的新结构会得到高分，并被提示为新结构', () => {
  const known = buildFeatures(galleryPage);
  const fresh = buildFeatures({ url: 'https://reader.example/comic/1/2', title: 'サンプル作品 第2話', imageCount: 12, navigationType: 'spa' });
  const novelty = noveltyScore(fresh, [known]);
  assert.ok(novelty.score >= 51, `score=${novelty.score}`);
  assert.match(noveltyMessage(novelty.score), /New page structure/);
  assert.equal(noveltyScore(fresh, []).score, 100);
});

test('分类：spa 页面进 navigation，meta 贫乏的页面进 cleaning，列表页进 negative', () => {
  const spaGallery = buildFeatures({ ...galleryPage, navigationType: 'spa' });
  assert.equal(categoryOf(spaGallery), 'spa-gallery');
  assert.equal(categoryDirOf(categoryOf(spaGallery), spaGallery), 'navigation');

  const noMeta = buildFeatures({ url: 'https://doujin.example/comic/1/1', title: '【サンプル作品】第1話', imageCount: 16 });
  assert.equal(categoryOf(noMeta), 'reader-chapter');
  assert.equal(categoryDirOf(categoryOf(noMeta), noMeta), 'cleaning');

  const listing = buildFeatures({ url: 'https://doujin.example/search?q=x', title: '搜索结果', imageCount: 0 });
  assert.equal(categoryDirOf('negative', listing), 'negative');
  assert.equal(categoryDirOf('matching', noMeta), 'matching');
});

test('短哈希与文字系统：只在本地用来对照，不携带作品名', () => {
  assert.equal(shortHash('サンプル作品アルファ').length, 8);
  assert.equal(shortHash('サンプル作品アルファ'), shortHash('サンプル作品アルファ'));
  assert.notEqual(shortHash('サンプル作品アルファ'), shortHash('サンプル作品ベータ'));
  assert.equal(scriptOf('サンプル作品'), 'cjk');
  assert.equal(scriptOf('Sample Work'), 'latin');
  assert.equal(scriptOf(''), 'none');
});
