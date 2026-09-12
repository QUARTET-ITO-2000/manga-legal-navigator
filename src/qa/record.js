/**
 * QA capture records (requirements doc §6–§14).
 *
 * A capture is the *structured summary* of one visited page plus what the
 * extension made of it. It never contains the page HTML, the images, cookies or
 * the account — only the fields the extractor already reads out of the DOM
 * (src/content/extractor.js) and the analysis result (src/lib/pipeline.js).
 *
 * Records are kept in chrome.storage.local, so they stay on the machine. The
 * export step (src/qa/export.js) is what turns them into a report — anonymised
 * unless the user explicitly asks for real titles.
 */

import { CONFIG } from '../lib/config.js';
import {
  buildFeatures,
  categoryOf,
  fingerprintLines,
  fingerprintOf,
  infoFieldsOf,
  noveltyScore,
  noveltyVerdict,
  originOf,
  pageKeyOf,
  pageTypeOf,
  scriptOf,
  shortHash,
  urlPatternOf
} from './fingerprint.js';

/** Test-result vocabulary (requirements doc §14) */
export const RESULT = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  LIMITATION: 'EXPECTED_LIMITATION',
  NOT_TESTED: 'NOT_TESTED'
};

/** Result fields recorded for every test case (requirements doc §14 / §15) */
export const RESULT_FIELDS = [
  'pageRecognition',
  'titleExtraction',
  'titleCleaning',
  'storeSearch',
  'correctMatch',
  'falsePositive',
  'falseNegative',
  'navigation',
  'requestCount',
  'cacheBehavior'
];

/**
 * The part of the page summary an offline re-run needs
 * (tools/qa-run.mjs replays exactly these fields through the pipeline).
 * Deliberately smaller than what the content script collects: no navHint, no
 * anchor list, no full body text.
 */
const REPLAY_LIMITS = {
  headings: 6,
  headingLength: 120,
  textSample: 400,
  infoText: 600,
  infoFields: 12,
  h1: 3,
  h2: 3,
  h3: 2
};

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clipArray(value, max, length) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map((item) => clip(item, length)).filter(Boolean);
}

/** Structured, replayable page summary — still structured data, not HTML */
export function replayPageInfo(pageInfo = {}) {
  return {
    url: pageInfo.url || '',
    host: pageInfo.host || '',
    origin: pageInfo.origin || originOf(pageInfo.url),
    title: clip(pageInfo.title, 300),
    h1: clipArray(pageInfo.h1, REPLAY_LIMITS.h1, 200),
    h2: clipArray(pageInfo.h2, REPLAY_LIMITS.h2, 200),
    h3: clipArray(pageInfo.h3, REPLAY_LIMITS.h3, 200),
    headings: (Array.isArray(pageInfo.headings) ? pageInfo.headings : [])
      .slice(0, REPLAY_LIMITS.headings)
      .map((item) => ({
        level: Number(item?.level) || 3,
        tag: String(item?.tag || 'h3').toLowerCase(),
        text: clip(item?.text, REPLAY_LIMITS.headingLength)
      }))
      .filter((item) => item.text),
    ogTitle: clip(pageInfo.ogTitle, 300),
    ogType: clip(pageInfo.ogType, 60),
    siteName: clip(pageInfo.siteName, 120),
    description: clip(pageInfo.description, 400),
    keywords: clip(pageInfo.keywords, 200),
    jsonLdName: clip(pageInfo.jsonLdName, 300),
    jsonLdType: clip(pageInfo.jsonLdType, 120),
    jsonLdAuthor: clip(pageInfo.jsonLdAuthor, 120),
    canonicalUrl: pageInfo.canonicalUrl || '',
    ogUrl: pageInfo.ogUrl || '',
    lang: clip(pageInfo.lang, 20),
    imageCount: Number(pageInfo.imageCount) || 0,
    textSample: clip(pageInfo.textSample, REPLAY_LIMITS.textSample),
    infoText: clip(pageInfo.infoText, REPLAY_LIMITS.infoText),
    // Older captures may predate the infoFields field: derive it from infoText
    infoFields: clipArray(infoFieldsOf(pageInfo), REPLAY_LIMITS.infoFields, 24),
    navigationType: pageInfo.navigationType === 'spa' ? 'spa' : 'load',
    analysisCount: Number(pageInfo.analysisCount) || 1,
    settled: pageInfo.settled !== false
  };
}

