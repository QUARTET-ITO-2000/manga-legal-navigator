import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanTitle, extractWorkTitle } from '../src/lib/cleaner.js';

test('测试 A：标准标题「作品名称 第12话」能识别出作品名称', () => {
  const result = cleanTitle('作品名称 第12话');
  assert.equal(result.cleaned, '作品名称');
  assert.equal(result.confidence, 'high');
  assert.equal(result.chapterHint, 12);
});

test('测试 B：带网站名的标题会去掉网站名与广告语', () => {
  const result = cleanTitle('【作品名称】第12话 - 免费漫画 - XXX漫画网', { host: 'xxxmanga.com' });
  assert.equal(result.cleaned, '作品名称');
  assert.equal(result.confidence, 'high');
  assert.ok(result.notes.some((note) => note.startsWith('dropped-site-segment')));
});

test('标题清洗不会过度清洗：没有噪音的标题保持原样', () => {
  const result = cleanTitle('サンプル作品アルファ');
  assert.equal(result.cleaned, 'サンプル作品アルファ');
  assert.ok(['medium', 'high'].includes(result.confidence));
});

test('下划线分隔的中文站标题也能清洗', () => {
  const result = cleanTitle('作品名称_第12话_免费在线阅读_某某漫画');
  assert.equal(result.cleaned, '作品名称');
});

test('作品名中间含有连字符/空格时不会被切断', () => {
  const result = cleanTitle('Love EDUCATE! ASMR');
  assert.equal(result.cleaned, 'Love EDUCATE! ASMR');
});

test('英文整句标题不会被误删', () => {
  const result = cleanTitle('サンプル作品ラムダ -Sample Subtitle One-');
  assert.match(result.cleaned, /サンプル作品ラムダ/);
  assert.match(result.cleaned, /Sample Subtitle One/);
});

test('测试 E：成人向标题走同一套流程，不做额外内容判断', () => {
  const result = cleanTitle('サンプル作品オメガ 合理的なスーツ 第3話 - 免费阅读 - R18漫画网');
  assert.equal(result.cleaned, 'サンプル作品オメガ 合理的なスーツ');
});

test('章节编号被剥离但保留章节提示，用于候选优先排序', () => {
  const result = cleanTitle('サンプル作品カッパ 第108巻');
  assert.equal(result.cleaned, 'サンプル作品カッパ');
  assert.equal(result.chapterHint, 108);
});

test('画廊站标题：站点名（» doujin）会被去掉', () => {
  const result = cleanTitle('サンプル作品ベータ! » doujin', { host: 'doujin.example' });
  assert.equal(result.cleaned, 'サンプル作品ベータ');
  assert.equal(result.confidence, 'high');
});

test('画廊站 h1：开头的 [社团名] 是作者而不是作品名，应被去掉', () => {
  const result = cleanTitle('[サークル名A] サンプル作品ベータ!', { host: 'doujin.example' });
  assert.equal(result.cleaned, 'サンプル作品ベータ');
});

test('副标题：`原名 - 副标题 | 英译副标题` 只取最前面的原名', () => {
  const result = cleanTitle(
    'Sample Romaji Delta Full - Sample Subtitle A | Sample Subtitle B » doujin',
    { host: 'doujin.example' }
  );
  assert.equal(result.cleaned, 'Sample Romaji Delta Full');
});

test('副标题（日文原名 + 英译）：不会因为英译标题更长就选中英译', () => {
  const result = cleanTitle('サンプル作品デルタ - Sample Subtitle A | Sample Subtitle B » doujin', {
    host: 'doujin.example'
  });
  assert.equal(result.cleaned, 'サンプル作品デルタ');
});

test('英文社团名开头的 h1 会被去掉，只留下日文原题', () => {
  const result = cleanTitle('[サークル名D (作者名D)] サンプル作品デルタ 図書室のテスト [英訳] [DL版]', {
    host: 'doujin.example'
  });
  assert.equal(result.cleaned, 'サンプル作品デルタ 図書室のテスト');
  assert.ok(result.notes.includes('dropped-prefix-label'));
  assert.ok(result.notes.includes('stripped-edition-label'));
});

test('结尾的版本/语言标签会被去掉', () => {
  assert.equal(cleanTitle('作品名称 [English] [Digital]').cleaned, '作品名称');
  assert.equal(cleanTitle('作品名称 [DL版]').cleaned, '作品名称');
  assert.equal(cleanTitle('作品名 第3話 [無修正]').cleaned, '作品名');
});

test('括号里是作品名时不会被误删（【作品名称】第12话）', () => {
  const result = cleanTitle('【作品名称】第12话');
  assert.equal(result.cleaned, '作品名称');
});

test('完全无意义的标题会返回 low 置信度', () => {
  const result = cleanTitle('第12话');
  assert.equal(result.confidence, 'low');
});

test('多来源标题会综合使用：og:title 更干净时优先采用它的结果', () => {
  const extraction = extractWorkTitle({
    host: 'example.com',
    title: '作品名称 第12话 - 免费漫画 - 某漫画网',
    ogTitle: '作品名称',
    h1: ['作品名称 第12话']
  });
  assert.equal(extraction.cleanedTitle, '作品名称');
  assert.equal(extraction.confidence, 'high');
  assert.ok(extraction.variants.includes('作品名称'));
  assert.ok(extraction.variants.length <= 3);
});

