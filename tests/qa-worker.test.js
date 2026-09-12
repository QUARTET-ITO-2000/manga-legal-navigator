/**
 * Service-worker side of the QA capture (requirements doc §5 / §6 / §13 / §32 / §34).
 *
 * The worker is loaded against a small chrome stub and the real store snapshots,
 * so the whole path is exercised: analysis → capture → dashboard state →
 * verdict → test case → export → clear.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const store = new Map();
const listeners = {};
let fetchCalls = 0;

function createChromeStub() {
  return {
    runtime: {
      onMessage: { addListener: (handler) => { listeners.message = handler; } },
      onInstalled: { addListener: () => {} },
      // The fixtures are read relative to the repository in the fetch stub below
      getURL: (path) => path,
      sendMessage: async () => {}
    },
    storage: {
      local: {
        get: async (key) => (key === null
          ? Object.fromEntries(store)
          : (store.has(key) ? { [key]: store.get(key) } : {})),
        set: async (value) => { for (const [key, item] of Object.entries(value)) store.set(key, item); },
        remove: async (key) => { (Array.isArray(key) ? key : [key]).forEach((item) => store.delete(item)); }
      }
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      get: async (id) => ({ id, url: currentTabUrl }),
      sendMessage: async () => ({}),
      create: async () => ({})
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
  };
}

let currentTabUrl = '';

/** Serve the committed store snapshots instead of the network (offscreen, deterministic) */
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  const value = String(url);
  const file = join(ROOT, value);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return { ok: true, status: 200, text: async () => text, url: value };
};

globalThis.chrome = createChromeStub();

const TAB_ID = 1;
let messageId = 0;

function ask(type, payload = {}) {
  messageId += 1;
  return new Promise((resolve, reject) => {
    listeners.message({ type, messageId, ...payload }, { tab: { id: TAB_ID } }, (response) => {
      if (response?.error) reject(new Error(`${type}: ${response.error}`));
      else resolve(response);
    });
  });
}

/** A popup is not a tab: `sender` has no `tab`, so the message must carry the tab id */
function askAsPopup(type, payload = {}) {
  messageId += 1;
  return new Promise((resolve, reject) => {
    listeners.message({ type, messageId, ...payload }, {}, (response) => {
      if (response?.error) reject(new Error(`${type}: ${response.error}`));
      else resolve(response);
    });
  });
}

await import('../src/background/service-worker.js');

const galleryPage = {
  url: 'https://doujin.example/g/000123/',
  host: 'doujin.example',
  origin: 'https://doujin.example',
  title: '【サンプル作品アルファ】第1話 - 免费漫画 - 示例漫画网',
  h1: ['サンプル作品アルファ 第1話'],
  headings: [{ level: 1, tag: 'h1', text: 'サンプル作品アルファ 第1話' }],
  ogTitle: 'サンプル作品アルファ',
  imageCount: 46,
  textSample: '第1話 サンプル作品アルファ',
  infoText: 'Parodies: original Tags: sample Languages: japanese Categories: doujinshi Pages: 46',
  analysisCount: 1,
  settled: true
};

const blogPage = {
  url: 'https://blog.example/posts/1',
  host: 'blog.example',
  origin: 'https://blog.example',
  title: '示例博客：今天写点东西',
  h1: ['今天写点东西'],
  imageCount: 1,
  textSample: '今天写点东西。',
  analysisCount: 1,
  settled: true
};

async function analyze(pageInfo) {
  currentTabUrl = pageInfo.url;
  const response = await ask('MN_ANALYZE_PAGE', { payload: pageInfo });
  return response.state;
}

test('QA 关闭时不写任何记录（普通用户不受影响，§34）', async () => {
  await ask('MN_SET_SETTINGS', { patch: { qaMode: false, mockMode: true } });
  fetchCalls = 0;
  await analyze(galleryPage);
  const requestsWithoutQa = fetchCalls;
  const status = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa;
  assert.equal(status.enabled, false);
  assert.equal(status.summary.total, 0);
  assert.equal(store.has('mn:qa'), false, '关闭时连存储键都不该被创建');

  await ask('MN_SET_SETTINGS', { patch: { qaMode: true } });
  fetchCalls = 0;
  await analyze(galleryPage);
  assert.ok(fetchCalls <= requestsWithoutQa, 'QA 记录不会带来额外请求（缓存命中时只会更少）');
});

test('QA 开启后：作品页被记录，含结构指纹、请求数与商店健康度（§6 / §23 / §30）', async () => {
  let status = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa;
  assert.equal(status.enabled, true);
  assert.equal(status.summary.total, 1);
  let capture = status.current;
  assert.equal(capture.id, 'QA-0001');
  assert.equal(capture.fingerprint, 'G-H1-OG-NJ-IMG40-INFO-STATIC');
  assert.equal(capture.pageType, 'gallery');
  assert.equal(capture.match.grade, 'found');
  assert.equal(capture.stores.health.dlsite, 'healthy');
  assert.equal(capture.results.pageRecognition, 'PASS');
  assert.equal(capture.results.requestCount, 'PASS');
  assert.equal(capture.urlPattern, '/g/:id/');
  // The page was already analysed before QA mode was switched on, so this
  // capture comes from a warm cache (§24): no new request at all.
  assert.equal(capture.requests.cacheHit, true);
  assert.equal(capture.requests.total, 0);
  assert.equal(capture.stores.fromCache.dlsite, true);

  // With the cache cleared, the same page costs real requests again (§23)
  await ask('MN_CLEAR_CACHE');
  await analyze(galleryPage);
  status = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa;
  capture = status.current;
  assert.ok(capture.requests.total >= 1, `expected store requests, got ${capture.requests.total}`);
  assert.equal(capture.requests.cacheHit, false);
  assert.equal(capture.requests.byStore.dlsite >= 1, true);
});

