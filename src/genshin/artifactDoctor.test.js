'use strict';

const assert = require('node:assert/strict');
const {
  setNeedsChange,
  formatArtifactDoctor,
  parseRequestedTargets,
  mainBlocksSubstat,
  improvementCandidates,
  rankArtifactPieces,
} = require('./artifactDoctor');
const { formatArtifactReview } = require('./ratingCopyV2');
const { formatCharacterLeaderboard } = require('./leaderboard');
const { isUnlink } = require('./uidRouter');
const { reviewArtifacts } = require('./artifactEvaluator');

const guide = {
  artifacts: ['Finale of the Deep Galleries (4-Piece)'],
  stats: {
    main: ['Sands: ATK%', 'Goblet: Cryo DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
    priority: 'CRIT Rate > CRIT DMG > ATK%',
    targets: ['CRIT Rate: 70-80%', 'CRIT DMG: 200%+', 'ATK: 2100+'],
  },
};

const snapshot = {
  name: 'Skirk',
  stats: { critRate: 71.8, critDmg: 229.1, atk: 2001, er: 111.7, em: 16 },
  setCounts: { 'Finale of the Deep Galleries': 4, 'Off Piece': 1 },
  artifacts: [
    { slot: 'flower', rarity: 5, level: 20, mainStat: 'HP', mainStatKey: 'FIGHT_PROP_HP', mainValue: '4780', set: 'Finale of the Deep Galleries', substats: [{ name: 'CRIT Rate', fightProp: 'FIGHT_PROP_CRITICAL', value: '9.7%', numericValue: 9.7, isPercent: true }, { name: 'CRIT DMG', fightProp: 'FIGHT_PROP_CRITICAL_HURT', value: '22.5%', numericValue: 22.5, isPercent: true }, { name: 'ER', fightProp: 'FIGHT_PROP_CHARGE_EFFICIENCY', value: '6.5%', numericValue: 6.5, isPercent: true }, { name: 'DEF', fightProp: 'FIGHT_PROP_DEFENSE', value: '16', numericValue: 16 }] },
    { slot: 'plume', rarity: 5, level: 20, mainStat: 'ATK', mainStatKey: 'FIGHT_PROP_ATTACK', mainValue: '311', set: 'Finale of the Deep Galleries', substats: [{ name: 'CRIT Rate', fightProp: 'FIGHT_PROP_CRITICAL', value: '10.1%', numericValue: 10.1, isPercent: true }, { name: 'CRIT DMG', fightProp: 'FIGHT_PROP_CRITICAL_HURT', value: '28.7%', numericValue: 28.7, isPercent: true }, { name: 'DEF', fightProp: 'FIGHT_PROP_DEFENSE', value: '19', numericValue: 19 }, { name: 'HP%', fightProp: 'FIGHT_PROP_HP_PERCENT', value: '5.8%', numericValue: 5.8, isPercent: true }] },
    { slot: 'sands', rarity: 5, level: 20, mainStat: 'ATK%', mainStatKey: 'FIGHT_PROP_ATTACK_PERCENT', mainValue: '46.6%', set: 'Finale of the Deep Galleries', substats: [{ name: 'CRIT Rate', fightProp: 'FIGHT_PROP_CRITICAL', value: '9.3%', numericValue: 9.3, isPercent: true }, { name: 'CRIT DMG', fightProp: 'FIGHT_PROP_CRITICAL_HURT', value: '13.2%', numericValue: 13.2, isPercent: true }, { name: 'ER', fightProp: 'FIGHT_PROP_CHARGE_EFFICIENCY', value: '5.2%', numericValue: 5.2, isPercent: true }, { name: 'HP', fightProp: 'FIGHT_PROP_HP', value: '508', numericValue: 508 }] },
    { slot: 'goblet', rarity: 5, level: 20, mainStat: 'Cryo DMG Bonus', mainStatKey: 'FIGHT_PROP_ICE_ADD_HURT', mainValue: '46.6%', set: 'Off Piece', substats: [{ name: 'CRIT Rate', fightProp: 'FIGHT_PROP_CRITICAL', value: '9.7%', numericValue: 9.7, isPercent: true }, { name: 'CRIT DMG', fightProp: 'FIGHT_PROP_CRITICAL_HURT', value: '14.0%', numericValue: 14, isPercent: true }, { name: 'ATK', fightProp: 'FIGHT_PROP_ATTACK', value: '35', numericValue: 35 }, { name: 'EM', fightProp: 'FIGHT_PROP_ELEMENT_MASTERY', value: '16', numericValue: 16 }] },
    { slot: 'circlet', rarity: 5, level: 20, mainStat: 'CRIT DMG', mainStatKey: 'FIGHT_PROP_CRITICAL_HURT', mainValue: '62.2%', set: 'Finale of the Deep Galleries', substats: [{ name: 'ATK%', fightProp: 'FIGHT_PROP_ATTACK_PERCENT', value: '8.7%', numericValue: 8.7, isPercent: true }, { name: 'CRIT Rate', fightProp: 'FIGHT_PROP_CRITICAL', value: '5.8%', numericValue: 5.8, isPercent: true }, { name: 'ATK', fightProp: 'FIGHT_PROP_ATTACK', value: '51', numericValue: 51 }, { name: 'DEF%', fightProp: 'FIGHT_PROP_DEFENSE_PERCENT', value: '5.1%', numericValue: 5.1, isPercent: true }] },
  ],
};

assert.equal(setNeedsChange(snapshot, guide), null);

const reviewText = formatArtifactReview(snapshot, guide, 'ar');
assert.match(reviewText, /RV/);
assert.match(reviewText, /CV/);
assert.match(reviewText, /Circlet/);

// The flower has much stronger relevant substats/CV. The weak link must be the circlet,
// not whichever piece happens to have a slightly lower legacy RV threshold.
const ranked = rankArtifactPieces(snapshot, guide, { relevantStats: [] });
assert.equal(ranked[0].row.slot, 'circlet');
assert.ok(ranked.find((row) => row.row.slot === 'flower').quality.score > ranked[0].quality.score);

const requested = parseRequestedTargets('تحسين ارتيفاكتات Skirk ارفع الكريت ريت إلى 80');
assert.equal(requested[0].key, 'critRate');
assert.equal(requested[0].target, 80);

const evaluation = { relevantStats: [
  { key: 'critRate', label: 'CRIT Rate', value: 71.8, target: { key: 'critRate', min: 70, max: 80 }, status: 'ok' },
  { key: 'critDmg', label: 'CRIT DMG', value: 229.1, target: { key: 'critDmg', min: 200, max: 200 }, status: 'ok' },
  { key: 'atk', label: 'ATK', value: 2001, target: { key: 'atk', min: 2100, max: 2100 }, status: 'down' },
] };
const doctorText = formatArtifactDoctor(snapshot, guide, evaluation, 'ar', 'تحسين ارتيفاكتات Skirk ارفع الكريت ريت إلى 80');
assert.match(doctorText, /Circlet/);
assert.match(doctorText, /14(?:\.0)?%/);
assert.match(doctorText, /RV/);
assert.match(doctorText, /CV/);
assert.doesNotMatch(doctorText, /5–7/);
assert.doesNotMatch(doctorText, /CRIT DMG: 30%\+/i);
assert.equal(mainBlocksSubstat(snapshot.artifacts[4], 'critDmg'), true);

const report = reviewArtifacts(snapshot, guide);
const candidates = improvementCandidates(snapshot, guide, report, { key: 'critRate', target: 80, explicit: true }, evaluation);
assert.equal(candidates[0].row.slot, 'circlet');
assert.ok(candidates[0].wanted >= 13.9 && candidates[0].wanted <= 14.1);
assert.ok(candidates[0].wanted <= 19.65);

// Non-crit profiles: CV is displayed but must not drive the Doctor. EM/HP/DEF can be
// the actual useful stats depending on the character guide.
const emGuide = {
  artifacts: ['Paradise Lost (4-Piece)'],
  stats: { main: ['Sands: Elemental Mastery', 'Goblet: Elemental Mastery', 'Circlet: Elemental Mastery'], priority: 'Elemental Mastery > HP%', targets: ['Elemental Mastery: 900+'] },
};
const emSnapshot = {
  name: 'Reaction Support', stats: { em: 700, hp: 30000, critRate: 5, critDmg: 50 },
  artifacts: [
    { slot: 'flower', rarity: 5, level: 20, mainStat: 'HP', mainStatKey: 'FIGHT_PROP_HP', set: 'Paradise Lost', substats: [{ name: 'CRIT Rate', fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 15, value: '15%', isPercent: true }, { name: 'CRIT DMG', fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 30, value: '30%', isPercent: true }] },
    { slot: 'plume', rarity: 5, level: 20, mainStat: 'ATK', mainStatKey: 'FIGHT_PROP_ATTACK', set: 'Paradise Lost', substats: [{ name: 'Elemental Mastery', fightProp: 'FIGHT_PROP_ELEMENT_MASTERY', numericValue: 80, value: '80' }, { name: 'HP%', fightProp: 'FIGHT_PROP_HP_PERCENT', numericValue: 10, value: '10%', isPercent: true }] },
  ],
};
const emRank = rankArtifactPieces(emSnapshot, emGuide, { relevantStats: [{ key: 'em', value: 700, target: { min: 900, max: 900 }, status: 'down' }] });
assert.equal(emRank[0].row.slot, 'flower');

assert.equal(isUnlink('قيم ارتفكتات ساندورني في حسابي'), false);
assert.equal(isUnlink('فك ربط UID'), true);
assert.equal(isUnlink('unlink uid'), true);

const boardText = formatCharacterLeaderboard({
  characterName: 'Skirk',
  rows: [{ discordUserId: '123', score: 93, akasha: { topPercent: 0.004 }, strengths: ['CRIT Rate 80%'] }],
}, 'ar');
assert.match(boardText, /<0\.01%/);
assert.doesNotMatch(boardText, /نقاط القوة/);

console.log('artifact doctor tests passed');
