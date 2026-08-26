'use strict';

const assert = require('node:assert/strict');
const {
  effectiveStatsForRating,
  weaponPassiveBonuses,
  extractPassiveBonus,
} = require('./combatStats');

const snapshot = {
  name: 'Test Character',
  stats: { critRate: 50, critDmg: 180, er: 120, em: 100 },
  weapon: { name: 'Test Sword', refinement: 1 },
  setCounts: {},
};
const guide = { weapons: ['Test Sword'], artifacts: [] };
const weaponData = {
  r1: {
    description: 'CRIT Rate is increased by 20%. Elemental Mastery is increased by 60. Energy Recharge is increased by 10%.',
  },
};
const effective = effectiveStatsForRating(snapshot, guide, { weaponData });
assert.equal(effective.effective.critRate, 70);
assert.equal(effective.effective.em, 160);
assert.equal(effective.effective.er, 130);
assert.equal(effective.sources.some((row) => /Test Sword passive/.test(row.source)), true);

const conditional = weaponPassiveBonuses(snapshot, guide, {
  r1: { description: 'After using an Elemental Skill, CRIT Rate is increased by 20% for 10s.' },
});
assert.equal(conditional.bonuses.critRate, 15, 'recommended conditional passive should use conservative expected uptime');

const blizzard = effectiveStatsForRating({
  ...snapshot,
  name: 'Ayaka',
  setCounts: { 'Blizzard Strayer': 4 },
}, { artifacts: ['4pc Blizzard Strayer'], weapons: ['Test Sword'] });
assert.equal(blizzard.effective.critRate, 70, 'Blizzard should count the conservative Cryo-affected 20% CRIT portion');

assert.equal(extractPassiveBonus('CRIT DMG is increased by 24%.', 'CRIT\\s*(?:DMG|Damage)', true, true), 24);

console.log('combatStats tests passed');
