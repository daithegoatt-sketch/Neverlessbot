'use strict';

const {
  personalInviteOwner,
  whenPersonalInvitesReady,
} = require('../serverTools');

const DATA_CHANNEL_NAME = 'neverless-data';
const PERSONAL_INVITE_PREFIX = 'NLPINV1|';
const aiOwnerByCode = new Map();
const aiCodeByOwner = new Map();

function ownerKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function codeKey(guildId, code) {
  return `${guildId}:${code}`;
}

function applyOwner(guild, invite) {
  if (!invite?.code) return invite;
  const ownerId = aiOwnerByCode.get(codeKey(guild.id, invite.code));
  if (!ownerId) return invite;
  const owner = guild.client.users.cache.get(ownerId) || { id: ownerId };
  try {
    Object.defineProperty(invite, 'inviter', {
      value: owner,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch {
    try { invite.inviter = owner; } catch {}
  }
  return invite;
}

function patchInviteFetch(guild) {
  const manager = guild?.invites;
  if (!manager || manager.__neverlessAiInvitePatched) return;
  const originalFetch = manager.fetch.bind(manager);
  manager.fetch = async (...args) => {
    const result = await originalFetch(...args);
    if (result?.values && typeof result.values === 'function') {
      for (const invite of result.values()) applyOwner(guild, invite);
    } else if (result?.code) {
      applyOwner(guild, result);
    }
    return result;
  };
  try {
    Object.defineProperty(manager, '__neverlessAiInvitePatched', { value: true, configurable: true });
  } catch {
    manager.__neverlessAiInvitePatched = true;
  }
}

async function persistAiInvite(guild, code, userId) {
  const dataChannel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  const updatedAt = new Date().toISOString();
  if (dataChannel) {
    await dataChannel.send(`${PERSONAL_INVITE_PREFIX}${guild.id}|${code}|${userId}|${updatedAt}`).catch(() => {});
  }
  aiOwnerByCode.set(codeKey(guild.id, code), String(userId));
  aiCodeByOwner.set(ownerKey(guild.id, userId), code);
}

async function findExistingInvite(guild, userId) {
  await whenPersonalInvitesReady().catch(() => {});
  patchInviteFetch(guild);
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites?.values) return null;

  const aiCode = aiCodeByOwner.get(ownerKey(guild.id, userId));
  if (aiCode && invites.has(aiCode)) return invites.get(aiCode);

  for (const invite of invites.values()) {
    if (personalInviteOwner(guild.id, invite.code) === String(userId)) return invite;
    if (aiOwnerByCode.get(codeKey(guild.id, invite.code)) === String(userId)) return invite;
  }
  return null;
}

async function getOrCreatePersonalInvite({ guild, channel, member }) {
  if (!guild || !channel || !member || member.user?.bot) return { error: 'INVALID_CONTEXT' };
  if (!channel?.createInvite) return { error: 'CHANNEL_CANNOT_CREATE_INVITE' };

  const existing = await findExistingInvite(guild, member.id);
  if (existing?.code) {
    return {
      url: `https://discord.gg/${existing.code}`,
      code: existing.code,
      reused: true,
      tracked_for_member: true,
    };
  }

  const invite = await channel.createInvite({
    maxAge: 0,
    maxUses: 0,
    unique: true,
    reason: `Neverless AI personal invite for ${member.user?.tag || member.id} (${member.id})`,
  }).catch(() => null);
  if (!invite?.code) return { error: 'CREATE_INVITE_FAILED' };

  await persistAiInvite(guild, invite.code, member.id);
  patchInviteFetch(guild);
  applyOwner(guild, invite);
  return {
    url: `https://discord.gg/${invite.code}`,
    code: invite.code,
    reused: false,
    tracked_for_member: true,
  };
}

module.exports = {
  getOrCreatePersonalInvite,
  patchInviteFetch,
};