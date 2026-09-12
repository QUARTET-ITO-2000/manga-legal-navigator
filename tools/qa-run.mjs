#!/usr/bin/env node
/**
 * Real-world test runner (requirements doc §14 / §22 / §24 / §36).
 *
 * It replays every case in tests/real-world/** through the real pipeline and
 * writes one compact result file. Two kinds of page fixture are understood:
 *
 *   1. a QA capture in qa/captures/<id>.json — the structured summary of a real
 *      page the user visited (git-ignored, contains real titles);
 *   2. the `fixture.pageInfo` of the committed case file — placeholder data that
 *      only needs to match the store snapshots, so the suite runs in CI.
 *
 * Store answers come from src/stores/fixtures/* unless --live is passed, in
 * which case the real stores are queried — once per case, never in a crawl
 * (requirements doc §31).
 *
 * Usage:
 *   node tools/qa-run.mjs                     # offline replay (repeatable, no network)
 *   node tools/qa-run.mjs --live              # query the real stores
 *   node tools/qa-run.mjs --case RW-001 --out qa
 *   node tools/qa-run.mjs --category matching --json
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONFIG } from '../src/lib/config.js';
import { analyzePage } from '../src/lib/pipeline.js';
import { buildFeatures, fingerprintOf, pageTypeOf } from '../src/qa/fingerprint.js';
import { RESULT, RESULT_FIELDS } from '../src/qa/record.js';
import { listJsonFiles, outDir, readJson, writeJson, ROOT, dayLabel } from './lib/qa-files.mjs';
import { mockFixtureText } from './lib/mock-stores.mjs';
import { createFetchText } from './probe-store.mjs';

/** The category directories of requirements doc §16 */
export const CASE_DIRS = ['extraction', 'cleaning', 'matching', 'navigation', 'store', 'performance', 'negative'];

function parseArgs(argv = process.argv.slice(2)) {
  const args = { live: false, json: false, caseId: '', category: '', out: 'qa', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--live') args.live = true;
    else if (value === '--json') args.json = true;
    else if (value === '--case') args.caseId = argv[++i] || '';
    else if (value === '--category') args.category = argv[++i] || '';
    else if (value === '--out') args.out = argv[++i] || 'qa';
    else if (value === '--help' || value === '-h') args.help = true;
  }
  return args;
}

