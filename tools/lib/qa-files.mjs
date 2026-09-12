/**
 * Small file helpers shared by the QA tools (requirements doc §26).
 *
 * The QA workflow is: browser collects → local script counts → only the
 * failures go to Codex. These helpers are the "local script" plumbing: they
 * read the JSON the popup exported and write the compact files the workflow
 * refers to (qa/qa-summary.json, qa/failures/FAIL-017.json, …).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (the parent of tools/) */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function listJsonFiles(dir) {
  const found = [];
  const walk = (path) => {
    for (const entry of readdirSync(path)) {
      if (entry.startsWith('.')) continue;
      const next = join(path, entry);
      if (statSync(next).isDirectory()) walk(next);
      else if (entry.endsWith('.json')) found.push(next);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

export function pad(value, width = 3) {
  return String(value).padStart(width, '0');
}

/** Local day label, e.g. 2026-09-12 */
export function dayLabel(date = new Date()) {
  const pad2 = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function relativeToRoot(path) {
  const value = relative(ROOT, path);
  // A path outside the repository (an absolute --out) is shown as it is
  if (!value || value.startsWith('..')) return path;
  return value;
}

export function resolveFromRoot(...segments) {
  return resolve(ROOT, ...segments);
}

/** A QA output directory: relative paths resolve inside the repository */
export function outDir(value = 'qa') {
  return isAbsolute(String(value)) ? String(value) : join(ROOT, String(value));
}

/**
 * Sort QA export files into the three kinds the popup produces
 * (`qa-summary`, `qa-failures`, `qa-tests`) plus anything else it finds.
 */
export function classifyInputs(files) {
  const out = { summary: [], failures: [], tests: [], run: [], unknown: [] };
  for (const file of files) {
    let value;
    try {
      value = readJson(file);
    } catch {
      out.unknown.push({ file, error: 'unreadable-json' });
      continue;
    }
    const entry = { file, value };
    if (value?.kind === 'qa-summary') out.summary.push(entry);
    else if (value?.kind === 'qa-failures') out.failures.push(entry);
    else if (value?.kind === 'qa-tests') out.tests.push(entry);
    else if (value?.kind === 'qa-run') out.run.push(entry);
    else out.unknown.push(entry);
  }
  return out;
}
