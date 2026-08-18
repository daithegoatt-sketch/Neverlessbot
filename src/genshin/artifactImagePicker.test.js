'use strict';

const assert = require('node:assert/strict');
const { parseArtifactText, scoreCandidateArtifact, projectedRecommendedSetCount, slotFromText } = require('./artifactImagePicker');
const { artifactCritValue } = require('./artifactEvaluator');

const guide = {
  artifacts: ['Finale of the Deep Galleries (4-Piece)'],
  stats: {
    main: ['Sands: ATK%', 'Goblet: Cryo DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
    priority: 'CRIT Rate > CRIT DMG > ATK%',
    targets: ['CRIT Rate: 70-80%', 'CRIT DMG: 200%+', 'ATK: 2100+'],
  },
};

assert.equal(slotFromText('اختر أفضل Circlet ارتيفاكت لـ Skirk'), 'circlet');
assert.equal(slotFromText('best goblet artifact'), 'goblet');

const ocrText = `
Veteran Circlet
Circlet of Logos
CRIT DMG
62.2%
+20
ATK+51
ATK+8.7%
CRIT Rate+5.8%
DEF+5.1%
Finale of the Deep Galleries:
4-Piece Set: test
`;
const parsed = parseArtifactText(ocrText, guide, 'circlet');
assert.equal(parsed.ok, true);
assert.equal(parsed.artifact.slot, 'circlet');
assert.equal(parsed.artifact.mainStatKey, 'FIGHT_PROP_CRITICAL_HURT');
assert.equal(parsed.artifact.set, 'Finale of the Deep Galleries');
assert.equal(parsed.artifact.substats.length, 4);
assert.equal(artifactCritValue(parsed.artifact), 11.6);

// Screenshot style shown by the user: main-stat and substats can be on separate lines.
const hpText = `
Veteran's Visage
Circlet of Logos
HP
46.6%
+20
DEF+23
HP+299
ATK+19
CRIT DMG+35.7%
Marechaussee Hunter:
2-Piece Set: Normal and Charged Attack DMG +15%
`;
const hpGuide = { artifacts: ['Marechaussee Hunter (4-Piece)'], stats: { main: ['Circlet: HP% / CRIT Rate / CRIT DMG'], priority: 'HP% > CRIT DMG' } };
const hp = parseArtifactText(hpText, hpGuide, 'circlet');
assert.equal(hp.ok, true);
assert.equal(hp.artifact.mainStatKey, 'FIGHT_PROP_HP_PERCENT');
assert.equal(hp.artifact.substats.find((row) => row.fightProp === 'FIGHT_PROP_CRITICAL_HURT').numericValue, 35.7);

const snapshot = {
  name: 'Skirk',
  stats: { critRate: 71.8, critDmg: 229.1, atk: 2001, er: 111.7, em: 16 },
  setCounts: { 'Finale of the Deep Galleries': 4, 'Off Piece': 1 },
  artifacts: [
    { slot: 'flower', rarity: 5, level: 20, mainStat: 'HP', mainStatKey: 'FIGHT_PROP_HP', set: 'Finale of the Deep Galleries', substats: [] },
    { slot: 'plume', rarity: 5, level: 20, mainStat: 'ATK', mainStatKey: 'FIGHT_PROP_ATTACK', set: 'Finale of the Deep Galleries', substats: [] },
    { slot: 'sands', rarity: 5, level: 20, mainStat: 'ATK%', mainStatKey: 'FIGHT_PROP_ATTACK_PERCENT', set: 'Finale of the Deep Galleries', substats: [] },
    { slot: 'goblet', rarity: 5, level: 20, mainStat: 'Cryo DMG Bonus', mainStatKey: 'FIGHT_PROP_ICE_ADD_HURT', set: 'Off Piece', substats: [] },
    parsed.artifact,
  ],
};

const evaluation = { relevantStats: [
  { key: 'critRate', value: 71.8, target: { min: 70, max: 80 }, status: 'ok' },
  { key: 'critDmg', value: 229.1, target: { min: 200, max: 200 }, status: 'ok' },
  { key: 'atk', value: 2001, target: { min: 2100, max: 2100 }, status: 'down' },
] };

const better = {
  ...parsed.artifact,
  substats: [
    { name: 'CRIT Rate', fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 14, value: '14%', isPercent: true },
    { name: 'ATK%', fightProp: 'FIGHT_PROP_ATTACK_PERCENT', numericValue: 10.5, value: '10.5%', isPercent: true },
    { name: 'ER', fightProp: 'FIGHT_PROP_CHARGE_EFFICIENCY', numericValue: 5.2, value: '5.2%', isPercent: true },
    { name: 'DEF', fightProp: 'FIGHT_PROP_DEFENSE', numericValue: 19, value: '19' },
  ],
};
const oldScore = scoreCandidateArtifact(parsed.artifact, snapshot, guide, evaluation, 'circlet');
const newScore = scoreCandidateArtifact(better, snapshot, guide, evaluation, 'circlet');
assert.equal(oldScore.valid, true);
assert.equal(newScore.valid, true);
assert.ok(newScore.score > oldScore.score);
assert.ok(newScore.projected.stats.critRate > snapshot.stats.critRate);

const offSet = { ...better, set: 'Random Set' };
const setFit = projectedRecommendedSetCount(snapshot, 'circlet', offSet, guide);
assert.equal(setFit.required, 4);
assert.equal(setFit.matched, false);
const offScore = scoreCandidateArtifact(offSet, snapshot, guide, evaluation, 'circlet');
assert.ok(offScore.score < newScore.score);

console.log('artifact image picker tests passed');
