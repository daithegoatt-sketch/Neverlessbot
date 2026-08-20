'use strict';

const assert = require('node:assert/strict');
const { parseCodesPayload } = require('./codesClient');
const { addCosts, groupMaterials, LEVEL_1_TO_90_MORA, LEVEL_1_TO_90_HERO_WIT } = require('./materialClient');
const { isProfile, isHistory, isC1Weapon, maskUid, firstSentence } = require('./profileRouter');

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

const totals = new Map();
addCosts(totals, {
  ascend1: [
    { id: 202, name: 'Mora', count: 20000 },
    { id: 104161, name: 'Shivada Jade Sliver', count: 1 },
    { id: 112083, name: 'Meshing Gear', count: 3 },
  ],
}, 1, 'ascension');
addCosts(totals, {
  lvl2: [
    { id: 202, name: 'Mora', count: 12500 },
    { id: 104347, name: 'Teachings of Contention', count: 3 },
    { id: 112083, name: 'Meshing Gear', count: 6 },
  ],
}, 3, 'talent');
assert.equal(totals.get('mora').count, 57500);
assert.equal(totals.get('meshing gear').count, 21);
const groups = groupMaterials([...totals.values()]);
assert.ok(groups.gems.some((row) => row.name === 'Shivada Jade Sliver'));
assert.ok(groups.books.some((row) => row.name === 'Teachings of Contention'));
assert.equal(LEVEL_1_TO_90_MORA, 1672000);
assert.equal(LEVEL_1_TO_90_HERO_WIT, 419);

assert.equal(isProfile('بروفايلي'), true);
assert.equal(isProfile('my profile'), true);
assert.equal(isHistory('تاريخ Skirk'), true);
assert.equal(isHistory('Skirk history'), true);
assert.equal(isC1Weapon('C1 ولا سلاح Skirk'), true);
assert.equal(isC1Weapon('Skirk weapon or C1'), true);
assert.equal(maskUid('729663359'), '72••••359');
assert.equal(firstSentence('First sentence. Second sentence.'), 'First sentence.');

console.log('public utility tests passed');
