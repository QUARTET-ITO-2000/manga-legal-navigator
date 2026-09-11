/**
 * Floating card in the bottom-right corner (content script: a plain script).
 * It lives in a Shadow DOM so the host page's CSS cannot affect it
 * (requirements doc §12).
 */

(function initUi() {
  const NS = (globalThis.MangaNav = globalThis.MangaNav || {});
  const HOST_ID = 'manga-nav-host';

  const STATUS = {
    OK_HIGH: 'ok_high',
    OK_POSSIBLE: 'ok_possible',
    NO_RESULT: 'no_result',
    UNRECOGNIZED: 'unrecognized',
    ERROR: 'error'
  };

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
      font-size: 13px; line-height: 1.55; color: #16202f; text-align: left;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      width: 272px; background: #ffffff; border: 1px solid rgba(15, 23, 42, .10);
      border-radius: 14px; box-shadow: 0 10px 30px rgba(15, 23, 42, .18);
      overflow: hidden; pointer-events: auto;
    }
    .head {
      display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px;
      background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff;
    }
    .head .brand { flex: 1 1 auto; font-weight: 600; font-size: 13px; letter-spacing: .2px; }
    .head .ico { font-size: 14px; }
    .icon-btn {
      all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px;
      display: inline-flex; align-items: center; justify-content: center;
      color: #fff; font-size: 15px; line-height: 1; opacity: .85;
    }
    .icon-btn:hover { background: rgba(255, 255, 255, .18); opacity: 1; }
    .body { padding: 10px 12px 12px; }
    .work { font-weight: 600; font-size: 13.5px; margin: 0 0 6px; word-break: break-word; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
    .store {
      font-size: 11px; font-weight: 600; color: #1d4ed8; background: rgba(37, 99, 235, .10);
      border-radius: 5px; padding: 1px 6px;
    }
    .price { font-weight: 700; font-size: 14px; color: #c2410c; }
    .cny, .strike, .maker, .badge { font-size: 11.5px; color: #64748b; }
    .strike { text-decoration: line-through; }
    .sale { font-size: 11px; font-weight: 700; color: #dc2626; }
    .badge { display: inline-block; margin-bottom: 8px; padding: 1px 6px; border-radius: 5px; background: rgba(100, 116, 139, .12); }
    .maker { display: block; margin: -2px 0 8px; word-break: break-word; }
    .candidates { list-style: none; margin: 0 0 8px; padding: 0; }
    .candidates li { margin: 0 0 4px; padding: 4px 6px; border-radius: 6px; background: rgba(15, 23, 42, .04); }
    .candidates a { color: #1d4ed8; text-decoration: none; }
    .candidates a:hover { text-decoration: underline; }
    .cand-title { display: block; font-size: 12.5px; word-break: break-word; }
    .cand-meta { font-size: 11px; color: #64748b; }
    .note { font-size: 11px; color: #94a3b8; margin: 8px 0 0; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .btn {
      all: unset; cursor: pointer; text-align: center; border-radius: 8px;
      padding: 7px 10px; font-size: 12.5px; font-weight: 600;
    }
    .btn.primary { flex: 1 1 auto; background: #2563eb; color: #fff; }
    .btn.primary:hover { background: #1d4ed8; }
    .btn.ghost { color: #64748b; border: 1px solid rgba(15, 23, 42, .12); }
    .btn.ghost:hover { color: #1d4ed8; border-color: rgba(37, 99, 235, .5); }
    .message { margin: 0 0 10px; color: #475569; }
    .bubble {
      all: unset; cursor: pointer; position: relative; display: inline-flex;
      align-items: center; justify-content: center; width: 40px; height: 40px;
      border-radius: 50%; background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff; font-size: 18px; box-shadow: 0 6px 18px rgba(29, 78, 216, .35);
      pointer-events: auto;
    }
    .bubble .tick {
      position: absolute; top: -2px; right: -2px; width: 16px; height: 16px;
      border-radius: 50%; background: #16a34a; color: #fff; font-size: 10px;
      display: flex; align-items: center; justify-content: center; font-weight: 700;
    }
    @media (prefers-color-scheme: dark) {
      .card { background: #1b2130; border-color: rgba(255, 255, 255, .12); color: #e6e8ee; }
      .message { color: #cbd5e1; }
      .candidates li { background: rgba(255, 255, 255, .06); }
      .candidates a, .store, .btn.ghost:hover { color: #93c5fd; }
      .store { background: rgba(147, 197, 253, .14); }
      .cny, .strike, .maker, .badge, .cand-meta, .note { color: #94a3b8; }
      .btn.ghost { color: #cbd5e1; border-color: rgba(255, 255, 255, .18); }
    }
    @media print { .wrap { display: none !important; } }
  `;

  let host = null;
  let shadow = null;
  let root = null;
  const uiState = { collapsed: false, dismissed: false, lastState: null };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  function ensureHost() {
    if (host && host.isConnected && root) return;
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
    }
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${STYLES}</style><div class="wrap"></div>`;
    root = shadow.querySelector('.wrap');
    (document.body || document.documentElement).appendChild(host);
  }

  function setVisible(visible) {
    if (!host) return;
    host.style.display = visible ? '' : 'none';
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
        <a class="cand-title" href="${escapeHtml(candidate.url)}" target="_blank" rel="noopener noreferrer">${index + 1}. ${escapeHtml(candidate.title)}</a>
        <span class="cand-meta">${escapeHtml(candidate.storeLabel || 'DLsite')}${price ? ` · ${escapeHtml(price)}` : ''} · 匹配度 ${escapeHtml(candidate.scoreLabel || '')}</span>
      </li>`;
    }).join('');
    return `<ol class="candidates">${items}</ol>`;
  }

  function headMarkup(title, withTick) {
    return `<div class="head">
      <span class="ico">📚</span>
      <span class="brand">${escapeHtml(title)}</span>
      <button class="icon-btn" data-action="collapse" title="收起">–</button>
      <button class="icon-btn" data-action="close" title="关闭">×</button>
    </div>`;
  }

  function renderCard(state) {
    const status = state.status;
    const match = state.match;

    if (status === STATUS.OK_HIGH || status === STATUS.OK_POSSIBLE) {
      const title = status === STATUS.OK_HIGH ? '找到正版' : '可能的正版';
      const badge = status === STATUS.OK_POSSIBLE || (state.candidates || []).length > 1
        ? `<div class="badge">匹配度：${escapeHtml(match.scoreLabel || '')}</div>`
        : '';
      const maker = match.maker || match.author
        ? `<span class="maker">${escapeHtml(match.maker || '')}${match.maker && match.author ? ' / ' : ''}${escapeHtml(match.author || '')}</span>`
        : '';
      return `<div class="card">
        ${headMarkup(title)}
        <div class="body">
          <div class="work">《${escapeHtml(match.title)}》</div>
          <div class="meta">${priceMarkup(match)}</div>
          ${maker}
          ${badge}
          ${candidatesMarkup(state.candidates)}
          <div class="actions">
            <a class="btn primary" href="${escapeHtml(match.url)}" target="_blank" rel="noopener noreferrer">${status === STATUS.OK_HIGH ? '查看正版' : '查看'}</a>
            <button class="btn ghost" data-action="collapse">收起</button>
          </div>
          <p class="note">是否购买由你自行决定，插件不会自动购买。</p>
        </div>
      </div>`;
    }

    const message = state.message || '暂未找到明确对应的 DLsite 商品。';
    const links = (state.searchUrls && state.searchUrls.length)
      ? state.searchUrls
      : (state.searchUrl ? [{ storeLabel: 'DLsite', url: state.searchUrl }] : []);
    const buttons = links.length
      ? `<div class="actions">${links.map((item, index) => (
        `<a class="btn ${index === 0 ? 'primary' : 'ghost'}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.storeLabel || '商店')}</a>`
      )).join('')}</div>`
      : '<span class="cny">没有可用的搜索关键词</span>';
    const ageHint = state.needsAgeCheck
      ? `<p class="note">${escapeHtml(state.ageCheckStoreLabel || 'FANZA')} 需要先确认年龄：<a href="${escapeHtml(state.ageCheckUrl)}" target="_blank" rel="noopener noreferrer">打开确认页面</a>，回来后再点「重新识别」。</p>`
      : '';
    return `<div class="card">
      ${headMarkup('正版购买')}
      <div class="body">
        ${state.query && state.query.cleanedTitle ? `<div class="work">《${escapeHtml(state.query.cleanedTitle)}》</div>` : ''}
        <p class="message">${escapeHtml(message)}</p>
        ${buttons}
        ${ageHint}
        <div class="actions"><button class="btn ghost" data-action="collapse">收起</button></div>
      </div>
    </div>`;
  }

  function renderBubble(state) {
    const hasMatch = state && (state.status === STATUS.OK_HIGH || state.status === STATUS.OK_POSSIBLE);
    return `<button class="bubble" data-action="expand" title="展开正版提示">📚${hasMatch ? '<span class="tick">✓</span>' : ''}</button>`;
  }

  function paint() {
    if (!root) return;
    if (uiState.dismissed) {
      root.innerHTML = renderBubble(uiState.lastState);
      setVisible(true);
      return;
    }
    if (uiState.collapsed) {
      root.innerHTML = renderBubble(uiState.lastState);
      setVisible(true);
      return;
    }
    root.innerHTML = renderCard(uiState.lastState);
    setVisible(true);
  }

  function onRootClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'collapse') {
      uiState.collapsed = true;
      paint();
    } else if (action === 'expand') {
      uiState.collapsed = false;
      uiState.dismissed = false;
      paint();
    } else if (action === 'close') {
      uiState.dismissed = true;
      uiState.collapsed = true;
      paint();
    }
  }

  function bindRoot() {
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    root.addEventListener('click', onRootClick, true);
  }

  function render(state, options = {}) {
    if (!state) return;
    uiState.lastState = state;
    if (state.status === STATUS.UNRECOGNIZED && !options.force) {
      // When no work is recognised, stay out of the way (requirements doc §20 test F).
      // NOTE: clear the card instead of hiding it — after a client-side
      // navigation a hidden card would stay on the new page and look like a
      // wrong detection.
      clear();
      return;
    }
    if (options.force) {
      uiState.dismissed = false;
      uiState.collapsed = false;
    }
    ensureHost();
    bindRoot();
    paint();
  }

  function hide() {
    uiState.dismissed = true;
    setVisible(false);
  }

  /** Remove the card completely (used on navigation so a stale card cannot linger) */
  function clear() {
    uiState.lastState = null;
    uiState.collapsed = false;
    uiState.dismissed = false;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    root = null;
  }

  function show(state, options = {}) {
    render(state || uiState.lastState, { force: true, ...options });
  }

  NS.ui = { render, hide, clear, show, getState: () => uiState.lastState };
})();