/** Which store ids were asked, and what came back (requirements doc §23) */
function storesOf(state = null) {
  const list = Array.isArray(state?.stores) ? state.stores : [];
  const order = [];
  const results = {};
  const matchScores = {};
  const health = {};
  const fromCache = {};
  for (const store of list) {
    const id = String(store?.storeId || '');
    if (!id) continue;
    order.push(id);
    if (store.kind === 'high') results[id] = 'found';
    else if (store.kind === 'possible') results[id] = 'possible';
    else if (store.kind === 'error') results[id] = 'error';
    else if (store.kind === 'age_check') results[id] = 'age_check';
    else results[id] = 'not_found';
    if (store.match && Number.isFinite(Number(store.match.score))) matchScores[id] = Number(store.match.score);
    if (store.health) health[id] = String(store.health);
    fromCache[id] = Boolean(store.fromCache);
  }
  return { order, results, matchScores, health, fromCache };
}

function gradeOf(state = null) {
  switch (state?.status) {
    case 'ok_high': return 'found';
    case 'ok_possible': return 'possible';
    case 'no_result': return 'none';
    case 'error': return 'error';
    case 'unrecognized': return 'unrecognized';
    default: return 'unknown';
  }
}

function observationOf({ state, requestStats, capturedAt }) {
  return {
    at: capturedAt,
    analysis: Number(requestStats?.analysis) || 1,
    requests: Number(requestStats?.total) || 0,
    byStore: { ...(requestStats?.byStore || {}) },
    cacheHit: Boolean(requestStats?.cacheHit),
    cacheEntryFound: Boolean(requestStats?.cacheEntryFound),
    grade: gradeOf(state),
    score: state?.match?.score ?? null
  };
}

/**
 * Automatic part of the result table (requirements doc §14).
 * The human-judged fields stay NOT_TESTED until the popup says otherwise.
 */
function autoResults({ state, features, requestStats, observations }) {
  const results = Object.fromEntries(RESULT_FIELDS.map((field) => [field, RESULT.NOT_TESTED]));
  const recognized = gradeOf(state) !== 'unrecognized';
  const queries = Array.isArray(state?.query?.searched) ? state.query.searched : [];

  results.pageRecognition = recognized ? RESULT.PASS : RESULT.FAIL;

  if (recognized) {
    const hasTitle = Boolean(String(state?.query?.cleanedTitle || '').trim());
    results.titleExtraction = hasTitle ? RESULT.PASS : RESULT.FAIL;
    results.titleCleaning = state?.query?.confidence === 'low' ? RESULT.FAIL : RESULT.PASS;
    const kinds = Object.values(storesOf(state).results);
    const errors = kinds.filter((kind) => kind === 'error').length;
    const usable = kinds.filter((kind) => kind === 'found' || kind === 'possible' || kind === 'not_found').length;
    results.storeSearch = !queries.length ? RESULT.NOT_TESTED : (usable ? RESULT.PASS : (errors ? RESULT.FAIL : RESULT.NOT_TESTED));
  }

  // Navigation regression (requirements doc §22): a client-side navigation must
  // not analyse the tree more than a couple of times, and never on a stale DOM.
  if (features.spaNavigation) {
    const analyses = Number(requestStats?.analysis) || 1;
    results.navigation = (analyses <= 4 && state?.page?.settled !== false) ? RESULT.PASS : RESULT.FAIL;
  } else if (state?.page?.settled === false) {
    results.navigation = RESULT.FAIL;
  }

  // Request budget (requirements doc §23): a page that is not a work page must
  // not touch a store at all.
  const budget = recognized ? CONFIG.qa.requestBudget.workPage : CONFIG.qa.requestBudget.nonWorkPage;
  const requests = Number(requestStats?.total) || 0;
  results.requestCount = requests <= budget ? RESULT.PASS : RESULT.FAIL;

  // Cache behaviour (requirements doc §24): a repeat visit must be served from cache.
  const repeats = observations.filter((item) => item.cacheHit);
  if (observations.length > 1) results.cacheBehavior = repeats.length ? RESULT.PASS : RESULT.FAIL;

  return results;
}