test('多个 h1（罗马音 + 日文原题）都会作为搜索变体', () => {
  const extraction = extractWorkTitle({
    host: 'doujin.example',
    title: 'Sample Romaji Delta » doujin',
    h1: [
      '[サークル名D (作者名D)] Sample Romaji Delta [English] [Digital]',
      '[サークル名D (作者名D)] サンプル作品デルタ [英訳] [DL版]'
    ]
  });
  assert.ok(extraction.variants.some((variant) => variant.includes('Sample Romaji Delta')), JSON.stringify(extraction.variants));
  assert.ok(extraction.variants.some((variant) => variant.includes('サンプル作品デルタ')), JSON.stringify(extraction.variants));
});

test('罗马音标题 + 日文原题：优先用日文原题搜索（DLsite 只认日文商品名）', () => {
  const extraction = extractWorkTitle({
    host: 'doujin.example',
    title: 'Sample Romaji Gamma Title » doujin',
    // real structure of these gallery sites: h1 = romanised title, h2 = Japanese original
    h1: ['[Circle Name B (Author B)] Sample Romaji Gamma Title [English] [mysterymeat3] [Digital]'],
    h2: [
      '[サークル名B (作者名B)] サンプル作品ガンマ ローマ字表記テスト [英訳] [DL版]',
      'More Like This'
    ],
    h3: ['#000001', 'Post a comment']
  });
  assert.equal(extraction.cleanedTitle, 'サンプル作品ガンマ ローマ字表記テスト');
  assert.equal(extraction.source, 'h2[0]');
  assert.equal(extraction.variants.length, 2, JSON.stringify(extraction.variants));
  assert.ok(extraction.variants[1].startsWith('Sample Romaji Gamma'), JSON.stringify(extraction.variants));
});

test('栏目名（More Like This / Post a comment / #000001）不会被当成作品名', () => {
  const extraction = extractWorkTitle({
    host: 'doujin.example',
    title: 'Some Work [English] » doujin',
    h1: ['Some Work [English] [Digital]'],
    h2: ['More Like This'],
    h3: ['#000001', 'Post a comment']
  });
  assert.deepEqual(extraction.variants, ['Some Work']);
});

test('页面同时有英文标题和日文标题时，优先用日文原题（DLsite 只有日文商品名）', () => {
  const extraction = extractWorkTitle({
    host: 'doujin.example',
    title: "Sample English Title - Chapter 1-16 » doujin",
    headings: [
      { tag: 'h1', level: 1, text: "[Circle Name E] Sample English Title - Chapter 1-16 (ENGLISH)" },
      { tag: 'h2', level: 2, text: '[サークル名E] サンプル作品ゼータ' },
      { tag: 'h3', level: 3, text: '#000002' },
      { tag: 'h2', level: 2, text: 'More Like This' },
      { tag: 'h2', level: 2, text: 'Save this search' }
    ]
  });
  assert.equal(extraction.cleanedTitle, 'サンプル作品ゼータ');
  assert.equal(extraction.variants[0], 'サンプル作品ゼータ');
});

test('中文译名不会压过日文原题', () => {
  const extraction = extractWorkTitle({
    host: 'doujin.example',
    title: 'Sample Romaji Eta | 示例中文译名Eta » doujin',
    headings: [
      { tag: 'h2', level: 2, text: '示例中文译名Eta' },
      { tag: 'h2', level: 2, text: 'サンプル作品イータ' }
    ]
  });
  assert.equal(extraction.cleanedTitle, 'サンプル作品イータ');
});

test('翻译/汉化标签（[中国翻訳] [甜族星人赞助汉化]）会被去掉', () => {
  assert.equal(
    cleanTitle('[作者名C] サンプル作品イプシロン [中国翻訳] [DL版]').cleaned,
    'サンプル作品イプシロン'
  );
  assert.equal(
    cleanTitle('[Author C] Sample Romaji Epsilon [Chinese] [甜族星人赞助汉化] [Digital]').cleaned,
    'Sample Romaji Epsilon'
  );
});

test('双语标题（日文原题︱中文译名）只保留日文原题', () => {
  assert.equal(
    cleanTitle('[サークル名F] サンプル作品シータ︱示例中文译名 [Chinese][第3卷]', { host: 'doujin.example' }).cleaned,
    'サンプル作品シータ'
  );
  // a "Japanese name + English subtitle" must not be dropped as a translation
  assert.equal(
    cleanTitle('サンプル作品ラムダ -Sample Subtitle One-').cleaned,
    'サンプル作品ラムダ -Sample Subtitle One'
  );
});

test('重复变体去重：只多了译名标签的同名变体不会再占名额', () => {
  const extraction = extractWorkTitle({
    host: 'example.test',
    title: '作品名称 [English] [Digital]',
    h1: ['作品名称', '作品名称 [DL版]']
  });
  assert.deepEqual(extraction.variants, ['作品名称']);
});

test('没有任何标题时返回 low 置信度且没有变体', () => {
  const extraction = extractWorkTitle({ host: 'example.com' });
  assert.equal(extraction.cleanedTitle, '');
  assert.equal(extraction.confidence, 'low');
  assert.deepEqual(extraction.variants, []);
});
