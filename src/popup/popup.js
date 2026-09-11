/**
 * Extension popup (requirements doc §13).
 * It only renders and forwards: the actual analysis happens in the service worker.
 */

import { MSG, STATUS } from '../shared/protocol.js';
import { CONFIG } from '../lib/config.js';

const els = {
  version: document.getElementById('version'),
  pageTitle: document.getElementById('page-title'),
  pageHost: document.getElementById('page-host'),
  resultBody: document.getElementById('result-body'),
  setEnabled: document.getElementById('set-enabled'),
  setAutoshow: document.getElementById('set-autoshow'),
  setMock: document.getElementById('set-mock'),
  setIgnoreFilter: document.getElementById('set-ignore-filter'),
  clearCache: document.getElementById('btn-clear-cache'),
  cacheInfo: document.getElementById('cache-info')
};

let activeTabId = null;
let currentState = null;
let currentSettings = null;
let currentTab = null;

/** Retry cadence while waiting for a new page (a client-side navigation has to swap its content first) */
const RETRY_MS = 350;
const MAX_WAIT_ATTEMPTS = Math.max(1, Math.round(CONFIG.extractor.popupWaitMs / RETRY_MS));
const MAX_UNAVAILABLE_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

async function notifyContent(payload) {
  if (activeTabId == null) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: MSG.STATE_UPDATED, payload });
  } catch {
    /* no content script on this page (e.g. a chrome:// page) */
  }
}

function priceMarkup(item) {
  const parts = [`<span class="store">${escapeHtml(item.storeLabel || 'DLsite')}</span>`];
  const priceText = item.isFree ? '免费' : (item.priceText || (item.price != null ? `${item.price} 円` : ''));
  if (priceText) parts.push(`<span class="price">${escapeHtml(priceText)}</span>`);
  if (item.approxCny) parts.push(`<span class="cny">约 ${escapeHtml(item.approxCny)} 元</span>`);
  if (item.discountLabel) parts.push(`<span class="sale">${escapeHtml(item.discountLabel)}</span>`);
  if (item.originalPriceText) parts.push(`<span class="strike">${escapeHtml(item.originalPriceText)}</span>`);
  return parts.join('');
}

function candidatesMarkup(candidates) {
  if (!candidates || candidates.length < 2) return '';
  const items = candidates.map((candidate, index) => {
    const price = candidate.isFree ? '免费' : (candidate.priceText || '');
    return `<li>
      <a class="cand-title" href="${escapeHtml(candidate.url)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(candidate.url)}">${index + 1}. ${escapeHtml(candidate.title)}</a>
      <span class="cand-meta">${escapeHtml(candidate.storeLabel || 'DLsite')}${price ? ` · ${escapeHtml(price)}` : ''} · 匹配度 ${escapeHtml(candidate.scoreLabel || '')}</span>
    </li>`;
  }).join('');
  return `<ol class="candidates">${items}</ol>`;
}

function sourceTag(state) {
  const source = state.query?.source;
  if (!source) return '';
  const confidence = state.query?.confidence === 'high' ? '清洗可信度高' : '清洗可信度一般';
  return `<span class="tag">来源：${escapeHtml(source)}</span><span class="tag">${escapeHtml(confidence)}</span>`;
}

/** Diagnostics: when nothing was recognised or found, show where it stopped */
function diagnosticsMarkup(state) {
  if (!state?.meta) return '';
  const parts = [];
  if (state.reason) parts.push(`原因：${state.reason}`);
  if (state.page?.settled === false) parts.push('页面仍在切换中');
  if (state.meta.signals?.length) parts.push(`识别信号：${state.meta.signals.join('、')}`);
  const searched = state.query?.searched?.length ? state.query.searched : state.query?.variants;
  if (searched?.length) parts.push(`搜索关键词：${searched.join(' / ')}`);
  if (state.meta.headings?.length) parts.push(`页面标题元素：${state.meta.headings.join(' | ')}`);
  if (state.meta.errors?.length) parts.push(`错误：${state.meta.errors.map((item) => item.reason || item.error).join('、')}`);
  if (!parts.length) return '';
  return `<p class="muted small">诊断：${escapeHtml(parts.join(' · '))}</p>`;
}

