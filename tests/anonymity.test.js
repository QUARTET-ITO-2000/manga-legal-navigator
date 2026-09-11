import test from 'node:test';
import assert from 'node:assert/strict';

import { createChecker, lintText } from '../tools/lint-anonymity.mjs';

const checker = createChecker({
  allow: ['1000001', '/g/000123'],
  deny: ['Sample Denied Title']
});

const kinds = (text) => lintText(text, checker).map((finding) => finding.kind);

test('商店商品 ID：真实形态会被标记，占位形态不会', () => {
  // The "bad" values below are deliberately fake shapes (repeated digits), used
  // as test input; they are waived so that the repository lint does not flag them.
  assert.deepEqual(kinds('id="RJ11111111"'), ['product-id']); // anonymity-lint: allow (fake id used as test input)
  assert.deepEqual(kinds('id="RJ00000001"'), []);
  assert.deepEqual(kinds('cid=d_22222222'), ['product-id']); // anonymity-lint: allow (fake id used as test input)
  assert.deepEqual(kinds('cid=d_00000001'), []);
});

test('商店查询参数 ID：允许列表里的占位 ID 不会，其它会', () => {
  assert.deepEqual(kinds('<a href="/detail.php?product_id=3333333">'), ['product-id']); // anonymity-lint: allow (fake id used as test input)
  assert.deepEqual(kinds('<a href="/detail.php?product_id=1000001">'), []);
});

test('画廊 ID：零填充占位或允许列表里的不会，其它会', () => {
  assert.deepEqual(kinds('https://example.test/g/444444/'), ['gallery-id']); // anonymity-lint: allow (fake id used as test input)
  assert.deepEqual(kinds('https://example.test/g/000456/'), []);
  assert.deepEqual(kinds('https://example.test/g/000123/'), []);
});

test('百分号编码的日文会被标记（真实标题常见的漏网方式）', () => {
  // The encoded run below is the placeholder word "サンプル", not a real title.
  assert.deepEqual(kinds('link="/x/%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB/"'), ['encoded-text']); // anonymity-lint: allow (encoded placeholder)
  assert.deepEqual(kinds('link="/x/%20%20"'), []);
});

test('行内豁免标记只跳过形态规则，denylist 依然生效', () => {
  assert.deepEqual(kinds('assert(x === "%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB"); // anonymity-lint: allow'), []); // anonymity-lint: allow
  assert.deepEqual(kinds('title: "Sample Denied Title"'), ['denylisted']);
  assert.deepEqual(kinds('title: "Sample Denied Title" // anonymity-lint: allow'), ['denylisted']);
});

test('新加入的真实名称可以通过本地 denylist 拦截', () => {
  const local = createChecker({ allow: [], deny: ['Another Real Name'] });
  const findings = lintText('const title = "Another Real Name";', local);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'denylisted');
  assert.equal(findings[0].line, 1);
});
