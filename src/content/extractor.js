/**
 * Page information reader (content script: a plain script, imports are not
 * available). It only *reads* — all judging and cleaning happens in the
 * background, so that it can be tested on its own.
 */

(function initExtractor() {
  const NS = (globalThis.MangaNav = globalThis.MangaNav || {});
  const TEXT_SAMPLE_LENGTH = 2000;
  /**
   * Id of this content-script instance.
   * A client-side navigation (history.pushState) keeps the content script
   * alive, while a full page load replaces it, so the background and the popup
   * use this id to tell whether a stored state belongs to the current document.
   */
  const SCRIPT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  function textOf(element) {
    if (!element) return '';
    return String(element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function metaContent(names) {
    for (const name of names) {
      const element = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      const content = element?.getAttribute('content');
      if (content && content.trim()) return content.trim();
    }
    return '';
  }

  /** Compare origin + path only, ignoring query, hash and trailing slash */
  function pathKey(value) {
    try {
      const url = new URL(String(value), location.href);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return '';
    }
  }

  /**
   * When the URL the page declares (og:url / canonical) does not match the
   * address bar, the URL has changed but the content is still the previous
   * page — the in-between state of a client-side navigation.
   * Reader pages often point their canonical at the work root, so one being a
   * prefix of the other is treated as a match.
   */
  function contentUrlMismatch() {
    const here = pathKey(location.href);
    if (!here) return false;
    const declared = [
      metaContent(['og:url']),
      document.querySelector('link[rel="canonical"]')?.getAttribute('href') || ''
    ].filter(Boolean);
    return declared.some((value) => {
      const key = pathKey(value);
      if (!key) return false;
      return !(key === here || key.startsWith(`${here}/`) || here.startsWith(`${key}/`));
    });
  }

  /** Content fingerprint: used after a navigation to tell whether the DOM really changed */
  function signature() {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, #info .title'))
      .slice(0, 6)
      .map(textOf)
      .join(' | ');
    const info = String(infoText() || '').slice(0, 160);
    return [
      document.title || '',
      headings,
      info,
      String(document.images.length),
      String((document.body?.textContent || '').length)
    ].join('::');
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = textOf(element);
      if (value) return value;
    }
    return '';
  }

  function readJsonLd() {
    const result = { name: '', type: '', author: '' };
    const nodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 8);
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const type = node['@type'];
      const name = node.name || node.headline || node.alternateName;
      if (!result.name && name && typeof name === 'string') {
        result.name = name;
        result.type = Array.isArray(type) ? type.join(',') : String(type || '');
      }
      if (!result.author && node.author) {
        const author = Array.isArray(node.author) ? node.author[0] : node.author;
        if (typeof author === 'string') result.author = author;
        else if (author?.name) result.author = String(author.name);
      }
      for (const key of ['@graph', 'mainEntity', 'itemListElement', 'hasPart']) {
        if (node[key]) visit(node[key]);
      }
    };
    for (const node of nodes) {
      try {
        const raw = String(node.textContent || '').replace(/^\s*<!--/, '').replace(/-->\s*$/, '');
        if (!raw.trim()) continue;
        visit(JSON.parse(raw));
      } catch {
        /* ignore JSON-LD that cannot be parsed */
      }
    }
    return result;
  }

  function textSample() {
    const container = document.querySelector('main, article, #content, .content, #chapter, .chapter, #reader, .reader');
    const source = container || document.body;
    if (!source) return '';
    return String(source.textContent || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_SAMPLE_LENGTH);
  }

  /**
   * Work info block (this is where gallery sites keep Tags / Groups /
   * Languages / Pages). Ordinary article pages do not have these fields, which
   * makes this a safe discriminator between a work page and a normal web page.
   */
  function infoText() {
    const selectors = ['#tags', '#info', '.tag-container', '.tags', '.info', '.work-info', '#work_info', 'dl'];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = String(element?.textContent || '').replace(/\s+/g, ' ').trim();
      if (value.length >= 20) return value.slice(0, 1500);
    }
    return '';
  }

  /**
   * Collect every "title-like" element on the page (h1–h4, role="heading",
   * aria-level, and .title inside #info).
   * The Japanese original is not always in an h2 — different gallery sites and
   * categories use different tags — so everything is collected uniformly here
   * and the background decides which candidate looks most like the work title.
   */
  function collectHeadings() {
    const selector = 'h1, h2, h3, h4, [role="heading"], [aria-level], #info .title, #info-block .title';
    const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 16);
    const out = [];
    for (const element of nodes) {
      const text = textOf(element);
      if (!text || text.length > 200) continue;
      if (out.some((item) => item.text === text)) continue;
      const tag = String(element.tagName || '').toLowerCase();
      const ariaLevel = Number(element.getAttribute('aria-level'));
      const level = Number.isFinite(ariaLevel) && ariaLevel > 0
        ? ariaLevel
        : (/^h[1-6]$/.test(tag) ? Number(tag[1]) : 3);
      out.push({ level, tag, text });
    }
    return out;
  }

  function collect() {
    const jsonLd = readJsonLd();
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    const anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 400).map((a) => textOf(a)).filter(Boolean);
    return {
      url: location.href,
      host: location.hostname,
      origin: location.origin,
      title: document.title || '',
      h1: Array.from(document.querySelectorAll('h1')).slice(0, 3).map(textOf).filter(Boolean),
      h2: Array.from(document.querySelectorAll('h2')).slice(0, 3).map(textOf).filter(Boolean),
      h3: Array.from(document.querySelectorAll('h3')).slice(0, 2).map(textOf).filter(Boolean),
      headings: collectHeadings(),
      ogTitle: metaContent(['og:title']),
      ogType: metaContent(['og:type']),
      siteName: metaContent(['og:site_name', 'application-name']),
      description: metaContent(['description', 'og:description']),
      keywords: metaContent(['keywords']),
      jsonLdName: jsonLd.name,
      jsonLdType: jsonLd.type,
      jsonLdAuthor: jsonLd.author,
      canonicalUrl: canonical,
      ogUrl: metaContent(['og:url']),
      lang: document.documentElement?.lang || '',
      imageCount: document.images.length,
      navHint: anchors.slice(0, 80).join(' ').slice(0, 500),
      textSample: textSample(),
      infoText: infoText(),
      scriptId: SCRIPT_ID,
      capturedAt: Date.now()
    };
  }

  NS.extractor = { collect, signature, contentUrlMismatch, scriptId: SCRIPT_ID };
})();
