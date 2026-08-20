'use strict';

const assert = require('node:assert/strict');
const { parseCodesPayload } = require('./codesClient');
const { isProfile, isHistory, maskUid, validSavedRating, latestValidRating } = require('./profileRouter');

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

const valid = { evaluation: { score: 84, akashaPercentile: 4.2 }, savedAt: '2026-08-20T10:00:00Z' };
const zero = { evaluation: { score: 0, akashaPercentile: null }, savedAt: '2026-08-20T11:00:00Z' };
assert.equal(validSavedRating(valid), true);
assert.equal(validSavedRating(zero), false);
assert.equal(validSavedRating({ evaluation: { score: NaN } }), false);
assert.equal(latestValidRating([valid, zero]), valid);
assert.equal(latestValidRating([zero]), null);

console.log('public utility tests passed');