/** Per-store results (DLsite / FANZA / Melonbooks) */
function storesMarkup(state) {
  const stores = state.stores || [];
  if (!stores.length) return '';
  const rows = stores.map((store) => {
    const label = escapeHtml(store.storeLabel || store.storeId);
    const searchLink = store.searchUrl
      ? `<a class="cand-title" href="${escapeHtml(store.searchUrl)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(store.searchUrl)}">手动搜索</a>`
      : '';
    if (store.kind === 'age_check') {
      const confirmLink = store.ageCheckUrl
        ? `<a class="cand-title" href="${escapeHtml(store.ageCheckUrl)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(store.ageCheckUrl)}">去确认年龄</a>`
        : '';
      return `<li><span class="store">${label}</span><span class="cand-meta">需要年龄确认</span>${confirmLink}</li>`;
    }
    if (store.kind === 'error') {
      return `<li><span class="store">${label}</span><span class="cand-meta">查询失败</span>${searchLink}</li>`;
    }
    if (store.match) {
      const price = store.match.priceText || '';
      return `<li><span class="store">${label}</span>
        <a class="cand-title" href="${escapeHtml(store.match.url)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(store.match.url)}">${escapeHtml(store.match.title)}</a>
        <span class="cand-meta">${escapeHtml(price)} · 匹配度 ${escapeHtml(store.match.scoreLabel || '')}</span></li>`;
    }
    const note = store.note ? `<span class="cand-meta">${escapeHtml(store.note)}</span>` : '';
    return `<li><span class="store">${label}</span><span class="cand-meta">未找到</span>${searchLink}${note}</li>`;
  }).join('');
  return `<h2 class="label">正版商店</h2><ul class="candidates store-list">${rows}</ul>`;
}

