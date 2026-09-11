/**
 * Product matching (requirements doc §10).
 *
 * No AI here, only string similarity. Strategies:
 *  1. identical after normalisation -> 100
 *  2. one contains the other -> 48–92, scaled by length ratio
 *  3. character-bigram Dice coefficient (most stable on short CJK titles)
 *  4. longest common subsequence ratio (handles small insertions/deletions)
 * The score is the maximum of the four, and a result is only shown to the user
 * once it crosses the thresholds.
 */

import { CONFIG } from '../lib/config.js';
import {
  diceCoefficient,
  lcsRatio,
  normalizeForMatch,
  normalizeText,
  stripChapterMarkers,
  stripDecoration
} from '../lib/text.js';

function containmentScore(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short || !long.includes(short)) return 0;
  const ratio = short.length / long.length;
  // Deliberately conservative: a containment match only counts as high
  // confidence when the lengths are very close, otherwise it is reported as a
  // "possible" match (requirements doc §22: a wrong recommendation is worse
  // than none).
  if (ratio >= 0.9) return 90;
  if (ratio >= 0.75) return 80;
  if (ratio >= 0.55) return 70;
  if (ratio >= 0.4) return 55;
  return 42;
}

export function similarity(a, b) {
  const A = normalizeForMatch(a);
  const B = normalizeForMatch(b);
  if (!A || !B) return { score: 0, method: 'empty' };
  if (A === B) return { score: 100, method: 'exact' };

  const containment = containmentScore(A, B);
  const dice = Math.round(diceCoefficient(A, B) * 100);
  const lcs = Math.round(lcsRatio(A, B) * 100);
  const best = Math.max(containment, dice, lcs);

  let method = 'dice';
  if (best === containment) method = 'containment';
  else if (best === lcs && lcs > dice) method = 'lcs';

  return { score: best, method };
}

function variantsOf(value) {
  const list = [value];
  const decorationStripped = stripDecoration(value);
  if (decorationStripped && decorationStripped !== value) list.push(decorationStripped);
  const chapterStripped = stripChapterMarkers(decorationStripped || value);
  if (chapterStripped && !list.includes(chapterStripped)) list.push(chapterStripped);
  return list.filter(Boolean);
}

/**
 * Score and rank a batch of store items.
 * @param {string[]} queries search variants (cleaned work titles)
 * @param {Array<object>} items items, each with at least a title
 */
export function rankCandidates(queries, items = [], options = {}) {
  const queryList = (Array.isArray(queries) ? queries : [queries]).filter(Boolean);
  const chapterHint = options.chapterHint ?? null;
  const hintPattern = chapterHint ? new RegExp(`(?:^|[^0-9])${chapterHint}(?:[^0-9]|$)`) : null;
  // The primary variant (the cleaned page title) wins; fallback variants are
  // only used as a safety net, so that a fallback variant which happens to
  // match a different work exactly cannot push the primary result aside.
  const VARIANT_PENALTY = [0, 5, 10];

  const scored = items.map((item, index) => {
    let best = { score: 0, method: 'none', query: queryList[0] || '' };
    const titleVariants = variantsOf(String(item.title || ''));
    queryList.forEach((query, queryIndex) => {
      const penalty = VARIANT_PENALTY[Math.min(queryIndex, VARIANT_PENALTY.length - 1)];
      for (const queryVariant of variantsOf(query)) {
        for (const titleVariant of titleVariants) {
          const { score, method } = similarity(queryVariant, titleVariant);
          const adjusted = Math.max(0, score - penalty);
          if (adjusted > best.score) best = { score: adjusted, rawScore: score, method, query };
        }
      }
    });

    let score = best.score;
    let hintApplied = false;
    if (hintPattern && score >= CONFIG.matcher.possible && hintPattern.test(normalizeText(item.title))) {
      score = Math.min(100, score + CONFIG.matcher.chapterHintBonus);
      hintApplied = true;
    }

    return {
      ...item,
      index,
      score,
      rawScore: best.rawScore ?? best.score,
      method: best.method,
      matchedQuery: best.query,
      chapterHintApplied: hintApplied
    };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored;
}

/**
 * Decide how the result is presented (requirements doc §11).
 * @returns {{kind:'high'|'high_with_alternatives'|'possible'|'none', best:object|null, candidates:object[]}}
 */
export function classify(ranked = [], options = {}) {
  const cfg = { ...CONFIG.matcher, ...(options.thresholds || {}) };
  const top = ranked[0];
  const alternativeCap = cfg.maxCandidates || 3;

  if (!top || top.score < cfg.possible) {
    return {
      kind: 'none',
      best: null,
      candidates: ranked.slice(0, alternativeCap).filter((item) => item.score >= cfg.minCandidate)
    };
  }

  const second = ranked[1];
  const closeTie = Boolean(second && second.score >= cfg.possible && top.score - second.score < cfg.tieMargin);

  if (top.score >= cfg.high) {
    return {
      kind: closeTie ? 'high_with_alternatives' : 'high',
      best: top,
      candidates: closeTie
        ? ranked.slice(0, alternativeCap).filter((item) => item.score >= cfg.minCandidate)
        : [top]
    };
  }

  return {
    kind: 'possible',
    best: top,
    candidates: ranked.slice(0, alternativeCap).filter((item) => item.score >= cfg.minCandidate)
  };
}

/** Match-confidence label (requirements doc §11) */
export function matchLabel(score) {
  if (score >= 90) return '很高';
  if (score >= CONFIG.matcher.high) return '较高';
  if (score >= 70) return '一般';
  return '较低';
}
