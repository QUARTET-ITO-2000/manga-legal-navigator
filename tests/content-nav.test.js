/**
 * Tests for the content script's navigation gate.
 *
 * Real scenario (reproduced in Chrome on 2026-09-11):
 * on these gallery sites, clicking a work from the home page is a client-side
 * navigation — the URL becomes /g/xxxxx/ first and the content follows. Reading
 * the page during that window yields the previous page's home-page tagline,
 * which the popup then searches for and reports as "not found".
 *
 * content.js runs against a minimal DOM / chrome stub to verify:
 * 1. the in-between state is never analysed;
 * 2. once the new page is in place, it is analysed again;
 * 3. a page-info request from the popup waits for the new content.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HOME = 'https://doujin.example/';
const GALLERY = 'https://doujin.example/g/680213/';
const HOME_TITLE = 'doujin.example: sample gallery site';
const GALLERY_TITLE = 'Sample Romaji Epsilon » doujin';

function createEnv() {
  const page = { href: HOME, title: HOME_TITLE, body: 'home-list' };
  const analyses = [];
  const renders = [];
  const observers = [];
  const listeners = [];
  let cleared = 0;
  let mismatch = false;

  const parse = (value) => new URL(value, page.href);
  const location = {
    get href() { return page.href; },
    get origin() { return parse(page.href).origin; },
    get pathname() { return parse(page.href).pathname; },
    get search() { return parse(page.href).search; },
    get hostname() { return parse(page.href).hostname; }
  };
  const history = {
    pushState(_state, _title, url) { if (url) page.href = parse(url).toString(); },
    replaceState(_state, _title, url) { if (url) page.href = parse(url).toString(); }
  };

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
    /** Simulate "the page content was replaced" */
    fire() { this.callback([{ target: { nodeType: 3, parentNode: null } }]); }
  }

  const extractor = {
    collect: () => ({
      url: page.href,
      host: parse(page.href).hostname,
      title: page.title,
      h1: [page.title],
      infoText: page.body,
      imageCount: 120,
      textSample: page.body,
      scriptId: 'script-1',
      capturedAt: Date.now()
    }),
    signature: () => `${page.title}::${page.body}`,
    contentUrlMismatch: () => mismatch
  };

  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === 'MN_GET_SETTINGS') return { settings: { enabled: true, autoShowCard: true } };
        if (message.type === 'MN_ANALYZE_PAGE') {
          analyses.push(message.payload);
          return {
            state: {
              status: 'ok_high',
              page: message.payload,
              query: { cleanedTitle: message.payload.title },
              match: { title: message.payload.title, url: 'https://www.dlsite.com/x', score: 100, scoreLabel: '很高', storeLabel: 'DLsite' },
              candidates: []
            }
          };
        }
        return {};
      },
      onMessage: { addListener: (listener) => listeners.push(listener) }
    }
  };

  const windowStub = { addEventListener: () => {}, removeEventListener: () => {} };
  windowStub.top = windowStub;

  const documentStub = { documentElement: {}, body: {}, title: HOME_TITLE, images: { length: 120 } };

  const context = vm.createContext({
    chrome,
    window: windowStub,
    document: documentStub,
    location,
    history,
    URL,
    Date,
    Math,
    Promise,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Set,
    Map,
    console,
    MutationObserver: FakeMutationObserver,
    setTimeout: (fn, ms, ...rest) => {
      const timer = setTimeout(fn, ms, ...rest);
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    setInterval: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearInterval,
    MangaNav: {
      extractor,
      ui: { render: (state) => renders.push(state), clear: () => { cleared += 1; } }
    }
  });

  const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);

  return {
    page,
    analyses,
    renders,
    listeners,
    observers,
    clearedCount: () => cleared,
    setMismatch: (value) => { mismatch = value; },
    /** Simulate the content being swapped for a new work (the DOM change fires the MutationObserver) */
    swapContent({ title, body }) {
      page.title = title;
      page.body = body;
      documentStub.title = title;
      for (const observer of observers) observer.fire();
    },
    /** Simulate a client-side navigation: the URL changes first, the content does not */
    navigate(url) {
      history.pushState({}, '', url);
    },
    askPageInfo() {
      return new Promise((resolve) => {
        const listener = listeners[0];
        const handled = listener({ type: 'MN_REQUEST_PAGE_INFO' }, {}, resolve);
        assert.equal(handled, true, '请求页面信息应该异步响应');
      });
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 4000, stepMs = 25 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return false;
}

test('初始加载：拿到当前页面的信息并识别一次', async () => {
  const env = createEnv();
  assert.ok(await waitFor(() => env.analyses.length === 1), '应该识别一次');
  assert.equal(env.analyses[0].url, HOME);
  assert.equal(env.analyses[0].settled, true);
  assert.equal(env.analyses[0].title, HOME_TITLE);
});

test('站内跳转：不会用「新地址 + 旧内容」的中间态去识别', async () => {
  const env = createEnv();
  assert.ok(await waitFor(() => env.analyses.length === 1), '初始识别');

  env.navigate(GALLERY);   // the URL becomes the work page first
  await sleep(150);        // the content is still the home page
  assert.equal(env.analyses.length, 1, '中间态不应该触发识别');

  env.swapContent({ title: GALLERY_TITLE, body: 'gallery-detail' });
  assert.ok(await waitFor(() => env.analyses.length >= 2), '内容换好后应该重新识别');

  const stale = env.analyses.filter((item) => item.url === GALLERY && item.title === HOME_TITLE);
  assert.equal(stale.length, 0, '绝不能把主页标题当成作品页的标题');
  const latest = env.analyses.at(-1);
  assert.equal(latest.url, GALLERY);
  assert.equal(latest.title, GALLERY_TITLE);
  assert.equal(latest.settled, true);
});

test('站内跳转：会先把旧页面的卡片撤掉', async () => {
  const env = createEnv();
  assert.ok(await waitFor(() => env.renders.length === 1), '主页先有一次识别');
  const before = env.clearedCount();
  env.navigate(GALLERY);
  assert.ok(await waitFor(() => env.clearedCount() > before), '跳转开始就应该清掉旧卡片');
});

test('Popup 询问页面信息：换页中间态要等到新内容就绪再回答', async () => {
  const env = createEnv();
  assert.ok(await waitFor(() => env.analyses.length === 1));

  env.navigate(GALLERY);
  let answered = null;
  const pending = env.askPageInfo().then((response) => { answered = response; });
  await sleep(150);
  assert.equal(answered, null, '内容还没换好时不能急着回答');

  env.swapContent({ title: GALLERY_TITLE, body: 'gallery-detail' });
  await Promise.race([pending, sleep(4000)]);
  assert.ok(answered, '换好内容后应该回答');
  assert.equal(answered.pageInfo.url, GALLERY);
  assert.equal(answered.pageInfo.title, GALLERY_TITLE);
  assert.equal(answered.pageInfo.settled, true);
});

test('内容换好之后（contentUrlMismatch 恢复）页面信息标记为已就绪', async () => {
  const env = createEnv();
  assert.ok(await waitFor(() => env.analyses.length === 1));

  env.setMismatch(true);
  const pending = env.askPageInfo();
  await sleep(120);
  env.swapContent({ title: GALLERY_TITLE, body: 'gallery-detail' });
  env.setMismatch(false);
  const response = await pending;
  assert.equal(response.pageInfo.settled, true);
  assert.equal(response.pending, false);
});

test('页面声明地址不一致时，页面信息会被标记成「还没就绪」', async () => {
  const env = createEnv();
  assert.ok(await waitFor(() => env.analyses.length === 1));

  env.setMismatch(true);
  const pending = env.askPageInfo();
  await sleep(120);
  assert.ok(env.analyses.length >= 1);
  // the content changed, but the URL the page declares is still another page -> not ready
  env.swapContent({ title: '某个中间态', body: 'mid-state' });
  const response = await pending;
  assert.equal(response.pageInfo.settled, false, '声明地址不一致时必须标记为未就绪');
  assert.equal(response.pageInfo.url, HOME, '地址没换，说明拿到的还是当前文档');
});
