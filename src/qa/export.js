/**
 * QA report building and anonymisation (requirements doc §8, §9, §27, §28).
 *
 * Three exports, all written by the popup and saved by the browser:
 *
 *   qa-summary-<date>-<n>.json    compact pass/fail statistics (§27)
 *   qa-failures-<date>-<n>.json   one bundle per failure (§28)
 *   qa-tests-<date>-<n>.json      the test-case pack, imported by tools/qa-import.mjs
 *
 * The first two are anonymised: real titles, product ids and URLs are replaced
 * by placeholders such as <title-1> / <id-2>, while the *shape* of the data
 * (length, writing system, hash) is kept so the numbers still mean something.
 * The test-case pack keeps real values only when the user explicitly enabled
 * "include real titles" for it, because its destination is a git-ignored local
 * file (requirements doc §9 / §13).
 */

import { failureIdOf, isFailure, RESULT, RESULT_FIELDS, summarize } from './record.js';
import { scriptOf, shortHash } from './fingerprint.js';

/** Placeholder factory: the same real string always maps to the same placeholder */
export function createRedactor() {
  const counters = { title: 0, id: 0, url: 0 };
  const maps = { title: new Map(), id: new Map(), url: new Map() };
  const dictionary = { titles: {}, ids: {}, urls: {} };

  const placeholder = (kind, value) => {
    if (value === null || value === undefined || value === '') return '';
    const text = String(value);
    if (!maps[kind].has(text)) {
      counters[kind] += 1;
      const label = `<${kind}-${counters[kind]}>`;
      maps[kind].set(text, label);
      if (kind === 'url') {
        try {
          const url = new URL(text);
          dictionary.urls[label] = { host: url.hostname, path: pathShape(url.pathname) };
        } catch {
          dictionary.urls[label] = { host: '', path: '' };
        }
      } else {
        dictionary[kind === 'title' ? 'titles' : 'ids'][label] = {
          length: text.length,
          script: scriptOf(text),
          key: shortHash(text)
        };
      }
    }
    return maps[kind].get(text);
  };

  return {
    title: (value) => placeholder('title', value),
    id: (value) => placeholder('id', value),
    url: (value) => placeholder('url', value),
    dictionary: () => dictionary
  };
}

/** Count id-like and slug-like path segments without revealing them */
function pathShape(pathname) {
  return String(pathname || '')
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? ':id' : (segment.length > 12 ? ':slug' : segment)))
    .join('/');
}

function listOf(value, max = 8) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

/** One capture, with real titles / ids / urls replaced (requirements doc §9) */
export function redactCapture(capture, redactor) {
  // pageKey / pageInfo are dropped entirely: they carry the real url and the
  // raw page summary, and an anonymised export must not contain either.
  const { pageKey, pageInfo, ...rest } = capture;
  return {
    ...rest,
    pageInfoIncluded: false,
    page: {
      ...capture.page,
      title: redactor.title(capture.page?.title),
      headings: listOf(capture.page?.headings, 6).map((value) => redactor.title(value))
    },
    extract: {
      ...capture.extract,
      cleanedTitle: redactor.title(capture.extract?.cleanedTitle),
      variants: listOf(capture.extract?.variants, 4).map((value) => redactor.title(value)),
      searched: listOf(capture.extract?.searched, 4).map((value) => redactor.title(value)),
      artists: listOf(capture.extract?.artists, 3).map((value) => redactor.title(value))
    },
    match: {
      ...capture.match,
      productTitle: redactor.title(capture.match?.productTitle)
    },
    stores: {
      ...capture.stores,
      // The keywords actually sent to a store are as sensitive as the title
      queries: listOf(capture.stores?.queries, 6).map((value) => redactor.title(value))
    },
    candidates: listOf(capture.candidates, 5).map((item) => ({
      storeId: item.storeId || '',
      score: item.score ?? null,
      grade: item.grade || '',
      productKey: item.productId ? shortHash(String(item.productId)) : '',
      productTitle: redactor.title(item.title)
    }))
  };
}

