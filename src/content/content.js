/**
 * Content script main flow: read the page -> hand it to the background for
 * analysis -> render the floating card.
 *
 * The part that is easy to miss: on some gallery sites a link is a
 * client-side navigation — the page is not reloaded and the content script is
 * not re-created. If the URL has already changed while the DOM still shows the
 * previous page, reading the page then yields the previous page's title (for
 * example a home-page tagline treated as a work title).
 * Hence the "navigation gate": once the URL changes, wait for the DOM to settle
 * before reading and analysing anything.
 */

(function initContent() {
  const NS = (globalThis.MangaNav = globalThis.MangaNav || {});

  /** Kept in sync with src/shared/protocol.js (content scripts cannot import) */
  const MSG = {
    ANALYZE_PAGE: 'MN_ANALYZE_PAGE',
    REQUEST_PAGE_INFO: 'MN_REQUEST_PAGE_INFO',
    GET_SETTINGS: 'MN_GET_SETTINGS',
    STATE_UPDATED: 'MN_STATE_UPDATED'
  };
  const STATUS = { UNRECOGNIZED: 'unrecognized' };
  // Kept in sync with CONFIG.extractor in src/lib/config.js (content scripts cannot import)
  const URL_POLL_MS = 900;
  const SETTLE_QUIET_MS = 400;
  const SETTLE_MAX_WAIT_MS = 5000;

  if (window.top !== window) return; // top frame only, so the card is not rendered inside every iframe

  let settings = null;
  let analyzing = false;
  let analyzeAgain = false;
  /** How many times this document has been analysed (QA capture §22 / §23) */
  let analysisCount = 0;

  /** Currently tracked URL (hash is ignored: an anchor jump is not a navigation) */
  let trackedHref = pageKey();
  /** Content fingerprint of the last analysis (tells whether the DOM really changed) */
  let lastSignature = NS.extractor?.signature?.() || '';
  /** Navigation gate */
  let navigating = false;
  /** The gate already waited once for this URL (avoids looping when the declared URL never matches) */
  let gatedHref = '';
  let navStartedAt = 0;
  let lastMutationAt = 0;
  let navDeadline = 0;
  let settleTimer = null;
  let settleWaiters = [];
  let observer = null;

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null; // extension reloaded/unloaded: fail silently
    }
  }

  function pageKey() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  /** Is this state for the current URL? (stops another tab's result from being painted here) */
  function samePageUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      url.hash = '';
      return url.toString().replace(/\/$/, '') === location.href.replace(/#.*$/, '').replace(/\/$/, '');
    } catch {
      return false;
    }
  }

  function collectPageInfo() {
    const pageInfo = NS.extractor?.collect() || null;
    if (!pageInfo) return null;
    // With settled=false the background does not treat the page as a work page; the popup keeps waiting
    pageInfo.settled = !navigating && !NS.extractor?.contentUrlMismatch?.();
    pageInfo.analysisCount = analysisCount;
    return pageInfo;
  }

  /**
   * Navigation gate: once the URL changes (pushState / popstate / poll), hold
   * off until the DOM has swapped content and stayed quiet for a while.
   */
  function beginNavigation() {
    navigating = true;
    // The URL changed without a page load: this document is a SPA (§22)
    NS.extractor?.markClientNavigation?.();
    navStartedAt = Date.now();
    lastMutationAt = navStartedAt;
    navDeadline = navStartedAt + SETTLE_MAX_WAIT_MS;
    gatedHref = pageKey();
    // Clear the previous page's card immediately, so the old recommendation is never shown
    NS.ui?.clear?.();
    observeDom();
    scheduleSettleCheck(SETTLE_QUIET_MS);
  }

  function insideCard(node) {
    let element = node?.nodeType === 1 ? node : node?.parentNode;
    while (element) {
      if (element.id === 'manga-nav-host') return true;
      element = element.parentNode || element.host || null;
    }
    return false;
  }

  function observeDom() {
    if (observer || typeof MutationObserver !== 'function' || !document.documentElement) return;
    const instance = new MutationObserver((records) => {
      if (!navigating) return;
      // Our own card does not count as "the page content changed"
      if (!records.some((record) => !insideCard(record.target))) return;
      lastMutationAt = Date.now();
      scheduleSettleCheck(SETTLE_QUIET_MS);
    });
    instance.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    observer = instance;
  }

  /** Stop observing once the navigation is over, instead of watching every page forever */
  function stopObservingDom() {
    try {
      observer?.disconnect?.();
    } catch {
      /* ignore */
    }
    observer = null;
  }

  function scheduleSettleCheck(delay) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(checkSettled, Math.max(50, delay));
  }

  function checkSettled() {
    if (!navigating) return;
    if (pageKey() !== trackedHref) {
      // Another navigation happened while waiting: restart the clock
      trackedHref = pageKey();
      beginNavigation();
      return;
    }
    const now = Date.now();
    const signature = NS.extractor?.signature?.() || '';
    const domChanged = Boolean(signature) && signature !== lastSignature;
    const quiet = now - Math.max(lastMutationAt, navStartedAt) >= SETTLE_QUIET_MS;
    if ((domChanged && quiet) || now >= navDeadline) {
      finishNavigation();
      return;
    }
    scheduleSettleCheck(Math.min(SETTLE_QUIET_MS, Math.max(50, navDeadline - now)));
  }

  function finishNavigation() {
    navigating = false;
    clearTimeout(settleTimer);
    stopObservingDom();
    const waiters = settleWaiters;
    settleWaiters = [];
    waiters.forEach((resolve) => resolve(true));
    analyze(); // re-analyse once the new page is in place
  }

  /** While a client-side navigation is in flight, wait for it (at most timeoutMs) */
  function waitForNavigation(timeoutMs = SETTLE_MAX_WAIT_MS) {
    if (!navigating) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      settleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** URL and content disagree, meaning the site changes the URL first: open the gate */
  function ensureNavigationGate() {
    if (navigating) return;
    if (!NS.extractor?.contentUrlMismatch?.()) return;
    if (gatedHref === pageKey()) return; // already waited once for this URL
    beginNavigation();
  }

  function onUrlMaybeChanged() {
    const key = pageKey();
    if (key === trackedHref) return;
    trackedHref = key;
    beginNavigation();
  }

  function watchNavigation() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history?.[method];
      if (typeof original !== 'function') continue;
      try {
        history[method] = function patched(...args) {
          const result = original.apply(this, args);
          onUrlMaybeChanged();
          return result;
        };
      } catch {
        /* some pages freeze history; ignoring is fine */
      }
    }
    window.addEventListener('popstate', onUrlMaybeChanged);
    window.addEventListener('hashchange', onUrlMaybeChanged);
    setInterval(onUrlMaybeChanged, URL_POLL_MS);
  }

  async function analyze(options = {}) {
    if (analyzing) {
      analyzeAgain = true;
      return;
    }
    analyzing = true;
    try {
      if (!settings) {
        const response = await sendMessage({ type: MSG.GET_SETTINGS });
        settings = response?.settings || null;
      }
      if (settings && settings.enabled === false) return;

      ensureNavigationGate();
      if (navigating) await waitForNavigation();

      analysisCount += 1;
      const pageInfo = collectPageInfo();
      if (!pageInfo) return;
      lastSignature = NS.extractor?.signature?.() || lastSignature;
      const response = await sendMessage({ type: MSG.ANALYZE_PAGE, payload: pageInfo });
      const state = response?.state;
      if (!state) return;

      if (state.status !== STATUS.UNRECOGNIZED) {
        const autoShow = !settings || settings.autoShowCard !== false;
        if (autoShow || options.force) {
          NS.ui?.render(state, { force: Boolean(options.force) });
        }
      } else if (options.force) {
        NS.ui?.render(state, { force: true });
      } else {
        // On a new page without a recognised work, do not leave the previous card on screen
        NS.ui?.clear?.();
      }
    } finally {
      analyzing = false;
      if (analyzeAgain) {
        analyzeAgain = false;
        analyze();
      }
    }
  }

  watchNavigation();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === MSG.REQUEST_PAGE_INFO) {
      // Never answer with the previous page during a navigation: wait for the new one
      (async () => {
        ensureNavigationGate();
        if (navigating) await waitForNavigation();
        sendResponse({ pageInfo: collectPageInfo(), pending: navigating });
      })();
      return true; // asynchronous response
    }
    if (message?.type === MSG.STATE_UPDATED) {
      const payload = message.payload || {};
      if (payload.settings) settings = payload.settings;
      if (payload.state) {
        if (!samePageUrl(payload.state.page?.url)) return; // another page's result: ignore
        NS.ui?.render(payload.state, { force: Boolean(payload.force) });
      }
      else if (payload.force) analyze({ force: true });
      return;
    }
  });

  analyze();
})();
