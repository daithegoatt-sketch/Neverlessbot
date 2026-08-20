'use strict';

const assert = require('node:assert/strict');
const { parseCodesPayload } = require('./codesClient');
const { isProfile, isHistory, maskUid, formatCurrentRatings } = require('./profileRouter');

const now = Date.UTC(2026, 7, 20, 9, 0, 0);
const codes = parseCodesPayload({
  active: [
    { code: 'ACTIVE123', rewards: ['Primogem x60'] },
    { code: 'FUTURE456', reward: 'Mora x10000', expires_at: new Date(now + 3600000).toISOString() },
    { code: 'EXPIRED999', reward: 'Old reward', expires_at: new Date(now - 1000).toISOString() },
  ],
  inactive: [{ code: 'INACTIVE777' }],
}, now);
assert.deepEqual(codes.map((row) => row.code), ['ACTIVE123', 'FUTURE456']);
assert.ok(!codes.some((row) => row.code === 'INACTIVE777'));

assert.equal(isProfile('بروفايلي'), true);
assert.equal(isProfile('my profile'), true);
assert.equal(isHistory('تاريخ Skirk'), true);
assert.equal(isHistory('Skirk history'), true);
assert.equal(isProfile('C1 ولا سلاح Skirk'), false);
assert.equal(maskUid('729663359'), '72••••359');

const profileLines = formatCurrentRatings([
  { name: 'Sandrone', score: 97 },
  { name: 'Furina', score: 0 },
  { name: 'Skirk', score: 88 },
], 'ar');
assert.match(profileLines.join('\n'), /Sandrone \*\*97%\*\*/);
assert.match(profileLines.join('\n'), /Skirk \*\*88%\*\*/);
assert.doesNotMatch(profileLines.join('\n'), /Furina/);
assert.deepEqual(formatCurrentRatings([{ name: 'Furina', score: 0 }], 'ar'), []);

console.log('public utility tests passed');