/** The fields a failure bundle must contain (requirements doc §28) */
export function buildFailureBundle(capture, { redactor = createRedactor(), includeRealTitles = false } = {}) {
  const redacted = includeRealTitles ? capture : redactCapture(capture, redactor);
  const failedFields = RESULT_FIELDS.filter((field) => capture.results?.[field] === RESULT.FAIL);
  return {
    id: failureIdOf(capture),
    captureId: capture.id,
    category: capture.category,
    pageType: capture.pageType,
    fingerprint: capture.fingerprint,
    fingerprintLines: capture.fingerprintLines,
    novelty: capture.novelty,
    verdict: capture.verdict,
    note: capture.note || '',
    failedFields,
    falsePositive: capture.match?.falsePositive === true,
    structure: {
      features: capture.features,
      imageCount: capture.page?.imageCount ?? 0,
      infoFields: capture.page?.infoFields || [],
      navigationType: capture.page?.navigationType || 'load',
      pageRecognition: capture.results?.pageRecognition
    },
    extraction: {
      recognized: capture.extract?.recognized,
      titleSource: capture.extract?.titleSource,
      cleanedTitle: redacted.extract?.cleanedTitle,
      cleanedTitleLength: capture.extract?.cleanedTitleLength,
      workKey: capture.extract?.workKey,
      confidence: capture.extract?.confidence,
      signals: capture.extract?.signals || [],
      notes: capture.extract?.notes || []
    },
    search: {
      variants: redacted.extract?.variants || [],
      queried: redacted.extract?.searched || [],
      artists: redacted.extract?.artists || []
    },
    stores: {
      order: capture.stores?.order || [],
      results: capture.stores?.results || {},
      matchScores: capture.stores?.matchScores || {},
      health: capture.stores?.health || {},
      fromCache: capture.stores?.fromCache || {}
    },
    match: {
      grade: capture.match?.grade,
      score: capture.match?.score,
      storeId: capture.match?.storeId,
      productKey: capture.match?.productKey,
      productTitle: redacted.match?.productTitle,
      candidateCount: capture.match?.candidateCount ?? 0,
      candidates: redacted.candidates || []
    },
    requests: capture.requests,
    errors: capture.errors || [],
    results: capture.results
  };
}

/** One-line failure entry used by the summary export (kept tiny on purpose) */
function compactFailure(capture) {
  return {
    id: failureIdOf(capture),
    captureId: capture.id,
    category: capture.category,
    fingerprint: capture.fingerprint,
    failedFields: RESULT_FIELDS.filter((field) => capture.results?.[field] === RESULT.FAIL),
    falsePositive: capture.match?.falsePositive === true,
    grade: capture.match?.grade,
    score: capture.match?.score,
    storeId: capture.match?.storeId || '',
    requests: capture.requests?.total ?? 0,
    cacheHit: Boolean(capture.requests?.cacheHit),
    novelty: capture.novelty?.score ?? null
  };
}

function compactCase(item) {
  return {
    id: item.id,
    category: item.category,
    fingerprint: item.source?.fingerprint || item.fingerprint || '',
    pageType: item.source?.pageType || item.features?.pageType || '',
    novelty: item.source?.novelty ?? null,
    verdict: item.source?.verdict || item.verdict || RESULT.NOT_TESTED,
    expected: item.expected
  };
}

/**
 * `qa-summary` export (§27). Small by construction: no per-capture detail, only
 * the statistics, the structures histogram, the compact case list and the
 * failure index. `failures` entries here have no bundle payload — those live in
 * the separate failures export (§28).
 */
