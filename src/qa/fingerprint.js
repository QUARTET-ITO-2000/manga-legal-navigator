/**
 * Page-structure fingerprint, novelty scoring and test-case grouping
 * (requirements doc §6, §10, §11, §12, §13).
 *
 * Everything here is a pure function over the *structured* page summary that
 * the content script already produces — no HTML, no DOM, no network. That is
 * what makes it usable from the service worker, from the popup and from the
 * offline tools at the same time.
 *
 * The fingerprint answers one question only:
 *
 *   "Does this page represent a page structure that is already in the test
 *    set, or a new one?"
 *
 * It is deliberately *not* a matching score — do not confuse it with
 * src/matching/matcher.js (requirements doc §12).
 */

/** Info-block field labels used by gallery-style work pages */
const INFO_FIELD_PATTERN = /(?:^|[^a-z])(parodies|tags|groups?|languages?|categories|category|pages|artists?|circles?|characters?|uploaded|favorites?|原作|サークル|作者|タグ|ジャンル|ページ数|収録)\s*[:：]/gi;

/** Chapter / volume marker, used to tell a reader page from a plain article */
const CHAPTER_MARKER = /第\s*\d{1,4}\s*[話话回巻卷集章]|(?:chapter|episode|vol|volume)\.?\s*\d{1,4}/i;

/** Page types (the "G" / "R" / "A" / "L" / "U" prefix of the fingerprint) */
export const PAGE_TYPE_PREFIX = {
  gallery: 'G',
  reader: 'R',
  article: 'A',
  listing: 'L',
  unknown: 'U'
};

/** Novelty buckets (requirements doc §12) */
export const NOVELTY_BANDS = [
  { max: 20, verdict: 'duplicate' },
  { max: 50, verdict: 'minor-new' },
  { max: 80, verdict: 'clearly-new' },
  { max: 100, verdict: 'new-type' }
];

/**
 * Relative importance of each feature when two pages are compared.
 * Page type, client-side navigation and structured data decide the *kind* of
 * page a test case represents, so they weigh the most; cosmetic details such as
 * the title length weigh the least.
 */
const TOKEN_WEIGHTS = {
  type: 3,
  spa: 2,
  jl: 2,
  info: 2,
  img: 1.5,
  h1: 1.5,
  og: 1,
  chapter: 1,
  lang: 0.5,
  title: 0.5
};

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

/** Field labels found in the work info block, e.g. ['tags', 'languages', 'pages'] */
export function infoFieldsOf(pageInfo = {}) {
  if (Array.isArray(pageInfo.infoFields) && pageInfo.infoFields.length) {
    return [...new Set(pageInfo.infoFields.map((item) => String(item).toLowerCase()))];
  }
  const text = `${pageInfo.infoText || ''}`;
  if (!text) return [];
  const found = new Set();
  for (const match of text.matchAll(INFO_FIELD_PATTERN)) {
    found.add(String(match[1] || '').toLowerCase().replace(/s$/, ''));
  }
  return [...found];
}

export function imageBucketOf(imageCount) {
  const count = Number(imageCount) || 0;
  if (count >= 40) return 'IMG40';
  if (count >= 8) return 'IMG8';
  return 'IMG0';
}

/** 'ja' | 'zh' | 'latin' | 'none' — enough to tell "Japanese only" pages apart */
export function langFamilyOf(value) {
  const text = String(value || '');
  if (!text) return 'none';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  if (/[A-Za-z]/.test(text)) return 'latin';
  return 'none';
}

export function titleBucketOf(value) {
  const length = String(value || '').trim().length;
  if (!length) return 'none';
  if (length < 12) return 'short';
  if (length < 30) return 'medium';
  return 'long';
}

/**
 * Which kind of page is this? (requirements doc §4 lists the structures the
 * test set must cover: gallery / reader / listing / article / unknown)
 */
