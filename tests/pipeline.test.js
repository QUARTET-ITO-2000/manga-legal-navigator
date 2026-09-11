import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analyzePage } from '../src/lib/pipeline.js';
import { STATUS } from '../src/shared/protocol.js';

/**
 * End-to-end pipeline tests, driven by the store page snapshots in
 * src/stores/fixtures/.
 * NOTE: the "page titles" here simulate real sites; the work name in them has to
 * match a product name in the snapshot for the matching logic to be exercised,
 * which is why those strings mirror the snapshots. Both use placeholder data.
 */

const sampleHtml = readFileSync(new URL('../src/stores/fixtures/dlsite-search-sample.html', import.meta.url), 'utf8');
const notFoundHtml = readFileSync(new URL('../src/stores/fixtures/dlsite-not-found-sample.html', import.meta.url), 'utf8');
const blockedHtml = '<!doctype html><html><head><title>403 Forbidden</title></head><body>403</body></html>';
const fanzaHtml = readFileSync(new URL('../src/stores/fixtures/fanza-search-sample.html', import.meta.url), 'utf8');
const fanzaAgeHtml = readFileSync(new URL('../src/stores/fixtures/fanza-age-check-sample.html', import.meta.url), 'utf8');
const melonHtml = readFileSync(new URL('../src/stores/fixtures/melonbooks-search-sample.html', import.meta.url), 'utf8');

function createDeps(options = {}) {
  const cacheStore = new Map();
  const calls = [];
  return {
    calls,
    deps: {
      fetchText: async (url) => {
        calls.push(url);
        if (options.throwOnFetch) throw new Error('network down');
        if (options.blocked) return { ok: false, status: 403, text: blockedHtml, url };
        if (/dmm\.co\.jp/.test(url)) {
          if (options.fanza === 'agecheck') {
            return { ok: false, status: 200, text: fanzaAgeHtml, url: 'https://www.dmm.co.jp/age_check/=/?rurl=x' };
          }
          if (options.fanza === 'none') return { ok: true, status: 200, text: notFoundHtml, url };
          return { ok: true, status: 200, text: fanzaHtml, url };
        }
        if (/melonbooks\.co\.jp/.test(url)) {
          if (options.melonbooks === 'none') return { ok: true, status: 200, text: notFoundHtml, url };
          return { ok: true, status: 200, text: melonHtml, url };
        }
        // The real DLsite only returns results for the "right" keyword; a keyword filter simulates that
        const decodedKeyword = decodeURIComponent(url).replace(/\+/g, ' ');
        if (options.onlyKeyword && !decodedKeyword.includes(options.onlyKeyword)) {
          return { ok: true, status: 200, text: notFoundHtml, url };
        }
        const html = /girls/.test(url) ? notFoundHtml : sampleHtml;
        return { ok: true, status: 200, text: html, url };
      },
      cache: {
        get: async (key) => cacheStore.get(key) || null,
        set: async (key, value) => { cacheStore.set(key, { ...value, at: Date.now() }); }
      }
    }
  };
}

const piratePage = {
  url: 'https://www.example-manga.test/comic/12345/3',
  host: 'www.example-manga.test',
  title: '【サンプル作品アルファ】第3話 - 免费漫画 - 某漫画网',
  h1: ['サンプル作品アルファ 第3話'],
  ogTitle: 'サンプル作品アルファ',
  description: '免费在线观看 サンプル作品アルファ 第3話',
  keywords: '漫画,免费',
  textSample: '第3話 サンプル作品アルファ……',
  imageCount: 18
};

test('核心闭环：漫画页 -> 清洗作品名 -> DLsite 搜索 -> 高分匹配 + 价格 + 链接', async () => {
  const { deps, calls } = createDeps();
  const state = await analyzePage({ pageInfo: piratePage, settings: {}, deps });

  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.query.cleanedTitle, 'サンプル作品アルファ');
  assert.equal(state.match.productId, 'RJ00000001');
  assert.equal(state.match.priceText, '1,980円');
  assert.match(state.match.url, /dlsite\.com\/.*product_id\/RJ00000001\.html/);
  assert.equal(state.storeLabel, 'DLsite');
  assert.ok(state.searchUrl.includes('dlsite.com'));
  // once a high-confidence result is found, the second section must not be searched
  assert.equal(calls.length, 1);
});