export function buildSummaryReport({ captures = [], cases = [], generatedAt = Date.now(), fileLabel = '001', includeRealTitles = false, lastError = null } = {}) {
  const failures = captures.filter(isFailure);
  return {
    schema: 'manga-nav/qa-summary@1',
    kind: 'qa-summary',
    generatedAt: new Date(generatedAt).toISOString(),
    fileLabel,
    containsRealData: false,
    redacted: true,
    note: includeRealTitles
      ? 'The summary never contains titles or URLs, even when "include real titles" is on.'
      : '',
    summary: summarize(captures, cases),
    cases: cases.map(compactCase),
    failures: failures.map(compactFailure),
    structures: summarize(captures).structures,
    lastError: lastError || null
  };
}

/** `qa-failures` export (§28): one detailed bundle per failure */
export function buildFailureReport({ captures = [], generatedAt = Date.now(), fileLabel = '001', includeRealTitles = false, lastError = null } = {}) {
  const redactor = createRedactor();
  const failures = captures.filter(isFailure);
  const report = {
    schema: 'manga-nav/qa-failures@1',
    kind: 'qa-failures',
    generatedAt: new Date(generatedAt).toISOString(),
    fileLabel,
    containsRealData: Boolean(includeRealTitles),
    note: includeRealTitles
      ? 'REAL DATA — keep this file in a git-ignored location (requirements doc §9).'
      : 'Titles, product ids and urls are placeholders; see the dictionary for their shape.',
    placeholderDictionary: includeRealTitles ? {} : redactor.dictionary(),
    lastError: lastError || null,
    breakdown: {
      total: failures.length,
      falsePositive: failures.filter((item) => item.match?.falsePositive === true).length,
      byField: RESULT_FIELDS.reduce((acc, field) => {
        const count = failures.filter((item) => item.results?.[field] === RESULT.FAIL).length;
        if (count) acc[field] = count;
        return acc;
      }, {})
    },
    failures: failures.map((capture) => buildFailureBundle(capture, { redactor, includeRealTitles }))
  };
  return report;
}

/**
 * `qa-tests` export (§13): the case records plus, when real data is allowed,
 * the real URL table and the replayable page summaries that tools/qa-import.mjs
 * writes into the git-ignored local files.
 */
export function buildCasePack({ captures = [], cases = [], generatedAt = Date.now(), fileLabel = '001', includeRealTitles = false } = {}) {
  const redactor = createRedactor();
  const byCapture = new Map(captures.map((item) => [item.id, item]));
  const entries = cases.map((item) => {
    const capture = item.captureId ? byCapture.get(item.captureId) : null;
    return {
      case: item,
      capture: capture
        ? (includeRealTitles ? { ...capture, pageInfoIncluded: true, containsRealData: true } : redactCapture(capture, redactor))
        : null,
      url: includeRealTitles ? (capture?.pageInfo?.url || '') : redactor.url(capture?.pageInfo?.url || '')
    };
  });
  return {
    schema: 'manga-nav/qa-tests@1',
    kind: 'qa-tests',
    generatedAt: new Date(generatedAt).toISOString(),
    fileLabel,
    containsRealData: Boolean(includeRealTitles),
    note: includeRealTitles
      ? 'REAL DATA — save under a git-ignored path (qa/…); tools/qa-import.mjs splits it into tests/sites.local.json and the committed case files.'
      : 'Anonymised: no real urls or titles. Enable "include real titles" to also produce the replayable local fixtures.',
    placeholderDictionary: includeRealTitles ? {} : redactor.dictionary(),
    cases: entries.map((entry) => entry.case),
    captures: entries.map((entry) => entry.capture).filter(Boolean),
    sites: Object.fromEntries(entries.filter((entry) => entry.url).map((entry) => [entry.case.id, entry.url]))
  };
}

/** `qa-<kind>-2026-09-12-001.json` (§8) */
export function exportFileName(kind, day, seq) {
  const name = kind === 'summary' ? 'qa-summary' : kind === 'failures' ? 'qa-failures' : 'qa-tests';
  return `${name}-${day}-${seq}.json`;
}
