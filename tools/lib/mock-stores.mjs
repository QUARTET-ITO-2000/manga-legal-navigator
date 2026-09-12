/**
 * Offline store backend for the QA runner (tools/qa-run.mjs).
 *
 * It answers store requests from the committed snapshots in
 * src/stores/fixtures/, exactly like the extension's "offline sample data"
 * debug switch does. That is what makes a real-world regression run repeatable
 * without touching the network: the page summary comes from a QA capture, the
 * store answers come from the fixture files.
 *
 * Live runs (`qa-run.mjs --live`) use tools/probe-store.mjs createFetchText
 * instead, and stay limited to the cases the user listed (requirements doc §31).
 */

import { readFileSync } from 'node:fs';

import { ROOT } from './qa-files.mjs';

const FIXTURES = {
  dlsite: 'src/stores/fixtures/dlsite-search-sample.html',
  dlsiteOther: 'src/stores/fixtures/dlsite-not-found-sample.html',
  fanza: 'src/stores/fixtures/fanza-search-sample.html',
  melonbooks: 'src/stores/fixtures/melonbooks-search-sample.html',
  pixiv: 'src/stores/fixtures/pixiv-search-sample.json',
  fantia: 'src/stores/fixtures/fantia-search-sample.html'
};

function read(path) {
  return readFileSync(`${ROOT}${path}`, 'utf8');
}

export function mockFixtureText(url) {
  if (/dmm\.co\.jp/.test(url)) return read(FIXTURES.fanza);
  if (/melonbooks\.co\.jp/.test(url)) return read(FIXTURES.melonbooks);
  if (/pixiv\.net/.test(url)) return read(FIXTURES.pixiv);
  if (/fantia\.jp/.test(url)) return read(FIXTURES.fantia);
  if (/\/girls\/fsr\//.test(url)) return read(FIXTURES.dlsiteOther);
  return read(FIXTURES.dlsite);
}

/**
 * Deps object for analyzePage(): fixture-backed fetch plus an in-memory cache,
 * with the same request counting the extension does.
 */
export function createMockDeps({ onRequest = null } = {}) {
  const cache = new Map();
  const stats = { total: 0, byStore: {} };
  return {
    stats,
    deps: {
      fetchText: async (url) => {
        stats.total += 1;
        onRequest?.(url);
        return { ok: true, status: 200, text: mockFixtureText(url), url, mock: true };
      },
      cache: {
        get: async (key) => cache.get(key) || null,
        set: async (key, value) => { cache.set(key, { ...value, at: Date.now() }); }
      }
    }
  };
}
