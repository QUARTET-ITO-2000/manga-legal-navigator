/**
 * Work title extraction and cleaning (requirements doc §6 page extraction, §7 title cleaning).
 *
 * Design principle: under-cleaning is better than over-cleaning.
 * The cleaner therefore returns several search variants; when the first one
 * finds nothing the background tries the next, instead of betting everything on
 * one guess.
 */

import { CONFIG } from './config.js';
import {
  collapseSpaces,
  decodeEntities,
  extractChapterNumber,
  hasMeaningfulChars,
  normalizeText,
  stripChapterMarkers
} from './text.js';

/** A segment matching one of these patterns is almost certainly a site name or ad text, not a title */
const SITE_NOISE_PATTERNS = [
  /(?:漫画|漫畫|マンガ|コミック|comic|manga)\s*(?:网|網|屋|吧|站|網站|网站|之家|空间|小站|世界|大全|馆|館|库|庫|图|圖|城|社)/i,
  /(?:免费|免費|無料|在线|在線|在线阅读|在线观看|試し読み|立ち読み|ネタバレ|汉化|漢化|生肉|raw|盗版|小說|小说)/i,
  /(?:官网|官方|網站|网站|首頁|首页|最新|更新|连载|連載|全集|全卷|全巻|免费阅读|免費閱讀)/i,
  /\b(?:read|online|free|raw|scan)\b/i,
  /\.(?:com|net|org|cc|me|tv|xyz|top|site|info|club|vip|cn|jp|tw|io|app|us|biz|fun|art)\b/i
];

/**
 * Common section/UI headings. They are also h2/h3 elements but are not titles,
 * e.g. "More Like This" or "Post a comment" on gallery sites.
 */
const SECTION_HEADING_PATTERNS = [
  /^more like this$/i,
  /^post a comment$/i,
  /^comments?$/i,
  /^recommend(ed|ations)?$/i,
  /^related( works?| galleries?)?$/i,
  /^you may also like$/i,
  /^tags?$/i,
  /^artists?$/i,
  /^groups?$/i,
  /^languages?$/i,
  /^categories$/i,
  /^pages?$/i,
  /^parodies$/i,
  /^uploaded$/i,
  /^download$/i,
  /^save this search$/i,
  /^search$/i,
  /^filter/i,
  /^sort/i,
  /^settings$/i,
  /^show (?:more|all)$/i,
  /^おすすめ$/,
  /^関連(作品)?$/,
  /^コメント$/,
  /^作者/,
  /^タグ$/,
  /^シリーズ/,
  /^この作品を買った人/,
  /^レビュー$/,
  /^概要$/,
  /^作品情報$/
];

