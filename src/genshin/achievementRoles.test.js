'use strict';

const assert = require('node:assert/strict');
const {
  chooseCharacterWinner,
  chooseAccountWinner,
  safeRoleName,
} = require('./achievementRoles');

const characterWinner = chooseCharacterWinner([
  { discordUserId: '1', score: 92, akasha: { topPercent: 5 }, artifactQuality: 600 },
  { discordUserId: '2', score: 94, akasha: { topPercent: 20 }, artifactQuality: 500 },
  { discordUserId: '3', score: 94, akasha: { topPercent: 8 }, artifactQuality: 450 },
]);
assert.equal(characterWinner.discordUserId, '3');

const characterTie = chooseCharacterWinner([
  { discordUserId: '1', score: 94, akasha: { topPercent: 8 }, artifactQuality: 450 },
  { discordUserId: '2', score: 94, akasha: { topPercent: 8 }, artifactQuality: 610 },
]);
assert.equal(characterTie.discordUserId, '2');

const accountWinner = chooseAccountWinner([
  { discordUserId: '1', accountScore: 91.2, averageBuild: 90 },
  { discordUserId: '2', accountScore: 92.1, averageBuild: 88 },
  { discordUserId: '3', accountScore: 92.1, averageBuild: 91 },
]);
assert.equal(accountWinner.discordUserId, '3');

assert.equal(safeRoleName('Skirk'), 'Top Skirk');
assert.equal(safeRoleName('Neverless'), 'Top Neverless');

console.log('achievementRoles tests passed');
