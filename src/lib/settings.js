/**
 * Settings storage: uses chrome.storage.local when running as an extension and
 * falls back to an in-memory object when loaded in plain Node (tests).
 */

import { CONFIG } from './config.js';

const KEY = 'mn:settings';
let memorySettings = { ...CONFIG.defaults };

function storageArea() {
  return globalThis.chrome?.storage?.local ?? null;
}

export function defaultSettings() {
  return { ...CONFIG.defaults };
}

export async function getSettings() {
  const area = storageArea();
  if (!area) return { ...defaultSettings(), ...memorySettings };
  const result = await area.get(KEY);
  return { ...defaultSettings(), ...(result?.[KEY] || {}) };
}

export async function setSettings(patch = {}) {
  const next = { ...(await getSettings()), ...patch };
  const area = storageArea();
  if (!area) {
    memorySettings = next;
    return next;
  }
  await area.set({ [KEY]: next });
  return next;
}
