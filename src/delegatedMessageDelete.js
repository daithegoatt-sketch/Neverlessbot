'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const DATA_CHANNEL_NAME = 'neverless-data';
const MUTE_ADMIN_PREFIX = 'NLCFG1|muteadmin|';
const DELETE_ACCESS_PREFIX = 'NLCFG1|muteadmin-delete|';
const LINK_CONFIG_PREFIX = 'NLCFG1|links|';
const MAX_SCAN_MESSAGES = 5000;

const states = new Map();
let installed = false;

function parseMuteAdmin(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(MUTE_ADMIN_PREFIX)) return null;
  const [guildId, roleId] = value.slice(MUTE_ADMIN_PREFIX.length).split('|');
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(roleId || '')) return null;
  return { guildId, roleId };
}

function parseDeleteAccess(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(DELETE_ACCESS_PREFIX)) return null;
  const [guildId, roleId, owned, updatedAt] = value.slice(DELETE_ACCESS_PREFIX.length).split('|');
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(roleId || '')) return null;
  if (!['0', '1'].includes(owned)) return null;
  return { guildId, roleId, owned: owned === '1', updatedAt: updatedAt || null };
}

function parseLinks(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(LINK_CONFIG_PREFIX)) return null;
  const rest = value.slice(LINK_CONFIG_PREFIX.length);
  const split = rest.indexOf('|');
  if (split < 0) return null;
  const guildId = rest.slice(0, split);
  if (!/^\d{15,22}$/.test(guildId || '')) return null;
  const ids = rest.slice(split + 1)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d{15,22}$/.test(item));
  return { guildId, ids };
}

function dataChannel(guild) {
  return guild?.channels?.cache?.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name === DATA_CHANNEL_NAME,
  ) || null;
}

async function fetchAllMessages(channel) {
  const out = [];
  let before;
  while (out.length < MAX_SCAN_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return out;
}

function stateFor(guildId) {
  let state = states.get(String(guildId));
  if (!state) {
    state = {
      roleId: null,
      owned: false,
      markerMessageId: null,
      allowedLinks: new Set(),
    };
    states.set(String(guildId), state);
  }
  return state;
}

async function persistDeleteAccess(guild, state) {
  const channel = dataChannel(guild);
  if (!channel || !state.roleId) return false;
  const content = `${DELETE_ACCESS_PREFIX}${guild.id}|${state.roleId}|${state.owned ? '1' : '0'}|${new Date().toISOString()}`;
  let message = state.markerMessageId
    ? await channel.messages.fetch(state.markerMessageId).catch(() => null)
    : null;
  if (message) await message.edit(content);
  else {
    message = await channel.send(content);
    state.markerMessageId = message.id;
  }
  return true;
}

async function fetchRole(guild, roleId) {
  if (!roleId) return null;
  return guild.roles.cache.get(String(roleId))
    || await guild.roles.fetch(String(roleId)).catch(() => null);
}

async function addManageMessages(guild, role, previousOwned = false) {
  if (!role || role.managed) return { ok: false, owned: previousOwned, reason: 'managed' };
  if (role.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return { ok: true, owned: Boolean(previousOwned) };
  }
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
    return { ok: false, owned: previousOwned, reason: 'hierarchy' };
  }
  await role.setPermissions(
    role.permissions.add(PermissionFlagsBits.ManageMessages),
    'Neverless delegated admin: native message deletion',
  );
  return { ok: true, owned: true };
}

async function removeOwnedManageMessages(guild, roleId, owned) {
  if (!owned || !roleId) return;
  const role = await fetchRole(guild, roleId);
  if (!role || role.managed || !role.permissions.has(PermissionFlagsBits.ManageMessages)) return;
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles) || !role.editable) return;
  await role.setPermissions(
    role.permissions.remove(PermissionFlagsBits.ManageMessages),
    'Neverless delegated admin role replaced',
  ).catch(() => {});
}