test('商店关键词里的标点会被替换成空格（Melonbooks 对标点直接返回 0 条）', async () => {
  const { deps, calls } = createDeps();
  const page = {
    ...piratePage,
    title: 'サンプル作品アルファ・総集編 第3話 - 免费漫画 - 某漫画网',
    h1: [],
    ogTitle: ''
  };
  const state = await analyzePage({ pageInfo: page, settings: {}, deps });

  // The title shown to the user keeps its original punctuation…
  assert.ok(state.query.cleanedTitle.includes('・'), state.query.cleanedTitle);
  // …while the keyword sent to the stores has none.
  assert.ok(state.query.searched.length >= 1);
  for (const query of state.query.searched) {
    assert.ok(!/[\p{P}\p{S}]/u.test(query), `商店关键词不该含标点：${query}`);
  }
  const decoded = calls.map((url) => decodeURIComponent(String(url).replace(/\+/g, ' ')));
  assert.ok(decoded.some((url) => url.includes('サンプル作品アルファ 総集編')), decoded.join('\n'));
});

test('可能的匹配（分数 62~84）会标注匹配度并给出候选', async () => {
  const { deps } = createDeps();
  const page = {
    ...piratePage,
    // the page title carries an extra "番外編 総集編", so this is a "possible" rather than an exact match
    title: 'サンプル作品アルファ 番外編 総集編 第5話 - 漫画 - 某漫画网',
    h1: [],
    ogTitle: ''
  };
  const state = await analyzePage({ pageInfo: page, settings: {}, deps });
  assert.equal(state.status, STATUS.OK_POSSIBLE);
  assert.ok(state.match.score >= 62 && state.match.score < 85);
  assert.ok(state.match.scoreLabel.length > 0);
});

test('DLsite 没有对应商品时返回 no_result，且不展示低分候选', async () => {
  const { deps } = createDeps();
  const page = { ...piratePage, title: '完全不存在的测试作品名 第1話 - 漫画 - 某漫画网', h1: [], ogTitle: '' };
  const state = await analyzePage({ pageInfo: page, settings: {}, deps });
  assert.equal(state.status, STATUS.NO_RESULT);
  assert.deepEqual(state.candidates, []);
  assert.equal(state.message, '暂未找到对应商品。');
  assert.ok(state.searchUrl.includes('dlsite.com'));
});

test('测试 E：成人向作品与全年龄作品走完全相同的流程', async () => {
  const { deps } = createDeps();
  const page = {
    ...piratePage,
    title: 'サンプル作品ガンマ 第2話 - 免费阅读 - R18漫画网',
    h1: [],
    ogTitle: ''
  };
  const state = await analyzePage({ pageInfo: page, settings: {}, deps });
  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.match.productId, 'RJ00000003');
});

test('测试 F：非漫画页面不会产生任何推荐', async () => {
  const { deps, calls } = createDeps();
  const state = await analyzePage({
    pageInfo: {
      url: 'https://blog.example.test/posts/hello',
      host: 'blog.example.test',
      title: '如何学习编程：给初学者的 10 条建议',
      description: '一篇关于编程学习的文章',
      textSample: '编程学习需要循序渐进……',
      imageCount: 1
    },
    settings: {},
    deps
  });
  assert.equal(state.status, STATUS.UNRECOGNIZED);
  assert.equal(state.reason, 'no-comic-signal');
  assert.equal(state.match, null);
  assert.equal(calls.length, 0);
});

test('无法读取页面 / 无法识别作品名时给出明确原因', async () => {
  const { deps } = createDeps();
  const noTitle = await analyzePage({
    pageInfo: { url: 'https://manga.example.test/a/1', host: 'manga.example.test', title: '', textSample: '第1話', imageCount: 5 },
    settings: {},
    deps
  });
  assert.equal(noTitle.status, STATUS.UNRECOGNIZED);
  assert.ok(['title-unrecognized', 'no-title'].includes(noTitle.reason));
});

test('DLsite 请求失败时显示「搜索暂时失败」，而不是假装没有结果', async () => {
  const { deps } = createDeps({ throwOnFetch: true });
  const state = await analyzePage({ pageInfo: piratePage, settings: {}, deps });
  assert.equal(state.status, STATUS.ERROR);
  assert.equal(state.message, 'DLsite 搜索暂时失败。');
});

test('被拦截（403）时同样提示搜索失败', async () => {
  const { deps } = createDeps({ blocked: true });
  const state = await analyzePage({ pageInfo: piratePage, settings: {}, deps });
  assert.equal(state.status, STATUS.ERROR);
  assert.equal(state.message, 'DLsite 搜索暂时失败。');
});