function renderResult(state) {
  if (!state) {
    els.resultBody.innerHTML = `
      <p class="muted">当前页面暂时无法识别漫画作品。</p>
      <div class="actions">
        <button class="btn primary" data-action="reanalyze">重新识别</button>
      </div>`;
    return;
  }

  const status = state.status;

  if (status === STATUS.OK_HIGH || status === STATUS.OK_POSSIBLE) {
    const match = state.match;
    const heading = status === STATUS.OK_HIGH
      ? `找到 ${match.storeLabel || 'DLsite'} 商品`
      : `找到可能的 ${match.storeLabel || 'DLsite'} 商品`;
    els.resultBody.innerHTML = `
      <ul class="status-list">
        <li><span class="ok">✓</span><span>已识别作品</span></li>
        <li><span class="ok">✓</span><span>${escapeHtml(heading)}</span></li>
      </ul>
      <p class="work">《${escapeHtml(match.title)}》</p>
      <div class="meta">${priceMarkup(match)}</div>
      ${match.maker || match.author ? `<span class="maker">${escapeHtml(match.maker || '')}${match.maker && match.author ? ' / ' : ''}${escapeHtml(match.author || '')}</span>` : ''}
      ${sourceTag(state)}
      <p class="muted">匹配度：${escapeHtml(match.scoreLabel || '')}（${escapeHtml(match.score)} 分）</p>
      ${candidatesMarkup(state.candidates)}
      <div class="actions">
        <a class="btn primary" href="${escapeHtml(match.url)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(match.url)}">查看正版</a>
        <button class="btn ghost" data-action="show-card">在页面显示</button>
      </div>
      ${storesMarkup(state)}`;
    return;
  }

  if (status === STATUS.NO_RESULT) {
    els.resultBody.innerHTML = `
      <ul class="status-list">
        <li><span class="ok">✓</span><span>已识别作品：${escapeHtml(state.query?.cleanedTitle || '')}</span></li>
        <li><span class="warn">!</span><span>暂未找到对应商品</span></li>
      </ul>
      <p class="muted">${escapeHtml(state.message || '暂未找到明确对应的 DLsite 商品。')}</p>
      ${sourceTag(state)}
      ${diagnosticsMarkup(state)}
      <div class="actions">
        ${(state.searchUrls && state.searchUrls.length
        ? state.searchUrls
        : (state.searchUrl ? [{ storeLabel: 'DLsite', url: state.searchUrl }] : []))
        .map((item, index) => `<a class="btn ${index === 0 ? 'primary' : 'ghost'}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(item.url)}">${escapeHtml(item.storeLabel)}</a>`)
        .join('')}
        ${state.needsAgeCheck && state.ageCheckUrl ? `<a class="btn ghost" href="${escapeHtml(state.ageCheckUrl)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(state.ageCheckUrl)}">${escapeHtml(state.ageCheckStoreLabel || 'FANZA')} 年龄确认</a>` : ''}
        <button class="btn ghost" data-action="show-card">在页面显示</button>
      </div>
      ${storesMarkup(state)}`;
    return;
  }

  if (status === STATUS.ERROR) {
    els.resultBody.innerHTML = `
      <ul class="status-list">
        <li><span class="warn">!</span><span>${escapeHtml(state.message || 'DLsite 搜索暂时失败。')}</span></li>
      </ul>
      <div class="actions">
        <button class="btn primary" data-action="reanalyze">重试</button>
        ${state.searchUrl ? `<a class="btn ghost" href="${escapeHtml(state.searchUrl)}" target="_blank" rel="noopener noreferrer" data-open="${escapeHtml(state.searchUrl)}">在 DLsite 搜索</a>` : ''}
      </div>`;
    return;
  }

  const reason = state.reason === 'no-comic-signal' || state.reason === 'denylisted-host'
    ? '当前页面不像漫画作品页，未自动识别。'
    : (state.reason === 'page-settling'
      ? '页面正在切换，正在重新识别…'
      : (state.message || '未能识别作品名称。'));
  els.resultBody.innerHTML = `
    <p class="muted">${escapeHtml(reason)}</p>
    ${diagnosticsMarkup(state)}
    <div class="actions">
      <button class="btn primary" data-action="reanalyze">重新识别</button>
    </div>`;
}

function renderPage(state, tab) {
  els.pageTitle.textContent = state?.page?.title || tab?.title || '（无法读取页面标题）';
  const host = state?.page?.host || (tab?.url ? new URL(tab.url).hostname : '');
  els.pageHost.textContent = host || '';
}

/** Drop the hash and any trailing slash, so two URLs can be compared */
function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '');
  }
}

/**
 * Is the stored state left over from the previous page?
 * Analysing the new page takes a second or two after a click, and until then
 * the background still holds the old page's result, which would look like a
 * mis-detection if shown.
 */
function isStaleState(state, tab) {
  if (!state) return false;
  const stateUrl = state.page?.url;
  const tabUrl = tab?.url;
  if (!stateUrl || !tabUrl) return false;
  if (/^(chrome|about|edge|devtools):/i.test(tabUrl)) return false;
  return normalizeUrl(stateUrl) !== normalizeUrl(tabUrl);
}

function isUnsupportedTab(tab) {
  const url = String(tab?.url || '');
  if (!url) return false;
  return /^(chrome|about|edge|devtools|view-source|chrome-extension|chrome-untrusted):/i.test(url);
}

function renderLoading(message = '正在识别…') {
  els.resultBody.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
}

function renderUnreadable(tab) {
  els.resultBody.innerHTML = `
    <p class="muted">无法读取当前页面。</p>
    <div class="actions"><button class="btn primary" data-action="reanalyze">重新识别</button></div>`;
  renderPage(null, tab);
}

