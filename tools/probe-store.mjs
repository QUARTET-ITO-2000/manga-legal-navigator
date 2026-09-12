#!/usr/bin/env node
/**
 * Live store probe — generalised from tools/probe-dlsite.mjs
 * (requirements doc §29 / §30).
 *
 * It answers two questions about one keyword:
 *   1. do the search URL and the parser still work? (health)
 *   2. which candidates does the matcher actually see? (top list)
 *
 * The output is a compact summary: no full HTML unless `--raw` is passed
 * explicitly, because the HTML is exactly what the QA workflow tries to keep
 * out of the picture (requirements doc §7 / §26 / §29).
 *
 * Usage:
 *   node tools/probe-store.mjs --store dlsite "サンプル作品名"
 *   node tools/probe-store.mjs --store fanza --title "【サンプル作品】第3話 - 免费漫画"
 *   node tools/probe-store.mjs --all "サンプル作品名"
 *   node tools/probe-store.mjs --store melonbooks "キーワード" --json
 *
 * Options:
 *   --store <id>      dlsite | fanza | melonbooks | pixiv | fantia (repeatable)
 *   --all             probe every registered store
 *   --title <text>    run a page title through the pipeline (clean → search → match)
 *   --raw             also print a short HTML fragment, to re-calibrate the selectors
 *   --json            print machine-readable JSON instead of the text summary
 *   --timeout <ms>    per-request timeout
 */

import { CONFIG } from '../src/lib/config.js';
import { analyzePage } from '../src/lib/pipeline.js';
import { extractWorkTitle } from '../src/lib/cleaner.js';
import { getAdapter, listStores } from '../src/stores/registry.js';
import { rankCandidates } from '../src/matching/matcher.js';
import { classifyStoreHealth, healthLabel } from '../src/lib/store-health.js';
import { pathToFileURL } from 'node:url';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function parseArgs(argv = []) {
  const args = { stores: [], keyword: '', title: '', raw: false, json: false, all: false, timeoutMs: CONFIG.search.timeoutMs };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--store') {
      const list = String(argv[++i] || '').split(',').map((item) => item.trim()).filter(Boolean);
      args.stores.push(...list);
    } else if (value === '--all') args.all = true;
    else if (value === '--title') args.title = argv[++i] || '';
    else if (value === '--raw') args.raw = true;
    else if (value === '--json') args.json = true;
    else if (value === '--timeout') args.timeoutMs = Number(argv[++i]) || CONFIG.search.timeoutMs;
    else if (!args.keyword) args.keyword = value;
  }
  return args;
}

/** Polite single-request fetcher: one request at a time, minimum interval */
export function createFetchText({ timeoutMs = CONFIG.search.timeoutMs } = {}) {
  const state = { lastAt: 0, calls: [] };
  const fetchText = async (url, options = {}) => {
    const wait = Math.max(0, CONFIG.search.minIntervalMs - (Date.now() - state.lastAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    state.lastAt = Date.now();
    state.calls.push(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: options.credentials || 'omit',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/json,application/xhtml+xml',
          'Accept-Language': 'ja,en;q=0.8'
        }
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text, url: response.url || url };
    } finally {
      clearTimeout(timer);
    }
  };
  return { fetchText, state };
}

/**
 * Probe one store with one keyword.
 * @returns {{ storeId, label, steps, itemCount, health, healthLabel, candidates, requests }}
 */
export async function probeStore({ storeId, keyword, fetchText, timeoutMs }) {
  const adapter = getAdapter(storeId);
  const plan = adapter.searchPlan(keyword);
  const steps = [];
  const items = [];
  const seen = new Set();
  let snippets = [];

  for (const step of plan) {
    let response;
    try {
      response = await adapter.searchStep(step, { fetchText, adapterId: adapter.id, timeoutMs });
    } catch (error) {
      steps.push({ id: step.id, url: step.url, httpStatus: 0, ok: false, reason: 'network-error', itemCount: 0, error: String(error?.message || error) });
      continue;
    }
    const parsedItems = Array.isArray(response.items) ? response.items : [];
    steps.push({
      id: step.id,
      url: step.url,
      httpStatus: response.httpStatus,
      ok: Boolean(response.ok),
      reason: String(response.reason || ''),
      itemCount: parsedItems.length,
      needsAgeCheck: Boolean(response.needsAgeCheck),
      needsLogin: Boolean(response.needsLogin)
    });
    for (const item of parsedItems) {
      if (item?.productId && seen.has(item.productId)) continue;
      if (item?.productId) seen.add(item.productId);
      items.push(item);
    }
    if (steps[steps.length - 1].reason !== 'ok') {
      snippets.push(String(response.text || '').replace(/\s+/g, ' ').slice(0, 160));
    }
  }

  const ranked = rankCandidates([keyword], items);
  const health = classifyStoreHealth({ steps, itemCount: items.length });
  return {
    storeId: adapter.id,
    label: adapter.label,
    keyword,
    steps,
    itemCount: items.length,
    health,
    healthLabel: healthLabel(health),
    candidates: ranked.slice(0, 5).map((item) => ({
      productId: item.productId,
      title: item.title,
      priceText: item.isFree ? 'free' : item.priceText,
      score: item.score,
      url: item.url
    })),
    emptyResultNote: adapter.emptyResultNote || '',
    snippets
  };
}