test('第二次分析同一作品时命中缓存，不再请求 DLsite', async () => {
  const { deps, calls } = createDeps();
  const sharedCache = {
    get: async () => null,
    set: async () => {}
  };
  const first = await analyzePage({ pageInfo: piratePage, settings: {}, deps });
  const firstCallCount = calls.length;

  // reuse one cache instance to simulate the real store
  const store = new Map();
  const deps2 = {
    fetchText: deps.fetchText,
    cache: {
      get: async (key) => store.get(key) || null,
      set: async (key, value) => { store.set(key, { ...value, at: Date.now() }); }
    }
  };
  const a = await analyzePage({ pageInfo: piratePage, settings: {}, deps: deps2 });
  const afterFirst = calls.length;
  const b = await analyzePage({ pageInfo: piratePage, settings: {}, deps: deps2 });
  assert.equal(a.status, STATUS.OK_HIGH);
  assert.equal(b.status, STATUS.OK_HIGH);
  assert.equal(b.meta.fromCache, true);
  assert.equal(calls.length, afterFirst, '第二次不应再发起网络请求');
  assert.equal(first.status, STATUS.OK_HIGH);
  assert.ok(firstCallCount >= 1);
  assert.equal(sharedCache.get.length, 0);
});

test('调试模式（mock）可以用离线快照跑通整条链路', async () => {
  const { deps } = createDeps();
  const state = await analyzePage({
    pageInfo: { ...piratePage, title: 'サンプル作品デルタ～第1部～ 第1話 - 漫画 - 某站' },
    settings: {},
    deps
  });
  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.match.productId, 'RJ00000004');
});

test('同人志画廊站（Tags/Groups/Pages 式页面）能识别并匹配到 DLsite 正版商品', async () => {
  const { deps } = createDeps();
  const state = await analyzePage({
    pageInfo: {
      url: 'https://doujin.example/g/000003/',
      host: 'doujin.example',
      title: 'サンプル作品ゼータの物語! » doujin',
      h1: ['[サンプルサークルE] サンプル作品ゼータの物語'],
      ogTitle: '[サンプルサークルE] サンプル作品ゼータの物語',
      infoText: 'Parodies: original Tags: netorare Groups: futaba sugar Languages: japanese Categories: doujinshi Pages: 170',
      imageCount: 170
    },
    settings: {},
    deps
  });
  assert.equal(state.status, STATUS.OK_HIGH, JSON.stringify(state.meta.signals));
  assert.equal(state.query.cleanedTitle, 'サンプル作品ゼータの物語');
  assert.equal(state.match.productId, 'RJ00000006');
  assert.equal(state.match.priceText, '385円');
});

test('有副标题时只取原名，不会被更长的英文副标题带偏', async () => {
  const { deps } = createDeps();
  const state = await analyzePage({
    pageInfo: {
      url: 'https://doujin.example/g/000001/',
      host: 'doujin.example',
      title: 'サンプル作品アルファ - Sample Subtitle A | Sample Subtitle B » doujin',
      h1: ['サンプル作品アルファ - Sample Subtitle A | Sample Subtitle B » doujin'],
      infoText: 'Parodies: original Tags: schoolgirl Groups: fiction memo Languages: japanese Categories: doujinshi Pages: 46',
      imageCount: 46
    },
    settings: {},
    deps
  });
  assert.equal(state.query.cleanedTitle, 'サンプル作品アルファ');
  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.match.productId, 'RJ00000001');
});

test('主变体搜不到时，会再用第二个变体（日文原题）重搜一次', async () => {
  const { deps, calls } = createDeps({ onlyKeyword: 'サンプル作品アルファ' });
  const state = await analyzePage({
    pageInfo: {
      url: 'https://doujin.example/g/000002/',
      host: 'doujin.example',
      title: 'サンプル作品オメガ » doujin',
      h1: [
        '[サンプルサークルF] サンプル作品オメガ [DL版]',
        '[サンプルサークルF] サンプル作品アルファ [DL版]'
      ],
      infoText: 'Parodies: original Tags: big breasts Groups: sample circle Languages: japanese Categories: doujinshi Pages: 46',
      imageCount: 46
    },
    settings: {},
    deps
  });
  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.match.productId, 'RJ00000001');
  assert.equal(state.match.matchedQuery, 'サンプル作品アルファ');
  assert.equal(calls.length, 2, '两个变体各发一次搜索请求');
});

