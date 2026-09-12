/**
 * MV3 service worker: the single outbound request gateway and the state hub.
 *
 * Why searching happens here: content scripts are bound by the page's CORS
 * rules and cannot read the store pages, while the service worker has
 * host_permissions and can fetch them cross-origin (public pages only).
 */

import { MSG, STATUS } from '../shared/protocol.js';
import { CONFIG, EXTENSION_VERSION } from '../lib/config.js';
import { analyzePage } from '../lib/pipeline.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { clearSearchCache, getCacheStats, getCachedSearch, setCachedSearch } from '../lib/cache.js';
import { buildCapture, createCaseRecord, findCapture, setFalsePositive, setNote, setVerdict, summarize } from '../qa/record.js';
import {
  addCase,
  clearQa,
  clearQaError,
  nextCaseNumber,
  readQa,
  readQaError,
  recordCapture,
  recordQaError,
  takeExportLabel,
  updateCapture
} from '../qa/storage.js';
import { buildCasePack, buildFailureReport, buildSummaryReport, exportFileName } from '../qa/export.js';
import { pageKeyOf } from '../qa/fingerprint.js';

/** tabId -> most recent analysis result */
const tabStates = new Map();
/** tabId -> { url, promise }: while an analysis for the same tab and URL is running, later requests reuse it */
const inFlight = new Map();
let lastFetchAt = 0;

/** Which store a request belongs to, for the QA request budget (§23) */
const STORE_HOSTS = [
  ['dlsite.com', 'dlsite'],
  ['dmm.co.jp', 'fanza'],
  ['melonbooks.co.jp', 'melonbooks'],
  ['pixiv.net', 'pixiv'],
  ['fantia.jp', 'fantia']
];