async function loadGuild(guild) {
  const state = stateFor(guild.id);
  const channel = dataChannel(guild);
  if (!channel) return;
  const messages = await fetchAllMessages(channel);
  let latestMute = null;
  let latestDelete = null;
  let latestLinks = null;

  for (const message of messages) {
    if (message.author?.id !== guild.members.me?.id) continue;
    const mute = parseMuteAdmin(message.content);
    if (mute?.guildId === guild.id && (!latestMute || message.createdTimestamp > latestMute.createdTimestamp)) {
      latestMute = { ...mute, createdTimestamp: message.createdTimestamp };
    }
    const access = parseDeleteAccess(message.content);
    if (access?.guildId === guild.id && (!latestDelete || message.createdTimestamp > latestDelete.createdTimestamp)) {
      latestDelete = { ...access, messageId: message.id, createdTimestamp: message.createdTimestamp };
    }
    const links = parseLinks(message.content);
    if (links?.guildId === guild.id && (!latestLinks || message.createdTimestamp > latestLinks.createdTimestamp)) {
      latestLinks = { ...links, createdTimestamp: message.createdTimestamp };
    }
  }

  state.allowedLinks = new Set(latestLinks?.ids || []);
  if (!latestMute) return;

  if (latestDelete?.roleId && latestDelete.roleId !== latestMute.roleId && latestDelete.owned) {
    await removeOwnedManageMessages(guild, latestDelete.roleId, true);
  }

  state.roleId = latestMute.roleId;
  state.owned = latestDelete?.roleId === state.roleId ? Boolean(latestDelete.owned) : false;
  state.markerMessageId = latestDelete?.messageId || null;

  const role = await fetchRole(guild, state.roleId);
  const result = await addManageMessages(guild, role, state.owned);
  if (result.ok) {
    state.owned = result.owned;
    await persistDeleteAccess(guild, state).catch(() => false);
  } else {
    console.warn(`[delegated-delete] Could not add Manage Messages to role ${state.roleId} in ${guild.name}. Check Manage Roles and role hierarchy.`);
  }
}

function hasExternalLink(content) {
  return /(?:https?:\/\/|www\.)\S+|(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/iu.test(String(content || ''));
}

function hasIndependentManageMessages(member, delegatedRoleId) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles?.cache?.some?.((role) =>
    role.id !== delegatedRoleId && role.permissions?.has?.(PermissionFlagsBits.ManageMessages)) || false;
}

async function preserveLinkFilter(message) {
  if (!message?.guildId || message.author?.bot || !hasExternalLink(message.content)) return;
  if (message.channel?.name === DATA_CHANNEL_NAME) return;
  const state = states.get(message.guildId);
  if (!state?.roleId || !state.owned || !message.member?.roles?.cache?.has?.(state.roleId)) return;
  if (hasIndependentManageMessages(message.member, state.roleId)) return;
  if (state.allowedLinks.has(message.channelId)) return;
  await message.delete().catch(() => {});
}

async function waitForInteractionReply(interaction, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (interaction.replied || interaction.deferred) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function handleAddAdmin(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'addadmin' || !interaction.guild) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return;
  const role = interaction.options.getRole('role');
  if (!role || role.id === interaction.guild.id || role.managed) return;

  const state = stateFor(interaction.guildId);
  const oldRoleId = state.roleId;
  const oldOwned = state.owned;
  const result = await addManageMessages(interaction.guild, role, oldRoleId === role.id ? oldOwned : false);
  if (!result.ok) {
    await waitForInteractionReply(interaction);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: 'تم حفظ رتبة الميوت، لكن ما قدرت أعطيها **Manage Messages**. ارفع رتبة البوت فوقها وتأكد أن عنده **Manage Roles** ثم نفّذ `/addadmin` مرة ثانية.',
        ephemeral: true,
      }).catch(() => {});
    }
    return;
  }

  if (oldRoleId && oldRoleId !== role.id) {
    await removeOwnedManageMessages(interaction.guild, oldRoleId, oldOwned);
  }

  state.roleId = role.id;
  state.owned = result.owned;
  await persistDeleteAccess(interaction.guild, state).catch(() => false);

  await waitForInteractionReply(interaction);
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({
      content: `تم تحديد ${role} كرتبة مخولة بـ **/mute** و **/unmute**، وتقدر تحذف الرسائل يدويًا من Discord.`,
      allowedMentions: { roles: [] },
    }).catch(() => {});
  }
}

function handleLinksInteraction(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'links' || !interaction.guild) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return;
  const state = stateFor(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  if (sub === 'allow') {
    const channel = interaction.options.getChannel('channel');
    if (channel) state.allowedLinks.add(channel.id);
  } else if (sub === 'remove') {
    const channel = interaction.options.getChannel('channel');
    if (channel) state.allowedLinks.delete(channel.id);
  }
}

function installDelegatedMessageDelete(client) {
  if (installed) return;
  installed = true;

  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      await loadGuild(guild).catch((error) => console.warn('[delegated-delete] load failed:', error.message));
    }
  });
  client.on('guildCreate', (guild) => loadGuild(guild).catch(() => {}));
  client.on('interactionCreate', (interaction) => {
    handleLinksInteraction(interaction);
    handleAddAdmin(interaction).catch((error) => console.warn('[delegated-delete] addadmin failed:', error.message));
  });
  client.on('messageCreate', (message) => preserveLinkFilter(message).catch(() => {}));
}

module.exports = {
  installDelegatedMessageDelete,
  parseMuteAdmin,
  parseDeleteAccess,
  parseLinks,
  hasExternalLink,
  hasIndependentManageMessages,
};
