'use strict';

const assert = require('node:assert/strict');
const {
  applyRatingFairness,
  akashaBenchmarkScore,
  constellationBonus,
  constellationImpact,
} = require('./ratingFairness');
const { weaponMatch } = require('./buildEvaluator');

function baseEvaluation(overrides = {}) {
  return {
    score: 83,
    artifactCompletionScore: 100,
    artifactCount: 5,
    artifactAvgLevel: 20,
    mainStatScore: 67,
    artifactSetScore: 100,
    weaponScore: 100,
    relevantStats: [],
    ...overrides,
  };
}

const nahidaLike = applyRatingFairness(
  baseEvaluation(),
  { constellation: 0, weapon: { name: "Kagura's Verity", refinement: 1 } },
  { akashaPercentile: { topPercent: 0.01, ranking: 23, outOf: 283841 }, artifactQuality: 600 },
);
assert.ok(nahidaLike.score >= 96, `elite Akasha build was still undervalued: ${nahidaLike.score}`);
assert.ok(nahidaLike.rankingScore >= 96);
assert.equal(nahidaLike.constellationBonus, 0);

const ordinaryAkasha = applyRatingFairness(
  baseEvaluation({ score: 84 }),
  { constellation: 0, weapon: { name: "Kagura's Verity", refinement: 1 } },
  { akashaPercentile: { topPercent: 57 }, artifactQuality: 600 },
);
assert.equal(ordinaryAkasha.score, 84, 'ordinary Akasha placement must not inflate a score');

const badC4 = applyRatingFairness(
  baseEvaluation({ score: 62, mainStatScore: 34, artifactSetScore: 20, weaponScore: 50 }),
  { constellation: 4, weapon: { name: 'Weak Weapon', refinement: 1 } },
  {
    akashaPercentile: null,
    artifactQuality: 250,
    constellationData: {
      c1: { description: 'CRIT Rate is increased by 20%.' },
      c2: { description: 'DMG dealt is increased by 30%.' },
      c3: { description: 'Increases the Level of Elemental Skill by 3.' },
      c4: { description: 'Elemental Mastery is increased by 160.' },
    },
  },
);
assert.equal(badC4.score, 62, 'even documented combat constellations must not rescue a poor build');

const excellentC0 = applyRatingFairness(
  baseEvaluation({ score: 95, mainStatScore: 100 }),
  { constellation: 0, weapon: { name: 'Strong Weapon', refinement: 1 } },
  { akashaPercentile: null, artifactQuality: 620 },
);
assert.ok(excellentC0.score > badC4.score);

const strongC4 = applyRatingFairness(
  baseEvaluation({ score: 95, mainStatScore: 100 }),
  { constellation: 4, weapon: { name: 'Strong Weapon', refinement: 1 } },
  {
    akashaPercentile: null,
    artifactQuality: 620,
    constellationData: {
      c1: { description: 'Movement speed is increased.' },
      c2: { description: 'Enemy DEF is decreased by 30%.' },
      c3: { description: 'Increases the Level of Elemental Skill by 3.' },
      c4: { description: 'Elemental Mastery is increased by 160.' },
    },
  },
);
assert.ok(strongC4.rankingScore > excellentC0.rankingScore, 'documented combat constellations should give a small edge between similarly strong builds');
assert.ok(strongC4.rankingScore - excellentC0.rankingScore < 1, 'constellation edge must remain bounded');
assert.ok(constellationImpact('Enemy DEF is decreased by 30%.') > constellationImpact('Movement speed is increased.'));

const perfect = applyRatingFairness(
  baseEvaluation({ score: 99, mainStatScore: 100 }),
  { constellation: 6, weapon: { name: 'Strong Weapon', refinement: 5 } },
  { akashaPercentile: { topPercent: 0.01 }, artifactQuality: 700 },
);
assert.equal(perfect.score, 100, '100% must remain attainable');
assert.equal(akashaBenchmarkScore({ topPercent: 0.01 }), 100);
assert.equal(constellationBonus({ constellation: 0 }, 100), 0);

const unlistedFiveStar = weaponMatch(
  { weapon: { name: 'Viable 5 Star', rarity: 5, level: 90 } },
  { weapons: ['Signature Weapon'], f2pWeapons: [] },
);
assert.ok(unlistedFiveStar >= 0.69 && unlistedFiveStar < 0.8, 'unlisted 5-star should be treated as viable unknown, not a 50% failure');

const f2pRecommended = weaponMatch(
  { weapon: { name: 'Crafted Sword', rarity: 4, level: 90 } },
  { weapons: ['Signature Weapon'], f2pWeapons: ['Crafted Sword'] },
);
assert.equal(f2pRecommended, 0.93, 'published F2P recommendations must count as documented weapons');

console.log('ratingFairness tests passed');