/** Ask the content script for the current page; during a navigation it waits for the new content before answering */
async function readLivePageInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.REQUEST_PAGE_INFO });
    if (!response) return { status: 'waiting' };
    if (!response.pageInfo) return { status: 'waiting', pending: Boolean(response.pending) };
    return { status: 'ok', pageInfo: response.pageInfo };
  } catch (error) {
    return { status: 'unavailable', error: String(error?.message || error) };
  }
}

/**
 * Wait for the page info of the document that is actually live in the tab.
 * When a link changes the URL first and the content afterwards, we must wait
 * for the content, otherwise we would read the previous page's title — that is
 * exactly where the "recognised the home-page title" bug came from.
 */
async function waitForLivePage() {
  let unavailable = 0;
  let unsettled = 0;
  let lastPending = false;
  for (let attempt = 0; attempt < MAX_WAIT_ATTEMPTS; attempt += 1) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = typeof tab?.id === 'number' ? tab.id : null;
    currentTab = tab || currentTab;
    if (activeTabId == null) return { pageInfo: null, tab: currentTab, reason: 'no-tab' };

    const result = await readLivePageInfo(activeTabId);
    if (result.status === 'ok') {
      const target = tab?.pendingUrl || tab?.url || '';
      const matches = !target || normalizeUrl(result.pageInfo.url) === normalizeUrl(target);
      if (matches && result.pageInfo.settled !== false) {
        return { pageInfo: result.pageInfo, tab };
      }
      if (matches && result.pageInfo.settled === false) {
        unsettled += 1;
        // We already know the content is not swapped yet; waiting longer adds little:
        // once it settles the content script re-analyses and broadcasts the state,
        // which refreshes the popup automatically.
        if (unsettled >= 2) return { pageInfo: null, tab, reason: 'page-settling' };
      }
      lastPending = true;
    } else if (result.status === 'unavailable') {
      unavailable += 1;
      if (unavailable >= MAX_UNAVAILABLE_ATTEMPTS) {
        return { pageInfo: null, tab: currentTab, reason: 'unreadable-page' };
      }
    } else {
      lastPending = Boolean(result.pending);
    }
    await sleep(RETRY_MS);
  }
  return { pageInfo: null, tab: currentTab, reason: lastPending ? 'page-settling' : 'timeout' };
}

async function loadSettings() {
  const response = await send({ type: MSG.GET_SETTINGS });
  currentSettings = response?.settings || null;
  if (response?.version) els.version.textContent = `DLsite · v${response.version}`;
  if (response?.cache) els.cacheInfo.textContent = `缓存 ${response.cache.entries} 条`;
  if (currentSettings) {
    els.setEnabled.checked = currentSettings.enabled !== false;
    els.setAutoshow.checked = currentSettings.autoShowCard !== false;
    els.setMock.checked = Boolean(currentSettings.mockMode);
    els.setIgnoreFilter.checked = Boolean(currentSettings.ignoreSiteFilter);
  }
}

