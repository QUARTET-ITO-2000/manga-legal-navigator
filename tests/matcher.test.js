import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, matchLabel, rankCandidates, similarity } from '../src/matching/matcher.js';

test('完全一致的标题得 100 分', () => {
  assert.equal(similarity('作品名称', '作品名称').score, 100);
});

test('测试 A：网页标题带章节号时仍然高分匹配商品名', () => {
  // chapter numbers are stripped before matching, so "作品名称 第12话" should still score high against "作品名称"
  const ranked = rankCandidates(['作品名称 第12话'], [{ title: '作品名称' }]);
  assert.ok(ranked[0].score >= 85, `期望 >= 85，实际 ${ranked[0].score}`);
});

test('测试 C：完全不同的作品不会匹配（低于阈值）', () => {
  const { score } = similarity('作品名称', '完全不同的作品');
  assert.ok(score < 50, `期望 < 50，实际 ${score}`);
});

test('测试 F：无关的英文查询不会误匹配日文商品', () => {
  const ranked = rankCandidates(['one piece'], [
    { title: 'サンプル作品ミュー' },
    { title: 'サンプル作品ニュー' },
    { title: 'サンプル作品クシー' }
  ]);
  assert.equal(classify(ranked).kind, 'none');
});

test('装饰括号（【Android版】）不影响匹配', () => {
  const { score } = similarity('サンプル作品アルファ', '【Android版】サンプル作品アルファ');
  assert.ok(score >= 62, `期望至少达到「可能匹配」，实际 ${score}`);
});

test('高可信度：唯一高分结果只展示一条', () => {
  const ranked = rankCandidates(['サンプル作品アルファ'], [
    { title: 'サンプル作品アルファ' },
    { title: '全然違う別の作品' }
  ]);
  const verdict = classify(ranked);
  assert.equal(verdict.kind, 'high');
  assert.equal(verdict.candidates.length, 1);
  assert.equal(verdict.best.title, 'サンプル作品アルファ');
});

test('测试 D：多个相似作品时给出候选列表，而不是武断选择', () => {
  const ranked = rankCandidates(['サンプルシリーズ～海賊姫の秘宝～'], [
    { title: 'サンプルシリーズ～海賊姫の秘宝～' },
    { title: 'サンプルシリーズ～錬金術師の亡都～' },
    { title: '全く関係ない作品' }
  ]);
  const verdict = classify(ranked);
  assert.ok(['high', 'high_with_alternatives', 'possible'].includes(verdict.kind));
  assert.equal(verdict.best.title, 'サンプルシリーズ～海賊姫の秘宝～');
  assert.ok(verdict.candidates.length >= 1);
  assert.ok(verdict.candidates.every((item) => item.score >= 50));
});

test('并列候选会触发 high_with_alternatives', () => {
  const ranked = [
    { title: 'A', score: 92 },
    { title: 'B', score: 89 }
  ];
  const verdict = classify(ranked);
  assert.equal(verdict.kind, 'high_with_alternatives');
  assert.equal(verdict.candidates.length, 2);
});

test('可能匹配（62~84 分）走「可能的正版」展示', () => {
  const ranked = [
    { title: 'サンプル作品アルファ', score: 82 },
    { title: '全く違う作品', score: 20 }
  ];
  const verdict = classify(ranked);
  assert.equal(verdict.kind, 'possible');
  assert.equal(verdict.best.score, 82);
});

test('章节号命中会小幅加分（用于优先同一卷/话）', () => {
  const ranked = rankCandidates(['作品名称'], [
    { title: '作品名称 第3巻' },
    { title: '作品名称 第1巻' }
  ], { chapterHint: 3 });
  assert.equal(ranked[0].title, '作品名称 第3巻');
  assert.ok(ranked[0].chapterHintApplied);
});

test('主变体优先：备用变体恰好命中另一个作品时也不会挤掉主结果', () => {
  const ranked = rankCandidates(['サンプルシリーズ', 'サンプル作品アルファ'], [
    { title: 'サンプル作品アルファ' },
    { title: 'サンプルシリーズ' }
  ]);
  assert.equal(ranked[0].title, 'サンプルシリーズ');
  assert.equal(ranked[0].score, 100);
  assert.equal(ranked[1].title, 'サンプル作品アルファ');
  assert.ok(ranked[1].score < ranked[0].score);
});

test('匹配度文案分档', () => {
  assert.equal(matchLabel(95), '很高');
  assert.equal(matchLabel(86), '较高');
  assert.equal(matchLabel(70), '一般');
  assert.equal(matchLabel(64), '较低');
});
