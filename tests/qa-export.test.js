/**
 * QA export + anonymisation (requirements doc §8 / §9 / §27 / §28).
 *
 * The important property: an export that is not explicitly marked as containing
 * real data must not leak a real title, a product id or a real url.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCapture, createCaseRecord, setFalsePositive, setVerdict, RESULT } from '../src/qa/record.js';
import {
  buildCasePack,
  buildFailureReport,
  buildSummaryReport,
  createRedactor,
  exportFileName,
  redactCapture
} from '../src/qa/export.js';

const REAL_TITLE = 'サンプル作品アルファ';
const REAL_URL = 'https://doujin.example/g/000123/';

const pageInfo = {
  url: REAL_URL,
  host: 'doujin.example',
  origin: 'https://doujin.example',
  title: `【${REAL_TITLE}】第1話 - 免费漫画 - 示例漫画网`,
  h1: [`${REAL_TITLE} 第1話`],
  headings: [{ level: 1, tag: 'h1', text: `${REAL_TITLE} 第1話` }],
  ogTitle: REAL_TITLE,
  imageCount: 46,
  textSample: `第1話 ${REAL_TITLE}`,
  infoText: 'Tags: sample Languages: japanese Pages: 46',
  analysisCount: 1,
  settled: true
};

function stateOf(overrides = {}) {
  return {
    status: 'ok_high',
    reason: 'high',
    page: { url: REAL_URL, host: 'doujin.example', title: pageInfo.title, settled: true },
    query: {
      cleanedTitle: REAL_TITLE,
      source: 'title',
      confidence: 'high',
      variants: [REAL_TITLE],
      searched: [REAL_TITLE],
      artists: ['サンプル作者A'],
      notes: []
    },
    match: { productId: 'RJ00000001', title: REAL_TITLE, store: 'dlsite', score: 100 },
    candidates: [{ productId: 'RJ00000001', title: REAL_TITLE, store: 'dlsite', score: 100 }],
    stores: [{ storeId: 'dlsite', kind: 'high', itemCount: 7, fromCache: false, health: 'healthy', match: { score: 100 } }],
    meta: { signals: ['chapter-marker-in-title'], errors: [], preview: [] },
    ...overrides
  };
}

function captureOf(overrides = {}, id = 'QA-0001') {
  return buildCapture({
    pageInfo,
    state: stateOf(overrides.state),
    requestStats: { analysis: 1, total: 1, byStore: { dlsite: 1 } },
    id
  });
}

test('脱敏：默认导出里没有真实标题 / 商品 ID / 真实 URL，但保留形状与哈希', () => {
  const capture = captureOf();
  const redacted = redactCapture(capture, createRedactor());
  const serialized = JSON.stringify(redacted);

  assert.ok(!serialized.includes('サンプル'), '不能出现真实作品名');
  assert.ok(!serialized.includes('RJ00000001'), '不能出现真实商品 ID');
  assert.ok(!serialized.includes(REAL_URL), '不能出现真实 URL');
  assert.ok(serialized.includes('<title-1>'));
  assert.equal(redacted.pageInfoIncluded, false);
  assert.equal('pageInfo' in redacted, false);
  assert.equal(redacted.extract.workKey.length, 8, '仍然用哈希关联同一作品');
  assert.equal(redacted.extract.cleanedTitleLength, REAL_TITLE.length);
  assert.equal(redacted.match.productKey.length, 8);
});

test('脱敏：占位符字典保留长度 / 文字系统 / 主机名，便于人工核对', () => {
  const redactor = createRedactor();
  redactCapture(captureOf(), redactor);
  // The case pack maps urls through the same redactor, so the dictionary keeps
  // the host and the path shape (never the full url).
  assert.equal(redactor.url(REAL_URL), '<url-1>');
  assert.equal(redactor.url(REAL_URL), '<url-1>', '同一个 URL 始终映射到同一个占位符');
  const dictionary = redactor.dictionary();
  const entries = Object.values(dictionary.titles);
  assert.ok(entries.some((entry) => entry.length === REAL_TITLE.length && entry.script === 'cjk'), JSON.stringify(entries));
  assert.deepEqual(dictionary.urls['<url-1>'], { host: 'doujin.example', path: '/g/:id/' });
});

test('Summary 报告：体积很小，且永远不会带真实数据（§8 / §27）', () => {
  const pass = setVerdict(captureOf({}, 'QA-0001'), RESULT.PASS);
  const fail = setFalsePositive(captureOf({ state: { status: 'ok_possible', match: { productId: 'RJ00000002', title: '相似作品', store: 'dlsite', score: 70 } } }, 'QA-0002'), true);
  const report = buildSummaryReport({ captures: [pass, fail], cases: [], generatedAt: Date.now(), fileLabel: '001', includeRealTitles: true });

  assert.equal(report.schema, 'manga-nav/qa-summary@1');
  assert.equal(report.kind, 'qa-summary');
  assert.equal(report.containsRealData, false, '即使勾选了真实标题，摘要也不写真实数据');
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.falsePositive, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].id, 'FAIL-002');
  const bytes = JSON.stringify(report).length;
  assert.ok(bytes < 8000, `summary should stay tiny, got ${bytes} bytes`);
  assert.ok(!JSON.stringify(report).includes('サンプル'));
});

test('Failure 报告：每个失败一个 bundle，包含需求书 §28 要求的字段', () => {
  const fail = setFalsePositive(captureOf({}, 'QA-0007'), true);
  const report = buildFailureReport({ captures: [captureOf(), fail], generatedAt: Date.now(), fileLabel: '001' });

  assert.equal(report.kind, 'qa-failures');
  assert.equal(report.failures.length, 1);
  const bundle = report.failures[0];
  assert.equal(bundle.id, 'FAIL-007');
  assert.equal(bundle.captureId, 'QA-0007');
  assert.equal(bundle.falsePositive, true);
  assert.ok(bundle.structure.features.pageType);
  assert.ok('cleanedTitle' in bundle.extraction);
  assert.ok(Array.isArray(bundle.search.queried));
  assert.ok('results' in bundle.stores);
  assert.ok('score' in bundle.match);
  assert.ok('byStore' in bundle.requests);
  assert.ok(!JSON.stringify(bundle).includes('サンプル作品アルファ'));
  assert.equal(report.breakdown.total, 1);
});

test('Failure 报告：显式勾选真实数据时才写入真实标题，并明确标注', () => {
  const fail = setFalsePositive(captureOf({}, 'QA-0007'), true);
  const report = buildFailureReport({ captures: [fail], generatedAt: Date.now(), includeRealTitles: true });
  assert.equal(report.containsRealData, true);
  assert.match(report.note, /REAL DATA/);
  assert.ok(JSON.stringify(report).includes('サンプル'), '勾选后才会带上真实标题');
});

test('TestCase Pack：默认脱敏，勾选后带上真实 URL 与可重放页面摘要（§13）', () => {
  const capture = setVerdict(captureOf(), RESULT.PASS);
  const cases = [{ ...createCaseRecord(capture, { number: 1 }), captureId: capture.id }];

  const anonymised = buildCasePack({ captures: [capture], cases, generatedAt: Date.now() });
  assert.equal(anonymised.containsRealData, false);
  assert.ok(!JSON.stringify(anonymised).includes(REAL_URL));
  assert.ok(!anonymised.captures[0].pageInfo);

  const local = buildCasePack({ captures: [capture], cases, generatedAt: Date.now(), includeRealTitles: true });
  assert.equal(local.containsRealData, true);
  assert.equal(local.sites['RW-001'], REAL_URL);
  assert.equal(local.captures[0].pageInfoIncluded, true);
  assert.equal(local.captures[0].pageInfo.url, REAL_URL);
  assert.equal(local.cases[0].id, 'RW-001');
  assert.equal(local.cases[0].expected.correctMatch, true);
});

test('导出文件名遵循 qa-<kind>-<date>-<seq>.json（§8）', () => {
  assert.equal(exportFileName('summary', '2026-09-12', '001'), 'qa-summary-2026-09-12-001.json');
  assert.equal(exportFileName('failures', '2026-09-12', '007'), 'qa-failures-2026-09-12-007.json');
  assert.equal(exportFileName('tests', '2026-09-12', '002'), 'qa-tests-2026-09-12-002.json');
});
