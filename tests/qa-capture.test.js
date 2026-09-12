/**
 * QA capture records (requirements doc §6 / §13 / §14 / §23 / §24).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESULT,
  RESULT_FIELDS,
  buildCapture,
  createCaseRecord,
  failureIdOf,
  isFailure,
  mergeCapture,
  replayPageInfo,
  setFalsePositive,
  setNote,
  setVerdict,
  summarize
} from '../src/qa/record.js';
import { __resetMemoryQa, clearQa, readQa, readQaError, recordCapture, recordQaError } from '../src/qa/storage.js';

test('QA 失败会被记下来，而不是永远静默（§28 错误信息）', async () => {
  __resetMemoryQa();
  await clearQa();
  await recordQaError(new Error('storage write failed'), { stage: 'capture', origin: 'https://doujin.example' });
  const error = await readQaError();
  assert.equal(error.message, 'storage write failed');
  assert.equal(error.context.stage, 'capture');
  assert.equal(error.context.origin, 'https://doujin.example');
  await clearQa();
  assert.equal(await readQaError(), null, 'Clear QA Data 也会清掉错误记录');
});

test('捕获写入：同一个页面重复分析只增加 observation', async () => {
  __resetMemoryQa();
  await clearQa();
  const first = buildCapture({ pageInfo, state: stateOf(), requestStats: { total: 1, byStore: { dlsite: 1 } }, id: 'QA-0001' });
  await recordCapture(first);
  const second = buildCapture({ pageInfo, state: stateOf(), requestStats: { total: 0, byStore: {}, cacheHit: true } });
  const { capture, isNew } = await recordCapture(second);
  assert.equal(isNew, false);
  assert.equal(capture.id, 'QA-0001');
  assert.equal(capture.requests.observations.length, 2);
  const stored = await readQa();
  assert.equal(stored.captures.length, 1);
  __resetMemoryQa();
});

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
  infoText: 'Parodies: original Tags: sample Languages: japanese Categories: doujinshi Pages: 46',
  navHint: 'x'.repeat(500),
  analysisCount: 1,
  settled: true
};

/** A minimal state shaped like the one src/lib/pipeline.js returns */
function stateOf(overrides = {}) {
  return {
    status: 'ok_high',
    reason: 'high',
    page: { url: pageInfo.url, host: pageInfo.host, title: pageInfo.title, settled: true },
    query: {
      rawTitle: 'サンプル作品アルファ',
      cleanedTitle: 'サンプル作品アルファ',
      source: 'title',
      confidence: 'high',
      variants: ['サンプル作品アルファ'],
      searched: ['サンプル作品アルファ'],
      artists: [],
      notes: []
    },
    match: { productId: 'RJ00000001', title: 'サンプル作品アルファ', store: 'dlsite', score: 100 },
    candidates: [{ productId: 'RJ00000001', title: 'サンプル作品アルファ', store: 'dlsite', score: 100 }],
    stores: [
      { storeId: 'dlsite', storeLabel: 'DLsite', kind: 'high', itemCount: 7, fromCache: false, cacheEntryFound: false, health: 'healthy', match: { score: 100 } }
    ],
    meta: { storeId: 'dlsite', signals: ['chapter-marker-in-title', 'gallery-structure'], errors: [], preview: [] },
    ...overrides
  };
}

test('捕获：只保存结构化摘要，不保存 URL 以外的页面内容', () => {
  const capture = buildCapture({
    pageInfo,
    state: stateOf(),
    requestStats: { analysis: 1, total: 1, byStore: { dlsite: 1 }, cacheHit: false },
    id: 'QA-0001'
  });

  assert.equal(capture.id, 'QA-0001');
  assert.equal(capture.fingerprint, 'G-H1-OG-NJ-IMG40-INFO-STATIC');
  assert.equal(capture.pageType, 'gallery');
  assert.equal(capture.category, 'static-gallery');
  assert.equal(capture.match.grade, 'found');
  assert.equal(capture.extract.workKey.length, 8);
  // The replayable page summary keeps the fields the pipeline needs…
  assert.equal(capture.pageInfo.title, pageInfo.title);
  assert.equal(capture.pageInfo.infoFields.length >= 3, true);
  // …but not the bulk: no anchor list, no full body text.
  assert.equal('navHint' in capture.pageInfo, false);
  assert.ok(capture.pageInfo.textSample.length <= 401);
  assert.deepEqual(Object.keys(capture.results).sort(), RESULT_FIELDS.slice().sort());
});

test('捕获：自动判定（页面识别 / 标题 / 商店搜索 / 请求预算 / 缓存）', () => {
  const capture = buildCapture({
    pageInfo,
    state: stateOf(),
    requestStats: { analysis: 1, total: 1, byStore: { dlsite: 1 } },
    id: 'QA-0001'
  });
  assert.equal(capture.results.pageRecognition, RESULT.PASS);
  assert.equal(capture.results.titleExtraction, RESULT.PASS);
  assert.equal(capture.results.storeSearch, RESULT.PASS);
  assert.equal(capture.results.requestCount, RESULT.PASS);
  // human-judged fields stay open until the popup records them
  assert.equal(capture.results.correctMatch, RESULT.NOT_TESTED);
  assert.equal(capture.results.cacheBehavior, RESULT.NOT_TESTED);
});