test('罗马音标题 + 日文原题的画廊页：用日文原题命中 DLsite', async () => {
  const { deps, calls } = createDeps({ onlyKeyword: 'サンプル作品ガンマ' });
  const state = await analyzePage({
    pageInfo: {
      url: 'https://doujin.example/g/000007/',
      host: 'doujin.example',
      title: 'Sample Romaji Title Gamma » doujin',
      h1: ['[Circle Name C] Sample Romaji Title Gamma [English] [sample translator] [Digital]'],
      h2: [
        '[サンプルサークルC (サンプル作者C)] サンプル作品ガンマ [英訳] [DL版]',
        'More Like This'
      ],
      h3: ['#000007', 'Post a comment'],
      ogTitle: '[Circle Name C] Sample Romaji Title Gamma [English] [Digital]',
      infoText: 'Parodies: original Tags: crossdressing Groups: sample circle c Languages: japanese Categories: doujinshi Pages: 42',
      imageCount: 42
    },
    settings: {},
    deps
  });
  assert.equal(state.query.cleanedTitle, 'サンプル作品ガンマ');
  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.match.productId, 'RJ00000003');
  assert.equal(state.match.priceText, '693円');
  assert.equal(calls.length, 1, '日文原题一次就命中，不需要再搜罗马音');
});

test('DLsite 没有结果时会继续查 FANZA（多商店，命中后不再查 Melonbooks）', async () => {
  const { deps, calls } = createDeps({ onlyKeyword: 'この作品はディーエルサイトにない' });
  const state = await analyzePage({
    pageInfo: {
      url: 'https://doujin.example/g/000001/',
      host: 'doujin.example',
      title: 'サンプル作品F 図書室のテスト 第1話 - 漫画 - 某漫画网',
      h1: ['【サンプル作品F 図書室のテスト】第1話'],
      infoText: 'Parodies: original Tags: big breasts Groups: sample circle Languages: japanese Categories: doujinshi Pages: 46',
      imageCount: 46
    },
    settings: {},
    deps
  });
  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.match.store, 'fanza');
  assert.equal(state.match.storeLabel, 'FANZA');
  assert.equal(state.match.priceText, '¥770');
  assert.ok(state.match.url.includes('cid=d_00000001'));
  assert.ok(calls.some((url) => url.includes('dmm.co.jp')), '应该查过 FANZA');
  assert.ok(!calls.some((url) => url.includes('melonbooks')), 'FANZA 命中后不该再查 Melonbooks');
  assert.equal(state.needsAgeCheck, false);
});

test('FANZA 需要年龄确认时：给出提示，而不是当成「没有结果」', async () => {
  const { deps } = createDeps({ onlyKeyword: '存在しない', fanza: 'agecheck', melonbooks: 'none' });
  const state = await analyzePage({
    pageInfo: {
      url: 'https://doujin.example/g/000001/',
      host: 'doujin.example',
      title: 'サンプル作品F 図書室のテスト 第1話 - 漫画 - 某漫画网',
      h1: [],
      infoText: 'Parodies: original Tags: big breasts Languages: japanese Categories: doujinshi Pages: 46',
      imageCount: 46
    },
    settings: {},
    deps
  });
  assert.equal(state.status, STATUS.NO_RESULT);
  assert.equal(state.needsAgeCheck, true);
  assert.equal(state.ageCheckStoreLabel, 'FANZA');
  assert.ok(state.ageCheckUrl.includes('age_check'));
  const fanza = state.stores.find((item) => item.storeId === 'fanza');
  assert.equal(fanza.kind, 'age_check');
});

test('DLsite / FANZA 都没有时，最后会在 Melonbooks 上找到', async () => {
  const { deps, calls } = createDeps({ onlyKeyword: '存在しない', fanza: 'none' });
  const state = await analyzePage({
    pageInfo: {
      url: 'https://doujin.example/g/000001/',
      host: 'doujin.example',
      title: 'サンプル作品F 図書室のテスト 第1話 - 漫画 - 某漫画网',
      h1: [],
      infoText: 'Parodies: original Tags: big breasts Languages: japanese Categories: doujinshi Pages: 46',
      imageCount: 46
    },
    settings: {},
    deps
  });
  assert.equal(state.status, STATUS.OK_HIGH);
  assert.equal(state.match.store, 'melonbooks');
  assert.equal(state.match.priceText, '¥990');
  assert.ok(state.match.url.includes('product_id=1000001'));
  assert.ok(calls.some((url) => url.includes('melonbooks')), '应该查过 Melonbooks');
  assert.equal(state.searchUrls.length, 3, '没找到时每个商店都应给出搜索入口');
});
