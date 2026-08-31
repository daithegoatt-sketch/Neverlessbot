'use strict';

const assert = require('node:assert/strict');
const {
  parseHallRecord,
  currentContent,
  championContent,
  formatHoldDuration,
  safeTopBuilds,
  isHallCommand,
} = require('./achievementHall');
const {
  isNeverlessFlexCommand,
  stripBotMention,
  roleMembershipChanged,
} = require('./achievementHallRuntime');

const guildId = '1537000000000000000';
const userId = '1537111111111111111';
const current = {
  userId,
  startedAt: 1000,
  score: 96.4,
  peakScore: 97.1,
  averageBuild: 95.8,
  topBuilds: [
    { name: 'Skirk', score: 98 },
    { name: 'Furina', score: 96 },
    { name: 'Nahida', score: 95 },
  ],
};

const parsedCurrent = parseHallRecord(currentContent(guildId, current, '2026-08-31T10:00:00.000Z'));
assert.equal(parsedCurrent.type, 'current');
assert.equal(parsedCurrent.guildId, guildId);
assert.equal(parsedCurrent.current.userId, userId);
assert.equal(parsedCurrent.current.score, 96.4);
assert.equal(parsedCurrent.current.topBuilds.length, 3);

const champion = {
  userId,
  firstAt: 1000,
  lastStartedAt: 2000,
  totalMs: 7200000,
  peakScore: 97.1,
  reigns: 2,
};
const parsedChampion = parseHallRecord(championContent(guildId, champion, '2026-08-31T10:00:00.000Z'));
assert.equal(parsedChampion.type, 'champ');
assert.equal(parsedChampion.champion.reigns, 2);
assert.equal(parsedChampion.champion.peakScore, 97.1);

assert.equal(formatHoldDuration(90 * 60 * 1000), '1h 30m');
assert.equal(formatHoldDuration(2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000), '2d 3h');

const builds = safeTopBuilds([
  { name: 'A', score: 90, rankingScore: 90.2 },
  { name: 'B', score: 95, rankingScore: 95.1 },
  { name: 'C', score: 92, rankingScore: 92.4 },
  { name: 'D', score: 80, rankingScore: 80.1 },
]);
assert.deepEqual(builds.map((row) => row.name), ['B', 'C', 'A']);

assert.equal(isHallCommand('Hall of fame'), true);
assert.equal(isHallCommand('قاعة الأبطال'), true);
assert.equal(isHallCommand('قاعه الابطال'), true);
assert.equal(isHallCommand('hall'), false);

assert.equal(isNeverlessFlexCommand('-flex neverless'), true);
assert.equal(isNeverlessFlexCommand('-فلكس Neverless'), true);
assert.equal(isNeverlessFlexCommand('-فليكس neverless'), true);
assert.equal(isNeverlessFlexCommand('flex neverless'), false);

const fakeClient = { user: { id: '1537222222222222222' } };
assert.equal(stripBotMention('<@1537222222222222222> Hall of fame', fakeClient), 'Hall of fame');

const oldMember = { roles: { cache: new Map([['1', { name: 'Member' }]]) } };
const newMember = { roles: { cache: new Map([['1', { name: 'Member' }], ['2', { name: 'Top Neverless' }]]) } };
assert.equal(roleMembershipChanged(oldMember, newMember), true);
assert.equal(roleMembershipChanged(newMember, newMember), false);

console.log('achievement Hall tests passed');
