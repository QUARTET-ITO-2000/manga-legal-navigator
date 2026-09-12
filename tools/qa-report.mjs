#!/usr/bin/env node
/**
 * Local QA statistics (requirements doc §25 / §26 / §27 / §28).
 *
 * This is the only file Codex needs to look at after a test round:
 *
 *   browser collects (QA Capture)
 *     ↓  qa-summary-*.json / qa-failures-*.json / qa-tests-*.json  (popup exports)
 *   this tool merges them
 *     ↓  qa/qa-summary.json          — the numbers, a few lines
 *     ↓  qa/failures/FAIL-017.json   — one bundle per failure
 *   Codex reads the summary, then only the failing bundles.
 *
 * Nothing here prints real titles; the exports are already anonymised unless the
 * user explicitly asked for real data.
 *
 * Usage:
 *   node tools/qa-report.mjs                      # reads qa/inbox/** and qa/**
 *   node tools/qa-report.mjs --input ~/Downloads
 *   node tools/qa-report.mjs --json
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RESULT_FIELDS } from '../src/qa/record.js';
import { classifyInputs, listJsonFiles, outDir, writeJson, ROOT, relativeToRoot } from './lib/qa-files.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { inputs: [], out: 'qa', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--input') args.inputs.push(argv[++i] || '');
    else if (value === '--out') args.out = argv[++i] || 'qa';
    else if (value === '--json') args.json = true;
    else if (value === '--help' || value === '-h') args.help = true;
  }
  return args;
}

function collectInputFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    if (!input || !existsSync(input)) continue;
    if (input.endsWith('.json')) files.push(input);
    else files.push(...listJsonFiles(input));
  }
  // Runner output is not an export, but it is useful context when present
  const latest = join(ROOT, 'qa/results-latest.json');
  if (existsSync(latest) && !files.includes(latest)) files.push(latest);
  return [...new Set(files)];
}

function newestBy(entries, key = 'generatedAt') {
  return entries
    .slice()
    .sort((a, b) => String(b.value?.[key] || '').localeCompare(String(a.value?.[key] || '')));
}

/**
 * Merge the exports into one report.
 * The newest `qa-summary` export is authoritative for the numbers (a second
 * export of the same captures must not double-count); the failures and cases are
 * unioned by id, taking the newest version of a duplicate.
 */
export function mergeExports(inputs) {
  const summaries = newestBy(inputs.summary);
  const authoritative = summaries[0]?.value || null;
  const failures = new Map();
  for (const entry of newestBy(inputs.failures).reverse()) {
    for (const bundle of entry.value.failures || []) {
      if (bundle?.id) failures.set(bundle.id, bundle);
    }
  }
  const cases = new Map();
  for (const entry of newestBy(inputs.tests).reverse()) {
    for (const item of entry.value.cases || []) {
      if (item?.id) cases.set(item.id, item);
    }
  }
  for (const item of authoritative?.cases || []) {
    if (item?.id && !cases.has(item.id)) cases.set(item.id, item);
  }
  const compactFailures = new Map();
  for (const entry of newestBy(inputs.summary).reverse()) {
    for (const item of entry.value.failures || []) {
      if (item?.id) compactFailures.set(item.id, item);
    }
  }
  const runs = newestBy(inputs.run);

  const sourceFiles = [
    ...inputs.summary.map((entry) => relativeToRoot(entry.file)),
    ...inputs.failures.map((entry) => relativeToRoot(entry.file)),
    ...inputs.tests.map((entry) => relativeToRoot(entry.file)),
    ...inputs.run.map((entry) => relativeToRoot(entry.file))
  ];

  return {
    authoritative,
    failures,
    compactFailures,
    cases,
    runs,
    sourceFiles,
    result: summaries[0]?.value?.summary || null,
    structures: authoritative?.structures || summaries[0]?.value?.structures || [],
    redacted: authoritative ? authoritative.containsRealData !== true : true,
    unknown: inputs.unknown.map((entry) => relativeToRoot(entry.file))
  };
}

function oneLineReason(bundle) {
  const fields = bundle.failedFields?.length ? bundle.failedFields.join(',') : 'unknown';
  const parts = [`fields=${fields}`];
  if (bundle.grade) parts.push(`grade=${bundle.grade}`);
  if (bundle.falsePositive) parts.push('falsePositive');
  if (bundle.fingerprint) parts.push(bundle.fingerprint);
  const requests = bundle.requests?.total ?? bundle.requests?.first;
  if (requests !== undefined) parts.push(`requests=${requests}`);
  const health = Object.entries(bundle.stores?.health || {})
    .filter(([, value]) => value !== 'healthy' && value !== 'no-result')
    .map(([store, value]) => `${store}:${value}`);
  if (health.length) parts.push(health.join(' '));
  return parts.join(' · ');
}

