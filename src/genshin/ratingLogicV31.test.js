'use strict';

const assert = require('node:assert/strict');
const { evaluateBuild } = require('./buildEvaluator');
const { effectiveStatsForRating } = require('./combatStats');
const { enhancedAccountEvaluationText, currentSetText, setUpgrade } = require('./enhancedRatingText');
const { addArtifactAlternatives } = require('./guideClient');

function piece(slot, set, mainStat, mainStatKey) {
  return {
    slot,
    set,
    rarity: 5,
    level: 20,
    mainStat,
    mainStatKey,
    mainValue: '46.6%',
    substats: [
      { fightProp: 'FIGHT_PROP_CRITICAL', numericValue: 7.8, isPercent: true },
      { fightProp: 'FIGHT_PROP_CRITICAL_HURT', numericValue: 15.5, isPercent: true },
      { fightProp: 'FIGHT_PROP_HP_PERCENT', numericValue: 5.8, isPercent: true },
    ],
    rolls: [],
    totalRolls: 0,
  };
}

const neuvGuideWithoutParsedSet = {
  name: 'Neuvillette',
  stats: {
    main: ['Sands: HP%', 'Goblet: Hydro DMG Bonus or HP%', 'Circlet: CRIT Rate / CRIT DMG'],
    priority: 'HP% > CRIT Rate > CRIT DMG',
    targets: ['HP: 30,000+', 'CRIT Rate: 49%+', 'CRIT DMG: 300%+'],
  },
  weapons: ['Tome of the Eternal Flow'],
  artifacts: [],
};

const neuv = {
  name: 'Neuvillette',
  level: 90,
  stats: { hp: 30131, atk: 1254, def: 593, critRate: 49.7, critDmg: 322.7, er: 121.4, em: 35 },
  weapon: { name: 'Tome of the Eternal Flow', level: 90, refinement: 1 },
  setCounts: { 'Marechaussee Hunter': 4, 'Other Set': 1 },
  artifacts: [
    piece('flower', 'Marechaussee Hunter', 'HP', 'FIGHT_PROP_HP'),
    piece('plume', 'Marechaussee Hunter', 'ATK', 'FIGHT_PROP_ATTACK'),
    piece('sands', 'Marechaussee Hunter', 'HP', 'FIGHT_PROP_HP_PERCENT'),
    piece('goblet', 'Marechaussee Hunter', 'Hydro DMG Bonus', 'FIGHT_PROP_WATER_ADD_HURT'),
    piece('circlet', 'Other Set', 'CRIT DMG', 'FIGHT_PROP_CRITICAL_HURT'),
  ],
};

const neuvEffective = effectiveStatsForRating(neuv, neuvGuideWithoutParsedSet);
assert.equal(neuvEffective.bonuses.critRate, 36);
assert.equal(neuvEffective.effective.critRate, 85.7);
assert.equal(neuv.stats.critRate, 49.7);
const neuvScore = evaluateBuild(neuv, neuvGuideWithoutParsedSet, { akashaPercentile: { topPercent: 19 } });
assert.ok(neuvScore.score >= 90, `Neuvillette score unexpectedly low: ${neuvScore.score}`);

const mavuika = {
  name: 'Mavuika',
  stats: { critRate: 55, critDmg: 220, atk: 2100, em: 100 },
  setCounts: { 'Obsidian Codex': 4, 'Other Set': 1 },
  artifacts: [],
};
const mavuikaEffective = effectiveStatsForRating(mavuika, { name: 'Mavuika', artifacts: [] });
assert.equal(mavuikaEffective.bonuses.critRate, 40);
assert.equal(mavuikaEffective.effective.critRate, 95);

const alternativeGuide = {
  name: 'Columbina',
  artifacts: ["4pc Silken Moon's Serenade", '4pc Aubade of Morningstar and Moon'],
  stats: { main: [], priority: 'CRIT Rate > CRIT DMG', targets: [] },
  weapons: [],
};
const alternateSnapshot = {
  name: 'Columbina',
  stats: { critRate: 70, critDmg: 190 },
  weapon: { name: 'Test Weapon', level: 90, refinement: 1 },
  setCounts: { 'Aubade of Morningstar and Moon': 4, 'Other Set': 1 },
  artifacts: [
    piece('flower', 'Aubade of Morningstar and Moon', 'HP', 'FIGHT_PROP_HP'),
    piece('plume', 'Aubade of Morningstar and Moon', 'ATK', 'FIGHT_PROP_ATTACK'),
    piece('sands', 'Aubade of Morningstar and Moon', 'ATK', 'FIGHT_PROP_ATTACK_PERCENT'),
    piece('goblet', 'Aubade of Morningstar and Moon', 'Elemental DMG Bonus', 'FIGHT_PROP_ELEC_ADD_HURT'),
    piece('circlet', 'Other Set', 'CRIT Rate', 'FIGHT_PROP_CRITICAL'),
  ],
};
const altEval = evaluateBuild(alternateSnapshot, alternativeGuide);
assert.equal(altEval.artifactSetScore, 100);
assert.equal(setUpgrade(alternateSnapshot, alternativeGuide), null);
assert.match(currentSetText(alternateSnapshot), /Aubade of Morningstar and Moon 4pc/);

const augmentedColumbina = addArtifactAlternatives({ name: 'Columbina', artifacts: ["4pc Silken Moon's Serenade"] }, 'Columbina');
assert.equal(augmentedColumbina.artifacts.some((item) => /Aubade of Morningstar and Moon/i.test(item)), true);
const augmentedIneffa = addArtifactAlternatives({ name: 'Ineffa', artifacts: ['4pc Aubade of Morningstar and Moon'] }, 'Ineffa');
assert.equal(augmentedIneffa.artifacts.some((item) => /Silken Moon's Serenade/i.test(item)), true);

const displayEvaluation = {
  score: 90,
  relevantStats: [],
  artifactCount: 5,
  artifactAvgLevel: 20,
  mainStatScore: 100,
  artifactSetScore: 100,
  notes: [],
};
const validCopy = enhancedAccountEvaluationText(alternateSnapshot, displayEvaluation, null, alternativeGuide, 'ar', null);
assert.match(validCopy, /Aubade of Morningstar and Moon 4pc/);
assert.doesNotMatch(validCopy, /Aubade of Morningstar and Moon 4pc\s*→/);

const wrongSnapshot = {
  ...alternateSnapshot,
  setCounts: { "Gladiator's Finale": 4, 'Other Set': 1 },
  artifacts: alternateSnapshot.artifacts.map((row, index) => ({ ...row, set: index < 4 ? "Gladiator's Finale" : 'Other Set' })),
};
const issue = setUpgrade(wrongSnapshot, alternativeGuide);
assert.ok(issue);
assert.match(issue.recommended, /Silken Moon/);
const wrongCopy = enhancedAccountEvaluationText(wrongSnapshot, { ...displayEvaluation, artifactSetScore: 20 }, null, alternativeGuide, 'ar', null);
assert.match(wrongCopy, /Gladiator's Finale 4pc/);
assert.match(wrongCopy, /الـSet:/);
assert.match(wrongCopy, /Silken Moon/);

console.log('rating logic v31 tests passed');