test('非作品页也会被记录：识别失败 + 0 请求（§21 / §23）', async () => {
  await analyze(blogPage);
  const status = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa;
  assert.equal(status.summary.total, 2);
  assert.equal(status.current.results.pageRecognition, 'FAIL');
  assert.equal(status.current.results.requestCount, 'PASS');
  assert.equal(status.current.requests.total, 0);
});

test('判定与测试案例：PASS / 误判 / RW-001（§13 / §14 / §15.5）', async () => {
  // Back to the work page: analysing it again updates the same capture (§24)
  await analyze(galleryPage);
  const first = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa.current;
  assert.equal(first.pageType, 'gallery');
  assert.ok(first.requests.observations.length >= 2, '同一页面的重复分析会并入同一条记录');

  await ask('MN_QA_UPDATE', { pageKey: first.pageKey, verdict: 'PASS' });
  let status = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa;
  assert.equal(status.current.verdict, 'PASS');
  assert.equal(status.summary.total, 2, '重复分析不会增加捕获数');

  const created = await ask('MN_QA_CREATE_CASE', { pageKey: first.pageKey });
  assert.equal(created.case.id, 'RW-001');
  assert.equal(created.case.captureId, first.id);
  status = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa;
  assert.equal(status.currentIsCase, true);
  assert.equal(status.summary.cases, 1);

  await ask('MN_QA_UPDATE', { pageKey: first.pageKey, falsePositive: true });
  status = (await ask('MN_QA_GET', { tabId: TAB_ID })).qa;
  assert.equal(status.current.verdict, 'FAIL');
  assert.equal(status.current.match.falsePositive, true);
  assert.equal(status.summary.falsePositive, 1);
});

test('导出：摘要脱敏且很小，案例包在勾选后才带真实 URL（§8 / §9）', async () => {
  const summary = (await ask('MN_QA_EXPORT', { kind: 'summary' })).export;
  assert.match(summary.fileName, /^qa-summary-\d{4}-\d{2}-\d{2}-\d{3}\.json$/);
  const parsed = JSON.parse(summary.json);
  assert.equal(parsed.containsRealData, false);
  assert.equal(parsed.summary.total, 2);
  assert.equal(summary.json.includes('サンプル'), false);
  assert.ok(summary.bytes < 8000, `summary should stay small, got ${summary.bytes}`);

  const failures = (await ask('MN_QA_EXPORT', { kind: 'failures' })).export;
  assert.match(failures.fileName, /^qa-failures-/);
  assert.equal(failures.json.includes('サンプル'), false, '失败包默认也是脱敏的');
  assert.equal(JSON.parse(failures.json).failures.length, 1);

  const anonymised = (await ask('MN_QA_EXPORT', { kind: 'tests' })).export;
  assert.equal(JSON.parse(anonymised.json).containsRealData, false);

  const local = (await ask('MN_QA_EXPORT', { kind: 'tests', includeRealTitles: true })).export;
  const pack = JSON.parse(local.json);
  assert.equal(pack.containsRealData, true);
  assert.equal(pack.sites['RW-001'], 'https://doujin.example/g/000123/');
  assert.equal(pack.captures[0].pageInfoIncluded, true);
});

test('Clear QA Data：一次删除所有捕获与案例（§33）', async () => {
  const status = (await ask('MN_QA_CLEAR')).qa;
  assert.equal(status.summary.total, 0);
  assert.equal(status.summary.cases, 0);
  assert.equal(status.current, null);
  assert.equal(store.has('mn:qa'), false);
});

test('Service Worker 重启后，「当前页」靠标签页 URL 找回来（不是内存缓存）', async () => {
  // The in-memory tabStates map only knows about tabs that were analysed by
  // *this* worker instance. Tab 42 never analysed anything here, so the status
  // has to fall back to chrome.tabs.get(42).url — otherwise the panel would
  // claim "no record for this page" and disable the verdict buttons.
  await ask('MN_SET_SETTINGS', { patch: { qaMode: true, mockMode: true } });
  currentTabUrl = blogPage.url;
  await ask('MN_ANALYZE_PAGE', { payload: blogPage, tabId: undefined });
  const status = (await ask('MN_QA_GET', { tabId: 42 })).qa;
  assert.equal(status.summary.total, 1);
  assert.equal(status.current?.pageKey, 'https://blog.example/posts/1');
  await ask('MN_QA_CLEAR');
});

test('Popup（sender 没有 tab）发来的更新/建案例也能定位当前页', async () => {
  await ask('MN_SET_SETTINGS', { patch: { qaMode: true, mockMode: true } });
  currentTabUrl = galleryPage.url;
  await ask('MN_ANALYZE_PAGE', { payload: galleryPage });
  const before = (await askAsPopup('MN_QA_GET', { tabId: TAB_ID })).qa;
  const pageKey = before.current.pageKey;

  const updated = await askAsPopup('MN_QA_UPDATE', { tabId: TAB_ID, pageKey, verdict: 'EXPECTED_LIMITATION' });
  assert.equal(updated.qa.current?.pageKey, pageKey, '判定后仍然认得当前页');
  assert.equal(updated.qa.summary.expectedLimitation, 1);

  const created = await askAsPopup('MN_QA_CREATE_CASE', { tabId: TAB_ID, pageKey });
  assert.ok(created.case.id.startsWith('RW-'));
  assert.equal(created.qa.currentIsCase, true);

  const cleared = await askAsPopup('MN_QA_CLEAR', { tabId: TAB_ID });
  assert.equal(cleared.qa.summary.total, 0);
});
