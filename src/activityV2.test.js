'use strict';

const assert = require('node:assert/strict');
const {
  levelFromXp,
  xpForNextLevel,
  xpRemainingForNextLevel,
  periodKeys,
  parsePeriod,
  isInviteTopCommand,
  isSelfInviteCommand,
  isMemberInviteCommand,
  isActivityTopCommand,
} = require('./activityV2');

assert.equal(levelFromXp(0), 0);
assert.equal(levelFromXp(99), 0);
assert.equal(levelFromXp(100), 1);
assert.equal(levelFromXp(300), 2);
assert.equal(xpForNextLevel(2), 600);
assert.equal(xpRemainingForNextLevel(420), 180);

assert.equal(parsePeriod('#توب اليوم'), 'daily');
assert.equal(parsePeriod('توب الاسبوع'), 'weekly');
assert.equal(parsePeriod('#top monthly'), 'monthly');
assert.equal(parsePeriod('top'), 'all');

assert.equal(isActivityTopCommand('#توب'), true);
assert.equal(isActivityTopCommand('#top daily'), true);
assert.equal(isActivityTopCommand('توب دعوات'), false);
assert.equal(isActivityTopCommand('top invites'), false);

assert.equal(isInviteTopCommand('#توب دعوات'), true);
assert.equal(isInviteTopCommand('top invites'), true);
assert.equal(isInviteTopCommand('#top'), false);

assert.equal(isSelfInviteCommand('دعواتي'), true);
assert.equal(isSelfInviteCommand('#دعواتي'), true);
assert.equal(isSelfInviteCommand('my invites'), true);
assert.equal(isSelfInviteCommand('#my invites'), true);
assert.equal(isSelfInviteCommand('invites'), false);

assert.equal(isMemberInviteCommand('دعوات <@123456789012345678>'), true);
assert.equal(isMemberInviteCommand('#invites <@123456789012345678>'), true);
assert.equal(isMemberInviteCommand('my invites'), false);

const keys = periodKeys(Date.UTC(2026, 7, 16, 21, 0, 0));
assert.equal(keys.day, '2026-08-17');
assert.equal(keys.month, '2026-08');

console.log('activity v2 tests passed');