async function loadState({ reanalyze = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = typeof tab?.id === 'number' ? tab.id : null;
  currentTab = tab || null;

  if (activeTabId == null || isUnsupportedTab(tab)) {
    currentState = null;
    renderPage(null, tab);
    renderUnreadable(tab);
    return;
  }

  renderLoading();

  const cachedResponse = await send({ type: MSG.GET_STATE, tabId: activeTabId });
  const cached = cachedResponse?.state || null;

  const live = await waitForLivePage();
  const pageInfo = live.pageInfo;

  if (!pageInfo) {
    if (cached && !isStaleState(cached, live.tab || tab)) {
      // No live page info (e.g. a PDF page), but the cached state is this exact page: use it
      currentState = cached;
      renderPage(cached, live.tab || tab);
      renderResult(cached);
      return;
    }
    if (live.reason === 'page-settling') {
      // Still navigating: show no result, the background refresh will fill this in
      currentState = null;
      renderPage(null, live.tab || tab);
      els.resultBody.innerHTML = `
        <p class="muted">页面正在切换，正在重新识别…</p>
        <div class="actions"><button class="btn primary" data-action="reanalyze">重新识别</button></div>`;
      return;
    }
    currentState = null;
    renderUnreadable(live.tab || tab);
    return;
  }

  const sameDocument = Boolean(cached?.page?.scriptId)
    && cached.page.scriptId === pageInfo.scriptId
    && normalizeUrl(cached.page.url) === normalizeUrl(pageInfo.url);

  if (!reanalyze && sameDocument) {
    currentState = cached;
    renderPage(cached, live.tab || tab);
    renderResult(cached);
    return;
  }

  const response = await send({ type: MSG.REANALYZE_TAB, tabId: activeTabId, pageInfo });
  if (response?.error) {
    if (response.error === 'page-settling') {
      renderLoading('页面正在切换，正在重新识别…');
      currentState = null;
      renderPage(null, live.tab || tab);
      return;
    }
    currentState = null;
    renderUnreadable(live.tab || tab);
    return;
  }

  currentState = response?.state || null;
  renderPage(currentState, live.tab || tab);
  renderResult(currentState);
}

document.addEventListener('click', async (event) => {
  const link = event.target instanceof Element ? event.target.closest('[data-open]') : null;
  if (link) {
    event.preventDefault();
    const url = link.getAttribute('data-open');
    if (url) chrome.tabs.create({ url });
    return;
  }

  const action = event.target instanceof Element ? event.target.closest('[data-action]')?.getAttribute('data-action') : null;
  if (!action) return;

  if (action === 'reanalyze') {
    els.resultBody.innerHTML = '<p class="muted">正在重新识别…</p>';
    await loadState({ reanalyze: true });
    if (currentState) await notifyContent({ state: currentState, force: true, settings: currentSettings });
  } else if (action === 'show-card') {
    await notifyContent({ state: currentState, force: true, settings: currentSettings });
    window.close();
  }
});

for (const [element, patch] of [
  [els.setEnabled, (checked) => ({ enabled: checked })],
  [els.setAutoshow, (checked) => ({ autoShowCard: checked })],
  [els.setMock, (checked) => ({ mockMode: checked })],
  [els.setIgnoreFilter, (checked) => ({ ignoreSiteFilter: checked })]
]) {
  element.addEventListener('change', async () => {
    const response = await send({ type: MSG.SET_SETTINGS, patch: patch(element.checked) });
    currentSettings = response?.settings || currentSettings;
    await notifyContent({ settings: currentSettings, force: false });
    await loadState();
  });
}

els.clearCache.addEventListener('click', async () => {
  const response = await send({ type: MSG.CLEAR_CACHE });
  if (response?.cache) els.cacheInfo.textContent = `缓存 ${response.cache.entries} 条`;
  els.clearCache.textContent = '已清除';
  setTimeout(() => { els.clearCache.textContent = '清除搜索缓存'; }, 1200);
});

/**
 * The background broadcasts a state whenever an analysis finishes. If the popup
 * is open while the user has just moved to a new page (it may be showing
 * "analysing…" or the previous result), this refresh turns it into the new
 * page's result without the user pressing "re-analyse".
 */
if (chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message) => {
    const payload = message?.payload;
    if (message?.type !== MSG.STATE_UPDATED || !payload?.state) return;
    if (payload.tabId !== activeTabId) return;
    const state = payload.state;
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) return;
      const tabUrl = tab.pendingUrl || tab.url || '';
      if (tabUrl && normalizeUrl(tabUrl) !== normalizeUrl(state.page?.url || '')) return;
      currentState = state;
      renderPage(state, tab);
      renderResult(state);
    }).catch(() => {});
  });
}

(async function main() {
  await loadSettings();
  await loadState();
})();
