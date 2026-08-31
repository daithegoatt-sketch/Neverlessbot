'use strict';

const assert = require('node:assert/strict');
const {
  parseMuteAdmin,
  parseDeleteAccess,
  canDelegatedDelete,
} = require('./delegatedMessageDelete');

assert.deepEqual(
  parseMuteAdmin('NLCFG1|muteadmin|1537000000000000000|1537111111111111111'),
  { guildId: '1537000000000000000', roleId: '1537111111111111111' },
);
assert.equal(parseMuteAdmin('NLCFG1|muteadmin|bad|role'), null);

const access = parseDeleteAccess('NLCFG1|muteadmin-delete|1537000000000000000|1537111111111111111|1|2026-08-31T15:00:00.000Z');
assert.equal(access.guildId, '1537000000000000000');
assert.equal(access.roleId, '1537111111111111111');
assert.equal(access.owned, true);

function member(id, position, roleId = null, admin = false) {
  return {
    id,
    permissions: { has: () => admin },
    roles: {
      cache: { has: (value) => value === roleId },
      highest: { position, comparePositionTo: (other) => position - other.position },
    },
  };
}

const delegatedRoleId = '1537111111111111111';
const actor = member('actor', 10, delegatedRoleId);
assert.equal(canDelegatedDelete(actor, member('lower', 5), delegatedRoleId, 'owner'), true);
assert.equal(canDelegatedDelete(actor, member('equal', 10), delegatedRoleId, 'owner'), false);
assert.equal(canDelegatedDelete(actor, member('higher', 11), delegatedRoleId, 'owner'), false);
assert.equal(canDelegatedDelete(actor, member('owner', 1), delegatedRoleId, 'owner'), false);
assert.equal(canDelegatedDelete(actor, null, delegatedRoleId, 'owner'), true);
assert.equal(canDelegatedDelete(member('outsider', 20), member('lower', 5), delegatedRoleId, 'owner'), false);
assert.equal(canDelegatedDelete(member('realadmin', 1, null, true), member('higher', 99), delegatedRoleId, 'owner'), true);

console.log('delegated message delete tests passed');
