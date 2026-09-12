/**
 * End-to-end checks of the QA toolchain (requirements doc §26 / §27 / §28 / §36).
 *
 *   qa-run.mjs     replays tests/real-world/** through the pipeline
 *   qa-report.mjs  merges the popup exports into qa-summary.json + failure bundles
 *   qa-import.mjs  splits a test-case pack into committed cases + local files
 *
 * Everything is written into a temporary directory, so the repository is not
 * touched by the test run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildCapture, createCaseRecord, setFalsePositive, setVerdict, RESULT } from '../src/qa/record.js';
import { buildCasePack, buildFailureReport, buildSummaryReport } from '../src/qa/export.js';
import { parseArgs as parseProbeArgs } from '../tools/probe-store.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'manga-qa-'));

function runTool(script, args) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: 'utf8', cwd: ROOT });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const pageInfo = {
  url: 'https://doujin.example/g/000123/',
  host: 'doujin.example',
  origin: 'https://doujin.example',
  title: '【サンプル作品アルファ】第1話 - 免费漫画 - 示例漫画网',
  h1: ['サンプル作品アルファ 第1話'],
  headings: [{ level: 1, tag: 'h1', text: 'サンプル作品アルファ 第1話' }],
  ogTitle: 'サンプル作品アルファ',
  imageCount: 46,
  textSample: '第1話 サンプル作品アルファ',
  infoText: 'Parodies: original Tags: sample Languages: japanese Pages: 46',
  analysisCount: 1,
  settled: true
};

function captureOf(id, { failing = false } = {}) {
  const state = {
    status: 'ok_high',
    reason: 'high',
    page: { url: pageInfo.url, host: 'doujin.example', title: pageInfo.title, settled: true },
    query: { cleanedTitle: 'サンプル作品アルファ', source: 'title', confidence: 'high', variants: ['サンプル作品アルファ'], searched: ['サンプル作品アルファ'], artists: [], notes: [] },
    match: { productId: 'RJ00000001', title: 'サンプル作品アルファ', store: 'dlsite', score: 100 },
    candidates: [],
    stores: [{ storeId: 'dlsite', kind: 'high', itemCount: 7, fromCache: false, health: 'healthy', match: { score: 100 } }],
    meta: { signals: ['gallery-structure'], errors: [], preview: [] }
  };
  const capture = buildCapture({ pageInfo, state, requestStats: { analysis: 1, total: 1, byStore: { dlsite: 1 } }, id });
  return failing ? setFalsePositive(setVerdict(capture, RESULT.FAIL), true) : setVerdict(capture, RESULT.PASS);
}

test('qa-run：离线重放全部真实测试案例，缓存、误判、请求预算都会被检查', () => {
  const out = tmp();
  const result = runTool('tools/qa-run.mjs', ['--out', out, '--json']);
  const report = JSON.parse(result.stdout);

  assert.equal(report.schema, 'manga-nav/qa-run@1');
  assert.equal(report.mode, 'offline');
  assert.ok(report.summary.total >= 10, `至少要有 10 个案例，实际 ${report.summary.total}`);
  assert.equal(report.summary.cacheMissed, 0, '第二次分析必须命中缓存（§24）');
  assert.ok(report.summary.falsePositive <= 1, '相似作品误判要被记录，但不应该变多');

  const rw004 = report.results.find((item) => item.id === 'RW-004');
  assert.equal(rw004.verdict, RESULT.FAIL, 'RW-004 是已知的清洗缺陷，应该在结果里暴露出来');
  assert.equal(rw004.failedFields.includes('titleExtraction'), true);
  assert.equal(rw004.failureId, 'FAIL-004');

  const rw012 = report.results.find((item) => item.id === 'RW-012');
  assert.equal(rw012.verdict, RESULT.PASS);
  assert.equal(rw012.results.requestCount, RESULT.PASS, '非漫画页 0 请求');

  assert.ok(existsSync(join(out, 'results-latest.json')));
  assert.equal(readFileSync(join(out, 'results-latest.json'), 'utf8').includes('サンプル'), false, 'runner 结果只记结构，不记标题');
});

test('qa-report：把导出合并成 qa-summary.json 与 qa/failures/FAIL-xxx.json', () => {
  const inbox = tmp();
  const out = tmp();
  const captures = [captureOf('QA-0001'), captureOf('QA-0007', { failing: true })];
  const cases = [{ ...createCaseRecord(captures[0], { number: 1 }), captureId: captures[0].id }];
  const generatedAt = Date.now();
  writeFileSync(join(inbox, 'qa-summary-2026-09-12-001.json'), JSON.stringify(buildSummaryReport({ captures, cases, generatedAt, fileLabel: '001' })));
  writeFileSync(join(inbox, 'qa-failures-2026-09-12-001.json'), JSON.stringify(buildFailureReport({ captures, generatedAt, fileLabel: '001' })));
  writeFileSync(join(inbox, 'qa-tests-2026-09-12-001.json'), JSON.stringify(buildCasePack({ captures, cases, generatedAt, fileLabel: '001' })));

  const result = runTool('tools/qa-report.mjs', ['--input', inbox, '--out', out, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.schema, 'manga-nav/qa-summary@1');
  assert.equal(summary.summary.total, 2);
  assert.equal(summary.summary.falsePositive, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].id, 'FAIL-007');
  assert.equal(summary.failures[0].bundle, 'qa/failures/FAIL-007.json');
  assert.ok(existsSync(join(out, 'qa-summary.json')));
  assert.ok(existsSync(join(out, 'failures', 'FAIL-007.json')));
  const bundle = JSON.parse(readFileSync(join(out, 'failures', 'FAIL-007.json'), 'utf8'));
  assert.equal(bundle.detail, undefined);
  assert.ok(bundle.structure.features.pageType);
  assert.equal(JSON.stringify(bundle).includes('サンプル作品アルファ'), false, '失败包默认脱敏');

  // The text output is the one Codex reads first: it must stay compact
  const text = runTool('tools/qa-report.mjs', ['--input', inbox, '--out', out]);
  assert.equal(text.status, 0);
  assert.ok(text.stdout.split('\n').length < 25, '汇总输出必须足够短');
  assert.match(text.stdout, /FAIL-007/);
  assert.equal(text.stdout.includes('サンプル'), false);
});

test('qa-import：真实 URL 进 sites.local.json，仓库里的案例文件保持匿名', () => {
  const inbox = tmp();
  const out = tmp();
  const repo = tmp();
  const captures = [captureOf('QA-0001')];
  const cases = [{ ...createCaseRecord(captures[0], { number: 1 }), captureId: captures[0].id }];
  writeFileSync(
    join(inbox, 'qa-tests-2026-09-12-001.json'),
    JSON.stringify(buildCasePack({ captures, cases, generatedAt: Date.now(), fileLabel: '001', includeRealTitles: true }))
  );

  const result = runTool('tools/qa-import.mjs', ['--input', join(inbox, 'qa-tests-2026-09-12-001.json'), '--root', repo, '--out', out]);
  assert.equal(result.status, 0, result.stderr);

  const casePath = join(repo, 'tests/real-world/extraction/RW-001.json');
  const sitesPath = join(repo, 'tests/sites.local.json');
  assert.ok(existsSync(casePath), '案例文件要写进按分类分的目录');
  assert.ok(existsSync(sitesPath), '真实 URL 单独写到 sites.local.json（git-ignored）');
  assert.ok(existsSync(join(out, 'captures', 'RW-001.json')), '可重放的页面摘要写到本地 qa/captures/');

  const caseFile = readFileSync(casePath, 'utf8');
  assert.equal(caseFile.includes('サンプル'), false);
  assert.equal(caseFile.includes('doujin.example'), false);
  assert.equal(JSON.parse(caseFile).expected.correctMatch, true);
  assert.equal(JSON.parse(readFileSync(sitesPath, 'utf8')).sites['RW-001'].url, pageInfo.url);
});

test('probe-store：命令行参数解析（--store 可重复 / --all / --title / --raw）', () => {
  const args = parseProbeArgs(['--store', 'dlsite', '--store', 'fanza', '--title', '标题', '--raw']);
  assert.deepEqual(args.stores, ['dlsite', 'fanza']);
  assert.equal(args.title, '标题');
  assert.equal(args.raw, true);
  assert.equal(parseProbeArgs(['--all', 'キーワード']).all, true);
  assert.equal(parseProbeArgs(['キーワード']).keyword, 'キーワード');
});
