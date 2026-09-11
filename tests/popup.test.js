/**
 * Popup smoke tests: render each of the four states against a minimal
 * chrome / DOM stub and check the result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function createElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    checked: false,
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    }
  };
}

const ELEMENT_IDS = [
  'version', 'page-title', 'page-host', 'result-body',
  'set-enabled', 'set-autoshow', 'set-mock', 'set-ignore-filter',
  'btn-clear-cache', 'cache-info'
];

/**
 * Popup test environment.
 * The content script's REQUEST_PAGE_INFO is stubbed:
 * - livePageInfo:     the page info of the document that is actually live
 * - livePendingTimes: the first N requests answer "still navigating" (the in-between state of a client-side navigation)
 * - liveUnavailable:  no content script at all (e.g. a PDF page)
 */
async function loadPopup({
  state,
  settings = {},
  reanalyzeState,
  reanalyzeError,
  tabUrl = 'https://manga.test/a/1',
  livePageInfo,
  livePendingTimes = 0,
  liveUnavailable = false
} = {}) {
  const elements = new Map(ELEMENT_IDS.map((id) => [id, createElement(id)]));
  const documentStub = {
    getElementById: (id) => elements.get(id) || createElement(id),
    addEventListener: () => {}
  };

  const sent = [];
  const events = [];

  /** Give a state the id of the document that produced it, mirroring page.scriptId */
  const withScriptId = (value, scriptId) => {
    if (!value || !value.page || value.page.scriptId) return value;
    return { ...value, page: { ...value.page, scriptId, settled: value.page.settled !== false } };
  };
  const cachedState = withScriptId(state, 'script-1');
  const reanalyzed = withScriptId(reanalyzeState ?? undefined, 'script-2');

  const defaultLive = () => ({
    url: tabUrl,
    host: new URL(tabUrl).hostname,
    title: '测试页面标题',
    scriptId: 'script-1',
    settled: true,
    capturedAt: Date.now()
  });
  let pendingLeft = livePendingTimes;

  const chromeStub = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => {
        sent.push(message.type);
        if (message.type === 'MN_GET_SETTINGS') {
          return {
            settings: { enabled: true, autoShowCard: true, mockMode: false, ignoreSiteFilter: false, ...settings },
            cache: { entries: 0 },
            version: '0.1.0'
          };
        }
        if (message.type === 'MN_GET_STATE') return { state: cachedState ?? null };
        if (message.type === 'MN_REANALYZE_TAB') {
          events.push('REANALYZE');
          if (reanalyzeError) return { error: reanalyzeError };
          return { state: reanalyzed ?? cachedState ?? null };
        }
        if (message.type === 'MN_SET_SETTINGS') return { settings };
        if (message.type === 'MN_CLEAR_CACHE') return { cache: { entries: 0 } };
        return {};
      }
    },
    tabs: {
      query: async () => [{ id: 1, url: tabUrl, title: '测试页面标题' }],
      sendMessage: async (_tabId, message) => {
        if (message?.type !== 'MN_REQUEST_PAGE_INFO') return {};
        events.push('REQUEST_PAGE_INFO');
        if (liveUnavailable) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        if (pendingLeft > 0) {
          pendingLeft -= 1;
          return { pageInfo: null, pending: true };
        }
        return { pageInfo: livePageInfo || defaultLive() };
      },
      create: async () => ({})
    }
  };

  globalThis.document = documentStub;
  globalThis.chrome = chromeStub;
  globalThis.window = { close: () => {} };

  // re-import with a random query each time, so the ESM module cache does not interfere
  await import(`../src/popup/popup.js?case=${Math.random()}`);
  await waitForRender(elements.get('result-body'));
  return { elements, sent, events };
}

const LOADING = '<p class="muted">正在识别…</p>';

/** Wait until the popup rendered a final result (not the "analysing…" placeholder) */
async function waitForRender(body, timeoutMs = 8000) {
  const startedAt = Date.now();
  let last = body.innerHTML;
  let stable = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (body.innerHTML !== last) {
      last = body.innerHTML;
      stable = 0;
      continue;
    }
    if (last && last !== LOADING) stable += 1;
    if (stable >= 4) return last;
  }
  return body.innerHTML;
}

