'use strict';

const assert = require('node:assert/strict');
const { reviewArtifact, mainStatMatches } = require('./artifactEvaluator');
const { formatArtifactReview, akashaImprovementAdvice } = require('./ratingCopyV2');
const { applyKnownComputedStats } = require('./computedStats');
const { accountScoreFromRated } = require('./leaderboard');
const { evaluateBuild, akashaPercent } = require('./buildEvaluator');
const { effectiveStatsForRating } = require('./combatStats');

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
  substats: [
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

const sandroneArtifacts = [{
  slot: 'flower',
  mainStatKey: 'FIGHT_PROP_HP',
  mainValue: '4,780',
  substats: [{ fightProp: 'FIGHT_PROP_ELEMENT_MASTERY', numericValue: 124 }],
}];
const corrected = applyKnownComputedStats('Sandrone', { atk: 2613, em: 124, er: 100 }, sandroneArtifacts);
assert.equal(corrected.em, 284);
assert.equal(corrected.er, 100);
const alreadyComputed = applyKnownComputedStats('Sandrone', { atk: 2613, em: 284, er: 100 }, sandroneArtifacts);
assert.equal(alreadyComputed.em, 284);

const artifactCopy = formatArtifactReview({ name: 'Test', artifacts: [atkGoblet] }, guide, 'ar');
assert.match(artifactCopy, /RV الحالي/);
assert.match(artifactCopy, /RV المقترح/);
assert.match(artifactCopy, /الخلاصة/);
assert.doesNotMatch(artifactCopy, /الرولات المفيدة/);

const akashaCopy = akashaImprovementAdvice(
  { name: 'Sandrone', artifacts: [cryoGoblet] },
  guide,
  { relevantStats: [
    { key: 'em', label: 'EM', value: 284, target: { key: 'em', min: 150, max: 200 }, status: 'ok' },
    { key: 'er', label: 'ER', value: 100, target: { key: 'er', min: 125, max: 145 }, status: 'down' },
  ] },
  { topPercent: 25, category: 'Stellar-Conduct Basic Team' },
  'ar',
);
assert.match(akashaCopy, /ER/);
assert.doesNotMatch(akashaCopy, /EM.*284.*150/);
assert.match(akashaCopy, /Burst كل Rotation/);

const scored = accountScoreFromRated([
  { score: 96, akasha: { topPercent: 2 }, artifactQuality: 650 },
  { score: 93, akasha: { topPercent: 4 }, artifactQuality: 610 },
  { score: 90, akasha: { topPercent: 8 }, artifactQuality: 590 },
  { score: 40, akasha: { topPercent: 80 }, artifactQuality: 250 },
]);
assert.equal(scored.topBuilds.length, 3);
assert.deepEqual(scored.topBuilds.map((row) => row.score), [96, 93, 90]);
assert.ok(scored.accountScore > 92 && scored.accountScore < 95);

// A guide without numeric Goal Stat Values must not automatically lose half of
// the stat component. This mirrors a strong Neuvillette-style build where Game8
// provides build priorities but no numeric target table.
function neuvPiece(slot, mainStat, mainStatKey) {
  return {
    slot,
    set: 'Marechaussee Hunter',
    rarity: 5,
    level: 20,
    mainStat,
    mainStatKey,
    mainValue: '46.6%',
    substats: [
      { fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 7.8, isPercent: true },
      { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 15.5, isPercent: true },
      { fightProp: 'FIGHT_PROP_HP_PERCENT', numericValue: 3, isPercent: true },
    ],
    rolls: [],
    totalRolls: 0,
  };
}

const neuvGuide = {
  name: 'Neuvillette',
  stats: {
    main: ['Sands: HP%', 'Goblet: Hydro DMG Bonus or HP%', 'Circlet: CRIT Rate / CRIT DMG'],
    priority: 'HP% > CRIT Rate > CRIT DMG > Energy Recharge > Elemental Mastery',
    targets: [],
  },
  weapons: ['Tome of the Eternal Flow', 'Sacrificial Jade', 'Prototype Amber'],
  artifacts: ['4pc Marechaussee Hunter'],
};

const neuvSnapshot = {
  name: 'Neuvillette',
  level: 90,
  stats: { hp: 30131, atk: 1254, def: 593, critRate: 49.7, critDmg: 322.7, er: 121.4, em: 35 },
  weapon: { name: 'Tome of the Eternal Flow', level: 90, refinement: 1 },
  setCounts: { 'Marechaussee Hunter': 4, 'Other Set': 1 },
  artifacts: [
    neuvPiece('flower', 'HP', 'FIGHT_PROP_HP'),
    neuvPiece('plume', 'ATK', 'FIGHT_PROP_ATTACK'),
    neuvPiece('sands', 'HP', 'FIGHT_PROP_HP_PERCENT'),
    neuvPiece('goblet', 'Hydro DMG Bonus', 'FIGHT_PROP_WATER_ADD_HURT'),
    neuvPiece('circlet', 'CRIT DMG', 'FIGHT_PROP_CRITICAL_HURT'),
  ],
};

const effectiveNeuv = effectiveStatsForRating(neuvSnapshot, neuvGuide);
assert.equal(Math.round(effectiveNeuv.effective.critRate * 10) / 10, 85.7);
assert.equal(effectiveNeuv.bonuses.critRate, 36);
assert.equal(neuvSnapshot.stats.critRate, 49.7); // Raw Showcase stat stays untouched.

const neuvEvaluation = evaluateBuild(neuvSnapshot, neuvGuide, { akashaPercentile: { topPercent: 19 } });
assert.equal(neuvEvaluation.statTargetCount, 0);
assert.ok(neuvEvaluation.fallbackStatScore >= 78);
assert.ok(neuvEvaluation.score >= 88 && neuvEvaluation.score <= 95, `unexpected Neuv score ${neuvEvaluation.score}`);

const noSetSnapshot = {
  ...neuvSnapshot,
  setCounts: { "Wanderer's Troupe": 4, 'Other Set': 1 },
  artifacts: neuvSnapshot.artifacts.map((item) => ({ ...item, set: "Wanderer's Troupe" })),
};
const noSetEffective = effectiveStatsForRating(noSetSnapshot, neuvGuide);
assert.equal(noSetEffective.bonuses.critRate || 0, 0);
assert.equal(noSetEffective.effective.critRate, 49.7);

// Akasha 0 is invalid/missing data, never an elite Top 0% placement.
assert.equal(akashaPercent(0), null);
assert.equal(akashaPercent({ topPercent: 0 }), null);
assert.equal(akashaPercent({ topPercent: 19 }), 19);

console.log('rating enhancement tests passed');
