'use strict';

const assert = require('node:assert/strict');
const {
  joinFloodState,
  accountAgeMs,
  isSuspiciousRaidJoin,
  raidActive,
  messageBurst,
  activeMark,
  markedAction,
  parseMark,
  constants,
} = require('./antiRaid');

const now = 1_800_000_000_000;
let joins = [];
for (let index = 0; index < constants.SHORT_JOIN_THRESHOLD - 1; index += 1) {
  const result = joinFloodState(joins, now + index * 500);
  joins = result.joins;
  assert.equal(result.triggered, false);
}
const threshold = joinFloodState(joins, now + (constants.SHORT_JOIN_THRESHOLD - 1) * 500);
assert.equal(threshold.triggered, true, 'short join flood should activate only at the configured threshold');

const oldMember = { user: { bot: false, createdTimestamp: now - 30 * 24 * 60 * 60 * 1000 } };
const youngMember = { user: { bot: false, createdTimestamp: now - 2 * 24 * 60 * 60 * 1000 } };
const botMember = { user: { bot: true, createdTimestamp: now - 365 * 24 * 60 * 60 * 1000 } };
assert.equal(isSuspiciousRaidJoin(oldMember, now), false, 'normal established account must be allowed during raid mode');
assert.equal(isSuspiciousRaidJoin(youngMember, now), true, 'very new account should be quarantined only during raid mode');
assert.equal(isSuspiciousRaidJoin(botMember, now), true, 'bot joins remain suspicious during an active raid');
assert.ok(accountAgeMs(oldMember, now) > constants.YOUNG_ACCOUNT_MS);

assert.equal(raidActive({ raidUntil: now + 1 }, now), true);
assert.equal(raidActive({ raidUntil: now }, now), false);

let burst = [];
for (let index = 0; index < constants.FLOOD_MESSAGE_THRESHOLD; index += 1) {
  const result = messageBurst(burst, now + index * 200);
  burst = result.times;
  if (index < constants.FLOOD_MESSAGE_THRESHOLD - 1) assert.equal(result.triggered, false);
  else assert.equal(result.triggered, true, 'message flood should trigger at threshold');
}

const firstMark = { expiresAt: now + constants.RAID_MARK_MS, strikes: 0 };
assert.equal(activeMark(firstMark, now), true);
assert.equal(markedAction(firstMark), 'timeout', 'first marked offense should timeout instead of kick');
assert.equal(markedAction({ ...firstMark, strikes: 1 }), 'kick', 'second marked offense should kick');
assert.equal(activeMark({ ...firstMark, expiresAt: now }, now), false);

const parsed = parseMark(`NLRAID2|mark|1537600000000000000|1537611111111111111|${now + constants.RAID_MARK_MS}|1`);
assert.deepEqual(parsed, {
  guildId: '1537600000000000000',
  userId: '1537611111111111111',
  expiresAt: now + constants.RAID_MARK_MS,
  strikes: 1,
});

assert.equal(constants.INITIAL_QUARANTINE_MS, 5 * 60 * 1000);
assert.equal(constants.ESCALATION_TIMEOUT_MS, 10 * 60 * 1000);
assert.equal(constants.RAID_MARK_MS, 30 * 60 * 1000);

console.log('anti-raid tests passed');
