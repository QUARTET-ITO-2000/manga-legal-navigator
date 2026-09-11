#!/usr/bin/env node
/**
 * Live-store probe (requires network access).
 *
 * The requirements doc (§8) insists that the search implementation must be
 * based on measurements rather than assumptions about fixed URLs, so this probe
 * can be re-run at any time to check whether the URLs and the parsing still hold
 * after a store redesign.
 *
 * Usage:
 *   node tools/probe-dlsite.mjs "サンプル作品名"
 *   node tools/probe-dlsite.mjs --title "【サンプル作品】第3話 - 免费漫画 - 示例漫画网"
 *   node tools/probe-dlsite.mjs "キーワード" --raw
 *
 * Options:
 *   --title <page title>  run a page title through the whole pipeline (clean -> search -> match)
 *   --raw                 also print the fetched HTML fragments, to check the selectors
 */

import { CONFIG } from '../src/lib/config.js';
import { analyzePage } from '../src/lib/pipeline.js';
import { extractWorkTitle } from '../src/lib/cleaner.js';
import { DLsiteAdapter, encodeKeyword } from '../src/stores/dlsite.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let lastFetchAt = 0;

async function fetchText(url, { timeoutMs = CONFIG.search.timeoutMs } = {}) {
  const wait = Math.max(0, CONFIG.search.minIntervalMs - (Date.now() - lastFetchAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastFetchAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, url: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const args = { keyword: '', title: '', raw: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--title') args.title = argv[++i] || '';
    else if (value === '--raw') args.raw = true;
    else if (!args.keyword) args.keyword = value;
  }
  return args;
}

const adapter = new DLsiteAdapter();
const args = parseArgs(process.argv.slice(2));
const keyword = args.title || args.keyword;

if (!keyword) {
  console.error('usage: node tools/probe-dlsite.mjs "<keyword or page title>" [--title "<page title>"] [--raw]');
  process.exit(1);
}

console.log(`\n== 1. search URL ==`);
const probeKeyword = args.title
  ? (extractWorkTitle({ host: 'example-manga.test', title: args.title }).cleanedTitle || args.title)
  : keyword;
if (args.title) {
  console.log(`  page title: ${args.title}`);
  console.log(`  keyword after cleaning: ${probeKeyword}`);
}
const plan = adapter.searchPlan(probeKeyword);
for (const step of plan) console.log(`  [${step.id}] ${step.url}`);
console.log(`  (space encoding check: ${encodeKeyword(probeKeyword).includes('%20') ? '❌ %20 found — the WAF answers 403' : '✅ spaces are encoded as +'})`);

if (args.raw && args.title) {
  console.log(`  raw (uncleaned) keyword for comparison: ${adapter.buildSearchUrl(args.title)}`);
}

console.log(`\n== 2. fetch and parse ==`);
for (const step of plan) {
  const response = await fetchText(step.url);
  const parsed = adapter.parseResults(response.text, step);
  console.log(`  [${step.id}] http=${response.status} bytes=${response.text.length} ok=${parsed.ok} reason=${parsed.reason} items=${parsed.items.length}`);
  if (!parsed.ok) {
    const snippet = response.text.replace(/\s+/g, ' ').slice(0, 160);
    console.log(`      page snippet: ${snippet}`);
    continue;
  }
  for (const item of parsed.items.slice(0, 5)) {
    const price = item.isFree ? 'free' : item.priceText;
    console.log(`      - ${item.productId} ${price}${item.discountLabel ? ` (${item.discountLabel})` : ''} ${item.title.slice(0, 40)}`);
    console.log(`        ${item.url}`);
  }
  if (args.raw) {
    const index = response.text.lastIndexOf('id="search_result_list"');
    console.log(`      raw: ${response.text.slice(index, index + 600).replace(/\s+/g, ' ')}`);
  }
}

if (args.title) {
  console.log(`\n== 3. full pipeline (simulating a page title) ==`);
  const pageInfo = {
    url: 'https://www.example-manga.test/comic/1/3',
    host: 'www.example-manga.test',
    title: args.title,
    h1: [],
    ogTitle: '',
    textSample: args.title,
    imageCount: 12
  };
  const state = await analyzePage({
    pageInfo,
    settings: {},
    deps: { fetchText, cache: { get: async () => null, set: async () => {} } }
  });
  console.log(`  cleaned title: ${state.query?.cleanedTitle || '(none)'}`);
  console.log(`  search variants: ${JSON.stringify(state.query?.variants || [])}`);
  console.log(`  status: ${state.status} (${state.message || state.reason})`);
  if (state.match) {
    console.log(`  matched product: "${state.match.title}" ${state.match.priceText} score=${state.match.score}`);
    console.log(`  product URL: ${state.match.url}`);
  }
  if (state.meta.preview?.length) {
    console.log('  top 5 by score (useful when tuning the thresholds):');
    for (const item of state.meta.preview) console.log(`    - ${String(item.score).padStart(3)} ${item.title.slice(0, 50)}`);
  }
  if (state.candidates.length > 1) {
    console.log('  candidates:');
    for (const candidate of state.candidates) console.log(`    - ${candidate.score} ${candidate.title}`);
  }
}

console.log('\ndone.');
