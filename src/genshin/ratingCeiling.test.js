'use strict';

const assert = require('node:assert/strict');
const {
  applyCompetitiveCeiling,
  competitiveAdviceRows,
  softCapFor,
} = require('./ratingCeiling');

function evaluation(stats, overrides = {}) {
  return {
    score: 100,
    artifactCount: 5,
    artifactAvgLevel: 20,
    mainStatScore: 100,
    artifactSetScore: 100,
    relevantStats: stats,
    ...overrides,
  };
}

function row(key, label, value, min, max = min, weight = 1) {
  return {
    key,
    label,
    value,
    effectiveValue: value,
    target: { key, min, max },
    status: value < min ? 'down' : 'ok',
    weight,
  };
}

const floorBuild = applyCompetitiveCeiling(evaluation([
  row('critRate', 'CRIT Rate', 70, 70, 80, 1.3),
  row('critDmg', 'CRIT DMG', 200, 200, 200, 1.3),
  row('atk', 'ATK', 2100, 2100, 2100, 1.2),
]));
assert.equal(floorBuild.score, 95);
assert.equal(floorBuild.competitiveBonus, 0);
assert.equal(floorBuild.competitiveReservedPoints, 5);

const strongerBuild = applyCompetitiveCeiling(evaluation([
  row('critRate', 'CRIT Rate', 80, 70, 80, 1.3),
  row('critDmg', 'CRIT DMG', 240, 200, 200, 1.3),
  row('atk', 'ATK', 2400, 2100, 2100, 1.2),
]));
assert.ok(strongerBuild.score > floorBuild.score, `${strongerBuild.score} must beat ${floorBuild.score}`);
assert.ok(strongerBuild.competitiveBonus >= 1 && strongerBuild.competitiveBonus <= 5);
assert.ok(competitiveAdviceRows(strongerBuild).length > 0);

const missingTarget = applyCompetitiveCeiling(evaluation([
  row('critRate', 'CRIT Rate', 60, 70, 80, 1.3),
  row('critDmg', 'CRIT DMG', 260, 200, 200, 1.3),
  row('atk', 'ATK', 2600, 2100, 2100, 1.2),
]));
assert.equal(missingTarget.competitiveBonus, 0);
assert.equal(missingTarget.score, 100);

const incomplete = applyCompetitiveCeiling(evaluation([
  row('critRate', 'CRIT Rate', 90, 70, 80),
  row('critDmg', 'CRIT DMG', 280, 200),
], { artifactSetScore: 65, score: 86 }));
assert.equal(incomplete.competitiveBonus, 0);
assert.equal(incomplete.score, 86);

const withEr = applyCompetitiveCeiling(evaluation([
  row('critRate', 'CRIT Rate', 80, 70, 80),
  row('critDmg', 'CRIT DMG', 240, 200),
  row('er', 'ER', 220, 120, 140),
]));
assert.equal((withEr.competitiveCeilingRows || []).some((item) => item.key === 'er'), false);

assert.equal(softCapFor(row('critRate', 'CRIT Rate', 80, 70, 80)), 91);
assert.ok(softCapFor(row('critDmg', 'CRIT DMG', 240, 200)) > 200);

console.log('ratingCeiling tests passed');