test('捕获：非作品页 / 请求超预算都会被标出来', () => {
  const negative = buildCapture({
    pageInfo: { url: 'https://blog.example/posts/1', host: 'blog.example', title: '一篇博客', imageCount: 1 },
    state: stateOf({ status: 'unrecognized', reason: 'no-comic-signal', query: null, match: null, candidates: [] }),
    requestStats: { analysis: 1, total: 0, byStore: {} },
    id: 'QA-0002'
  });
  assert.equal(negative.results.pageRecognition, RESULT.FAIL);
  assert.equal(negative.results.requestCount, RESULT.PASS);

  const expensive = buildCapture({
    pageInfo,
    state: stateOf(),
    requestStats: { analysis: 1, total: 12, byStore: { dlsite: 12 } },
    id: 'QA-0003'
  });
  assert.equal(expensive.results.requestCount, RESULT.FAIL);
});

test('重复访问同一页面：合并观察记录，并留下缓存命中的证据（§24）', () => {
  const first = buildCapture({
    pageInfo,
    state: stateOf({ stores: [{ storeId: 'dlsite', kind: 'high', health: 'healthy', itemCount: 7, fromCache: false }] }),
    requestStats: { analysis: 1, total: 1, byStore: { dlsite: 1 }, cacheHit: false },
    id: 'QA-0001'
  });
  const second = buildCapture({
    pageInfo,
    state: stateOf({ stores: [{ storeId: 'dlsite', kind: 'high', health: 'healthy', itemCount: 7, fromCache: true }] }),
    requestStats: { analysis: 1, total: 0, byStore: {}, cacheHit: true },
    id: ''
  });
  const merged = mergeCapture(setVerdict(first, RESULT.PASS), second);

  assert.equal(merged.id, 'QA-0001');
  assert.equal(merged.requests.observations.length, 2);
  assert.equal(merged.requests.observations[1].cacheHit, true);
  assert.equal(merged.results.cacheBehavior, RESULT.PASS);
  assert.equal(merged.verdict, RESULT.PASS, '人工判定不会被重新分析覆盖');
});

test('人工判定：误判标记会直接变成 FAIL（§15.5）', () => {
  const capture = setFalsePositive(buildCapture({ pageInfo, state: stateOf(), requestStats: { total: 1, byStore: {} }, id: 'QA-0001' }), true);
  assert.equal(capture.verdict, RESULT.FAIL);
  assert.equal(capture.results.falsePositive, RESULT.FAIL);
  assert.equal(isFailure(capture), true);
  assert.equal(failureIdOf(capture), 'FAIL-001');

  const noted = setNote(capture, '误推荐了相似作品');
  assert.equal(noted.note, '误推荐了相似作品');
  assert.equal(setVerdict(capture, 'NOPE').verdict, RESULT.NOT_TESTED);
});

test('测试案例：从捕获生成 RW-001，只带结构 + 预期，不带真实数据（§13）', () => {
  const capture = setVerdict(buildCapture({ pageInfo, state: stateOf(), requestStats: { total: 1, byStore: {} }, id: 'QA-0001' }), RESULT.PASS);
  const record = createCaseRecord(capture, { number: 1 });
  assert.equal(record.id, 'RW-001');
  assert.equal(record.category, 'static-gallery');
  assert.deepEqual(Object.keys(record.features).sort(), ['galleryInfo', 'h1', 'jsonLd', 'manyImages', 'ogTitle', 'pageType', 'spaNavigation'].sort());
  assert.equal(record.expected.pageRecognition, true);
  assert.equal(record.expected.correctMatch, true);
  assert.equal(record.source.fingerprint, capture.fingerprint);
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes('サンプル'), '测试案例文件里不能出现真实作品名');
  assert.ok(!serialized.includes('doujin.example'), '测试案例文件里不能出现真实 URL');
});

test('汇总：通过 / 失败 / 限制 / 误判 / 请求预算 / 结构分布（§27）', () => {
  const pass = setVerdict(buildCapture({ pageInfo, state: stateOf(), requestStats: { total: 1, byStore: { dlsite: 1 } }, id: 'QA-0001' }), RESULT.PASS);
  const fail = setFalsePositive(buildCapture({
    pageInfo,
    state: stateOf({ status: 'ok_possible', match: { productId: 'RJ00000002', title: 'サンプル作品ベータ', store: 'dlsite', score: 70 } }),
    requestStats: { total: 3, byStore: { dlsite: 2, fanza: 1 } },
    id: 'QA-0002'
  }), true);

  const summary = summarize([pass, fail], []);
  assert.equal(summary.total, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.falsePositive, 1);
  assert.equal(summary.pageRecognitionRate, 1);
  assert.equal(summary.requestBudget.total, 4);
  assert.equal(summary.requestBudget.byStore.fanza, 1);
  assert.equal(summary.structures.length, 1);
  assert.equal(summary.structures[0].fingerprint, pass.fingerprint);
});

test('replayPageInfo：裁剪正文样本，保留离线重放需要的字段', () => {
  const replay = replayPageInfo({ ...pageInfo, textSample: 'a'.repeat(900), headings: new Array(20).fill({ level: 2, tag: 'h2', text: 'x'.repeat(300) }) });
  assert.equal(replay.textSample.length, 401);
  assert.equal(replay.headings.length, 6);
  assert.equal(replay.headings[0].text.length, 121);
  assert.ok(!('navHint' in replay));
});
