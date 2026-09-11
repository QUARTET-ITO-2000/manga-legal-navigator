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

/** tabId -> most recent analysis result */
const tabStates = new Map();
/** tabId -> { url, promise }: while an analysis for the same tab and URL is running, later requests reuse it */
const inFlight = new Map();
let lastFetchAt = 0;

const MOCK_FIXTURES = {
  dlsite: 'src/stores/fixtures/dlsite-search-sample.html',
  dlsiteOther: 'src/stores/fixtures/dlsite-not-found-sample.html',
  fanza: 'src/stores/fixtures/fanza-search-sample.html',
  melonbooks: 'src/stores/fixtures/melonbooks-search-sample.html',
  pixiv: 'src/stores/fixtures/pixiv-search-sample.json',
  fantia: 'src/stores/fixtures/fantia-search-sample.json'
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

function createDeps(settings) {
  return {
    fetchText: settings.mockMode ? mockFetchText : politeFetchText,
    cache: { get: getCachedSearch, set: setCachedSearch },
    adapterId: settings.storeId || 'dlsite'
  };
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
    const state = await analyzePage({ pageInfo, settings, deps: createDeps(settings) });
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

async function handleMessage(message, sender) {
  const type = message?.type;
  const tabId = sender?.tab?.id;

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
      return { settings, cache, version: EXTENSION_VERSION };
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
