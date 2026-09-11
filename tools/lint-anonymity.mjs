#!/usr/bin/env node
/**
 * Anonymity lint.
 *
 * This project must not publish third-party identifiers: store product ids,
 * gallery ids, or the titles/circle names that go with them. The lint is
 * deliberately written as *shape* rules plus two lists, so the checker itself
 * never contains a real name:
 *
 *   tools/anonymity-allowlist.txt  (committed)  placeholder ids that are fine
 *   docs/forbidden-names.local.txt (git-ignored, optional)  real names to flag
 *
 * Checks:
 *   product-id     store product ids (RJ…, BJ…, d_…) that are not placeholders
 *   gallery-id     gallery paths such as /g/000123/ that are not placeholders
 *   encoded-text   percent-encoded runs that decode to non-ASCII text
 *                  (a common way for a real title to survive anonymisation)
 *   denylisted     a string from the local denylist was found
 *
 * A line containing `anonymity-lint: allow` skips the shape rules for that line
 * (used for percent-encoded placeholder text). The local denylist still applies
 * to such lines.
 *
 * Usage:
 *   node tools/lint-anonymity.mjs                 # scan tracked + untracked (not ignored) files
 *   node tools/lint-anonymity.mjs --all           # scan the working tree
 *   node tools/lint-anonymity.mjs --cjk           # also list CJK text in comments/markdown for review
 *   node tools/lint-anonymity.mjs --path src      # scan one directory or file
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWLIST_PATH = 'tools/anonymity-allowlist.txt';
const DENYLIST_PATH = 'docs/forbidden-names.local.txt';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml']);

/** Store product id: RJ00000001 (placeholder) or an id that should not be published */
const PRODUCT_ID = /\b(?:RJ|BJ)\d{6,}\b|\bd_\d{5,}\b/g;
/** Melonbooks-style query parameter: ?product_id=1000001 (allowlisted placeholder) */
const PRODUCT_QUERY = /[?&]product_id=(\d{4,})/g;
/** Gallery path: /g/000123/ (placeholder) */
const GALLERY_PATH = /\/g\/(\d{4,})(?=[/?"'\s]|$)/g;
/** Two or more percent-encoded bytes in a row */
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2}){2,}/g;
/** CJK runs, used by the review mode */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu;

function readList(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** Build the matcher used by lintText(). */
export function createChecker({ allow = [], deny = [] } = {}) {
  const allowed = new Set(allow);
  return { allowed, deny };
}

function isAllowedIdentifier(value, allowed) {
  if (allowed.has(value)) return true;
  // Anything that is a zero-padded placeholder (RJ00000001, d_00000001) is fine.
  return /^(?:RJ|BJ|d_)?0{6,}\d*$/.test(value.replace(/^d_/, ''));
}

/**
 * Lint one text blob.
 * @returns {Array<{line:number, column:number, kind:string, match:string}>}
 */
export function lintText(text, checker = createChecker()) {
  const findings = [];
  const value = String(text ?? '');

  const lines = value.split('\n');
  const push = (index, kind, match, column) => {
    findings.push({ line: index + 1, column: column + 1, kind, match });
  };

  lines.forEach((line, index) => {
    const waived = line.includes('anonymity-lint: allow');
    if (!waived) {
    for (const match of line.matchAll(PRODUCT_ID)) {
      if (!isAllowedIdentifier(match[0], checker.allowed)) push(index, 'product-id', match[0], match.index);
    }
    for (const match of line.matchAll(PRODUCT_QUERY)) {
      if (!checker.allowed.has(match[1]) && !/^0{6,}\d*$/.test(match[1])) push(index, 'product-id', match[0], match.index);
    }
    for (const match of line.matchAll(GALLERY_PATH)) {
      if (!checker.allowed.has(match[0]) && !/^0{3,}\d*$/.test(match[1])) push(index, 'gallery-id', match[0], match.index);
    }
    for (const match of line.matchAll(PERCENT_RUN)) {
      let decoded = '';
      try {
        decoded = decodeURIComponent(match[0]);
      } catch {
        decoded = '';
      }
      if (/[^\x00-\x7F]/.test(decoded)) push(index, 'encoded-text', match[0], match.index);
    }
    }
    for (const entry of checker.deny) {
      const at = line.toLowerCase().indexOf(entry.toLowerCase());
      if (at !== -1) push(index, 'denylisted', entry, at);
    }
  });

  return findings;
}

/** List CJK runs for manual review (comments, markdown and test data). */
export function reviewCjk(text) {
  const found = new Set();
  for (const line of String(text ?? '').split('\n')) {
    for (const match of line.matchAll(CJK_RUN)) found.add(match[0]);
  }
  return [...found];
}

function listFiles(root, target) {
  const files = [];
  const walk = (path) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (SKIP_DIRS.has(entry)) continue;
        walk(join(path, entry));
      }
      return;
    }
    const ext = path.slice(path.lastIndexOf('.'));
    if (TEXT_EXTENSIONS.has(ext)) files.push(path);
  };
  if (existsSync(target)) walk(target);
  return files.map((file) => relative(root, file)).sort();
}

/**
 * Every file that is or will become part of the repository: tracked files plus
 * untracked files that are not ignored. Scanning only tracked files would miss
 * a new file that has not been added yet — exactly the gap that let a real id
 * slip into an earlier commit.
 */
function repositoryFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const root = process.cwd();
  const target = args.includes('--path') ? args[args.indexOf('--path') + 1] : null;
  const scanAll = args.includes('--all') || Boolean(target);
  const withCjk = args.includes('--cjk');

  const fromGit = scanAll ? null : repositoryFiles(root);
  const files = target ? listFiles(root, target) : (fromGit || listFiles(root, '.'))
    .filter((file) => TEXT_EXTENSIONS.has(file.slice(file.lastIndexOf('.'))))
    // `git ls-files` also lists files that were just deleted from the working
    // tree, which would make readFileSync throw.
    .filter((file) => existsSync(join(root, file)));

  const checker = createChecker({
    allow: readList(join(root, ALLOWLIST_PATH)),
    deny: readList(join(root, DENYLIST_PATH))
  });

  let problems = 0;
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const finding of lintText(text, checker)) {
      problems += 1;
      console.log(`${file}:${finding.line}:${finding.column}  ${finding.kind}  ${finding.match}`);
    }
    if (withCjk) {
      const tokens = reviewCjk(text);
      if (tokens.length) console.log(`# review ${file}: ${tokens.join(' ')}`);
    }
  }

  if (problems) {
    console.error(`\n${problems} finding(s). Replace real identifiers with placeholders (see README "Test fixtures").`);
    process.exit(1);
  }
  console.log(`anonymity lint: ${files.length} file(s) checked, no findings.`);
}

// Compare through pathToFileURL(): a hand-built `file://${argv[1]}` string does
// not match when the path contains characters such as spaces, and the script
// would then exit silently without scanning anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