/**
 * Build one capture record from a page summary and its analysis result.
 * @param {object} options
 * @param {object} options.pageInfo     structured page summary (content script)
 * @param {object} options.state        analysis result (pipeline)
 * @param {object} options.requestStats { analysis, total, byStore, cacheHit }
 * @param {string} options.id           local capture id, e.g. `QA-0007`
 * @param {Array}  options.known        features of the captures already stored
 */
export function buildCapture({ pageInfo = {}, state = null, requestStats = null, id = '', known = [], capturedAt = Date.now() } = {}) {
  const features = buildFeatures(pageInfo, state);
  const novelty = noveltyScore(features, known);
  const observation = observationOf({ state, requestStats, capturedAt });
  const observations = [observation];
  const stores = storesOf(state);
  const cleanedTitle = String(state?.query?.cleanedTitle || '');

  const capture = {
    schema: 'manga-nav/qa-capture@1',
    id,
    capturedAt,
    origin: originOf(pageInfo.url),
    pageKey: pageKeyOf(pageInfo.url),
    urlPattern: urlPatternOf(pageInfo.url),
    pageType: pageTypeOf(pageInfo, state),
    fingerprint: fingerprintOf(features),
    fingerprintLines: fingerprintLines(features),
    features,
    novelty,
    category: categoryOf(features),
    page: {
      title: String(pageInfo.title || ''),
      titleScript: scriptOf(pageInfo.title),
      titleLength: String(pageInfo.title || '').trim().length,
      headings: (Array.isArray(pageInfo.headings) ? pageInfo.headings : []).slice(0, 6).map((item) => clip(item?.text, 120)),
      hasOgTitle: Boolean(pageInfo.ogTitle),
      hasJsonLd: Boolean(pageInfo.jsonLdName || pageInfo.jsonLdType),
      jsonLdType: String(pageInfo.jsonLdType || ''),
      imageCount: Number(pageInfo.imageCount) || 0,
      infoFieldCount: features.infoFieldCount,
      infoFields: features.infoFields,
      navigationType: features.spaNavigation ? 'spa' : 'load',
      analysisCount: observation.analysis,
      lang: String(pageInfo.lang || ''),
      settled: pageInfo.settled !== false
    },
    extract: {
      recognized: gradeOf(state) !== 'unrecognized',
      reason: state?.reason || '',
      signals: Array.isArray(state?.meta?.signals) ? state.meta.signals.slice(0, 8) : [],
      titleSource: state?.query?.source || '',
      cleanedTitle,
      workKey: cleanedTitle ? shortHash(cleanedTitle) : '',
      cleanedTitleLength: cleanedTitle.length,
      confidence: state?.query?.confidence || '',
      variants: Array.isArray(state?.query?.variants) ? state.query.variants.slice(0, 4) : [],
      searched: Array.isArray(state?.query?.searched) ? state.query.searched.slice(0, 4) : [],
      artists: Array.isArray(state?.query?.artists) ? state.query.artists.slice(0, 3) : [],
      notes: Array.isArray(state?.query?.notes) ? state.query.notes.slice(0, 4) : []
    },
    stores: {
      order: stores.order,
      results: stores.results,
      matchScores: stores.matchScores,
      health: stores.health,
      fromCache: stores.fromCache,
      queries: stores.order.map(() => (state?.query?.searched || [])).flat().slice(0, 6)
    },
    requests: {
      analyses: Number(requestStats?.analysis) || 1,
      total: Number(requestStats?.total) || 0,
      byStore: { ...(requestStats?.byStore || {}) },
      cacheHit: observation.cacheHit,
      cacheEntryFound: observation.cacheEntryFound,
      observations
    },
    match: {
      grade: gradeOf(state),
      score: Number.isFinite(Number(state?.match?.score)) ? Number(state.match.score) : null,
      storeId: state?.match?.store || state?.meta?.storeId || '',
      productKey: state?.match?.productId ? shortHash(String(state.match.productId)) : '',
      productTitle: String(state?.match?.title || ''),
      productTitleScript: scriptOf(state?.match?.title),
      candidateCount: Array.isArray(state?.candidates) ? state.candidates.length : 0,
      falsePositive: null
    },
    errors: Array.isArray(state?.meta?.errors) ? state.meta.errors.slice(0, 4) : [],
    verdict: RESULT.NOT_TESTED,
    note: '',
    pageInfo: replayPageInfo(pageInfo)
  };

  capture.results = autoResults({ state, features, requestStats, observations });
  const judged = capture.results.correctMatch === RESULT.NOT_TESTED;
  capture.judged = !judged;
  return capture;
}

