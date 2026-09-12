/**
 * Store adapter health (requirements doc §30).
 *
 * The rule that matters: HTTP 200 + parser returned 0 is NOT "this work does
 * not exist" — it is a parser / search failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH,
  canConcludeNoResult,
  classifyStep,
  classifyStoreHealth,
  healthLabel,
  storeUsable
} from '../src/lib/store-health.js';

test('HTTP 200 但解析不到条目 → parser-broken，绝不能当成「没有结果」', () => {
  const health = classifyStoreHealth({ steps: [{ id: 'primary', httpStatus: 200, ok: false, reason: 'no-items-parsed', itemCount: 0 }] });
  assert.equal(health, HEALTH.PARSER_BROKEN);
  assert.equal(canConcludeNoResult(health), false);
  assert.equal(storeUsable(health), false);
  assert.match(healthLabel(health), /did not match the expected markup/);
});

test('商店明确说没有 → no-result（只有这种情况可以下结论）', () => {
  const health = classifyStoreHealth({ steps: [{ id: 'primary', httpStatus: 200, ok: true, reason: 'not-found', itemCount: 0 }] });
  assert.equal(health, HEALTH.NO_RESULT);
  assert.equal(canConcludeNoResult(health), true);
});

test('被拦截 / 年龄确认 / 需要登录 → blocked', () => {
  assert.equal(classifyStep({ httpStatus: 403, reason: 'blocked' }), HEALTH.BLOCKED);
  assert.equal(classifyStep({ httpStatus: 429, reason: '' }), HEALTH.BLOCKED);
  assert.equal(classifyStep({ httpStatus: 200, reason: 'age-check' }), HEALTH.BLOCKED);
  assert.equal(classifyStep({ httpStatus: 200, reason: 'login-required' }), HEALTH.BLOCKED);
  assert.equal(classifyStoreHealth({ steps: [{ httpStatus: 200, reason: 'age-check' }] }), HEALTH.BLOCKED);
});

test('请求本身失败（空响应 / 超时 / 5xx）→ search-failed', () => {
  assert.equal(classifyStep({ httpStatus: 200, reason: 'empty-response' }), HEALTH.SEARCH_FAILED);
  assert.equal(classifyStep({ httpStatus: 200, reason: 'unexpected-page' }), HEALTH.SEARCH_FAILED);
  assert.equal(classifyStep({ httpStatus: 0, reason: 'network-error' }), HEALTH.SEARCH_FAILED);
  assert.equal(classifyStep({ httpStatus: 502, reason: '' }), HEALTH.SEARCH_FAILED);
});

test('有结果就是 healthy；部分步骤失败则是 degraded', () => {
  assert.equal(classifyStoreHealth({ steps: [{ httpStatus: 200, reason: 'ok', itemCount: 30 }] }), HEALTH.HEALTHY);
  const degraded = classifyStoreHealth({
    steps: [
      { id: 'primary', httpStatus: 200, reason: 'ok', itemCount: 12 },
      { id: 'female', httpStatus: 200, reason: 'no-items-parsed', itemCount: 0 }
    ]
  });
  assert.equal(degraded, HEALTH.DEGRADED);
  assert.equal(storeUsable(degraded), true);
});

test('多个步骤里最严重的问题优先（blocked > search-failed > parser-broken > no-result）', () => {
  const health = classifyStoreHealth({
    steps: [
      { id: 'a', httpStatus: 200, reason: 'not-found', itemCount: 0 },
      { id: 'b', httpStatus: 200, reason: 'no-items-parsed', itemCount: 0 },
      { id: 'c', httpStatus: 403, reason: 'blocked', itemCount: 0 }
    ]
  });
  assert.equal(health, HEALTH.BLOCKED);
});

test('直接给出 itemCount 时也按同样的规则判断', () => {
  assert.equal(classifyStoreHealth({ steps: [], itemCount: 4 }), HEALTH.HEALTHY);
  assert.equal(classifyStoreHealth({ steps: [], itemCount: 0 }), HEALTH.NO_RESULT);
  assert.equal(classifyStoreHealth({}), HEALTH.NO_RESULT);
});