/** Chapter headings, section headings and id-like headings (#12345) never count as titles */
function isSectionHeading(text) {
  const value = collapseSpaces(text);
  if (!value) return true;
  if (/^#?\d{3,}$/.test(value)) return true;
  return SECTION_HEADING_PATTERNS.some((pattern) => pattern.test(value));
}

/** Noise words that can safely be trimmed from either end (never from the middle, to protect real titles) */
const BOUNDARY_NOISE_TOKENS = [
  '無料', '免费', '免費', '在线', '在線', '在线阅读', '在线阅读', '在线观看', '全文',
  '漫画', '漫畫', 'マンガ', 'コミック', 'comic', 'manga',
  'raw', '生肉', '汉化', '漢化', '试看', '試し読み', '立ち読み',
  '连载', '連載', '完结', '完結', '最新', '更新', '全集', '全巻', '全卷', '免费阅读', '免費閱讀'
];

/**
 * Strong noise markers: once one appears, everything after it is almost
 * certainly a site or section name. These words practically never occur inside
 * a real title (note: a bare "漫画" is deliberately not included, to avoid
 * damaging titles that contain it).
 */
const STRONG_NOISE_PATTERNS = [
  /免费|免費|無料/,
  /在线阅读|在线阅读|在线观看|在线漫画|在線|在线/,
  /(?:漫画|漫畫|マンガ|コミック)(?:网|網|屋|吧|站|網站|网站|之家|空间|世界|大全|馆|館|库|庫|圖|图)/,
  /汉化|漢化|生肉|熟肉/,
  /试看|試し読み|立ち読み|ネタバレ/,
  /最新章节|最新話|全巻|全卷/,
  /\braw\b|\bR18\b/i
];

// Separators: | ｜ / ／ » « › 、:: 、_ , " - " (with spaces) and "– —" (including the NFKC form of ︱, which splits without spaces)
const SEPARATOR_PATTERN = /\s*[|｜/／»«›]\s*|\s*::\s*|\s*[–—]+\s*|\s+-\s*|_+/;
const KANA_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_PATTERN = /\p{Script=Han}/u;

const TRAILING_PUNCTUATION = /^[\s\-–—_·•|｜/、,，.。:：;；!！?？~～]+|[\s\-–—_·•|｜/、,，.。:：;；!！?？~～]+$/g;
const BRACKET_PAIRS = [['【', '】'], ['[', ']'], ['（', '）'], ['(', ')'], ['「', '」'], ['『', '』'], ['〈', '〉'], ['《', '》'], ['<', '>']];

/** Split a leading bracket block into "inside the brackets" + "the rest"; brackets must pair up (nesting supported) */
function splitLeadingBracket(text) {
  const value = collapseSpaces(text);
  if (!value) return { inner: '', rest: '', matched: false };
  const pair = BRACKET_PAIRS.find(([open]) => value.startsWith(open));
  if (!pair) return { inner: '', rest: '', matched: false };
  const [open, close] = pair;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === open) depth += 1;
    else if (value[i] === close) {
      depth -= 1;
      if (depth === 0) {
        const inner = collapseSpaces(value.slice(1, i));
        const rest = collapseSpaces(value.slice(i + 1));
        if (!inner) return { inner: '', rest: '', matched: false };
        return { inner, rest, matched: true };
      }
    }
  }
  return { inner: '', rest: '', matched: false };
}

/** If the whole string is wrapped in one pair of brackets, return its contents */
function unwrapIfFullyWrapped(text) {
  const { inner, rest, matched } = splitLeadingBracket(text);
  if (matched && !rest) return inner;
  return null;
}

/**
 * Version/language tags at the end ([DL版] [英訳] [English] [Digital] …).
 * They are virtually never part of a title but appear constantly at the end of
 * doujinshi site titles.
 */
const EDITION_LABEL = [
  'DL版', 'DL', 'ダウンロード版', '英訳', '英語', 'English', 'Chinese', '中文', '中文版',
  '漢化', '汉化', '汉化组', '漢化組', '翻訳', '翻訳版', 'Translated', 'Digital', 'デジタル',
  '無修正', 'Uncensored', 'Censored', 'Raw', '生肉', '熟肉', '日本語訳', '日本語版',
  '個人翻訳', '个人汉化', '機翻', '机翻', '嵌字', 'モザイク', '修正版', '再録', '再录'
];
const TRAILING_LABEL_PATTERN = new RegExp(
  String.raw`[\s\-–—_·•|｜]*[\[【（(「『]\s*(?:${EDITION_LABEL.join('|')})\s*[\]】）)」』]`,
  'gi'
);

/**
 * Trailing bracketed blocks that contain only Latin letters/digits
 * (`[mysterymeat3]`, `[English]`, `[Digital]` …). Japanese titles rarely end
 * that way, so they can safely be dropped as translation/release tags.
 */