export function pageTypeOf(pageInfo = {}, state = null) {
  const signals = asArray(state?.meta?.signals).map((item) => String(item));
  const imageCount = Number(pageInfo.imageCount) || 0;
  const infoFields = infoFieldsOf(pageInfo);
  const title = `${pageInfo.title || ''} ${asArray(pageInfo.h1).join(' ')} ${asArray(pageInfo.h2).join(' ')}`;
  const bodyText = `${pageInfo.textSample || ''} ${pageInfo.infoText || ''}`;
  const chapterMarker = CHAPTER_MARKER.test(title) || CHAPTER_MARKER.test(bodyText);
  const pathname = (() => {
    try {
      return new URL(String(pageInfo.url || '')).pathname;
    } catch {
      return String(pageInfo.url || '');
    }
  })();
  const detailUrl = /(?:^|\/)(?:g|gallery|galleries|view|work|works|comic|comics|manga|book|books|read|chapter|ch|ep|episode|detail|doujinshi|p|post)\/[^/?#]+/i
    .test(pathname);
  /** Blogs / news / text articles look different from a work listing page */
  const articleLike = /article|blog|news|post/i.test(String(pageInfo.ogType || ''))
    || /(?:^|\/)(?:posts?|blog|articles?|news|diary)\//i.test(pathname);

  if (signals.includes('gallery-structure') || infoFields.length >= 2) return 'gallery';
  if (chapterMarker && imageCount >= 12) return 'reader';
  if (imageCount >= 20 && detailUrl) return 'reader';
  if (articleLike) return 'article';
  if (!detailUrl && imageCount < 8) return 'listing';
  if (imageCount < 8 && !chapterMarker) return 'article';
  return 'unknown';
}

/**
 * The structured feature set a test case is built from
 * (requirements doc §13 `features`).
 */
export function buildFeatures(pageInfo = {}, state = null) {
  const infoFields = infoFieldsOf(pageInfo);
  const imageCount = Number(pageInfo.imageCount) || 0;
  const title = `${pageInfo.title || ''}`;
  const bodyText = `${pageInfo.textSample || ''} ${pageInfo.infoText || ''}`;
  const headings = asArray(pageInfo.headings);
  const hasH1 = asArray(pageInfo.h1).length > 0
    || headings.some((item) => Number(item?.level) === 1 || String(item?.tag || '').toLowerCase() === 'h1');
  const pageType = pageTypeOf(pageInfo, state);

  return {
    pageType,
    h1: hasH1,
    ogTitle: Boolean(pageInfo.ogTitle),
    jsonLd: Boolean(pageInfo.jsonLdName || pageInfo.jsonLdType),
    galleryInfo: infoFields.length >= 2,
    manyImages: imageCount >= 40,
    spaNavigation: String(pageInfo.navigationType || '') === 'spa',
    chapterMarker: CHAPTER_MARKER.test(title) || CHAPTER_MARKER.test(bodyText),
    imageCount,
    imageBucket: imageBucketOf(imageCount),
    infoFields,
    infoFieldCount: infoFields.length,
    hasDescription: Boolean(pageInfo.description),
    hasCanonical: Boolean(pageInfo.canonicalUrl),
    hasSiteName: Boolean(pageInfo.siteName),
    lang: String(pageInfo.lang || ''),
    langFamily: langFamilyOf(title),
    titleLength: title.trim().length,
    titleBucket: titleBucketOf(title)
  };
}

/**
 * Short fingerprint of a page structure (requirements doc §10).
 * Example: gallery + h1 + og:title + no JSON-LD + 40+ images + info block + SPA
 *          -> `G-H1-OG-NJ-IMG40-INFO-SPA`
 */
export function fingerprintOf(features = {}) {
  const prefix = PAGE_TYPE_PREFIX[features.pageType] || PAGE_TYPE_PREFIX.unknown;
  const parts = [
    prefix,
    features.h1 ? 'H1' : 'NH1',
    features.ogTitle ? 'OG' : 'NOG',
    features.jsonLd ? 'JL' : 'NJ',
    features.imageBucket || imageBucketOf(features.imageCount),
    features.galleryInfo ? 'INFO' : 'NOINFO',
    features.spaNavigation ? 'SPA' : 'STATIC'
  ];
  return parts.join('-');
}

/** Human-readable fingerprint lines (requirements doc §10 first example) */
export function fingerprintLines(features = {}) {
  return [
    `${features.pageType || 'unknown'}`,
    `h1=${features.h1 ? 'yes' : 'no'}`,
    `og=${features.ogTitle ? 'yes' : 'no'}`,
    `jsonld=${features.jsonLd ? 'yes' : 'no'}`,
    `${(Number(features.imageCount) || 0) >= 40 ? 'images=40+' : `images=${Number(features.imageCount) || 0}`}`,
    `info-block=${features.galleryInfo ? 'yes' : 'no'}`,
    `spa=${features.spaNavigation ? 'yes' : 'no'}`
  ];
}

/**
 * Structured summary of a URL shape, with ids and slug text masked
 * (requirements doc §6 `urlPattern`, §9 anonymisation): `/g/000123/` becomes
 * `/g/:id`, `/doujinshi/some-slug-japanese-000000-1.html#1` becomes
 * `/doujinshi/:slug.html`.
 */
export function urlPatternOf(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return '';
  }
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => {
    const decoded = segment.replace(/%[0-9A-Fa-f]{2}/g, '');
    const [name, ...rest] = decoded.split('.');
    const extension = rest.length ? `.${rest.join('.')}` : '';
    if (/^\d+$/.test(name)) return `:id${extension}`;
    if (!name) return `:slug${extension}`;
    if (name.length > 16) return `:slug${extension}`;
    if (/[^\x20-\x7E]/.test(name)) return `:slug${extension}`;
    if (/\d/.test(name) && /[A-Za-z]/.test(name)) return `:slug${extension}`;
    return `${name.toLowerCase()}${extension}`;
  });
  const shown = segments.slice(0, 4).join('/');
  const suffix = segments.length > 4 ? '/…' : '';
  const pattern = `/${shown}${suffix}`;
  return url.pathname.endsWith('/') && shown ? `${pattern}/` : pattern;
}

export function originOf(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return '';
  }
}

/** Local-only page identity (origin + path, query dropped) */
export function pageKeyOf(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(value || '');
  }
}

