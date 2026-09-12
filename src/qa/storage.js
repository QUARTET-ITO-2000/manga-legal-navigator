/**
 * QA data lifecycle (requirements doc §32 / §33).
 *
 * Everything lives in chrome.storage.local under a single key, with an
 * in-memory fallback so the module can also be imported by the Node tools and
 * the test suite. Nothing here ever leaves the machine: there is no upload, and
 * `[Clear QA Data]` deletes the whole record in one step.
 */

import { CONFIG } from '../lib/config.js';
import { mergeCapture, findCapture } from './record.js';

const QA_KEY = 'mn:qa';
const QA_ERROR_KEY = 'mn:qa:error';

let memoryState = null;

function storageArea() {
  return globalThis.chrome?.storage?.local ?? null;
}

export function emptyQaState() {
  return {
    schema: 'manga-nav/qa@1',
    captures: [],
    cases: [],
    meta: { nextCapture: 1, nextCase: 1, exports: {} }
  };
}

function normalize(value) {
  const base = emptyQaState();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    captures: Array.isArray(value.captures) ? value.captures : [],
    cases: Array.isArray(value.cases) ? value.cases : [],
    meta: { ...base.meta, ...(value.meta || {}), exports: { ...(value.meta?.exports || {}) } }
  };
}

export async function readQa() {
  const area = storageArea();
  if (!area) {
    if (!memoryState) memoryState = emptyQaState();
    return normalize(memoryState);
  }
  const result = await area.get(QA_KEY);
  return normalize(result?.[QA_KEY]);
}

export async function writeQa(state) {
  const value = normalize(state);
  const area = storageArea();
  if (!area) {
    memoryState = value;
    return value;
  }
  await area.set({ [QA_KEY]: value });
  return value;
}

export async function clearQa() {
  const area = storageArea();
  if (!area) {
    memoryState = emptyQaState();
    memoryError = null;
    return memoryState;
  }
  await area.remove([QA_KEY, QA_ERROR_KEY]);
  return emptyQaState();
}

/**
 * QA must never break the normal analysis flow, but it must also never fail
 * *silently* (§28 "错误信息"): the last capture error is kept so the popup can
 * show it, instead of the counter mysteriously staying at 0.
 */
let memoryError = null;

export async function recordQaError(error, context = {}) {
  const entry = {
    at: Date.now(),
    message: String((error && error.message) || error),
    name: String((error && error.name) || 'Error'),
    stack: String((error && error.stack) || '').split('\n').slice(0, 3).join(' | '),
    context
  };
  try {
    const area = storageArea();
    if (!area) {
      memoryError = entry;
      return entry;
    }
    await area.set({ [QA_ERROR_KEY]: entry });
    return entry;
  } catch {
    memoryError = entry; // even the error report may fail; keep it in memory
    return entry;
  }
}

export async function readQaError() {
  try {
    const area = storageArea();
    if (!area) return memoryError;
    const result = await area.get(QA_ERROR_KEY);
    return result?.[QA_ERROR_KEY] ?? null;
  } catch {
    return memoryError;
  }
}

export async function clearQaError() {
  memoryError = null;
  const area = storageArea();
  if (!area) return;
  try {
    await area.remove(QA_ERROR_KEY);
  } catch {
    /* ignore */
  }
}

/** Local, sequential capture id — used for the failure-bundle names (FAIL-017) */
function takeCaptureId(state) {
  const id = `QA-${String(state.meta.nextCapture || 1).padStart(4, '0')}`;
  state.meta.nextCapture = (state.meta.nextCapture || 1) + 1;
  return id;
}

/**
 * Store one capture. A page that is analysed again (a repeat visit, or a
 * client-side navigation back to it) updates the existing record instead of
 * adding a second one, so "Captured" counts pages, not analyses.
 */
export async function recordCapture(fresh) {
  const state = await readQa();
  const existing = findCapture(state.captures, fresh.pageKey);
  const capture = existing
    ? mergeCapture(existing, fresh, { maxObservations: CONFIG.qa.maxObservations })
    : { ...fresh, id: fresh.id || takeCaptureId(state) };
  if (existing) {
    state.captures = state.captures.map((item) => (item.pageKey === capture.pageKey ? capture : item));
  } else {
    state.captures = [...state.captures, capture];
    if (state.captures.length > CONFIG.qa.maxCaptures) {
      state.captures = state.captures.slice(state.captures.length - CONFIG.qa.maxCaptures);
    }
  }
  await writeQa(state);
  return { capture, isNew: !existing, state };
}

/** Apply a change (verdict, false-positive flag, note) to the capture of one page */
export async function updateCapture(pageKey, updater) {
  const state = await readQa();
  let updated = null;
  state.captures = state.captures.map((item) => {
    if (item.pageKey !== pageKey) return item;
    updated = updater(item) || item;
    return updated;
  });
  if (updated) await writeQa(state);
  return updated;
}

export async function addCase(record) {
  const state = await readQa();
  const existing = state.cases.find((item) => item.id === record.id);
  const value = { ...record, id: existing ? existing.id : record.id };
  state.cases = existing
    ? state.cases.map((item) => (item.id === value.id ? value : item))
    : [...state.cases, value];
  state.meta.nextCase = Math.max(state.meta.nextCase || 1, countCases(state) + 1);
  await writeQa(state);
  return { case: value, state, replaced: Boolean(existing) };
}

function countCases(state) {
  const numbers = state.cases
    .map((item) => Number(/^RW-(\d+)$/.exec(String(item.id || ''))?.[1] || 0))
    .filter((value) => value > 0);
  return numbers.length ? Math.max(...numbers) : 0;
}

/**
 * Next test-case id (§13). Cases are numbered by the highest existing RW-nnn,
 * so a case deleted by hand never shifts the others.
 */
export function nextCaseNumber(state) {
  return Math.max(state.meta.nextCase || 1, countCases(state) + 1);
}

export function todayLabel(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Export file counter (§8): `qa-report-2026-09-12-001.json`, then `-002`, …
 * The counter restarts each day.
 */
export async function takeExportLabel(date = new Date()) {
  const state = await readQa();
  const day = todayLabel(date);
  const current = state.meta.exports?.[day] || 0;
  const next = current + 1;
  state.meta.exports = { ...(state.meta.exports || {}), [day]: next };
  // Keep the counter file from growing forever: three days of exports is plenty.
  const keys = Object.keys(state.meta.exports).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - 3))) delete state.meta.exports[key];
  await writeQa(state);
  return { day, seq: String(next).padStart(3, '0') };
}

/** Test hook: forget the in-memory fallback state */
export function __resetMemoryQa() {
  memoryState = null;
}
