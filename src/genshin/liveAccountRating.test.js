'use strict';

const assert = require('node:assert/strict');
const { validRatedRows, snapshotSignature } = require('./liveAccountRating');
const { accountScoreFromRated } = require('./leaderboard');

const rows = validRatedRows([
  { name: 'A', score: 90, akasha: null, artifactQuality: 500 },
  { name: 'B', score: 0, akasha: null, artifactQuality: 500 },
  { name: 'C', score: 75, akasha: null, artifactQuality: 400 },
]);
assert.deepEqual(rows.map((row) => row.name), ['A', 'C']);

const scored = accountScoreFromRated([
  { name: 'A', score: 90, akasha: null, artifactQuality: 500 },
  { name: 'B', score: 0, akasha: null, artifactQuality: 500 },
  { name: 'C', score: 75, akasha: null, artifactQuality: 400 },
]);
assert.deepEqual(scored.topBuilds.map((row) => row.name), ['A', 'C']);
assert.ok(scored.accountScore > 0);

const before = {
  name: 'Sandrone', level: 90, constellation: 0,
  weapon: { name: 'Mailed Flower', level: 90, refinement: 5 },
  stats: { atk: 2368, critRate: 51.8, critDmg: 181.4, er: 135, em: 336 },
  artifacts: [{ slot: 'circlet', set: 'Test', level: 20, mainStat: 'CRIT DMG', mainValue: '62.2%', substats: [{ name: 'CRIT Rate', numericValue: 3.9 }] }],
};
const after = { ...before, stats: { ...before.stats, critDmg: 244.9, em: 207 } };
assert.notEqual(snapshotSignature(before), snapshotSignature(after));
assert.equal(snapshotSignature(before), snapshotSignature({ ...before }));

console.log('live account rating tests passed');
