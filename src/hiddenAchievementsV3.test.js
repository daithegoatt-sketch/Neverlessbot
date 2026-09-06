'use strict';

const assert = require('node:assert/strict');
const {
  compactUser,
  expandUser,
  kuwaitDay,
  advanceStreak,
  levelFromXp,
  xpForLevel,
  standardAchievementIds,
  parseHiddenCommand,
  parseClaimCustomId,
  qualifiesForDailyActivity,
} = require('./hiddenAchievementsV3');

assert.equal(kuwaitDay(Date.UTC(2026, 8, 6, 22, 30)), '2026-09-07');
assert.equal(levelFromXp(xpForLevel(20)), 20);
assert.equal(levelFromXp(xpForLevel(20) - 1), 19);

const record = { lastActiveDay: '', currentStreak: 0, bestStreak: 0, activeDays: 0, voiceMs: 0 };
assert.equal(advanceStreak(record, '2026-09-01'), true);
assert.equal(advanceStreak(record, '2026-09-01'), false);
assert.equal(advanceStreak(record, '2026-09-02'), true);
assert.equal(record.currentStreak, 2);
assert.equal(record.bestStreak, 2);
assert.equal(record.activeDays, 2);
assert.equal(advanceStreak(record, '2026-09-04'), true);
assert.equal(record.currentStreak, 1);
assert.equal(record.bestStreak, 2);

const ids = standardAchievementIds({ bestStreak: 14, activeDays: 45, voiceMs: 400 * 60_000 }, 10_000);
assert.ok(ids.includes('message500'));
assert.ok(ids.includes('message1000'));
assert.ok(ids.includes('streak7'));
assert.ok(ids.includes('streak14'));
assert.ok(!ids.includes('streak30'));
assert.ok(ids.includes('voice400'));
assert.ok(!ids.includes('voice1200'));
assert.ok(ids.includes('active45'));

const compact = compactUser({
  lastActiveDay: '2026-09-07', currentStreak: 7, bestStreak: 7, activeDays: 7, voiceMs: 12345,
  roomId: '123456789012345678', updatedAt: '2026-09-07T00:00:00.000Z',
  achievements: { streak7: { unlockedAt: '2026-09-07T00:00:00.000Z', claimedAt: null, messageId: '223456789012345678' } },
});
const expanded = expandUser(compact);
assert.equal(expanded.currentStreak, 7);
assert.equal(expanded.achievements.streak7.messageId, '223456789012345678');
assert.ok(Buffer.from(JSON.stringify(compact)).length < 700);

assert.deepEqual(parseHiddenCommand('-hidden'), { type: 'about' });
assert.deepEqual(parseHiddenCommand('-hidden stats'), { type: 'stats' });
assert.deepEqual(parseHiddenCommand('-مخفي بطاقتي'), { type: 'card' });
assert.equal(parseHiddenCommand('hidden'), null);
assert.deepEqual(parseClaimCustomId('hidden:claim:streak7:123456789012345678'), { achievementId: 'streak7', userId: '123456789012345678' });
assert.equal(parseClaimCustomId('hidden:claim:nope:123456789012345678'), null);

assert.equal(qualifiesForDailyActivity({ guildId: '1', author: { bot: false }, system: false, content: 'hello', attachments: { size: 0 }, stickers: { size: 0 } }), true);
assert.equal(qualifiesForDailyActivity({ guildId: '1', author: { bot: false }, system: false, content: '-hidden', attachments: { size: 0 }, stickers: { size: 0 } }), false);
assert.equal(qualifiesForDailyActivity({ guildId: '1', author: { bot: false }, system: false, content: 'hi', attachments: { size: 0 }, stickers: { size: 0 } }), false);

console.log('hidden achievement V3 tests passed');
