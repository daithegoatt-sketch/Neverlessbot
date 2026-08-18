'use strict';

const assert = require('node:assert/strict');
const { reviewArtifact, mainStatMatches } = require('./artifactEvaluator');
const { accountScoreFromRated } = require('./leaderboard');

const guide = {
  stats: {
    main: [
      'Sands: ATK%',
      'Goblet: Cryo DMG Bonus',
      'Circlet: CRIT Rate / CRIT DMG',
    ],
    priority: 'CRIT Rate > CRIT DMG > ATK% > ER',
    targets: ['CRIT Rate: 70-80%', 'CRIT DMG: 200%+', 'ATK: 2000+', 'ER: 120-140%'],
  },
};

const atkGoblet = {
  slot: 'goblet',
  rarity: 5,
  level: 20,
  mainStat: 'ATK',
  mainStatKey: 'FIGHT_PROP_ATTACK_PERCENT',
  mainValue: '46.6%',
  rolls: [
    { fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 3.89, isPercent: true },
    { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 7.77, isPercent: true },
    { fightProp: 'FIGHT_PROP_ATTACK_PERCENT', numericValue: 5.83, isPercent: true },
    { fightProp: 'FIGHT_PROP_CHARGE_EFFICIENCY', numericValue: 6.48, isPercent: true },
  ],
  totalRolls: 4,
};

const reviewed = reviewArtifact(atkGoblet, guide);
assert.equal(reviewed.mainMatch, false);
assert.ok(reviewed.totalRv >= 396 && reviewed.totalRv <= 404);
assert.ok(reviewed.usefulRv >= 396 && reviewed.usefulRv <= 404);
assert.deepEqual(reviewed.mainOptions, ['Cryo DMG Bonus']);

const cryoGoblet = {
  ...atkGoblet,
  mainStat: 'Cryo DMG Bonus',
  mainStatKey: 'FIGHT_PROP_ICE_ADD_HURT',
};
assert.equal(mainStatMatches(cryoGoblet, guide), true);

const scored = accountScoreFromRated([
  { score: 96, akasha: { topPercent: 2 }, artifactQuality: 650 },
  { score: 93, akasha: { topPercent: 4 }, artifactQuality: 610 },
  { score: 90, akasha: { topPercent: 8 }, artifactQuality: 590 },
  { score: 40, akasha: { topPercent: 80 }, artifactQuality: 250 },
]);
assert.equal(scored.topBuilds.length, 3);
assert.deepEqual(scored.topBuilds.map((row) => row.score), [96, 93, 90]);
assert.ok(scored.accountScore > 92 && scored.accountScore < 95);

console.log('rating enhancement tests passed');
