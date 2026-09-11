/**
 * Smoke tests for the floating card template: run ui.js against a minimal DOM
 * stub and check that each of the four states renders the expected HTML, so a
 * broken template cannot silently produce a blank card at runtime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function createFakeElement(tag = 'div') {
  const element = {
    tagName: tag.toUpperCase(),
    id: '',
    style: {},
    dataset: {},
    isConnected: false,
    innerHTML: '',
    listeners: [],
    attachShadow() {
      const wrap = createFakeElement('div');
      this.shadowRoot = {
        innerHTML: '',
        querySelector: () => wrap,
        __wrap: wrap
      };
      return this.shadowRoot;
    },
    addEventListener(type, handler) {
      element.listeners.push([type, handler]);
    },
    appendChild(child) {
      child.isConnected = true;
      child.parentNode = element;
      element.children = element.children || [];
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      element.children = (element.children || []).filter((item) => item !== child);
      child.parentNode = null;
      child.isConnected = false;
      return child;
    }
  };
  return element;
}

function loadUi() {
  const document = {
    body: createFakeElement('body'),
    documentElement: createFakeElement('html'),
    getElementById: () => null,
    createElement: (tag) => createFakeElement(tag)
  };
  const context = vm.createContext({ document, window: { top: {}, document }, console, Element: class Element {} });
  const source = readFileSync(new URL('../src/content/ui.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return { ui: context.MangaNav.ui, document };
}

/** The most recently mounted card host and its HTML */
function readCard(document) {
  const host = (document.body.children || []).at(-1);
  assert.ok(host, '浮窗宿主应该已经被挂载');
  return { host, html: host.shadowRoot.__wrap.innerHTML };
}

const basePage = { url: 'https://manga.test/a/1', host: 'manga.test', title: '测试页面' };

test('高可信匹配：卡片包含商品名、价格、DLsite 与商品链接', () => {
  const { ui, document } = loadUi();
  ui.render({
    status: 'ok_high',
    page: basePage,
    match: {
      title: 'サンプル作品アルファ',
      url: 'https://www.dlsite.com/maniax/work/=/product_id/RJ00000000.html',
      storeLabel: 'DLsite',
      priceText: '1,980円',
      approxCny: 87,
      maker: 'サークル名',
      score: 100,
      scoreLabel: '很高',
      isFree: false
    },
    candidates: [{ title: 'サンプル作品アルファ', url: 'https://x', score: 100, scoreLabel: '很高', storeLabel: 'DLsite', priceText: '1,980円' }],
    query: { cleanedTitle: 'サンプル作品アルファ' },
    searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/'
  });
  const { html } = readCard(document);
  assert.match(html, /找到正版/);
  assert.match(html, /サンプル作品アルファ/);
  assert.match(html, /1,980円/);
  assert.match(html, /约 87 元/);
  assert.match(html, /product_id\/RJ00000000\.html/);
  assert.match(html, /查看正版/);
});

test('可能的匹配：显示匹配度与候选列表', () => {
  const { ui, document } = loadUi();
  ui.render({
    status: 'ok_possible',
    page: basePage,
    match: { title: 'サンプル作品アルファ 番外編', url: 'https://x', storeLabel: 'DLsite', priceText: '880円', score: 70, scoreLabel: '一般', isFree: false },
    candidates: [
      { title: 'サンプル作品アルファ 番外編', url: 'https://a', storeLabel: 'DLsite', priceText: '880円', score: 70, scoreLabel: '一般' },
      { title: 'サンプル作品アルファ 完全版', url: 'https://b', storeLabel: 'DLsite', priceText: '1,100円', score: 66, scoreLabel: '较低' }
    ],
    query: { cleanedTitle: 'サンプル作品アルファ 番外編' },
    searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/'
  });
  const { html } = readCard(document);
  assert.match(html, /可能的正版/);
  assert.match(html, /匹配度：一般/);
  assert.match(html, /2\. サンプル作品アルファ 完全版/);
});

