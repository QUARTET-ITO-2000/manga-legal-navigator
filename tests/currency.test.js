/**
 * JPY -> CNY estimate (src/lib/currency.js).
 *
 * The rate is not fetched from anywhere: the default lives in CONFIG.currency
 * with its measurement date, and the user can override it in the popup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/lib/config.js';
import { estimateCny, isCustomRate, resolveCnyPerJpy } from '../src/lib/currency.js';

test('默认汇率来自 CONFIG，并带着测量日期与来源', () => {
  assert.equal(resolveCnyPerJpy({}), CONFIG.currency.jpyToCny);
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: null }), CONFIG.currency.jpyToCny);
  assert.equal(resolveCnyPerJpy(undefined), CONFIG.currency.jpyToCny);
  assert.match(CONFIG.currency.jpyToCnySource, /Google Finance/);
  assert.equal(CONFIG.currency.jpyToCny, 0.044);
});

test('用户可以覆盖汇率（字符串输入也能用），越界或非法输入回落到默认', () => {
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: 0.05 }), 0.05);
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: '0.0512' }), 0.0512);
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: 0 }), CONFIG.currency.jpyToCny);
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: -1 }), CONFIG.currency.jpyToCny);
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: 12 }), CONFIG.currency.jpyToCny);
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: 'abc' }), CONFIG.currency.jpyToCny);
  assert.equal(resolveCnyPerJpy({ cnyPerJpy: 0.0001 }), CONFIG.currency.jpyToCny);
});

test('isCustomRate 只在用户真的覆盖时才是 true', () => {
  assert.equal(isCustomRate({}), false);
  assert.equal(isCustomRate({ cnyPerJpy: null }), false);
  assert.equal(isCustomRate({ cnyPerJpy: 0.05 }), true);
});

test('估算：免费是 0，未知价格是 null，付费至少 1 元', () => {
  assert.equal(estimateCny(0), 0, '免费商品不能显示「约 1 元」');
  assert.equal(estimateCny(null), null);
  assert.equal(estimateCny(undefined), null);
  assert.equal(estimateCny(-100), 0);
  assert.equal(estimateCny(10), 1, '不足 1 元的按 1 元');
  assert.equal(estimateCny(990, 0.044), 44);
  assert.equal(estimateCny(1980, 0.044), 87);
  assert.equal(estimateCny(1980, 0.05), 99, '自定义汇率会改变结果');
});