/** Same page revisited: keep the first capture, append the new observation (§24) */
export function mergeCapture(previous, fresh, { maxObservations = 6 } = {}) {
  if (!previous) return fresh;
  const observations = [...(previous.requests?.observations || []), ...(fresh.requests?.observations || [])]
    .slice(-maxObservations);
  const merged = {
    ...previous,
    capturedAt: fresh.capturedAt,
    features: fresh.features,
    fingerprint: fresh.fingerprint,
    fingerprintLines: fresh.fingerprintLines,
    pageType: fresh.pageType,
    category: fresh.category,
    page: { ...fresh.page },
    extract: fresh.extract,
    stores: fresh.stores,
    match: { ...fresh.match, falsePositive: previous.match?.falsePositive ?? null },
    errors: fresh.errors,
    requests: { ...fresh.requests, observations, analyses: observations.length },
    pageInfo: fresh.pageInfo
  };
  merged.verdict = previous.verdict || RESULT.NOT_TESTED;
  merged.note = previous.note || '';
  merged.results = { ...fresh.results };
  // Judgements the human already made survive a re-analysis of the same page.
  for (const field of RESULT_FIELDS) {
    if (previous.results?.[field] && previous.results[field] !== RESULT.NOT_TESTED) merged.results[field] = previous.results[field];
  }
  // Cache evidence is cumulative: remember that a repeat hit the cache.
  if (observations.some((item) => item.cacheHit)) merged.results.cacheBehavior = RESULT.PASS;
  merged.judged = Boolean(previous.judged);
  return merged;
}

export function setVerdict(capture, verdict) {
  const value = Object.values(RESULT).includes(verdict) ? verdict : RESULT.NOT_TESTED;
  return { ...capture, verdict: value };
}

/** A wrong recommendation is the most serious failure mode (requirements doc §15.5) */
export function setFalsePositive(capture, value) {
  if (value === null || value === undefined) {
    return { ...capture, match: { ...capture.match, falsePositive: null } };
  }
  const flag = Boolean(value);
  return {
    ...capture,
    match: { ...capture.match, falsePositive: flag },
    results: { ...capture.results, falsePositive: flag ? RESULT.FAIL : RESULT.PASS, falseNegative: flag ? capture.results.falseNegative : capture.results.falseNegative },
    verdict: flag ? RESULT.FAIL : capture.verdict
  };
}

export function setNote(capture, note) {
  return { ...capture, note: clip(note, 300) };
}

export function findCapture(captures = [], pageKey = '') {
  return captures.find((item) => item.pageKey === pageKey) || null;
}

/** Test case derived from a capture (requirements doc §13) — no real data yet */
export function createCaseRecord(capture, { number = 1, note = '' } = {}) {
  const id = `RW-${String(number).padStart(3, '0')}`;
  return {
    id,
    category: capture.category,
    capturedAt: new Date(capture.capturedAt || Date.now()).toISOString(),
    features: {
      pageType: capture.features.pageType,
      h1: capture.features.h1,
      ogTitle: capture.features.ogTitle,
      jsonLd: capture.features.jsonLd,
      galleryInfo: capture.features.galleryInfo,
      manyImages: capture.features.manyImages,
      spaNavigation: capture.features.spaNavigation
    },
    expected: {
      pageRecognition: capture.results.pageRecognition === RESULT.PASS,
      storeSearch: capture.results.storeSearch === RESULT.PASS,
      correctMatch: capture.match.grade === 'found' && capture.match.falsePositive !== true,
      falsePositive: capture.match.falsePositive === true
    },
    source: {
      fingerprint: capture.fingerprint,
      pageType: capture.pageType,
      novelty: capture.novelty?.score ?? null,
      verdict: capture.verdict || RESULT.NOT_TESTED
    },
    note: note || capture.note || ''
  };
}

function verdictCounts(items) {
  const counts = { pass: 0, fail: 0, expectedLimitation: 0, notTested: 0 };
  for (const item of items) {
    if (item.verdict === RESULT.PASS) counts.pass += 1;
    else if (item.verdict === RESULT.FAIL) counts.fail += 1;
    else if (item.verdict === RESULT.LIMITATION) counts.expectedLimitation += 1;
    else counts.notTested += 1;
  }
  return counts;
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(3));
}

