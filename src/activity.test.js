'use strict';

const assert = require('node:assert/strict');
const {
  levelFromXp,
  periodKeys,
  parsePeriod,
  isTopCommand,
  isInviteCommand,
} = require('./activity');

assert.equal(levelFromXp(0), 0);
assert.equal(levelFromXp(99), 0);
assert.equal(levelFromXp(100), 1);
assert.equal(levelFromXp(299), 1);
assert.equal(levelFromXp(300), 2);
assert.equal(levelFromXp(5500), 10);

assert.equal(parsePeriod('#توب اليوم'), 'daily');
assert.equal(parsePeriod('#توب أسبوعي'), 'weekly');
assert.equal(parsePeriod('top monthly'), 'monthly');
assert.equal(parsePeriod('#top'), 'all');

assert.equal(isTopCommand('#توب'), true);
assert.equal(isTopCommand('top weekly'), true);
assert.equal(isTopCommand('ترتيب Skirk'), false);
assert.equal(isInviteCommand('#دعواتي'), true);
assert.equal(isInviteCommand('دعوات <@123456789012345678>'), true);
assert.equal(isInviteCommand('#invites'), true);

// 2026-08-16 21:00 UTC = 2026-08-17 00:00 in Kuwait.
const keys = periodKeys(Date.UTC(2026, 7, 16, 21, 0, 0));
assert.equal(keys.day, '2026-08-17');
assert.equal(keys.month, '2026-08');

console.log('activity tests passed');
