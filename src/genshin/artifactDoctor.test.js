'use strict';

const assert = require('node:assert/strict');
const { setNeedsChange, formatArtifactDoctor, parseRequestedTargets, mainBlocksSubstat } = require('./artifactDoctor');
const { formatArtifactReview } = require('./ratingCopyV2');
const { formatCharacterLeaderboard } = require('./leaderboard');
const { isUnlink } = require('./uidRouter');

const guide = {
  artifacts: ['Finale of the Deep Galleries (4-Piece)'],
  stats: {
    main: ['Sands: ATK%', 'Goblet: Cryo DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
    priority: 'CRIT Rate > CRIT DMG > ATK% > ER',
    targets: ['CRIT Rate: 70-80%', 'CRIT DMG: 200%+', 'ATK: 2000+', 'ER: 100-130%'],
  },
};

const snapshot = {
  name: 'Skirk',
  stats: { critRate: 71.8, critDmg: 229.1, atk: 2001, er: 111.7, em: 16 },
  setCounts: { 'Wrong Set': 4, 'Finale of the Deep Galleries': 1 },
  artifacts: [
    { slot: 'flower', rarity: 5, level: 20, mainStat: 'HP', mainStatKey: 'FIGHT_PROP_HP', mainValue: '4780', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '9.7%', numericValue: 9.7, isPercent: true }, { name: 'CRIT DMG', value: '22.5%', numericValue: 22.5, isPercent: true }, { name: 'ER', value: '6.5%', numericValue: 6.5, isPercent: true }], rolls: [{ fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 3.89, isPercent: true }, { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 7.77, isPercent: true }] },
    { slot: 'plume', rarity: 5, level: 20, mainStat: 'ATK', mainStatKey: 'FIGHT_PROP_ATTACK', mainValue: '311', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '10.1%', numericValue: 10.1, isPercent: true }, { name: 'CRIT DMG', value: '28.7%', numericValue: 28.7, isPercent: true }, { name: 'HP%', value: '5.8%', numericValue: 5.8, isPercent: true }], rolls: [{ fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 3.89, isPercent: true }, { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 7.77, isPercent: true }] },
    { slot: 'sands', rarity: 5, level: 20, mainStat: 'ATK%', mainStatKey: 'FIGHT_PROP_ATTACK_PERCENT', mainValue: '46.6%', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '9.3%', numericValue: 9.3, isPercent: true }, { name: 'CRIT DMG', value: '13.2%', numericValue: 13.2, isPercent: true }, { name: 'ER', value: '5.2%', numericValue: 5.2, isPercent: true }], rolls: [{ fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 3.89, isPercent: true }, { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 7.77, isPercent: true }] },
    { slot: 'goblet', rarity: 5, level: 20, mainStat: 'Cryo DMG Bonus', mainStatKey: 'FIGHT_PROP_ICE_ADD_HURT', mainValue: '46.6%', set: 'Wrong Set', substats: [{ name: 'CRIT Rate', value: '9.7%', numericValue: 9.7, isPercent: true }, { name: 'CRIT DMG', value: '14.0%', numericValue: 14.0, isPercent: true }, { name: 'ATK', value: '35', numericValue: 35 }], rolls: [{ fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 3.89, isPercent: true }, { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 7.77, isPercent: true }] },
    { slot: 'circlet', rarity: 5, level: 20, mainStat: 'CRIT DMG', mainStatKey: 'FIGHT_PROP_CRITICAL_HURT', mainValue: '62.2%', set: 'Finale of the Deep Galleries', substats: [{ name: 'ATK%', value: '8.7%', numericValue: 8.7, isPercent: true }, { name: 'CRIT Rate', value: '5.8%', numericValue: 5.8, isPercent: true }, { name: 'ATK', value: '51', numericValue: 51 }, { name: 'DEF%', value: '5.1%', numericValue: 5.1, isPercent: true }], rolls: [{ fightProp: 'FIGHT_PROP_ATTACK_PERCENT', numericValue: 5.83, isPercent: true }, { fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 3.89, isPercent: true }] },
  ],
};

const setIssue = setNeedsChange(snapshot, guide);
assert.equal(setIssue.current, 'Wrong Set');
assert.match(setIssue.recommended, /Finale/i);

const reviewText = formatArtifactReview(snapshot, guide, 'ar');
assert.match(reviewText, /RV الحالي/);
assert.match(reviewText, /RV المقترح/);
assert.doesNotMatch(reviewText, /الرولات المفيدة/);
assert.match(reviewText, /الـSet/);

const requested = parseRequestedTargets('تحسين ارتيفاكتات Skirk ارفع الكريت ريت إلى 80');
assert.equal(requested[0].key, 'critRate');
assert.equal(requested[0].target, 80);

const evaluation = { relevantStats: [
  { key: 'critRate', label: 'CRIT Rate', value: 71.8, target: { key: 'critRate', min: 70, max: 80 }, status: 'ok' },
  { key: 'critDmg', label: 'CRIT DMG', value: 229.1, target: { key: 'critDmg', min: 200, max: 200 }, status: 'ok' },
  { key: 'atk', label: 'ATK', value: 2001, target: { key: 'atk', min: 2000, max: 2000 }, status: 'ok' },
] };
const doctorText = formatArtifactDoctor(snapshot, guide, evaluation, 'ar', 'تحسين ارتيفاكتات Skirk ارفع الكريت ريت إلى 80');
assert.match(doctorText, /80%/);
assert.match(doctorText, /CRIT Rate/);
assert.match(doctorText, /4–5/);
assert.doesNotMatch(doctorText, /5–7/);
assert.doesNotMatch(doctorText, /CRIT DMG: 30%\+.*Circlet/i);
assert.equal(mainBlocksSubstat(snapshot.artifacts[4], 'critDmg'), true);

// A misspelling of artifacts must never be interpreted as "فك ربط".
assert.equal(isUnlink('قيم ارتفكتات ساندورني في حسابي'), false);
assert.equal(isUnlink('فك ربط UID'), true);
assert.equal(isUnlink('unlink uid'), true);

const boardText = formatCharacterLeaderboard({
  characterName: 'Skirk',
  rows: [{ discordUserId: '123', score: 93, akasha: { topPercent: 0.004 }, strengths: ['CRIT Rate 80%'] }],
}, 'ar');
assert.match(boardText, /<0\.01%/);
assert.doesNotMatch(boardText, /نقاط القوة/);
assert.doesNotMatch(boardText, /#\d+\s*\//);

console.log('artifact doctor tests passed');
