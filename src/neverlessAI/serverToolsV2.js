'use strict';

const base = require('./serverTools');
const { getOrCreatePersonalInvite } = require('./safeActions');

const SAFE_TOOLS = [
  {
    type: 'function',
    name: 'get_personal_invite',
    description: 'Get or create the requesting member own tracked Neverless server invite, equivalent to the public #رابط command. Use when the user naturally asks for the server invite/link. This is a safe public action and must never be used for another member.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'get_server_info',
    description: 'Read basic Neverless server information such as server name, member count, boost tier and creation date. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const TOOL_DEFINITIONS = [...base.TOOL_DEFINITIONS, ...SAFE_TOOLS];

function createServerToolExecutor(context) {
  const baseExecutor = base.createServerToolExecutor(context);
  const { guild, requester, requestChannel } = context;

  return async function execute(name, args = {}) {
    if (name === 'get_personal_invite') {
      if (!guild || !requester || !requestChannel) return { error: 'NO_GUILD_CONTEXT' };
      return getOrCreatePersonalInvite({ guild, channel: requestChannel, member: requester });
    }

    if (name === 'get_server_info') {
      if (!guild || !requester) return { error: 'NO_GUILD_CONTEXT' };
      return {
        id: guild.id,
        name: guild.name,
        member_count: guild.memberCount,
        created_at: guild.createdAt?.toISOString?.() || null,
        boost_tier: guild.premiumTier ?? null,
        boost_count: guild.premiumSubscriptionCount ?? null,
      };
    }

    return baseExecutor(name, args);
  };
}

module.exports = {
  ...base,
  TOOL_DEFINITIONS,
  createServerToolExecutor,
};