const TRAILING_LATIN_BRACKET = /[\s\-–—_·•|｜]*[\[【（(]\s*[A-Za-z0-9][A-Za-z0-9 .,'&_\-]{0,24}\s*[\]】）)]/g;

/**
 * Trailing translation/scanlation brackets (`[中国翻訳]`, `[サンプル汉化组]`, `[个人汉化]` …).
 * They usually contain a scanlation group's name, which cannot be enumerated,
 * so they are matched by keyword.
 */
const TRAILING_TRANSLATION_BRACKET =
  /[\s\-–—_·•|｜]*[\[【（(][^\[\]【】（）()]{0,24}(?:汉化|漢化|翻译|翻譯|翻訳|中文|中国語|日本語訳|个人|個人|机翻|機翻|赞助|贊助|掃圖|扫图)[^\[\]【】（）()]{0,24}[\]】）)]/g;

/**
 * A trailing bracketed block that describes where or how the work was published
 * rather than being part of its title:
 *   (サンプルマガジン Vol.54)  magazine issue
 *   (…ページ)                  page count
 *   (C…)                       event edition
 * These are removed *before* chapter/volume numbers are stripped: stripping the
 * volume number first leaves a dangling `(name )` behind, and a keyword with
 * that dangling bracket makes the store search return 0 results (measured).
 */
const TRAILING_ANNOTATION_HINT = /\d|ページ|page|vol\.?|号|巻|収録|版/i;
const TRAILING_BRACKET_AT_END = /[\s\-–—_·•|｜]*([\[【（(][^\[\]【】（）()]{1,60}[\]】）)])\s*$/;

function stripTrailingSourceAnnotation(text) {
  let out = collapseSpaces(text);
  for (let i = 0; i < 3; i += 1) {
    const match = out.match(TRAILING_BRACKET_AT_END);
    if (!match) break;
    if (!TRAILING_ANNOTATION_HINT.test(match[1].slice(1, -1))) break;
    const head = collapseSpaces(out.slice(0, match.index));
    if (meaningfulLength(head) < 2) break; // never strip the title away entirely
    out = head;
  }
  return out;
}

/** Does the bracket content look like a circle/author name (Latin letters, possibly with a bracketed note) rather than a title? */
function looksLikeCircleName(text) {
  const value = collapseSpaces(text);
  if (!value || value.length > 40) return false;
  return /^[\sA-Za-z0-9.,'&()\-_!?☆★♪~・]+$/.test(value);
}

function stripEditionLabels(text) {
  let out = collapseSpaces(text);
  for (let i = 0; i < 6; i += 1) {
    const next = collapseSpaces(
      out
        .replace(TRAILING_LABEL_PATTERN, ' ')
        .replace(TRAILING_TRANSLATION_BRACKET, ' ')
        .replace(TRAILING_LATIN_BRACKET, ' ')
    );
    if (next === out) break;
    if (meaningfulLength(next) < 2) break; // do not strip the title away entirely
    out = next;
  }
  return out;
}

/** Comparison key with all bracket content removed, used to tell whether two variants are the same title */
function variantKey(text) {
  return String(text ?? '')
    .replace(/[\[【（(「『〈《<][^\]】）)」』〉》>]{0,60}[\]】）)」』〉》>]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

function isNoiseSegment(segment, host) {
  const value = collapseSpaces(segment);
  if (!value) return true;
  if (value.length <= 1) return true;
  if (SITE_NOISE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  if (host) {
    const hostCore = host.replace(/^www\./, '').split('.')[0].toLowerCase();
    if (hostCore.length >= 3 && value.toLowerCase().includes(hostCore)) return true;
  }
  return false;
}

function stripBoundaryNoise(text) {
  let out = collapseSpaces(text);
  // First cut at a strong noise marker (keeping the head), e.g. "title 第12话 free manga example-site"
  for (const pattern of STRONG_NOISE_PATTERNS) {
    const match = pattern.exec(out);
    if (!match) continue;
    const head = collapseSpaces(out.slice(0, match.index));
    if (meaningfulLength(head) >= 2 && match.index >= 2 && meaningfulLength(head) < meaningfulLength(out)) {
      out = head;
      break;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const token of BOUNDARY_NOISE_TOKENS) {
      const lower = out.toLowerCase();
      if (lower.startsWith(token.toLowerCase()) && out.length - token.length >= 2) {
        out = out.slice(token.length).trim();
        changed = true;
      }
      if (lower.endsWith(token.toLowerCase()) && out.length - token.length >= 2) {
        out = out.slice(0, out.length - token.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** Number of meaningful characters once whitespace and punctuation are removed */
function meaningfulLength(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '').length;
}

function trimPunctuation(text) {
  return collapseSpaces(
    String(text ?? '')
      // Remove empty brackets left behind by cleaning: `[ ]` `【】` `（）`
      .replace(/[\[【（(「『]\s*[\]】）)」』]/g, ' ')
      .replace(TRAILING_PUNCTUATION, '')
  );
}

function unwrapLeadingBracket(text) {
  const { inner, rest, matched } = splitLeadingBracket(text);
  if (!matched) return { value: collapseSpaces(text), inner: '', rest: '', unwrapped: false };
  return { value: collapseSpaces(`${inner} ${rest}`), inner, rest, unwrapped: true };
}

/**
 * Clean a single title string.
 * @returns {{rawTitle:string, cleaned:string, confidence:'high'|'medium'|'low', notes:string[], chapterHint:number|null}}
 */
export function cleanTitle(rawTitle, options = {}) {
  const host = (options.host || '').toLowerCase();
  const raw = collapseSpaces(decodeEntities(rawTitle));
  const notes = [];
  const chapterHint = extractChapterNumber(raw);

  if (!raw) {
    return { rawTitle: raw, cleaned: '', confidence: 'low', notes: ['empty'], chapterHint: null };
  }

  let working = normalizeText(raw);

  // A title fully wrapped in brackets such as 【作品名】: take the contents
  const fullyWrapped = unwrapIfFullyWrapped(working);
  if (fullyWrapped && hasMeaningfulChars(fullyWrapped)) {
    working = collapseSpaces(fullyWrapped);
    notes.push('unwrapped');
  }

  // Split on separators to find site-name / ad-text segments
  const segments = working.split(SEPARATOR_PATTERN).map((part) => part.trim()).filter(Boolean);
  let titleSegment = working;
  if (segments.length > 1) {
    const infos = segments.map((segment, index) => {
      const stripped = collapseSpaces(stripBoundaryNoise(stripChapterMarkers(unwrapLeadingBracket(segment).value)));
      return { segment, index, stripped, contentLength: meaningfulLength(stripped) };
    });
    const maxContent = Math.max(...infos.map((info) => info.contentLength));
    const isNoisy = (info) => {
      if (isNoiseSegment(info.segment, host)) return true;
      if (info.contentLength === 0) return true;
      // In structures like "title - episode 3 - site name" the short trailing segments are site/section names
      if (info.index > 0 && info.contentLength <= 4 && maxContent >= info.contentLength * 3) return true;
      return false;
    };
    let noiseInfos = infos.filter(isNoisy);
    let meaningfulInfos = infos.filter((info) => !isNoisy(info));
    // Bilingual title (Japanese original ︱ Chinese translation): when exactly one segment contains kana, that is the original and the others are dropped as translations
    if (noiseInfos.length === 0 && meaningfulInfos.length > 1) {
      const kanaInfos = meaningfulInfos.filter((info) => KANA_PATTERN.test(info.segment));
      const others = meaningfulInfos.filter((info) => !KANA_PATTERN.test(info.segment));
      if (kanaInfos.length === 1 && others.length > 0 && others.every((info) => HAN_PATTERN.test(info.segment))) {
        noiseInfos = others;
        meaningfulInfos = kanaInfos;
      }
    }
    if (noiseInfos.length > 0 && meaningfulInfos.length > 0) {
      // In "A - B - C" / "A | B" style titles the work name almost always comes
      // first; taking the *longest* segment used to pick the English subtitle
      // (subtitles are usually longer), so the first usable segment wins now.
      const bracketed = meaningfulInfos.find((info) => unwrapIfFullyWrapped(info.segment));
      const firstUsable = meaningfulInfos.find((info) => info.contentLength >= 2);
      const chosen = bracketed || firstUsable || meaningfulInfos[0];
      titleSegment = chosen.segment;
      notes.push(`dropped-site-segment:${noiseInfos.map((info) => info.segment).join('|')}`);
    }
  }

  // Trailing edition/language labels are removed before the leading label is
  // unwrapped, so a source annotation sitting in front of them
  // (… (サンプルマガジン Vol.54) [DL版]) is still the last bracket and can be
  // recognised as one. Stripping the volume number first would leave a dangling
  // "(name )" behind, and a keyword with that dangling bracket makes the store
  // search return 0 results (measured on DLsite).
  const beforeEdition = collapseSpaces(titleSegment);
  titleSegment = stripEditionLabels(titleSegment);
  if (titleSegment !== beforeEdition) notes.push('stripped-edition-label');

  const beforeAnnotation = collapseSpaces(titleSegment);
  titleSegment = stripTrailingSourceAnnotation(titleSegment);
  if (titleSegment !== beforeAnnotation) notes.push('stripped-source-annotation');

  const unwrapped = unwrapLeadingBracket(collapseSpaces(titleSegment));
  if (unwrapped.unwrapped && hasMeaningfulChars(unwrapped.value)) {
    const innerRest = collapseSpaces(stripChapterMarkers(unwrapped.rest));
    const innerLength = meaningfulLength(unwrapped.inner);
    const restLength = meaningfulLength(innerRest);
    const circleLike = looksLikeCircleName(unwrapped.inner) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(innerRest);
    // For "[circle/author/edition] work title" the leading bracket labels the
    // work that follows; when the bracket *is* the title (【作品名称】第12话)
    // the length check below keeps it, because only a chapter number remains.
    if (innerLength > 0 && restLength >= 4) {
      titleSegment = innerRest;
      notes.push('dropped-prefix-label');
    } else {
      titleSegment = unwrapped.value;
      notes.push('unwrapped-leading');
    }
  }

  const beforeChapterStrip = collapseSpaces(titleSegment);
  titleSegment = stripChapterMarkers(titleSegment);
  if (titleSegment !== beforeChapterStrip) notes.push('stripped-chapter');

  const beforeBoundary = titleSegment;
  titleSegment = stripBoundaryNoise(titleSegment);
  if (titleSegment !== beforeBoundary) notes.push('stripped-noise-word');

  const cleaned = trimPunctuation(titleSegment);

  let confidence = 'medium';
  if (!hasMeaningfulChars(cleaned) || cleaned.length < 2) confidence = 'low';
  else if (notes.some((note) => (
    note.startsWith('dropped-site-segment')
    || note === 'unwrapped'
    || note === 'stripped-chapter'
    || note === 'dropped-prefix-label'
    || note === 'stripped-edition-label'
  ))) {
    confidence = 'high';
  }

  return { rawTitle: raw, cleaned, confidence, notes, chapterHint };
}

/**
 * Labels that appear inside a gallery info block. They mark where one field
 * ends and the next one starts, so a value can be sliced out of the flat text.
 */
const INFO_LABELS = [
  'parodies?', 'tags?', 'groups?', 'artists?', 'circles?', 'authors?', 'characters?',
  'languages?', 'categories?', 'pages?', 'uploaded', 'favorites?'
].join('|');
/** Labels whose value is an artist / circle name. */
const ARTIST_LABELS = 'artists?|circles?|groups?|authors?';
/** Values that look like an artist name but are actually a category or a flag. */
const NOT_AN_ARTIST = /^(?:original|japanese|english|chinese|translated|doujinshi|manga|various|none|unknown|full[- ]?color)$/i;

/**
 * Artist / circle names taken from the page's info block (`Artists: …`,
 * `Groups: …`).
 *
 * This is the fallback search term: a work can be stored under a *different*
 * title on another site (Pixiv often renames it), but the author usually stays
 * the same, so searching by author is what finds those works.
 */
export function extractArtistNames(pageInfo = {}) {
  const out = [];
  const push = (raw) => {
    const name = collapseSpaces(raw)
      .replace(/^#+/, '')
      // parenthetical notes inside the label ("Circle Name (Author)")
      .replace(/[（(].*$/, '')
      // gallery sites append a number to disambiguate identical slugs
      // ("ra-men 171"), which is unsearchable elsewhere
      .replace(/\s+\d{1,4}$/, '')
      .trim();
    if (name.length < 2 || name.length > 40) return;
    if (NOT_AN_ARTIST.test(name) || /^\d+$/.test(name)) return;
    if (out.some((item) => item.toLowerCase() === name.toLowerCase())) return;
    out.push(name);
  };

  // 1) The Japanese name, taken from the bracketed prefix of a Japanese
  //    heading: "[踊るロンドン] お狐様ともう一匹の妖怪" -> 踊るロンドン.
  //    This matters because the info block's Artists/Groups fields carry the
  //    romanised slug ("ra-men"), and searching a Japanese site with that finds
  //    nobody.
  const headings = [
    ...(Array.isArray(pageInfo.h2) ? pageInfo.h2 : []),
    ...(Array.isArray(pageInfo.h3) ? pageInfo.h3 : []),
    ...(Array.isArray(pageInfo.headings) ? pageInfo.headings.map((item) => item?.text || '') : [])
  ];
  for (const heading of headings) {
    const match = String(heading || '').match(/^\s*[\[【]\s*([^\]】]{2,40}?)\s*[\]】]/);
    if (!match) continue;
    if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(match[1])) continue;
    push(match[1]);
  }
  // Japanese names win: a Japanese site cannot be searched with a romanised one.
  if (out.length) return out.slice(0, 2);

  // 2) Fall back to the Artists/Groups fields of the info block (usually the
  //    romanised slug).
  const infoText = String(pageInfo.infoText || '');
  if (!infoText) return [];
  const pattern = new RegExp(
    `(?:${ARTIST_LABELS})\\s*[:：]\\s*([\\s\\S]*?)(?=\\s*(?:${INFO_LABELS})\\s*[:：]|$)`,
    'gi'
  );
  for (const match of infoText.matchAll(pattern)) {
    for (const part of String(match[1]).split(/[|｜/／、,，;；]\s*/)) {
      push(part);
    }
  }
  return out.slice(0, 3);
}

/** Gather every usable title source on the page (requirements doc §6 priority order) */
export function collectTitleSources(pageInfo = {}) {
  const headings = (key, weight, limit = 3) => (Array.isArray(pageInfo[key]) ? pageInfo[key] : [pageInfo[key]])
    .filter((value) => value && String(value).trim() && !isSectionHeading(value))
    .slice(0, limit)
    .map((value, index) => ({ source: `${key}[${index}]`, weight: weight - index * 0.1, value }));

  // Prefer the levelled heading list collected by the content script
  // (h1–h4 / role="heading" / .title): it survives gallery sites changing their
  // markup better than reading h1/h2/h3 directly. Fall back to tag-based
  // collection when it is missing.
  const headingSources = (Array.isArray(pageInfo.headings) && pageInfo.headings.length
    ? pageInfo.headings
      .filter((item) => item && item.text && String(item.text).trim() && !isSectionHeading(item.text))
      .map((item) => {
        const level = Math.min(Math.max(Number(item.level) || 3, 1), 4);
        const tag = String(item.tag || `h${level}`).toLowerCase();
        return { source: `${tag}(h${level})`, weight: 3 - (level - 1) * 0.4, value: item.text };
      })
    : [
      ...headings('h1', 3),
      ...headings('h2', 2.6),
      ...headings('h3', 2)
    ])
    // Drop headings that repeat the previous source verbatim (gallery sites often render the same title twice)
    .filter((entry, index, list) => !list.slice(0, index).some((other) => other.value === entry.value));

  return [
    { source: 'title', weight: 4.5, value: pageInfo.title },
    ...headingSources,
    { source: 'og:title', weight: 2.5, value: pageInfo.ogTitle },
    { source: 'json-ld', weight: 2, value: pageInfo.jsonLdName }
  ]
    .filter((entry) => entry.value && String(entry.value).trim())
    .map((entry) => {
      const result = cleanTitle(entry.value, { host: pageInfo.host });
      const cleanliness = result.confidence === 'high' ? 2 : result.confidence === 'medium' ? 1 : 0;
      const lengthBonus = Math.min(result.cleaned.length, 30) / 30;
      return {
        ...entry,
        ...result,
        score: entry.weight + cleanliness + lengthBonus
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Decide which work title to search for, and produce a few fallback variants.
 */
export function extractWorkTitle(pageInfo = {}) {
  const sources = collectTitleSources(pageInfo);
  if (!sources.length) {
    return {
      rawTitle: '', source: null, cleanedTitle: '', confidence: 'low',
      notes: ['no-title'], chapterHint: null, variants: [], sources: [],
      artists: extractArtistNames(pageInfo)
    };
  }

  const usable = sources.filter((entry) => entry.confidence !== 'low');
  const primary = (usable[0] || sources[0]);

  const variants = [];
  const variantSources = [];
  const push = (value, source) => {
    const trimmed = collapseSpaces(value || '');
    if (!trimmed || trimmed.length < 2) return;
    // De-duplicate by the bracket-insensitive key: "title [English] [Digital]"
    // and "title" are the same variant, otherwise such duplicates would use up
    // the slots of a genuinely different variant (e.g. the Japanese original).
    const key = variantKey(trimmed);
    if (!key) return;
    if (variants.some((item) => variantKey(item) === key)) return;
    variants.push(trimmed);
    variantSources.push(source || primary.source);
  };

  push(primary.cleaned, primary.source);
  for (const entry of usable.slice(1)) push(entry.cleaned, entry.source);

  // Fallback variant: chapter numbers kept (only obvious site noise removed),
  // for store product names that themselves contain a volume/episode number.
  const rawNormalized = collapseSpaces(pageInfo.title || '');
  if (rawNormalized && rawNormalized.length <= 40 && !isNoiseSegment(rawNormalized, pageInfo.host)) {
    push(rawNormalized, primary.source);
  }

  // Store product names are almost exclusively Japanese, so variants are sorted
  // by "how Japanese do they look" before taking the first few:
  //   2 = contains kana (almost certainly the Japanese original)
  //   1 = kanji only (could be a Japanese kanji title or a Chinese translation)
  //   0 = pure Latin (romanised / English title, usually not searchable there)
  const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const HAN = /\p{Script=Han}/u;
  const rankOf = (text) => (KANA.test(text) ? 2 : (HAN.test(text) ? 1 : 0));
  const ordered = variants
    .map((variant, index) => ({ variant, source: variantSources[index], rank: rankOf(variant), index }))
    .sort((a, b) => (b.rank - a.rank) || (a.index - b.index));

  const limit = Math.max(1, CONFIG.search.maxQueries);
  const limited = ordered.slice(0, limit).map((item) => item.variant);
  const limitedSources = ordered.slice(0, limit).map((item) => item.source);

  return {
    rawTitle: primary.rawTitle,
    source: limitedSources[0] || primary.source,
    // The card and the "search the store" link both use the variant that is actually searched
    cleanedTitle: limited[0] || primary.cleaned,
    confidence: primary.confidence,
    notes: primary.notes,
    chapterHint: primary.chapterHint,
    variants: limited,
    artists: extractArtistNames(pageInfo),
    sources: sources.map(({ source, rawTitle, cleaned, confidence, score }) => ({
      source, rawTitle, cleaned, confidence, score
    }))
  };
}
