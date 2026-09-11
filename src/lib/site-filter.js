/**
 * Decides whether a page is worth analysing.
 *
 * The MVP does not try to tell whether a site is a pirate site (requirements
 * doc §3), but it must avoid showing a wrong recommendation on unrelated pages
 * (requirements doc §20 test F), so this is only a light "does it look like a
 * manga page?" check.
 */

import {
  DETAIL_URL_PATTERN,
  DENY_HOSTS,
  DENY_URL_PATTERNS,
  GALLERY_PAGE_SIGNALS,
  MANGA_HOST_HINTS,
  NORMAL_PAGE_SIGNALS,
  STRONG_PAGE_SIGNALS
} from './config.js';

function hostMatches(host, entry) {
  return host === entry || host.endsWith(`.${entry}`);
}

export function isDeniedHost(host) {
  const value = String(host || '').toLowerCase();
  if (!value) return false;
  return DENY_HOSTS.some((entry) => hostMatches(value, entry));
}

export function evaluatePage(pageInfo, settings = {}) {
  const result = { allowed: false, reason: 'unknown', signals: [], host: '' };
  if (!pageInfo || !pageInfo.url) return { ...result, reason: 'no-page-info' };

  let parsedUrl;
  try {
    parsedUrl = new URL(pageInfo.url);
  } catch {
    return { ...result, reason: 'invalid-url' };
  }

  const host = parsedUrl.hostname.toLowerCase();
  result.host = host;

  if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
    return { ...result, reason: 'unsupported-scheme' };
  }
  if (isDeniedHost(host)) return { ...result, reason: 'denylisted-host', allowed: false };
  if (DENY_URL_PATTERNS.some((pattern) => pattern.test(pageInfo.url))) {
    return { ...result, reason: 'denylisted-url' };
  }

  // In-between state of a client-side navigation: the URL already changed while
  // the DOM still shows the previous page. Any title read here belongs to that
  // previous page and must never be searched for.
  if (pageInfo.settled === false) {
    return { ...result, reason: 'page-settling', allowed: false };
  }

  // Site root / listing pages (/, /index.html, ?page=2, …) are not work pages
  const pathname = parsedUrl.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/index.html') {
    return { ...result, reason: 'site-root', allowed: false };
  }

  if (settings.ignoreSiteFilter) return { ...result, allowed: true, reason: 'forced' };

  const title = String(pageInfo.title || '');
  const headings = Array.isArray(pageInfo.h1) ? pageInfo.h1.join(' ') : String(pageInfo.h1 || '');
  const metaText = [
    pageInfo.ogTitle, pageInfo.siteName, pageInfo.description, pageInfo.keywords,
    pageInfo.jsonLdName, headings
  ].filter(Boolean).join(' \n ');
  const textSample = String(pageInfo.textSample || '');
  const infoText = `${textSample} \n ${String(pageInfo.infoText || '')}`;

  const signals = [];
  const strongHit = STRONG_PAGE_SIGNALS.some((pattern) => pattern.test(title) || pattern.test(metaText));
  if (strongHit) signals.push('chapter-marker-in-title');
  const textChapterHit = STRONG_PAGE_SIGNALS.some((pattern) => pattern.test(textSample));
  if (textChapterHit) signals.push('chapter-marker-in-page');

  const imageCount = Number(pageInfo.imageCount) || 0;
  const detailUrl = DETAIL_URL_PATTERN.test(String(pageInfo.url || ''));

  // Gallery-style work page: a Tags / Groups / Languages / Pages info block
  const galleryHits = GALLERY_PAGE_SIGNALS.filter((pattern) => pattern.test(infoText)).length;
  const galleryStructure = galleryHits >= 2 || (galleryHits >= 1 && imageCount >= 8 && detailUrl);
  if (galleryStructure) signals.push('gallery-structure');

  for (const pattern of NORMAL_PAGE_SIGNALS) {
    if (pattern.test(`${title} ${metaText}`)) signals.push(`meta:${pattern.source.slice(0, 24)}`);
  }

  const hostHint = MANGA_HOST_HINTS.some((hint) => host.includes(hint));
  if (hostHint) signals.push('manga-like-host');

  if (pageInfo.jsonLdType && /book|comic|article/i.test(String(pageInfo.jsonLdType))) {
    signals.push('structured-data-book');
  }
  // Many images only count on a detail-like URL, so image-heavy blog posts are not mistaken for work pages
  if (detailUrl) signals.push('detail-like-url');
  if (detailUrl && imageCount >= 6) signals.push('gallery-images');

  result.signals = signals;

  // NOTE: a host hint (manga-like-host) alone is not a strong signal — home pages and listing pages must not show a card
  const strongSignals = [
    'chapter-marker-in-title',
    'chapter-marker-in-page',
    'structured-data-book',
    'gallery-structure'
  ];
  if (signals.some((signal) => strongSignals.includes(signal))) {
    return { ...result, allowed: true, reason: 'strong-signal' };
  }
  // A manga-like host plus a detail-style URL (such as /g/12345/) counts as a
  // work page; home pages and listing pages do not show a card
  if (hostHint && detailUrl) {
    return { ...result, allowed: true, reason: 'manga-host-detail-url' };
  }
  if (signals.filter((signal) => signal.startsWith('meta:')).length >= 2) {
    return { ...result, allowed: true, reason: 'multiple-meta-signals' };
  }
  if (detailUrl && imageCount >= 6 && signals.some((signal) => signal.startsWith('meta:'))) {
    return { ...result, allowed: true, reason: 'detail-page-with-images' };
  }

  return { ...result, allowed: false, reason: 'no-comic-signal' };
}