/**
 * Local statistics (requirements doc §27). Everything the summary export and
 * the popup dashboard show comes from here.
 */
export function summarize(captures = [], cases = []) {
  const judgedList = cases.length ? cases.map((item) => ({ verdict: item.source?.verdict || item.verdict || RESULT.NOT_TESTED })) : captures;
  const counts = verdictCounts(judgedList);

  const judgedCaptures = captures.filter((item) => item.match?.falsePositive !== null && item.match?.falsePositive !== undefined);
  const claimed = captures.filter((item) => item.match?.grade === 'found' || item.match?.grade === 'possible');
  const falsePositive = captures.filter((item) => item.match?.falsePositive === true).length;
  const falseNegative = captures.filter((item) => item.results?.falseNegative === RESULT.FAIL).length;

  const requestByStore = {};
  let requestTotal = 0;
  let zeroRequestCaptures = 0;
  let cacheHitCaptures = 0;
  for (const capture of captures) {
    const byStore = capture.requests?.byStore || {};
    for (const [storeId, value] of Object.entries(byStore)) {
      requestByStore[storeId] = (requestByStore[storeId] || 0) + (Number(value) || 0);
      requestTotal += Number(value) || 0;
    }
    if (!capture.requests?.total) zeroRequestCaptures += 1;
    if ((capture.requests?.observations || []).some((item) => item.cacheHit)) cacheHitCaptures += 1;
  }

  const structures = new Map();
  for (const capture of captures) {
    const key = capture.fingerprint || 'unknown';
    const entry = structures.get(key) || { fingerprint: key, pageType: capture.pageType || 'unknown', count: 0, firstSeenAt: capture.capturedAt || 0 };
    entry.count += 1;
    entry.firstSeenAt = Math.min(entry.firstSeenAt || capture.capturedAt || 0, capture.capturedAt || 0);
    structures.set(key, entry);
  }
  const structureList = [...structures.values()].sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));

  const recognized = captures.filter((item) => item.results?.pageRecognition === RESULT.PASS).length;

  return {
    total: captures.length,
    cases: cases.length,
    ...counts,
    falsePositive,
    falseNegative,
    pageRecognitionRate: ratio(recognized, captures.length),
    matchPrecision: ratio(judgedCaptures.filter((item) => item.match.falsePositive !== true && (item.match.grade === 'found' || item.match.grade === 'possible')).length, judgedCaptures.length),
    claimedMatches: claimed.length,
    judgedMatches: judgedCaptures.length,
    newStructures: captures.filter((item) => noveltyVerdict(item.novelty?.score ?? 0) !== 'duplicate').length,
    duplicateStructures: captures.filter((item) => noveltyVerdict(item.novelty?.score ?? 0) === 'duplicate').length,
    requestBudget: {
      total: requestTotal,
      averagePerCapture: captures.length ? Number((requestTotal / captures.length).toFixed(2)) : 0,
      byStore: requestByStore,
      zeroRequestCaptures,
      cacheHitCaptures,
      overBudget: captures.filter((item) => item.results?.requestCount === RESULT.FAIL).length
    },
    structures: structureList.slice(0, 24)
  };
}

/** Failure ids are derived from the capture id, so they are stable (§28) */
export function failureIdOf(capture) {
  const match = /(\d+)\s*$/.exec(String(capture?.id || ''));
  return match ? `FAIL-${String(Number(match[1])).padStart(3, '0')}` : `FAIL-${shortHash(capture?.id || 'x', 4)}`;
}

/**
 * Is this capture a failure worth its own bundle? (requirements doc §28)
 *
 * A negative test *wants* the page to be unrecognised, so "pageRecognition =
 * FAIL" on its own is a measurement, not a problem. What counts as a failure:
 * a wrong recommendation, a verdict the user set to FAIL, an automatic check
 * that failed on a page that *was* recognised as a work page, or a page that is
 * not a work page yet still caused store requests (§21 / §23).
 */
export function isFailure(capture) {
  if (!capture) return false;
  if (capture.match?.falsePositive === true) return true;
  if (capture.verdict === RESULT.FAIL) return true;
  const results = capture.results || {};
  if (capture.extract?.recognized !== true) return results.requestCount === RESULT.FAIL;
  return RESULT_FIELDS.some((field) => field !== 'pageRecognition' && results[field] === RESULT.FAIL);
}