/** Feature tokens used for the novelty comparison */
export function featureTokens(features = {}) {
  return {
    type: `type:${features.pageType || 'unknown'}`,
    h1: `h1:${features.h1 ? 1 : 0}`,
    og: `og:${features.ogTitle ? 1 : 0}`,
    jl: `jl:${features.jsonLd ? 1 : 0}`,
    img: `img:${features.imageBucket || imageBucketOf(features.imageCount)}`,
    info: `info:${features.galleryInfo ? 1 : 0}`,
    spa: `spa:${features.spaNavigation ? 1 : 0}`,
    chapter: `chapter:${features.chapterMarker ? 1 : 0}`,
    lang: `lang:${features.langFamily || 'none'}`,
    title: `title:${features.titleBucket || 'none'}`
  };
}

/** Weighted Jaccard similarity of two feature token maps (0..1) */
function similarityBetween(a, b) {
  let intersection = 0;
  let union = 0;
  for (const key of Object.keys(TOKEN_WEIGHTS)) {
    const weight = TOKEN_WEIGHTS[key];
    const left = a?.[key];
    const right = b?.[key];
    if (left === undefined && right === undefined) continue;
    union += weight;
    if (left !== undefined && left === right) intersection += weight;
  }
  if (!union) return 1;
  return intersection / union;
}

/**
 * Novelty score 0–100 (requirements doc §12).
 * 0–20 duplicate / 21–50 minor new feature / 51–80 clearly new / 81–100 new type.
 *
 * @param {object} features            features of the page being scored
 * @param {Array<object>} known        features (or {features}) of the pages already collected
 */
export function noveltyScore(features, known = []) {
  const tokens = featureTokens(features);
  let maxSimilarity = 0;
  const similarTo = [];
  known.forEach((entry, index) => {
    const other = entry?.features ? entry.features : entry;
    const similarity = similarityBetween(tokens, featureTokens(other));
    if (similarity >= maxSimilarity) maxSimilarity = similarity;
    if (similarity >= 0.85) similarTo.push({ index, reference: entry?.id || entry?.fingerprint || '', similarity: Number(similarity.toFixed(3)) });
  });
  const score = Math.max(0, Math.min(100, Math.round((1 - maxSimilarity) * 100)));
  return {
    score,
    maxSimilarity: Number(maxSimilarity.toFixed(3)),
    verdict: noveltyVerdict(score),
    similarTo
  };
}

export function noveltyVerdict(score) {
  const value = Number(score) || 0;
  return (NOVELTY_BANDS.find((band) => value <= band.max) || NOVELTY_BANDS[NOVELTY_BANDS.length - 1]).verdict;
}

/**
 * The message the popup shows (requirements doc §11): "This page is
 * structurally similar to an existing test case." / "New page structure
 * detected."
 */
export function noveltyMessage(score) {
  const verdict = noveltyVerdict(score);
  if (verdict === 'duplicate') return 'This page is structurally similar to an existing test case.';
  if (verdict === 'minor-new') return 'Minor new features detected.';
  if (verdict === 'clearly-new') return 'New page structure detected.';
  return 'New page structure type detected.';
}

/**
 * Test-case category (requirements doc §13 `category`), e.g. `spa-gallery`.
 * The category also decides which tests/real-world/ sub-directory the case is
 * imported into (requirements doc §16).
 */
export function categoryOf(features = {}) {
  const base = features.pageType || 'unknown';
  if (features.spaNavigation) return `spa-${base}`;
  if (features.chapterMarker && base !== 'gallery') return `${base}-chapter`;
  if (!features.h1 && !features.ogTitle && !features.jsonLd) return 'meta-poor';
  if (!features.h1) return `${base}-no-h1`;
  return `static-${base}`;
}

/**
 * Which tests/real-world/ category directory a case belongs to
 * (requirements doc §16). The category written in the case file stays the
 * specific one (`spa-gallery`); this only picks the directory.
 */
export function categoryDirOf(category, features = {}) {
  const value = String(category || '');
  for (const dir of ['extraction', 'cleaning', 'matching', 'navigation', 'store', 'performance', 'negative']) {
    if (value === dir) return dir;
  }
  if (features.spaNavigation || value.startsWith('spa-')) return 'navigation';
  if (value === 'negative' || value === 'not-a-work-page') return 'negative';
  if (features.pageType === 'listing' || features.pageType === 'article') return 'negative';
  if (!features.galleryInfo) return 'cleaning';
  return 'extraction';
}

/** Short, non-reversible key so the same work can be correlated locally without its name */
export function shortHash(value, length = 8) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, length);
}

/** The title's writing system, kept even when the title itself is redacted */
export function scriptOf(value) {
  const text = String(value || '');
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  const han = /\p{Script=Han}/u.test(text);
  const latin = /[A-Za-z]/.test(text);
  const kinds = [kana || han ? 'cjk' : '', latin ? 'latin' : '', /\d/.test(text) ? 'digit' : ''].filter(Boolean);
  if (!kinds.length) return 'none';
  return kinds.join('+');
}