/** Every committed case file, plus any standalone case at the top level */
export function loadCases() {
  const cases = [];
  const dirs = [...CASE_DIRS, '.'];
  for (const dir of dirs) {
    const target = dir === '.' ? join(ROOT, 'tests/real-world') : join(ROOT, 'tests/real-world', dir);
    if (!existsSync(target)) continue;
    // The top-level pass only picks up cases that sit directly in the folder
    const files = listJsonFiles(target).filter((file) => dir !== '.' || dirname(file) === target.replace(/\/$/, ''));
    for (const file of files) {
      let value;
      try {
        value = readJson(file);
      } catch {
        continue;
      }
      if (!value?.id || !String(value.id).startsWith('RW-')) continue;
      cases.push({ ...value, dir: dir === '.' ? (value.dir || 'extraction') : dir, file });
    }
  }
  const seen = new Set();
  return cases
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The replayable page summary of a case: local capture first, committed fixture second */
function pageInfoOf(caseRecord, { out = 'qa' } = {}) {
  const capturePath = join(outDir(out), 'captures', `${caseRecord.id}.json`);
  if (existsSync(capturePath)) {
    const value = readJson(capturePath);
    const pageInfo = value?.pageInfo || value?.capture?.pageInfo;
    if (pageInfo) return { pageInfo, source: 'capture', capture: value?.capture || value };
  }
  const localCapture = caseRecord.capture?.pageInfo ? caseRecord.capture : null;
  if (localCapture) return { pageInfo: localCapture.pageInfo, source: 'case-capture', capture: localCapture };
  if (caseRecord.fixture?.pageInfo) return { pageInfo: caseRecord.fixture.pageInfo, source: 'fixture', capture: null };
  return { pageInfo: null, source: 'none', capture: null };
}

function expectedFlags(caseRecord = {}) {
  const expected = caseRecord.expected || {};
  return {
    pageRecognition: expected.pageRecognition,
    storeSearch: expected.storeSearch,
    correctMatch: expected.correctMatch,
    falsePositive: expected.falsePositive,
    cleanedTitle: expected.cleanedTitle || '',
    /** 'found' | 'possible' | 'none' | 'error' | 'unrecognized' (requirements doc §20) */
    grade: expected.grade || '',
    /** optional tighter request budget for one case (requirements doc §23) */
    maxRequests: Number.isFinite(Number(expected.maxRequests)) ? Number(expected.maxRequests) : null,
    limitation: expected.limitation === true
  };
}

function gradeOfStatus(status) {
  if (status === 'ok_high') return 'found';
  if (status === 'ok_possible') return 'possible';
  if (status === 'no_result') return 'none';
  if (status === 'error') return 'error';
  if (status === 'unrecognized') return 'unrecognized';
  return 'unknown';
}

function compare(expected, actual) {
  if (expected === undefined || expected === null) return RESULT.NOT_TESTED;
  return Boolean(expected) === Boolean(actual) ? RESULT.PASS : RESULT.FAIL;
}

/**
 * Replay one case twice: the second run must be served from the cache
 * (requirements doc §24). In live mode those two runs are the only requests
 * this case causes.
 */
export async function replayCase({ caseRecord, pageInfo, live = false, liveFetch = null }) {
  const stats = { first: 0, second: 0, byStore: {} };
  /**
   * One shared cache across both runs: that is what makes the second run a
   * cache test (requirements doc §24) instead of a second search.
   */
  const cacheStore = new Map();
  let calls = 0;
  const deps = {
    fetchText: async (url, options) => {
      calls += 1;
      const storeId = storeIdOf(url);
      stats.byStore[storeId] = (stats.byStore[storeId] || 0) + 1;
      if (live) return liveFetch(url, options);
      return { ok: true, status: 200, text: mockFixtureText(url), url, mock: true };
    },
    cache: {
      get: async (key) => cacheStore.get(key) || null,
      set: async (key, value) => { cacheStore.set(key, { ...value, at: Date.now() }); }
    }
  };

  const runOnce = async () => {
    const before = calls;
    const state = await analyzePage({ pageInfo, settings: {}, deps });
    return { state, requests: calls - before };
  };

  const first = await runOnce();
  const second = await runOnce();
  stats.first = first.requests;
  stats.second = second.requests;

  const state = first.state;
  const expected = expectedFlags(caseRecord);
  const results = Object.fromEntries(RESULT_FIELDS.map((field) => [field, RESULT.NOT_TESTED]));

  const recognized = state.status !== 'unrecognized';
  results.pageRecognition = compare(expected.pageRecognition, recognized);

  const cleaned = String(state.query?.cleanedTitle || '');
  if (expected.cleanedTitle) results.titleExtraction = cleaned === expected.cleanedTitle ? RESULT.PASS : RESULT.FAIL;
  else results.titleExtraction = compare(expected.pageRecognition === false ? undefined : true, Boolean(cleaned));
  results.titleCleaning = state.query?.confidence === 'low' && cleaned ? RESULT.FAIL : (cleaned ? RESULT.PASS : RESULT.NOT_TESTED);

  const queried = Object.keys(state.stores || {}).length > 0 || Boolean(state.query?.searched?.length);
  results.storeSearch = compare(expected.storeSearch, queried);

  const found = Boolean(state.match);
  const grade = gradeOfStatus(state.status);
  if (expected.grade) {
    // A similar work must not be recommended (requirements doc §20), so the
    // expected *grade* matters as much as found / not found.
    results.correctMatch = grade === expected.grade ? RESULT.PASS : RESULT.FAIL;
    results.falsePositive = expected.grade === 'none'
      ? (grade === 'none' ? RESULT.PASS : RESULT.FAIL)
      : RESULT.NOT_TESTED;
    results.falseNegative = expected.grade !== 'none' && grade === 'none' ? RESULT.FAIL : RESULT.NOT_TESTED;
  } else if (expected.correctMatch === false) {
    results.correctMatch = found ? RESULT.FAIL : RESULT.PASS;
    results.falsePositive = found ? RESULT.FAIL : RESULT.PASS;
    results.falseNegative = RESULT.NOT_TESTED;
  } else if (expected.correctMatch === true) {
    results.correctMatch = found ? RESULT.PASS : RESULT.FAIL;
    results.falseNegative = found ? RESULT.NOT_TESTED : RESULT.FAIL;
  }

  const budget = expected.maxRequests ?? (recognized ? CONFIG.qa.requestBudget.workPage : CONFIG.qa.requestBudget.nonWorkPage);
  results.requestCount = stats.first <= budget ? RESULT.PASS : RESULT.FAIL;
  results.cacheBehavior = stats.second === 0 ? RESULT.PASS : RESULT.FAIL;
  results.navigation = pageInfo.navigationType === 'spa'
    ? (pageInfo.settled !== false ? RESULT.PASS : RESULT.FAIL)
    : RESULT.NOT_TESTED;

  const failed = RESULT_FIELDS.filter((field) => results[field] === RESULT.FAIL);
  const checked = RESULT_FIELDS.filter((field) => results[field] !== RESULT.NOT_TESTED);
  // A case flagged as an accepted limitation is reported as such even though its
  // fields fail — that is the "Expected Limitation" bucket of requirements doc §35.
  const verdict = expected.limitation
    ? RESULT.LIMITATION
    : (failed.length ? RESULT.FAIL : (checked.length ? RESULT.PASS : RESULT.NOT_TESTED));

  return {
    state,
    results,
    verdict,
    failedFields: failed,
    requests: stats,
    grade: state.status,
    health: (state.stores || []).map((item) => ({ storeId: item.storeId, kind: item.kind, health: item.health || '', itemCount: item.itemCount })),
    stores: state.stores
  };
}

function storeIdOf(value) {
  let host = '';
  try {
    host = new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host.endsWith('dlsite.com')) return 'dlsite';
  if (host.endsWith('dmm.co.jp')) return 'fanza';
  if (host.endsWith('melonbooks.co.jp')) return 'melonbooks';
  if (host.endsWith('pixiv.net')) return 'pixiv';
  if (host.endsWith('fantia.jp')) return 'fantia';
  return 'other';
}

function failureIdOf(caseRecord) {
  const number = /(\d+)$/.exec(String(caseRecord.id || ''))?.[1];
  return number ? `FAIL-${String(Number(number)).padStart(3, '0')}` : `FAIL-${caseRecord.id}`;
}

export async function runCases({ cases, live = false, liveFetch = null, out = 'qa' }) {
  const results = [];
  for (const caseRecord of cases) {
    const { pageInfo, source, capture } = pageInfoOf(caseRecord, { out });
    if (!pageInfo) {
      results.push({
        id: caseRecord.id,
        category: caseRecord.category || '',
        dir: caseRecord.dir,
        pageType: caseRecord.features?.pageType || '',
        fingerprint: caseRecord.source?.fingerprint || '',
        fixtureSource: 'none',
        verdict: RESULT.NOT_TESTED,
        results: Object.fromEntries(RESULT_FIELDS.map((field) => [field, RESULT.NOT_TESTED])),
        failedFields: [],
        requests: { first: 0, second: 0, byStore: {} },
        note: 'no page fixture yet — visit the page with QA Capture on, then run tools/qa-import.mjs'
      });
      continue;
    }

    const features = buildFeatures(pageInfo, null);
    const expectedFeatures = caseRecord.features || {};
    const mismatches = Object.keys(expectedFeatures)
      .filter((key) => {
        if (!(key in features)) return false;
        const actual = features[key];
        const expected = expectedFeatures[key];
        if (typeof expected === 'boolean') return Boolean(actual) !== expected;
        return JSON.stringify(actual) !== JSON.stringify(expected);
      });
    const fingerprint = fingerprintOf(features);

    let replay;
    try {
      replay = await replayCase({ caseRecord, pageInfo, live, liveFetch });
    } catch (error) {
      results.push({
        id: caseRecord.id,
        category: caseRecord.category || '',
        dir: caseRecord.dir,
        pageType: pageTypeOf(pageInfo, null),
        fingerprint,
        fixtureSource: source,
        structure: { matches: mismatches.length === 0, mismatches },
        verdict: RESULT.FAIL,
        results: Object.fromEntries(RESULT_FIELDS.map((field) => [field, field === 'pageRecognition' ? RESULT.FAIL : RESULT.NOT_TESTED])),
        failedFields: ['replay'],
        requests: { first: 0, second: 0, byStore: {} },
        note: `pipeline error: ${String(error?.message || error)}`
      });
      continue;
    }

    const entry = {
      id: caseRecord.id,
      category: caseRecord.category || '',
      dir: caseRecord.dir,
      pageType: pageTypeOf(pageInfo, replay.state),
      fingerprint: capture?.fingerprint || fingerprint,
      fixtureSource: source,
      structure: { expected: expectedFeatures, actual: features, matches: mismatches.length === 0, mismatches },
      verdict: replay.verdict,
      results: replay.results,
      failedFields: replay.failedFields,
      grade: replay.grade,
      requests: replay.requests,
      health: replay.health,
      matched: replay.state?.match ? { store: replay.state.match.store, score: replay.state.match.score } : null,
      cleanedTitleLength: String(replay.state?.query?.cleanedTitle || '').length,
      note: caseRecord.note || ''
    };
    // The declared structure and the structure the page really has must agree,
    // otherwise the case (or the fingerprint logic) is out of date.
    if (mismatches.length) {
      entry.verdict = RESULT.FAIL;
      entry.failedFields = [...new Set([...entry.failedFields, 'structure'])];
    }
    if (entry.verdict === RESULT.FAIL) entry.failureId = failureIdOf(caseRecord);
    results.push(entry);
  }
  return results;
}

export function summarizeResults(results) {
  const counts = { pass: 0, fail: 0, expectedLimitation: 0, notTested: 0 };
  for (const item of results) {
    if (item.verdict === RESULT.PASS) counts.pass += 1;
    else if (item.verdict === RESULT.FAIL) counts.fail += 1;
    else if (item.verdict === RESULT.LIMITATION) counts.expectedLimitation += 1;
    else counts.notTested += 1;
  }
  const requestTotal = results.reduce((sum, item) => sum + (item.requests?.first || 0), 0);
  const byCategory = {};
  for (const item of results) {
    const entry = byCategory[item.dir || item.category || 'unknown'] || { pass: 0, fail: 0, expectedLimitation: 0, notTested: 0 };
    if (item.verdict === RESULT.PASS) entry.pass += 1;
    else if (item.verdict === RESULT.FAIL) entry.fail += 1;
    else if (item.verdict === RESULT.LIMITATION) entry.expectedLimitation += 1;
    else entry.notTested += 1;
    byCategory[item.dir || item.category || 'unknown'] = entry;
  }
  return {
    total: results.length,
    ...counts,
    falsePositive: results.filter((item) => item.results?.falsePositive === RESULT.FAIL).length,
    falseNegative: results.filter((item) => item.results?.falseNegative === RESULT.FAIL).length,
    structuresMismatched: results.filter((item) => item.structure && item.structure.matches === false).length,
    cacheMissed: results.filter((item) => item.results?.cacheBehavior === RESULT.FAIL).length,
    requests: { total: requestTotal, averagePerCase: results.length ? Number((requestTotal / results.length).toFixed(2)) : 0 },
    byCategory
  };
}

/** The compact failure bundle for one runner failure (requirements doc §28) */
function runFailureBundle(item) {
  return {
    id: item.failureId || failureIdOf(item),
    caseId: item.id,
    source: 'qa-run',
    category: item.category,
    pageType: item.pageType,
    fingerprint: item.fingerprint,
    failedFields: item.failedFields,
    structure: item.structure,
    results: item.results,
    requests: item.requests,
    stores: item.health,
    grade: item.grade,
    note: item.note || ''
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node tools/qa-run.mjs [--live] [--case RW-001] [--category matching] [--out qa] [--json]');
    return 0;
  }

  let cases = loadCases();
  if (args.caseId) cases = cases.filter((item) => item.id === args.caseId);
  if (args.category) cases = cases.filter((item) => item.dir === args.category || item.category === args.category);
  if (!cases.length) {
    console.error('no cases matched. Add case files under tests/real-world/<category>/RW-xxx.json');
    return 1;
  }

  const { fetchText: liveFetch } = createFetchText({});
  const results = await runCases({ cases, live: args.live, liveFetch, out: args.out });
  const summary = summarizeResults(results);
  const report = {
    schema: 'manga-nav/qa-run@1',
    kind: 'qa-run',
    generatedAt: new Date().toISOString(),
    day: dayLabel(),
    mode: args.live ? 'live' : 'offline',
    casesFile: 'tests/real-world/**',
    summary,
    results,
    failures: results.filter((item) => item.verdict === RESULT.FAIL).map(runFailureBundle)
  };

  const outPath = writeJson(join(outDir(args.out), 'results-latest.json'), report);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(`mode: ${report.mode}   cases: ${summary.total}`);
  for (const item of results) {
    const requests = `${item.requests?.first ?? 0}/${item.requests?.second ?? 0}`;
    console.log(`${item.id}  ${String(item.dir).padEnd(10)} ${String(item.verdict).padEnd(19)} ${String(item.fingerprint).padEnd(30)} req ${requests}`);
    if (item.verdict === RESULT.FAIL) console.log(`      failed: ${item.failedFields.join(', ')}${item.note ? `  (${item.note})` : ''}`);
  }
  console.log(`\nPASS ${summary.pass} · FAIL ${summary.fail} · EXPECTED_LIMITATION ${summary.expectedLimitation} · NOT_TESTED ${summary.notTested}`);
  console.log(`falsePositive ${summary.falsePositive} · falseNegative ${summary.falseNegative} · cacheMissed ${summary.cacheMissed} · requests ${summary.requests.total}`);
  console.log(`result: ${outPath}`);
  return summary.fail ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
