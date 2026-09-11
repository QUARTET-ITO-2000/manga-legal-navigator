/**
 * Search result cache (requirements doc §18).
 * Uses chrome.storage.local and falls back to an in-memory Map under Node.
 * Cache keys are hashes of the search keywords only, so which pages the user
 * visited is never stored.
 */

import { CONFIG } from './config.js';

/**
 * Bumping this prefix invalidates every cached search result. Do it whenever a
 * store adapter changes the shape of its items (field renamed, added, removed),
 * otherwise the old parsed objects would keep being served from cache and the
 * UI would show stale labels (this happened: Pixiv items lost their `store`
 * field and the card kept saying "DLsite" until the cache expired).
 */
const KEY_PREFIX = 'mn:search:v2:';
const memory = new Map();

function storageArea() {
  return globalThis.chrome?.storage?.local ?? null;
}

function hashText(input) {
  let hash = 5381;
  const value = String(input ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function cacheKeyFor(storeId, queries) {
  const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean);
  return `${KEY_PREFIX}${storeId}:${hashText(list.join('\u0001'))}`;
}

async function readEntry(key) {
  const area = storageArea();
  if (!area) return memory.get(key) ?? null;
  const result = await area.get(key);
  return result?.[key] ?? null;
}

async function writeEntry(key, value) {
  const area = storageArea();
  if (!area) {
    memory.set(key, value);
    return;
  }
  await area.set({ [key]: value });
}

async function removeEntry(key) {
  const area = storageArea();
  if (!area) {
    memory.delete(key);
    return;
  }
  await area.remove(key);
}

export async function getCachedSearch(key) {
  const entry = await readEntry(key);
  if (!entry || typeof entry.at !== 'number') return null;
  const hasItems = Array.isArray(entry.items) && entry.items.length > 0;
  const ttl = hasItems ? CONFIG.cache.positiveTtlMs : CONFIG.cache.negativeTtlMs;
  if (Date.now() - entry.at > ttl) {
    await removeEntry(key);
    return null;
  }
  return entry;
}

export async function setCachedSearch(key, payload) {
  await writeEntry(key, { ...payload, at: Date.now() });
  await pruneCache();
}

async function pruneCache() {
  const area = storageArea();
  if (!area) {
    while (memory.size > CONFIG.cache.maxEntries) {
      const oldest = [...memory.entries()].sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0))[0];
      if (!oldest) break;
      memory.delete(oldest[0]);
    }
    return;
  }
  const all = await area.get(null);
  const entries = Object.entries(all || {})
    .filter(([key]) => key.startsWith(KEY_PREFIX))
    .sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
  if (entries.length <= CONFIG.cache.maxEntries) return;
  const removeKeys = entries.slice(0, entries.length - CONFIG.cache.maxEntries).map(([key]) => key);
  if (removeKeys.length) await area.remove(removeKeys);
}

export async function clearSearchCache() {
  memory.clear();
  const area = storageArea();
  if (!area) return;
  const all = await area.get(null);
  const keys = Object.keys(all || {}).filter((key) => key.startsWith(KEY_PREFIX));
  if (keys.length) await area.remove(keys);
}

export async function getCacheStats() {
  const area = storageArea();
  if (!area) return { entries: memory.size };
  const all = await area.get(null);
  const keys = Object.keys(all || {}).filter((key) => key.startsWith(KEY_PREFIX));
  return { entries: keys.length };
}