/** Simulate a page title end-to-end (clean → search → match) */
async function probePipeline({ storeId, title, fetchText }) {
  const pageInfo = {
    url: 'https://www.example-manga.test/comic/1/3',
    host: 'www.example-manga.test',
    title,
    h1: [],
    ogTitle: '',
    textSample: title,
    imageCount: 12
  };
  const stats = { total: 0, byStore: {} };
  const cache = new Map();
  const state = await analyzePage({
    pageInfo,
    settings: { storeId },
    deps: {
      fetchText: async (url, options) => {
        stats.total += 1;
        return fetchText(url, options);
      },
      cache: {
        get: async (key) => cache.get(key) || null,
        set: async (key, value) => { cache.set(key, { ...value, at: Date.now() }); }
      }
    }
  });
  return {
    cleanedTitle: state.query?.cleanedTitle || '',
    variants: state.query?.variants || [],
    status: state.status,
    reason: state.reason,
    match: state.match ? { title: state.match.title, priceText: state.match.priceText, score: state.match.score, url: state.match.url } : null,
    preview: (state.meta?.preview || []).slice(0, 5),
    requests: stats.total,
    stores: (state.stores || []).map((item) => ({ storeId: item.storeId, kind: item.kind, health: item.health, itemCount: item.itemCount }))
  };
}

function printStoreSummary(result) {
  console.log(`\nStore: ${result.label} (${result.storeId})`);
  for (const step of result.steps) {
    console.log(`  [${step.id}] HTTP: ${step.httpStatus}  Parsed: ${step.itemCount}  reason=${step.reason}`);
    if (result.raw) console.log(`        url: ${step.url}`);
  }
  console.log(`HTTP: ${result.steps[0]?.httpStatus ?? 0}`);
  console.log(`Parsed: ${result.itemCount}`);
  console.log(`Health: ${result.health} — ${result.healthLabel}`);
  if (!result.candidates.length) {
    if (result.emptyResultNote) console.log(`Note: ${result.emptyResultNote}`);
    for (const snippet of result.snippets.slice(0, 1)) console.log(`Page snippet: ${snippet}`);
    return;
  }
  console.log('Top candidates:');
  result.candidates.forEach((item, index) => {
    console.log(`${index + 1}. ${item.title.slice(0, 60)}  score=${item.score}${item.priceText ? `  ${item.priceText}` : ''}`);
  });
}

export async function runProbeCli({ store = null, argv = process.argv.slice(2) } = {}) {
  const args = parseArgs(argv);
  const storeIds = args.all
    ? listStores()
    : (args.stores.length ? args.stores : [store || 'dlsite']);
  const keyword = args.title
    ? (extractWorkTitle({ host: 'example-manga.test', title: args.title }).cleanedTitle || args.title)
    : args.keyword;

  if (!keyword) {
    console.error('usage: node tools/probe-store.mjs --store <dlsite|fanza|melonbooks|pixiv|fantia> "<keyword>" [--title "<page title>"] [--raw] [--json]');
    process.exit(1);
  }

  const { fetchText } = createFetchText({ timeoutMs: args.timeoutMs });

  if (args.title) {
    console.log('== keyword after cleaning ==');
    console.log(`  page title: ${args.title}`);
    console.log(`  keyword: ${keyword}`);
  }

  const output = { keyword, title: args.title, stores: [] };
  for (const storeId of storeIds) {
    const adapter = getAdapter(storeId);
    for (const step of adapter.searchPlan(keyword)) {
      if (!args.json) console.log(`  search url [${step.id}]: ${step.url}`);
    }
    const result = await probeStore({ storeId: adapter.id, keyword, fetchText, timeoutMs: args.timeoutMs });
    result.raw = args.raw;
    output.stores.push(result);
    if (!args.json) printStoreSummary(result);
    if (args.raw && !args.json) {
      for (const snippet of result.snippets) console.log(`      raw: ${snippet}`);
    }
  }

  if (args.title) {
    const pipeline = await probePipeline({ storeId: storeIds[0], title: args.title, fetchText });
    output.pipeline = pipeline;
    if (!args.json) {
      console.log('\n== full pipeline (simulating a page title) ==');
      console.log(`  cleaned title: ${pipeline.cleanedTitle || '(none)'}`);
      console.log(`  search variants: ${JSON.stringify(pipeline.variants)}`);
      console.log(`  requests: ${pipeline.requests}`);
      console.log(`  status: ${pipeline.status}${pipeline.reason ? ` (${pipeline.reason})` : ''}`);
      if (pipeline.match) console.log(`  matched: "${pipeline.match.title}" ${pipeline.match.priceText || ''} score=${pipeline.match.score}`);
      for (const item of pipeline.preview) console.log(`    - ${String(item.score).padStart(3)} ${String(item.title).slice(0, 50)}`);
    }
  }

  if (args.json) console.log(JSON.stringify(output, null, 2));
  else console.log('\ndone.');
  return output;
}

// Run when called directly. Compare through pathToFileURL(): a hand-built
// `file://${argv[1]}` string does not match when the path contains spaces, and
// the probe would then exit silently. probe-dlsite.mjs imports runProbeCli.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProbeCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
