import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePage, isDeniedHost } from '../src/lib/site-filter.js';

test('明显无关的站点被直接跳过', () => {
  for (const host of ['www.google.com', 'mail.google.com', 'x.com', 'www.youtube.com', 'github.com', 'www.dlsite.com']) {
    assert.equal(isDeniedHost(host), true, `${host} 应被跳过`);
  }
});

test('漫画站不会被跳过', () => {
  assert.equal(isDeniedHost('www.manhuagui.com'), false);
  assert.equal(isDeniedHost('mangacopy.com'), false);
});

test('漫画页（标题含章节号）会被分析', () => {
  const result = evaluatePage({
    url: 'https://example-reader.test/book/1/chapter/3',
    host: 'example-reader.test',
    title: '作品名称 第3話 - 在线漫画',
    textSample: '第3話 作品名称',
    imageCount: 20
  });
  assert.equal(result.allowed, true);
});

test('测试 F：普通博客 / 文档页面不会被分析', () => {
  const result = evaluatePage({
    url: 'https://blog.example.test/posts/hello-world',
    host: 'blog.example.test',
    title: '如何学习编程：给初学者的 10 条建议',
    description: '一篇关于编程学习的文章',
    textSample: '编程学习需要循序渐进……',
    imageCount: 1
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no-comic-signal');
});

test('测试 F：搜索引擎结果页不会被分析', () => {
  const result = evaluatePage({
    url: 'https://www.google.com/search?q=%E6%BC%AB%E7%94%BB',
    host: 'www.google.com',
    title: '漫画 - Google 搜索'
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'denylisted-host');
});

test('域名像漫画站时也会被分析', () => {
  const result = evaluatePage({
    url: 'https://www.mangacopy.com/comic/xyz',
    host: 'www.mangacopy.com',
    title: 'Comic Name',
    textSample: ''
  });
  assert.equal(result.allowed, true);
});

test('同人志画廊站（Tags/Groups/Pages 式信息块）会被当作作品页分析', () => {
  const result = evaluatePage({
    url: 'https://doujin.example/g/515276/',
    host: 'doujin.example',
    title: 'サンプル作品ベータ! » doujin',
    h1: ['[サークル名A] サンプル作品ベータ!'],
    infoText: 'Parodies: original Tags: netorare urination Groups: sample circle A | sample circle B Languages: japanese Categories: doujinshi Pages: 170 Uploaded: 2 years ago',
    imageCount: 170
  });
  assert.equal(result.allowed, true);
  assert.ok(result.signals.includes('gallery-structure'));
});

test('漫画站首页 / 列表页不会被当成作品页（不会弹出「找到正版」卡片）', () => {
  const result = evaluatePage({
    url: 'https://doujin.example/',
    host: 'doujin.example',
    title: 'doujin.example: sample gallery site',
    h1: [],
    ogTitle: 'doujin.example: sample gallery site',
    description: 'sample gallery site',
    // A real home page lists many work titles (some containing words like 漢化 or 同人):
    // that is page content and must not count as evidence of a work page
    textSample: 'Popular Now [サークル名G] 示例中文譯名 [Chinese] [沒有漢化] New Uploads [サークル名H] SEX生配信 同人',
    navHint: '[サークル名D (作者名D)] Sample Romaji Delta manga comic',
    imageCount: 120
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'site-root');
});

test('列表页（?page=2）也不会被当成作品页', () => {
  const result = evaluatePage({
    url: 'https://doujin.example/?page=2',
    host: 'doujin.example',
    title: 'doujin.example: sample gallery site',
    imageCount: 120
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'site-root');
});

test('同一站点的作品详情页仍然会被分析', () => {
  const result = evaluatePage({
    url: 'https://doujin.example/g/680213/',
    host: 'doujin.example',
    title: 'Sample Romaji Epsilon » doujin',
    h1: ['[Author C] Sample Romaji Epsilon [Chinese] [Digital]'],
    imageCount: 197
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'manga-host-detail-url');
});

test('站内跳转中间态（地址已换、内容还是上一页）不会被当成作品页', () => {
  // Real scenario: clicking a gallery from a site home page changes the URL to
  // /g/680213/ first while the content is still the home page. The title read at
  // that moment belongs to the home page and must never be searched for.
  const result = evaluatePage({
    url: 'https://doujin.example/g/680213/',
    host: 'doujin.example',
    title: 'doujin.example: sample gallery site',
    h1: [],
    settled: false,
    imageCount: 120
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'page-settling');
});

test('页面内容就绪（settled=true）时按正常流程分析', () => {
  const result = evaluatePage({
    url: 'https://doujin.example/g/680213/',
    host: 'doujin.example',
    title: 'Sample Romaji Epsilon » doujin',
    settled: true,
    imageCount: 197
  });
  assert.equal(result.allowed, true);
});

test('只有一张信息块的普通页面不会被误判为作品页', () => {
  const result = evaluatePage({
    url: 'https://shop.example.test/blog/how-to-code',
    host: 'shop.example.test',
    title: '如何学习编程：给初学者的 10 条建议',
    description: '一篇关于编程学习的文章',
    infoText: 'Tags: 编程, 学习',
    imageCount: 10
  });
  assert.equal(result.allowed, false);
});

test('图片很多的文章页（非作品详情 URL）不会被分析', () => {
  const result = evaluatePage({
    url: 'https://travel.example.test/2024/05/photo-diary',
    host: 'travel.example.test',
    title: '京都赏樱 10 天摄影日记',
    description: '记录了这次旅行的照片',
    imageCount: 40
  });
  assert.equal(result.allowed, false);
});

test('作品详情页 URL + 多图 + 漫画关键词 会被分析', () => {
  const result = evaluatePage({
    url: 'https://example-reader.test/comic/1234/chapter-5',
    host: 'example-reader.test',
    title: 'Some Comic Name',
    keywords: 'comic, read online',
    imageCount: 20
  });
  assert.equal(result.allowed, true);
});

test('调试开关可以强制跳过页面判断', () => {
  const result = evaluatePage(
    { url: 'https://blog.example.test/post', host: 'blog.example.test', title: '随便一个页面' },
    { ignoreSiteFilter: true }
  );
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'forced');
});

test('无法解析的 URL 会被拒绝', () => {
  assert.equal(evaluatePage({ url: '', host: '' }).allowed, false);
  assert.equal(evaluatePage({ url: 'not a url' }).allowed, false);
});
