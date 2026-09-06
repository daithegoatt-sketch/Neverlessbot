'use strict';

const assert = require('node:assert/strict');
const {
  claimCustomId,
  messageClaimCustomId,
  isSecretClaimChannel,
} = require('./hiddenAchievementGuard');

const payload = {
  components: [{
    components: [{ data: { custom_id: 'hidden:claim:message500:123456789012345678' } }],
  }],
};
assert.equal(claimCustomId(payload), 'hidden:claim:message500:123456789012345678');
assert.equal(claimCustomId({ components: [] }), null);

const message = {
  components: [{ components: [{ customId: 'hidden:claim:streak7:123456789012345678' }] }],
};
assert.equal(messageClaimCustomId(message), 'hidden:claim:streak7:123456789012345678');
assert.equal(isSecretClaimChannel({ guildId: '1', topic: 'neverless-hidden-owner:123' }), true);
assert.equal(isSecretClaimChannel({ guildId: '1', topic: 'other' }), false);

console.log('hidden achievement guard tests passed');
