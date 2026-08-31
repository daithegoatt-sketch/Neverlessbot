'use strict';

const assert = require('node:assert/strict');
const {
  parseMuteAdmin,
  parseDeleteAccess,
  parseLinks,
  hasExternalLink,
  hasIndependentManageMessages,
} = require('./delegatedMessageDelete');
const { PermissionFlagsBits } = require('discord.js');

assert.deepEqual(
  parseMuteAdmin('NLCFG1|muteadmin|1537000000000000000|1537111111111111111'),
  { guildId: '1537000000000000000', roleId: '1537111111111111111' },
);
assert.equal(parseMuteAdmin('NLCFG1|muteadmin|bad|role'), null);

const access = parseDeleteAccess('NLCFG1|muteadmin-delete|1537000000000000000|1537111111111111111|1|2026-08-31T15:00:00.000Z');
assert.equal(access.guildId, '1537000000000000000');
assert.equal(access.roleId, '1537111111111111111');
assert.equal(access.owned, true);

assert.deepEqual(
  parseLinks('NLCFG1|links|1537000000000000000|1537222222222222222,1537333333333333333').ids,
  ['1537222222222222222', '1537333333333333333'],
);
assert.equal(hasExternalLink('hello https://example.com'), true);
assert.equal(hasExternalLink('hello world'), false);

const delegatedId = '1537111111111111111';
const delegatedRole = {
  id: delegatedId,
  permissions: { has: (permission) => permission === PermissionFlagsBits.ManageMessages },
};
const normalRole = {
  id: '1537444444444444444',
  permissions: { has: () => false },
};
const member = {
  permissions: { has: () => false },
  roles: { cache: new Map([[delegatedRole.id, delegatedRole], [normalRole.id, normalRole]]) },
};
assert.equal(hasIndependentManageMessages(member, delegatedId), false);

console.log('delegated message delete tests passed');
