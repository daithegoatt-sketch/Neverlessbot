'use strict';

const assert = require('node:assert/strict');
const { searchCommandCatalog } = require('./commandCatalog');
const { compactGuide } = require('./serverToolsV4');

const rating = searchCommandCatalog('تقييم سكيرك بحسابي');
assert.ok(rating.some((row) => row.syntax === 'تقييم <Character> بحسابي'));
assert.ok(!rating.some((row) => row.syntax === '/تقييم الشخصيات'));

const theater = searchCommandCatalog('ابي امر تيم المسرح');
assert.ok(theater.some((row) => row.syntax.startsWith('-تيم المسرح')));

const slash = searchCommandCatalog('مسح الرسائل');
assert.ok(slash.some((row) => row.syntax === '/clear'));

const guide = compactGuide({
  name: 'Skirk',
  source: 'test',
  role: 'DPS',
  stats: { main: ['ATK'], targets: ['CR 70+'], priority: 'CRIT' },
  weapons: ['Weapon A'],
  f2pWeapons: ['Weapon B'],
  artifacts: ['Set A'],
  combos: ['Combo'],
  teams: { premium: [['Skirk', 'A', 'B', 'C']], f2p: [] },
  teamGroups: [],
});
assert.equal(guide.name, 'Skirk');
assert.deepEqual(guide.teams.premium[0], ['Skirk', 'A', 'B', 'C']);

console.log('Neverless brain V4 tests passed.');
