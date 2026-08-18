'use strict';

const assert = require('node:assert/strict');
const { isArtifactImprove, cleanImproveText } = require('./artifactRouter');

assert.equal(isArtifactImprove('طبيب الارتيفاكتات'), false);
assert.equal(isArtifactImprove('artifact doctor'), false);
assert.equal(isArtifactImprove('تحسين ارتيفاكتات Skirk'), true);
assert.equal(isArtifactImprove('improve Skirk artifacts'), true);

const cleaned = cleanImproveText(
  '**Skirk — Artifact Doctor**\n**النتيجة المتوقعة:** حوالي 80%. كل رقم داخل حدود رول 5★ منطقي، ولا يطلب 6–7 رولات على سب ستات واحد.',
  'Skirk',
  'ar',
);
assert.match(cleaned, /تحسين الارتيفاكتات/);
assert.doesNotMatch(cleaned, /Artifact Doctor/);
assert.doesNotMatch(cleaned, /6–7/);
assert.doesNotMatch(cleaned, /كل رقم داخل حدود رول/);

console.log('artifact router removal tests passed');
