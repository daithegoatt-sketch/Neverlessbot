'use strict';

const assert = require('node:assert/strict');
const { recommendedRv, setNeedsChange, formatArtifactDoctor } = require('./artifactDoctor');
const { formatArtifactReview } = require('./ratingCopyV2');
const { formatCharacterLeaderboard } = require('./leaderboard');

const guide = {
  artifacts: ['Finale of the Deep Galleries (4-Piece)'],
  stats: {
    main: ['Sands: ATK%', 'Goblet: Cryo DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
    priority: 'CRIT Rate > CRIT DMG > ATK% > ER',
    targets: ['CRIT Rate: 70-80%', 'CRIT DMG: 200%+', 'ATK: 2000+', 'ER: 120-140%'],
  },
};

function piece(slot, usefulRv, mainMatch = true) {
  return {
    slot,
    slotLabel: slot[0].toUpperCase() + slot.slice(1),
    level: 20,
    mainStat: slot === 'goblet' ? 'Cryo DMG Bonus' : 'ATK%',
    mainValue: '46.6%',
    mainMatch,
    mainOptions: mainMatch ? [] : ['Cryo DMG Bonus'],
    usefulRv,
    totalRv: usefulRv + 100,
    priorityScore: Math.max(0, 650 - usefulRv) + (mainMatch ? 0 : 1000),
    usefulKeys: ['critRate', 'critDmg'],
  };
}

const snapshot = {
  name: 'Skirk',
  setCounts: { 'Wrong Set': 4, 'Finale of the Deep Galleries': 1 },
  artifacts: [
    { slot: 'flower', level: 20, mainStat: 'HP', mainValue: '4780', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '10.1%' }, { name: 'CRIT DMG', value: '20.2%' }] },
    { slot: 'plume', level: 20, mainStat: 'ATK', mainValue: '311', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '7.8%' }, { name: 'CRIT DMG', value: '21.0%' }] },
    { slot: 'sands', level: 20, mainStat: 'ATK%', mainValue: '46.6%', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '3.5%' }, { name: 'CRIT DMG', value: '14.0%' }, { name: 'ER', value: '5.8%' }] },
    { slot: 'goblet', level: 20, mainStat: 'Cryo DMG Bonus', mainValue: '46.6%', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '7.8%' }, { name: 'CRIT DMG', value: '14.0%' }] },
    { slot: 'circlet', level: 20, mainStat: 'CRIT DMG', mainValue: '62.2%', set: 'Finale of the Deep Galleries', substats: [{ name: 'CRIT Rate', value: '10.1%' }, { name: 'ATK%', value: '9.9%' }] },
  ],
};

// Stub reviewed rows through realistic roll data is outside this formatter test; thresholds stay bounded.
assert.equal(recommendedRv(piece('sands', 350)), 500);
assert.equal(recommendedRv(piece('sands', 470)), 550);
assert.equal(recommendedRv(piece('sands', 560)), 600);
assert.equal(recommendedRv(piece('sands', 700)), 650);

const setIssue = setNeedsChange(snapshot, guide);
assert.equal(setIssue.current, 'Wrong Set');
assert.match(setIssue.recommended, /Finale/i);

// Use a compact synthetic snapshot that artifactEvaluator can read.
const rvSnapshot = {
  ...snapshot,
  artifacts: snapshot.artifacts.map((row, index) => ({
    ...row,
    rarity: 5,
    mainStatKey: row.slot === 'goblet' ? 'FIGHT_PROP_ICE_ADD_HURT' : row.slot === 'sands' ? 'FIGHT_PROP_ATTACK_PERCENT' : row.slot === 'circlet' ? 'FIGHT_PROP_CRITICAL_HURT' : row.slot === 'flower' ? 'FIGHT_PROP_HP' : 'FIGHT_PROP_ATTACK',
    rolls: [
      { fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 3.89, isPercent: true },
      { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 7.77, isPercent: true },
      ...(index === 2 ? [{ fightProp: 'FIGHT_PROP_ATTACK_PERCENT', numericValue: 5.83, isPercent: true }] : []),
    ],
    totalRolls: index === 2 ? 3 : 2,
  })),
};

const reviewText = formatArtifactReview(rvSnapshot, guide, 'ar');
assert.match(reviewText, /RV الحالي/);
assert.match(reviewText, /RV المقترح/);
assert.doesNotMatch(reviewText, /الرولات المفيدة/);
assert.match(reviewText, /الـSet/);

const evaluation = { relevantStats: [{ key: 'er', label: 'ER', value: 100, status: 'down' }] };
const doctorText = formatArtifactDoctor(rvSnapshot, guide, evaluation, 'ar');
assert.match(doctorText, /5–7/);
assert.match(doctorText, /Artifact Doctor/);
assert.doesNotMatch(doctorText, /40%.*CRIT DMG.*20%.*CRIT Rate/i);

const boardText = formatCharacterLeaderboard({
  characterName: 'Skirk',
  rows: [{ discordUserId: '123', score: 93, akasha: { topPercent: 0.004 }, strengths: ['CRIT Rate 80%'] }],
}, 'ar');
assert.match(boardText, /<0\.01%/);
assert.doesNotMatch(boardText, /نقاط القوة/);
assert.doesNotMatch(boardText, /#\d+\s*\//);

console.log('artifact doctor tests passed');