test('Popup：高可信匹配时展示商品、价格与「查看正版」', async () => {
  const { elements } = await loadPopup({
    state: {
      status: 'ok_high',
      page: { url: 'https://manga.test/a/1', host: 'manga.test', title: '测试页面标题' },
      query: { cleanedTitle: 'サンプル作品アルファ', source: 'title', confidence: 'high' },
      match: {
        title: 'サンプル作品アルファ',
        url: 'https://www.dlsite.com/maniax/work/=/product_id/RJ00000000.html',
        storeLabel: 'DLsite',
        priceText: '1,980円',
        approxCny: 87,
        maker: 'サークル名',
        score: 100,
        scoreLabel: '很高'
      },
      candidates: []
    }
  });
  const html = elements.get('result-body').innerHTML;
  assert.match(html, /已识别作品/);
  assert.match(html, /找到 DLsite 商品/);
  assert.match(html, /サンプル作品アルファ/);
  assert.match(html, /1,980円/);
  assert.match(html, /查看正版/);
  assert.equal(elements.get('page-host').textContent, 'manga.test');
  assert.equal(elements.get('set-enabled').checked, true);
});

test('Popup：没有结果时给出各正版商店的搜索入口与年龄确认提示', async () => {
  const { elements } = await loadPopup({
    state: {
      status: 'no_result',
      page: { url: 'https://manga.test/a/1', host: 'manga.test', title: 'T' },
      query: { cleanedTitle: '不存在的作品', source: 'title', confidence: 'high' },
      message: '暂未找到对应商品。',
      match: null,
      candidates: [],
      searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/',
      searchUrls: [
        { storeLabel: 'DLsite', url: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/' },
        { storeLabel: 'FANZA', url: 'https://www.dmm.co.jp/search/=/searchstr/x/' }
      ],
      stores: [
        { storeId: 'dlsite', storeLabel: 'DLsite', kind: 'none', searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/' },
        { storeId: 'fanza', storeLabel: 'FANZA', kind: 'age_check', ageCheckUrl: 'https://www.dmm.co.jp/age_check/=/?rurl=x' }
      ],
      needsAgeCheck: true,
      ageCheckStoreLabel: 'FANZA',
      ageCheckUrl: 'https://www.dmm.co.jp/age_check/=/?rurl=x'
    }
  });
  const html = elements.get('result-body').innerHTML;
  assert.match(html, /暂未找到对应商品/);
  assert.match(html, /FANZA 年龄确认/);
  assert.match(html, /需要年龄确认/);
});

test('Popup：未能识别作品时提供「重新识别」', async () => {
  const { elements } = await loadPopup({
    state: {
      status: 'unrecognized',
      page: { url: 'https://blog.test/p/1', host: 'blog.test', title: '一篇博客' },
      reason: 'no-comic-signal',
      message: '当前页面不像漫画作品页。',
      match: null,
      candidates: []
    }
  });
  const html = elements.get('result-body').innerHTML;
  assert.match(html, /不像漫画作品页/);
  assert.match(html, /重新识别/);
});

test('Popup：DLsite 搜索失败时提示重试', async () => {
  const { elements } = await loadPopup({
    state: {
      status: 'error',
      page: { url: 'https://manga.test/a/1', host: 'manga.test', title: 'T' },
      message: 'DLsite 搜索暂时失败。',
      match: null,
      candidates: [],
      searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/'
    }
  });
  const html = elements.get('result-body').innerHTML;
  assert.match(html, /DLsite 搜索暂时失败/);
  assert.match(html, /重试/);
});

test('Popup：读不到页面（没有 content script）时提示「无法读取当前页面」', async () => {
  const { elements } = await loadPopup({ state: null, liveUnavailable: true });
  const html = elements.get('result-body').innerHTML;
  assert.match(html, /无法读取当前页面/);
});

test('Popup：页面能读取但没有状态时提示暂时无法识别', async () => {
  const { elements } = await loadPopup({ state: null, reanalyzeState: null });
  const html = elements.get('result-body').innerHTML;
  assert.match(html, /当前页面暂时无法识别漫画作品/);
});

test('Popup：状态属于上一个页面时（主页→作品页）会重新识别，不会显示旧结果', async () => {
  const { elements, events } = await loadPopup({
    tabUrl: 'https://doujin.example/g/680213/',
    state: {
      status: 'no_result',
      page: { url: 'https://doujin.example/', host: 'doujin.example', title: 'doujin.example: sample gallery site' },
      query: { cleanedTitle: 'doujin.example: sample gallery site', source: 'title', confidence: 'high' },
      message: '暂未找到对应商品。',
      match: null,
      candidates: []
    },
    livePageInfo: {
      url: 'https://doujin.example/g/680213/',
      host: 'doujin.example',
      title: 'Sample Romaji Epsilon » doujin',
      scriptId: 'script-2',
      settled: true
    },
    reanalyzeState: {
      status: 'ok_high',
      page: { url: 'https://doujin.example/g/680213/', host: 'doujin.example', title: 'Sample Romaji Epsilon ... » doujin' },
      query: { cleanedTitle: 'サンプル作品イプシロン', source: 'h2(h2)', confidence: 'high' },
      match: {
        title: 'サンプル作品イプシロン',
        url: 'https://www.dlsite.com/books/work/=/product_id/BJ000000.html',
        storeLabel: 'DLsite',
        priceText: '1,100円',
        score: 100,
        scoreLabel: '很高'
      },
      candidates: []
    }
  });
  const html = elements.get('result-body').innerHTML;
  assert.ok(!html.includes('doujin.example: sample gallery site'), '不该显示上一个页面的标题');
  assert.match(html, /サンプル作品イプシロン/);
  assert.match(html, /查看正版/);
  assert.ok(events.includes('REQUEST_PAGE_INFO'), '应该先向页面确认当前内容');
  assert.ok(events.includes('REANALYZE'), '应该重新识别新页面');
});

test('Popup：站内跳转还没换好内容时，一直等到新页面就绪才显示结果', async () => {
  const { elements, events } = await loadPopup({
    tabUrl: 'https://doujin.example/g/680213/',
    // the previous analysis still holds the home page
    state: {
      status: 'no_result',
      page: { url: 'https://doujin.example/', host: 'doujin.example', title: 'doujin.example: sample gallery site' },
      query: { cleanedTitle: 'doujin.example: sample gallery site', source: 'title', confidence: 'high' },
      message: '暂未找到对应商品。',
      match: null,
      candidates: []
    },
    // the page is still switching: the first 3 requests answer "not ready yet"
    livePendingTimes: 3,
    livePageInfo: {
      url: 'https://doujin.example/g/680213/',
      host: 'doujin.example',
      title: 'Sample Romaji Epsilon ... » doujin',
      scriptId: 'script-2',
      settled: true
    },
    reanalyzeState: {
      status: 'ok_high',
      page: { url: 'https://doujin.example/g/680213/', host: 'doujin.example', title: 'Sample Romaji Epsilon ... » doujin' },
      query: { cleanedTitle: 'サンプル作品イプシロン', source: 'h2(h2)', confidence: 'high' },
      match: {
        title: 'サンプル作品イプシロン',
        url: 'https://www.dlsite.com/books/work/=/product_id/BJ000000.html',
        storeLabel: 'DLsite',
        priceText: '1,100円',
        score: 100,
        scoreLabel: '很高'
      },
      candidates: []
    }
  });
  const html = elements.get('result-body').innerHTML;
  assert.ok(!html.includes('doujin.example: sample gallery site'), '换页中间态不能显示上一页的标题');
  assert.match(html, /サンプル作品イプシロン/);
  assert.ok(events.filter((item) => item === 'REQUEST_PAGE_INFO').length >= 4, '应该重试到新内容就绪');
});

test('Popup：同一份文档的现成状态会直接复用，不重复搜索商店', async () => {
  const { elements, events } = await loadPopup({
    tabUrl: 'https://doujin.example/g/680213/',
    state: {
      status: 'ok_high',
      page: { url: 'https://doujin.example/g/680213/', host: 'doujin.example', title: 'Sample Romaji Epsilon ... » doujin' },
      query: { cleanedTitle: 'サンプル作品イプシロン', source: 'h2(h2)', confidence: 'high' },
      match: {
        title: 'サンプル作品イプシロン',
        url: 'https://www.dlsite.com/books/work/=/product_id/BJ000000.html',
        storeLabel: 'DLsite',
        priceText: '1,100円',
        score: 100,
        scoreLabel: '很高'
      },
      candidates: []
    }
  });
  const html = elements.get('result-body').innerHTML;
  assert.match(html, /查看正版/);
  assert.ok(!events.includes('REANALYZE'), '同一份文档的缓存状态不该重新查一次商店');
});

test('Popup：页面还在换（settled=false）时不会把中间态当成结果', async () => {
  const { elements, events } = await loadPopup({
    tabUrl: 'https://doujin.example/g/680213/',
    livePageInfo: { url: 'https://doujin.example/g/680213/', host: 'doujin.example', title: 'doujin.example: sample gallery site', scriptId: 'script-2', settled: false },
    livePendingTimes: 0,
    state: null,
    reanalyzeState: null
  });
  const html = elements.get('result-body').innerHTML;
  assert.ok(events.includes('REQUEST_PAGE_INFO'));
  assert.ok(!html.includes('doujin.example: sample gallery site'), '换页中间态不能当成识别结果');
  assert.match(html, /页面正在切换/);
});