/** The compact summary Codex reads first (requirements doc §27) */
export function buildSummary(merged) {
  const summary = merged.result || { total: 0, pass: 0, fail: 0, expectedLimitation: 0, notTested: 0 };
  const failureIds = [...new Set([...merged.failures.keys(), ...merged.compactFailures.keys()])].sort();
  return {
    schema: 'manga-nav/qa-summary@1',
    generatedAt: new Date().toISOString(),
    sources: merged.sourceFiles,
    redacted: merged.redacted,
    summary: {
      ...summary,
      failuresWithBundles: merged.failures.size,
      failuresWithoutBundles: failureIds.filter((id) => !merged.failures.has(id)).length
    },
    cases: [...merged.cases.values()].map((item) => ({
      id: item.id,
      category: item.category,
      fingerprint: item.source?.fingerprint || item.fingerprint || '',
      verdict: item.source?.verdict || item.verdict || ''
    })),
    structures: merged.structures.slice(0, 24),
    failures: failureIds.map((id) => {
      const bundle = merged.failures.get(id);
      const compact = merged.compactFailures.get(id);
      return {
        id,
        bundle: bundle ? `qa/failures/${id}.json` : null,
        failedFields: bundle?.failedFields || compact?.failedFields || [],
        fingerprint: bundle?.fingerprint || compact?.fingerprint || '',
        falsePositive: Boolean(bundle?.falsePositive ?? compact?.falsePositive),
        reason: bundle ? oneLineReason(bundle) : (compact ? 'compact entry only — export the failure bundles for detail' : '')
      };
    }),
    offlineReplay: merged.runs.length
      ? merged.runs[0].value.summary
      : null
  };
}

export function writeFailureBundles(merged, out = 'qa') {
  const written = [];
  const failureIds = [...new Set([...merged.failures.keys(), ...merged.compactFailures.keys()])].sort();
  for (const id of failureIds) {
    const bundle = merged.failures.get(id) || {
      ...merged.compactFailures.get(id),
      detail: 'compact-entry-only',
      note: 'Export "Failed Cases" from the popup to get the full bundle for this failure.'
    };
    written.push(writeJson(join(outDir(out), 'failures', `${id}.json`), bundle));
  }
  return written;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node tools/qa-report.mjs [--input <file|dir>]... [--out qa] [--json]');
    return 0;
  }

  const inputs = args.inputs.length ? args.inputs : [join(ROOT, 'qa/inbox'), join(ROOT, 'qa')];
  const files = collectInputFiles(inputs);
  if (!files.length) {
    console.error(`no QA export found in: ${args.inputs.length ? args.inputs.join(', ') : 'qa/inbox, qa'}`);
    console.error('Export one from the popup: [Export Summary] (and [Export Failed Cases] when something failed).');
    return 1;
  }

  const merged = mergeExports(classifyInputs(files));
  const summary = buildSummary(merged);
  const summaryPath = writeJson(join(outDir(args.out), 'qa-summary.json'), summary);
  const bundles = writeFailureBundles(merged, args.out);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  const values = summary.summary || {};
  console.log(`QA report — ${merged.sourceFiles.length} export file(s)`);
  console.log(`captured ${values.total ?? 0} · cases ${values.cases ?? 0} · PASS ${values.pass ?? 0} · FAIL ${values.fail ?? 0} · EXPECTED_LIMITATION ${values.expectedLimitation ?? 0} · NOT_TESTED ${values.notTested ?? 0}`);
  console.log(`falsePositive ${values.falsePositive ?? 0} · falseNegative ${values.falseNegative ?? 0} · pageRecognition ${values.pageRecognitionRate ?? 'n/a'} · matchPrecision ${values.matchPrecision ?? 'n/a'} · newStructures ${values.newStructures ?? 0}`);
  if (values.requestBudget) {
    const budget = values.requestBudget;
    console.log(`requests ${budget.total ?? 0} (avg ${budget.averagePerCapture ?? 0}) · zeroRequest ${budget.zeroRequestCaptures ?? 0} · cacheHit ${budget.cacheHitCaptures ?? 0} · overBudget ${budget.overBudget ?? 0}`);
  }
  if (summary.structures?.length) {
    console.log(`structures (${summary.structures.length}): ${summary.structures.slice(0, 6).map((item) => `${item.fingerprint}×${item.count}`).join(', ')}`);
  }
  if (summary.offlineReplay) {
    console.log(`offline replay: PASS ${summary.offlineReplay.pass ?? 0} · FAIL ${summary.offlineReplay.fail ?? 0} · limitation ${summary.offlineReplay.expectedLimitation ?? 0} · cacheMissed ${summary.offlineReplay.cacheMissed ?? 0}`);
  }
  if (summary.failures.length) {
    console.log(`failures (${summary.failures.length}) — only these need attention:`);
    for (const item of summary.failures) console.log(`  ${item.id}  ${item.reason}`);
  } else {
    console.log('failures: none');
  }
  if (merged.unknown.length) console.log(`ignored: ${merged.unknown.join(', ')}`);
  console.log(`\nwrote ${relativeToRoot(summaryPath)}${bundles.length ? ` and ${bundles.length} failure bundle(s) in ${args.out}/failures/` : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
