#!/usr/bin/env node
/**
 * Import a QA test-case pack (requirements doc §13 / §16 / §26).
 *
 * The popup's `[Export Test Case Pack]` writes one JSON file. This tool splits
 * it the way the repository requires:
 *
 *   tests/real-world/<category>/RW-001.json   committed — structure + expectation only
 *   qa/captures/RW-001.json                   git-ignored — the replayable page summary
 *   tests/sites.local.json                    git-ignored — the real URLs
 *
 * So the committed fixtures stay anonymous (no titles, no urls) while the local
 * ones keep everything the offline runner needs (§9).
 *
 * Usage:
 *   node tools/qa-import.mjs --input qa/inbox/qa-tests-2026-09-12-001.json
 *   node tools/qa-import.mjs --input qa/inbox --out qa --dry-run
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { categoryDirOf } from '../src/qa/fingerprint.js';
import { listJsonFiles, outDir, readJson, writeJson, ROOT, relativeToRoot } from './lib/qa-files.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { inputs: [], out: 'qa', root: ROOT, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--input') args.inputs.push(argv[++i] || '');
    else if (value === '--out') args.out = argv[++i] || 'qa';
    else if (value === '--root') args.root = argv[++i] || ROOT;
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--json') args.json = true;
    else if (value === '--help' || value === '-h') args.help = true;
  }
  return args;
}

function collectPacks(inputs) {
  const files = [];
  for (const input of inputs) {
    if (!input) continue;
    if (!existsSync(input)) continue;
    if (input.endsWith('.json')) files.push(input);
    else files.push(...listJsonFiles(input));
  }
  const packs = [];
  for (const file of files) {
    try {
      const value = readJson(file);
      if (value?.kind === 'qa-tests' || Array.isArray(value?.cases)) packs.push({ file, value });
    } catch {
      /* ignore unrelated json */
    }
  }
  return packs;
}

/** The committed case file: structure + expectation, never a title or a url */
function caseFile(caseRecord, capture) {
  const features = caseRecord.features || capture?.features || {};
  return {
    id: caseRecord.id,
    category: caseRecord.category || capture?.category || 'unknown',
    title: caseRecord.note || '',
    features: {
      pageType: features.pageType || capture?.pageType || 'unknown',
      h1: Boolean(features.h1),
      ogTitle: Boolean(features.ogTitle),
      jsonLd: Boolean(features.jsonLd),
      galleryInfo: Boolean(features.galleryInfo),
      manyImages: Boolean(features.manyImages),
      spaNavigation: Boolean(features.spaNavigation)
    },
    expected: caseRecord.expected || {},
    source: {
      fingerprint: capture?.fingerprint || caseRecord.source?.fingerprint || '',
      pageType: capture?.pageType || features.pageType || 'unknown',
      novelty: caseRecord.source?.novelty ?? null,
      capturedAt: caseRecord.capturedAt || ''
    },
    note: caseRecord.note || ''
  };
}

export function importPacks({ packs, out = 'qa', root = ROOT, dryRun = false } = {}) {
  const written = { cases: [], captures: [], sites: [] };
  const sites = {};

  for (const pack of packs) {
    const cases = Array.isArray(pack.value.cases) ? pack.value.cases : [];
    const captures = new Map((pack.value.captures || []).map((item) => [item.id, item]));
    const siteMap = pack.value.sites || {};
    for (const caseRecord of cases) {
      const capture = captures.get(caseRecord.captureId) || null;
      if (capture) {
        const capturePath = join(outDir(out), 'captures', `${caseRecord.id}.json`);
        if (!dryRun) writeJson(capturePath, { schema: 'manga-nav/qa-capture-local@1', caseId: caseRecord.id, capture });
        written.captures.push(relativeToRoot(capturePath));
      }
      const dir = categoryDirOf(caseRecord.category, caseRecord.features || capture?.features || {});
      const casePath = join(root, 'tests/real-world', dir, `${caseRecord.id}.json`);
      if (!dryRun) writeJson(casePath, caseFile(caseRecord, capture));
      written.cases.push(relativeToRoot(casePath));

      const url = siteMap[caseRecord.id];
      if (url && !/^<.*>$/.test(url)) {
        sites[caseRecord.id] = { url, origin: capture?.origin || '', capturedAt: caseRecord.capturedAt || '' };
        written.sites.push(caseRecord.id);
      }
    }
  }

  if (Object.keys(sites).length) {
    const sitesPath = join(root, 'tests/sites.local.json');
    const value = {
      schema: 'manga-nav/qa-sites@1',
      note: 'Real test-page urls. Git-ignored on purpose (requirements doc §13): do not commit, do not paste into issues.',
      sites
    };
    if (!dryRun) writeJson(sitesPath, value);
    written.sitesPath = relativeToRoot(sitesPath);
  }

  return written;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node tools/qa-import.mjs --input <qa-tests-*.json|dir> [--out qa] [--dry-run]');
    return 0;
  }
  const inputs = args.inputs.length ? args.inputs : ['qa/inbox', 'qa'];
  const packs = collectPacks(inputs);
  if (!packs.length) {
    console.error(`no test-case pack found in: ${inputs.join(', ')}`);
    console.error('Export one from the popup first: [Export Test Case Pack]');
    return 1;
  }
  const result = importPacks({ packs, out: args.out, root: args.root, dryRun: args.dryRun });

  if (args.json) {
    console.log(JSON.stringify({ packs: packs.map((item) => item.file), ...result }, null, 2));
    return 0;
  }
  console.log(`packs: ${packs.length}`);
  console.log(`case files (committed): ${result.cases.length}`);
  for (const file of result.cases) console.log(`  ${file}`);
  console.log(`local captures (git-ignored): ${result.captures.length}`);
  if (result.sitesPath) {
    console.log(`real urls (git-ignored): ${result.sitesPath} — ${result.sites.length} entr${result.sites.length === 1 ? 'y' : 'ies'}`);
  } else {
    console.log('real urls: none in this pack (the export was anonymised) — re-export with "包含真实标题 / URL" checked if you need offline replay');
  }
  if (args.dryRun) console.log('dry-run: nothing was written');
  console.log('\nnext: node tools/qa-run.mjs');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
