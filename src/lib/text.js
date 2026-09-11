/**
 * Pure string helpers shared by the title cleaner and the matcher.
 * No browser API is used here, so everything is testable in plain Node.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  times: '×',
  yen: '¥'
};

/** Decode HTML entities, including numeric ones */
export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return match;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/** Strip tags and decode entities */
export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function collapseSpaces(text) {
  return String(text ?? '').replace(/[\s\u3000]+/g, ' ').trim();
}

/** NFKC normalisation plus whitespace collapsing */
export function normalizeText(text) {
  return collapseSpaces(String(text ?? '').normalize('NFKC'));
}

/**
 * Minimal form used for similarity comparison: no whitespace, no punctuation
 * or symbols, lower-cased. CJK has no word boundaries, so comparing characters
 * is more reliable than comparing words.
 */
export function normalizeForMatch(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
}

/**
 * Form used as the keyword when searching a store.
 *
 * Store search engines are punctuation-sensitive in a way that silently returns
 * zero results: measured in 2026-09, a keyword such as `サンプル！作品 第2巻`
 * returned 0 items on Melonbooks, while `サンプル 作品 第2巻` found the product.
 * Replacing punctuation and symbols with a space (instead of deleting them,
 * which would glue words together) keeps the search working, and scores are
 * unaffected because the matcher strips punctuation anyway.
 */
export function toStoreQuery(text) {
  return collapseSpaces(normalizeText(text).replace(/[\p{P}\p{S}]+/gu, ' '));
}

const CHAPTER_PATTERNS = [
  /第\s*\d{1,4}(?:\.\d+)?\s*[話话回巻卷集章幕]/g,
  /第\s*[一二三四五六七八九十百千]+\s*[話话回巻卷集章幕]/g,
  /\d{1,4}\s*[話话回]/g,
  /\d{1,4}\s*[巻卷]/g,
  /(?:ep|episode|chapter|ch|vol|volume)\.?\s*\d{1,4}/gi,
  /#\s*\d{1,4}/g,
  /[（(]\s*\d{1,4}\s*[/／]\s*\d{1,4}\s*[)）]/g,
  /(?:全|共)\s*\d{1,4}\s*[話话回巻卷]/g,
  /(?:[\s\-–—_]+)\d{1,3}\s*$/g
];

/** Remove chapter markers such as 第12话 / 第3巻 / Episode 4 / #5 / 12 */
export function stripChapterMarkers(text) {
  let out = normalizeText(text);
  for (const pattern of CHAPTER_PATTERNS) out = out.replace(pattern, ' ');
  return collapseSpaces(out);
}

/** Extract the chapter number from a title, used for the "same volume/episode" bonus */
export function extractChapterNumber(text) {
  const normalized = normalizeText(text);
  const patterns = [
    /第\s*(\d{1,4})\s*[話话回巻卷集章幕]/,
    /(\d{1,4})\s*[話话回巻卷]/,
    /(?:vol|volume|chapter|ep|episode)\.?\s*(\d{1,4})/i,
    /#\s*(\d{1,4})/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

/** Strip leading/trailing decoration blocks such as 【】「」『』（）[] (e.g. 【Android版】, [circle name]) */
export function stripDecoration(text) {
  let out = normalizeText(text);
  const leading = /^\s*[【[（(「『〈《<][^】\]）)」』〉》>]{1,40}[】\]）)」』〉》>]\s*/;
  const trailing = /\s*[【[（(「『〈《<][^】\]）)」』〉》>]{1,40}[】\]）)」』〉》>]\s*$/;
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    out = out.replace(leading, '').replace(trailing, '');
    if (out === before) break;
  }
  return collapseSpaces(out);
}

/** Character bigrams of a string (used by the Dice coefficient) */
export function bigrams(text) {
  const chars = Array.from(text);
  if (chars.length < 2) return chars.slice();
  const result = [];
  for (let i = 0; i < chars.length - 1; i += 1) result.push(chars[i] + chars[i + 1]);
  return result;
}

/** Dice coefficient: more stable than edit distance on short CJK titles */
export function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map();
  for (const gram of A) counts.set(gram, (counts.get(gram) || 0) + 1);
  let intersection = 0;
  for (const gram of B) {
    const remaining = counts.get(gram) || 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (A.length + B.length);
}

/** Longest common subsequence ratio: handles insertions/deletions of a few characters */
export function lcsRatio(a, b) {
  const A = Array.from(a);
  const B = Array.from(b);
  if (!A.length || !B.length) return 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j += 1) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[B.length] / Math.max(A.length, B.length);
}

export function truncate(text, max = 80) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Does the text contain CJK characters or letters? (filters out symbol-only candidates) */
export function hasMeaningfulChars(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}]/u.test(String(text ?? ''));
}
