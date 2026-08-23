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
  detectUsedInvite,
  nextInviteCache,
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

function invite(code, uses, inviterId) {
  return { code, uses, inviter: { id: inviterId }, maxUses: 0 };
}

const before = new Map([
  ['alpha', { code: 'alpha', uses: 10, inviterId: '111111111111111111', maxUses: 0 }],
  ['beta', { code: 'beta', uses: 5, inviterId: '222222222222222222', maxUses: 0 }],
]);
const current = new Map([
  ['alpha', invite('alpha', 12, '111111111111111111')],
  ['beta', invite('beta', 6, '222222222222222222')],
]);

const firstJoin = detectUsedInvite(before, current);
assert.equal(firstJoin.code, 'alpha');
assert.equal(firstJoin.delta, 2);

const afterFirstJoin = nextInviteCache(before, current, firstJoin);
assert.equal(afterFirstJoin.get('alpha').uses, 11);
assert.equal(afterFirstJoin.get('beta').uses, 5);

const secondJoin = detectUsedInvite(afterFirstJoin, current);
assert.equal(secondJoin.code, 'alpha');
assert.equal(secondJoin.delta, 1);

const afterSecondJoin = nextInviteCache(afterFirstJoin, current, secondJoin);
assert.equal(afterSecondJoin.get('alpha').uses, 12);
assert.equal(afterSecondJoin.get('beta').uses, 5);

const thirdJoin = detectUsedInvite(afterSecondJoin, current);
assert.equal(thirdJoin.code, 'beta');
assert.equal(thirdJoin.delta, 1);

console.log('activity v2 tests passed');