test('没有找到：显示兜底文案与各商店搜索入口，不显示任何商品', () => {
  const { ui, document } = loadUi();
  ui.render({
    status: 'no_result',
    page: basePage,
    match: null,
    candidates: [],
    message: '暂未找到对应商品。',
    query: { cleanedTitle: '完全に存在しない作品' },
    searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/',
    searchUrls: [
      { storeLabel: 'DLsite', url: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/' },
      { storeLabel: 'FANZA', url: 'https://www.dmm.co.jp/search/=/searchstr/x/' },
      { storeLabel: 'Melonbooks', url: 'https://www.melonbooks.co.jp/search/search.php?name=x' }
    ]
  });
  const { html } = readCard(document);
  assert.match(html, /正版购买/);
  assert.match(html, /暂未找到对应商品/);
  assert.match(html, />DLsite</);
  assert.match(html, />FANZA</);
  assert.match(html, />Melonbooks</);
  assert.ok(!html.includes('查看正版'));
});

test('搜索失败：显示错误文案并保留搜索兜底入口', () => {
  const { ui, document } = loadUi();
  ui.render({
    status: 'error',
    page: basePage,
    message: 'DLsite 搜索暂时失败。',
    candidates: [],
    query: { cleanedTitle: 'サンプル作品アルファ' },
    searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/'
  });
  const { html } = readCard(document);
  assert.match(html, /DLsite 搜索暂时失败/);
  assert.match(html, /DLsite/);
});

test('未识别作品：默认不显示浮窗（测试 F）', () => {
  const { ui, document } = loadUi();
  ui.render({ status: 'unrecognized', page: basePage, message: '当前页面不像漫画作品页。', candidates: [] });
  // After a client-side navigation, merely hiding the card would leave the previous work's card on the new page, so it must be removed
  assert.equal((document.body.children || []).length, 0, '未识别时不应该留下任何浮窗');
});

test('换页后重新识别：旧的卡片会被移除，新结果再画一次', () => {
  const { ui, document } = loadUi();
  ui.render({
    status: 'ok_high',
    page: { url: 'https://doujin.example/g/1/', host: 'doujin.example', title: '作品 A' },
    match: { title: '作品 A', url: 'https://x', storeLabel: 'DLsite', priceText: '770円', score: 100, scoreLabel: '很高' },
    candidates: []
  });
  ui.clear();
  assert.equal((document.body.children || []).length, 0, '换页时旧卡片应被移除');
  ui.render({
    status: 'ok_high',
    page: { url: 'https://doujin.example/g/2/', host: 'doujin.example', title: '作品 B' },
    match: { title: '作品 B', url: 'https://y', storeLabel: 'DLsite', priceText: '880円', score: 100, scoreLabel: '很高' },
    candidates: []
  });
  const { html } = readCard(document);
  assert.match(html, /作品 B/);
  assert.equal(html.includes('作品 A'), false);
});

test('未识别作品 + 强制显示：展示原因（Popup 的「在页面显示」）', () => {
  const { ui, document } = loadUi();
  ui.render(
    { status: 'unrecognized', page: basePage, message: '当前页面不像漫画作品页。', candidates: [] },
    { force: true }
  );
  const { html } = readCard(document);
  assert.match(html, /当前页面不像漫画作品页/);
});

test('价格为 0 时显示「免费」', () => {
  const { ui, document } = loadUi();
  ui.render({
    status: 'ok_high',
    page: basePage,
    match: { title: '无料作品', url: 'https://x', storeLabel: 'DLsite', priceText: '', price: 0, isFree: true, score: 100, scoreLabel: '很高' },
    candidates: [],
    query: { cleanedTitle: '无料作品' },
    searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/'
  });
  const { html } = readCard(document);
  assert.match(html, /免费/);
});

test('HTML 会被转义，避免商品名里的尖括号破坏 DOM', () => {
  const { ui, document } = loadUi();
  ui.render({
    status: 'ok_high',
    page: basePage,
    match: { title: '<img src=x onerror=alert(1)>', url: 'https://x', storeLabel: 'DLsite', priceText: '100円', score: 100, scoreLabel: '很高' },
    candidates: [],
    query: { cleanedTitle: '<script>' },
    searchUrl: 'https://www.dlsite.com/books/fsr/=/language/jp/keyword/x/'
  });
  const { html } = readCard(document);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});
