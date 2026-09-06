'use strict';

const assert = require('node:assert/strict');
const {
  kuwaitDay,
  advanceStreak,
  levelFromXp,
  xpForLevel,
  standardAchievementIds,
  parseHiddenCommand,
  parseClaimCustomId,
  qualifiesForDailyActivity,
} = require('./hiddenAchievements');

assert.equal(kuwaitDay(Date.UTC(2026, 8, 6, 22, 30)), '2026-09-07');
assert.equal(levelFromXp(xpForLevel(20)), 20);
assert.equal(levelFromXp(xpForLevel(20) - 1), 19);

const record = { lastActiveDay: '', currentStreak: 0, bestStreak: 0, activeDays: 0, voiceMs: 0 };
assert.equal(advanceStreak(record, '2026-09-01'), true);
assert.equal(record.currentStreak, 1);
assert.equal(record.activeDays, 1);
assert.equal(advanceStreak(record, '2026-09-01'), false);
assert.equal(record.activeDays, 1);
assert.equal(advanceStreak(record, '2026-09-02'), true);
assert.equal(record.currentStreak, 2);
assert.equal(record.bestStreak, 2);
assert.equal(advanceStreak(record, '2026-09-04'), true);
assert.equal(record.currentStreak, 1);
assert.equal(record.bestStreak, 2);

const achievements = standardAchievementIds({ bestStreak: 14, activeDays: 45, voiceMs: 400 * 60_000 }, 10_000);
assert.ok(achievements.includes('message500'));
assert.ok(achievements.includes('message1000'));
assert.ok(achievements.includes('streak7'));
assert.ok(achievements.includes('streak14'));
assert.ok(!achievements.includes('streak30'));
assert.ok(achievements.includes('voice400'));
assert.ok(!achievements.includes('voice1200'));
assert.ok(achievements.includes('active45'));

assert.deepEqual(parseHiddenCommand('-hidden'), { type: 'about' });
assert.deepEqual(parseHiddenCommand('-hidden stats'), { type: 'stats' });
assert.deepEqual(parseHiddenCommand('-مخفي بطاقتي'), { type: 'card' });
assert.equal(parseHiddenCommand('hidden'), null);

assert.deepEqual(parseClaimCustomId('hidden:claim:streak7:123456789012345678'), {
  achievementId: 'streak7',
  userId: '123456789012345678',
});
assert.equal(parseClaimCustomId('hidden:claim:nope:123456789012345678'), null);

assert.equal(qualifiesForDailyActivity({ guildId: '1', author: { bot: false }, system: false, content: 'hello', attachments: { size: 0 }, stickers: { size: 0 } }), true);
assert.equal(qualifiesForDailyActivity({ guildId: '1', author: { bot: false }, system: false, content: '-hidden', attachments: { size: 0 }, stickers: { size: 0 } }), false);
assert.equal(qualifiesForDailyActivity({ guildId: '1', author: { bot: false }, system: false, content: 'hi', attachments: { size: 0 }, stickers: { size: 0 } }), false);

console.log('hidden achievement tests passed');