function storeIdOfUrl(value) {
  let host = '';
  try {
    host = new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  for (const [suffix, id] of STORE_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return id;
  }
  return 'other';
}

const MOCK_FIXTURES = {
  dlsite: 'src/stores/fixtures/dlsite-search-sample.html',
  dlsiteOther: 'src/stores/fixtures/dlsite-not-found-sample.html',
  fanza: 'src/stores/fixtures/fanza-search-sample.html',
  melonbooks: 'src/stores/fixtures/melonbooks-search-sample.html',
  pixiv: 'src/stores/fixtures/pixiv-search-sample.json',
  fantia: 'src/stores/fixtures/fantia-search-sample.html'
};

async function politeFetchText(url, { timeoutMs = CONFIG.search.timeoutMs, credentials = 'omit' } = {}) {
  const wait = Math.max(0, CONFIG.search.minIntervalMs - (Date.now() - lastFetchAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastFetchAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Plain GET only, without cookies by default; only FANZA passes credentials, to reuse its age-check state
    const response = await fetch(url, {
      method: 'GET',
      credentials,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.8'
      }
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, url: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function mockFetchText(url) {
  let path = MOCK_FIXTURES.dlsite;
  if (/dmm\.co\.jp/.test(url)) path = MOCK_FIXTURES.fanza;
  else if (/melonbooks\.co\.jp/.test(url)) path = MOCK_FIXTURES.melonbooks;
  else if (/pixiv\.net/.test(url)) path = MOCK_FIXTURES.pixiv;
  else if (/fantia\.jp/.test(url)) path = MOCK_FIXTURES.fantia;
  else if (/\/girls\/fsr\//.test(url)) path = MOCK_FIXTURES.dlsiteOther;
  const response = await fetch(chrome.runtime.getURL(path));
  const text = await response.text();
  return { ok: true, status: 200, text, url, mock: true };
}

/**
 * Analysis dependencies. When a request counter is passed in, every store
 * request is counted (per store) so the QA capture can record the request
 * budget (§23 / §24). The counter is a pure observation: it never changes what
 * is fetched.
 */
function createDeps(settings, stats = null) {
  const baseFetch = settings.mockMode ? mockFetchText : politeFetchText;
  const fetchText = stats
    ? async (url, options) => {
        const storeId = storeIdOfUrl(url);
        stats.total += 1;
        stats.byStore[storeId] = (stats.byStore[storeId] || 0) + 1;
        return baseFetch(url, options);
      }
    : baseFetch;
  return {
    fetchText,
    cache: { get: getCachedSearch, set: setCachedSearch },
    adapterId: settings.storeId || 'dlsite'
  };
}

/**
 * QA Capture (requirements doc §5 / §6): store the structured summary of the
 * page that was just analysed. Nothing is written when QA mode is off (§34),
 * and a QA problem must never break the normal flow, so failures are swallowed.
 */
async function captureForQa({ pageInfo, state, stats }) {
  try {
    if (!pageInfo || pageInfo.settled === false) return null;
    const qa = await readQa();
    const fresh = buildCapture({
      pageInfo,
      state,
      requestStats: stats,
      known: qa.captures,
      capturedAt: Date.now()
    });
    const { capture } = await recordCapture(fresh);
    await clearQaError();
    return capture;
  } catch (error) {
    // QA must not break the normal flow, but a QA failure has to be visible
    // (§28): the popup shows the last error instead of a stuck counter.
    await recordQaError(error, {
      stage: 'capture',
      origin: pageInfo?.origin || pageInfo?.host || '',
      url: pageInfo?.url || '',
      status: state?.status || '',
      imageCount: Number(pageInfo?.imageCount) || 0
    });
    console.warn('[manga-nav] QA capture skipped:', error);
    return null;
  }
}

async function updateBadge(tabId, state) {
  if (typeof tabId !== 'number') return;
  try {
    if (state?.status === STATUS.OK_HIGH) {
      await chrome.action.setBadgeText({ tabId, text: '✓' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1f8a4c' });
    } else if (state?.status === STATUS.OK_POSSIBLE) {
      await chrome.action.setBadgeText({ tabId, text: '?' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b7791f' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch {
    /* the tab may be gone; ignore */
  }
}

/** Are these two URLs the same page? (hash and trailing slash ignored) */
function samePageUrl(a, b) {
  const normalize = (value) => {
    try {
      const url = new URL(String(value));
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return String(value || '');
    }
  };
  return normalize(a) === normalize(b);
}

/** Notify the popup after a state update (an open popup can refresh to the new page's result) */
async function broadcastState(state, tabId) {
  try {
    await chrome.runtime.sendMessage({ type: MSG.STATE_UPDATED, payload: { state, tabId } });
  } catch {
    /* ignore when nobody is listening (no popup open, no receiver) */
  }
}

async function runAnalysis({ pageInfo, tabId }) {
  const url = String(pageInfo?.url || '');
  const existing = typeof tabId === 'number' ? inFlight.get(tabId) : null;
  // Repeated requests for the same page (e.g. the popup opens right away) reuse one analysis, avoiding duplicate store requests
  if (existing && existing.url === url) return existing.promise;

  const task = (async () => {
    const settings = await getSettings();
    const stats = { analysis: Number(pageInfo?.analysisCount) || 1, total: 0, byStore: {} };
    const state = await analyzePage({ pageInfo, settings, deps: createDeps(settings, stats) });
    const stores = Array.isArray(state.stores) ? state.stores : [];
    stats.cacheHit = stores.length > 0 && stores.every((item) => item.fromCache);
    stats.cacheEntryFound = stores.some((item) => item.cacheEntryFound);
    if (settings.qaMode) await captureForQa({ pageInfo, state, stats });
    if (typeof tabId === 'number') {
      // The user may have navigated away while we were analysing: only store the
      // state when the tab is still on that page, otherwise the previous page's
      // result would stick around and the popup would show the wrong work.
      let stillCurrent = true;
      try {
        const tab = await chrome.tabs.get(tabId);
        stillCurrent = !tab?.url || samePageUrl(tab.url, url);
      } catch {
        stillCurrent = false; // tab closed
      }
      if (stillCurrent) {
        tabStates.set(tabId, state);
        await updateBadge(tabId, state);
        await broadcastState(state, tabId);
      }
    }
    return state;
  })();

  if (typeof tabId === 'number') {
    inFlight.set(tabId, { url, promise: task });
    const clear = () => {
      if (inFlight.get(tabId)?.promise === task) inFlight.delete(tabId);
    };
    task.then(clear, clear);
  }
  return task;
}

async function requestPageInfoFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.REQUEST_PAGE_INFO });
    return { pageInfo: response?.pageInfo || null, pending: Boolean(response?.pending) };
  } catch {
    return { pageInfo: null, pending: false, error: 'no-content-script' };
  }
}

async function openUrl(url) {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) return { ok: false, error: 'unsupported-url' };
  await chrome.tabs.create({ url: value, active: true });
  return { ok: true };
}

/**
 * The page the tab is currently showing, used to pick "the current capture".
 *
 * The in-memory tabStates map is only a cache: an MV3 service worker is shut
 * down when idle, and after a restart the map is empty while the user is still
 * looking at the same test page. Falling back to the tab's URL keeps the QA
 * panel pointed at the right page instead of claiming "no record yet".
 */
async function currentPageKey(tabId) {
  const state = typeof tabId === 'number' ? tabStates.get(tabId) : null;
  if (state?.page?.url) return pageKeyOf(state.page.url);
  if (typeof tabId !== 'number') return '';
  try {
    const tab = await chrome.tabs.get(tabId);
    return pageKeyOf(tab?.url || '');
  } catch {
    return '';
  }
}

/** Everything the QA dashboard shows (requirements doc §32) */
async function qaStatus(tabId) {
  const [qa, settings] = await Promise.all([readQa(), getSettings()]);
  const key = await currentPageKey(tabId);
  // `current` is strictly the page the tab is showing: judging or keeping a
  // different page's capture would silently attach the verdict to the wrong one.
  const current = key ? findCapture(qa.captures, key) : null;
  const last = qa.captures[qa.captures.length - 1] || null;
  // A dashboard that breaks must say so instead of quietly showing 0 (§32)
  let summary = null;
  let error = '';
  try {
    summary = summarize(qa.captures, qa.cases);
  } catch (cause) {
    error = `summary failed: ${String((cause && cause.message) || cause)}`;
    summary = {
      total: qa.captures.length, cases: qa.cases.length, pass: 0, fail: 0,
      expectedLimitation: 0, notTested: qa.captures.length, falsePositive: 0,
      falseNegative: 0, pageRecognitionRate: null, matchPrecision: null,
      newStructures: 0, requestBudget: { total: 0, byStore: {}, zeroRequestCaptures: 0, cacheHitCaptures: 0, overBudget: 0 },
      structures: []
    };
  }
  return {
    enabled: settings.qaMode === true,
    includeRealTitles: settings.qaIncludeRealTitles === true,
    summary,
    current,
    last,
    lastError: await readQaError(),
    error,
    currentIsCase: Boolean(current && qa.cases.some((item) => item.captureId === current.id)),
    cases: qa.cases.map((item) => ({ id: item.id, category: item.category, captureId: item.captureId }))
  };
}

/** Keep the current page as a test case (requirements doc §13) */
async function createCase(pageKey) {
  const qa = await readQa();
  const capture = findCapture(qa.captures, pageKey);
  if (!capture) return { error: 'no-capture' };
  const number = nextCaseNumber(qa);
  const record = { ...createCaseRecord(capture, { number }), captureId: capture.id };
  const { case: stored, replaced } = await addCase(record);
  return { case: stored, replaced };
}

/** Build one QA export (requirements doc §8) */
async function qaExport({ kind = 'summary', includeRealTitles = false } = {}) {
  const qa = await readQa();
  const lastError = await readQaError();
  const { day, seq } = await takeExportLabel();
  const generatedAt = Date.now();
  const options = {
    captures: qa.captures,
    cases: qa.cases,
    generatedAt,
    fileLabel: seq,
    includeRealTitles: includeRealTitles === true,
    // Error messages belong in the report (§28) so a silent capture failure is
    // impossible to miss when the files are reviewed.
    lastError
  };
  const report = kind === 'failures'
    ? buildFailureReport(options)
    : (kind === 'tests' ? buildCasePack(options) : buildSummaryReport(options));
  const json = JSON.stringify(report, null, 2);
  return { kind, fileName: exportFileName(kind, day, seq), json, bytes: json.length };
}

async function handleMessage(message, sender) {
  const type = message?.type;
  const tabId = sender?.tab?.id;
  /**
   * Which tab the reply should describe. A popup is not a tab, so `sender.tab`
   * is undefined there — the popup therefore passes the tab it is showing in
   * the message, and that always wins.
   */
  const statusTabId = typeof message?.tabId === 'number' ? message.tabId : tabId;

  switch (type) {
    case MSG.ANALYZE_PAGE: {
      const state = await runAnalysis({ pageInfo: message.payload, tabId });
      return { state };
    }
    case MSG.GET_STATE: {
      const id = typeof message.tabId === 'number' ? message.tabId : tabId;
      return { state: typeof id === 'number' ? tabStates.get(id) || null : null };
    }
    case MSG.REANALYZE_TAB: {
      const id = typeof message.tabId === 'number' ? message.tabId : tabId;
      if (typeof id !== 'number') return { error: 'no-tab' };
      // The popup may already hold page info (and have waited for the navigation): use it and save a round trip
      let pageInfo = message.pageInfo || null;
      let pending = false;
      if (!pageInfo) {
        const live = await requestPageInfoFromTab(id);
        pageInfo = live.pageInfo;
        pending = live.pending;
      }
      if (!pageInfo && pending) return { error: 'page-settling' };
      if (!pageInfo) return { error: 'unreadable-page' };
      const state = await runAnalysis({ pageInfo, tabId: id });
      return { state };
    }
    case MSG.REQUEST_PAGE_INFO: {
      return { pageInfo: null }; // handled by the content script; never reached
    }
    case MSG.GET_SETTINGS: {
      const settings = await getSettings();
      const cache = await getCacheStats();
      return {
        settings,
        cache,
        version: EXTENSION_VERSION,
        /** The built-in rate + its source, so the popup can show the default */
        currency: { jpyToCny: CONFIG.currency.jpyToCny, source: CONFIG.currency.jpyToCnySource }
      };
    }
    case MSG.SET_SETTINGS: {
      const settings = await setSettings(message.patch || {});
      return { settings };
    }
    case MSG.CLEAR_CACHE: {
      await clearSearchCache();
      const cache = await getCacheStats();
      return { cache };
    }
    case MSG.QA_GET: {
      return { qa: await qaStatus(statusTabId) };
    }
    case MSG.QA_UPDATE: {
      const pageKey = String(message.pageKey || '');
      if (!pageKey) return { error: 'no-page-key' };
      const capture = await updateCapture(pageKey, (item) => {
        let next = item;
        if (message.verdict !== undefined) next = setVerdict(next, message.verdict);
        if (message.falsePositive !== undefined) next = setFalsePositive(next, message.falsePositive);
        if (message.note !== undefined) next = setNote(next, message.note);
        return { ...next, judged: true };
      });
      if (!capture) return { error: 'no-capture' };
      return { capture, qa: await qaStatus(statusTabId) };
    }
    case MSG.QA_CREATE_CASE: {
      const result = await createCase(String(message.pageKey || ''));
      if (result.error) return result;
      return { ...result, qa: await qaStatus(statusTabId) };
    }
    case MSG.QA_EXPORT:
      return { export: await qaExport(message) };
    case MSG.QA_CLEAR: {
      await clearQa();
      return { qa: await qaStatus(statusTabId) };
    }
    case MSG.OPEN_URL:
      return openUrl(message.url);
    default:
      return { error: 'unknown-message', type };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ error: String((error && error.message) || error) }));
  return true; // asynchronous response
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    tabStates.delete(tabId);
    inFlight.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  inFlight.delete(tabId);
});

chrome.runtime.onInstalled.addListener(async () => {
  // Write default settings on first install so the popup can read them right away
  await setSettings({});
});
