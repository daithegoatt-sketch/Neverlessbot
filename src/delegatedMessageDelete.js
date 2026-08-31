'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const DATA_CHANNEL_NAME = 'neverless-data';
const MUTE_ADMIN_PREFIX = 'NLCFG1|muteadmin|';
const DELETE_ACCESS_PREFIX = 'NLCFG1|muteadmin-delete|';
const MAX_SCAN_MESSAGES = 5000;
const DELETE_CONTEXT_NAME = 'حذف الرسالة';

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
    state = { roleId: null, oldOwned: false, markerMessageId: null };
    states.set(String(guildId), state);
  }
  return state;
}

async function fetchRole(guild, roleId) {
  if (!roleId) return null;
  return guild.roles.cache.get(String(roleId))
    || await guild.roles.fetch(String(roleId)).catch(() => null);
}

async function removeLegacyManageMessages(guild, roleId, owned) {
  if (!owned || !roleId) return false;
  const role = await fetchRole(guild, roleId);
  if (!role || role.managed || !role.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles) || !role.editable) return false;
  await role.setPermissions(
    role.permissions.remove(PermissionFlagsBits.ManageMessages),
    'Neverless delegated deletion now enforces role hierarchy through message context menu',
  ).catch(() => {});
  return true;
}

async function persistMigratedAccess(guild, state) {
  const channel = dataChannel(guild);
  if (!channel || !state.roleId) return false;
  const content = `${DELETE_ACCESS_PREFIX}${guild.id}|${state.roleId}|0|${new Date().toISOString()}`;
  let message = state.markerMessageId
    ? await channel.messages.fetch(state.markerMessageId).catch(() => null)
    : null;
  if (message) await message.edit(content).catch(() => {});
  else {
    message = await channel.send(content).catch(() => null);
    if (message) state.markerMessageId = message.id;
  }
  return Boolean(message);
}

async function loadGuild(guild) {
  const state = stateFor(guild.id);
  const channel = dataChannel(guild);
  if (!channel) return;
  const messages = await fetchAllMessages(channel);
  let latestMute = null;
  let latestDelete = null;

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
  }

  if (!latestMute) return;
  state.roleId = latestMute.roleId;
  state.markerMessageId = latestDelete?.messageId || null;

  // Migrate away from native Manage Messages. Only remove the permission when
  // Neverless itself recorded that it added the permission previously.
  if (latestDelete?.owned && latestDelete.roleId) {
    await removeLegacyManageMessages(guild, latestDelete.roleId, true);
  }
  state.oldOwned = false;
  await persistMigratedAccess(guild, state).catch(() => false);
}

function memberHasDelegatedRole(member, roleId) {
  if (!member || !roleId) return false;
  return Boolean(member.roles?.cache?.has?.(String(roleId)));
}

function isRealAdministrator(member) {
  return Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

function canDelegatedDelete(actor, target, delegatedRoleId, ownerId) {
  if (!actor) return false;
  if (isRealAdministrator(actor)) return true;
  if (!memberHasDelegatedRole(actor, delegatedRoleId)) return false;
  if (!target) return true;
  if (target.id === actor.id) return true;
  if (target.id === ownerId || isRealAdministrator(target)) return false;
  const actorHighest = actor.roles?.highest;
  const targetHighest = target.roles?.highest;
  if (!actorHighest || !targetHighest) return false;
  if (typeof actorHighest.comparePositionTo === 'function') {
    return actorHighest.comparePositionTo(targetHighest) > 0;
  }
  return Number(actorHighest.position || 0) > Number(targetHighest.position || 0);
}

async function handleDeleteContext(interaction) {
  if (!interaction.isMessageContextMenuCommand?.() || interaction.commandName !== DELETE_CONTEXT_NAME || !interaction.guild) return false;
  const state = stateFor(interaction.guildId);
  const actor = interaction.member;
  if (!isRealAdministrator(actor) && !memberHasDelegatedRole(actor, state.roleId)) {
    await interaction.reply({ content: 'هذه الخاصية مخصصة للرتبة المخولة عبر `/addadmin`.', ephemeral: true });
    return true;
  }

  const message = interaction.targetMessage;
  if (!message) {
    await interaction.reply({ content: 'ما قدرت أحدد الرسالة.', ephemeral: true });
    return true;
  }

  let target = null;
  if (message.author?.id) {
    target = interaction.guild.members.cache.get(message.author.id)
      || await interaction.guild.members.fetch(message.author.id).catch(() => null);
  }

  if (!canDelegatedDelete(actor, target, state.roleId, interaction.guild.ownerId)) {
    await interaction.reply({
      content: 'ما تقدر تحذف رسالة عضو رتبته مساوية أو أعلى من رتبتك.',
      ephemeral: true,
    });
    return true;
  }

  if (!message.deletable) {
    await interaction.reply({
      content: 'البوت ما يقدر يحذف هذه الرسالة. تأكد أن عنده **Manage Messages** في هذا الروم.',
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await message.delete();
    await interaction.editReply('تم حذف الرسالة.');
  } catch {
    await interaction.editReply('ما قدرت أحذف الرسالة.').catch(() => {});
  }
  return true;
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
  if (state.roleId && state.roleId !== role.id && state.oldOwned) {
    await removeLegacyManageMessages(interaction.guild, state.roleId, true);
  }
  state.roleId = role.id;
  state.oldOwned = false;
  await persistMigratedAccess(interaction.guild, state).catch(() => false);

  await waitForInteractionReply(interaction);
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({
      content: `تم تحديد ${role} كرتبة مخولة بـ **/mute** و **/unmute** وحذف رسائل الأعضاء الأقل رتبة عبر الضغط على الرسالة → **Apps** → **${DELETE_CONTEXT_NAME}**.`,
      allowedMentions: { roles: [] },
    }).catch(() => {});
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
    if (interaction.isMessageContextMenuCommand?.()) {
      handleDeleteContext(interaction).catch((error) => {
        console.warn('[delegated-delete] context delete failed:', error.message);
        if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
          interaction.reply({ content: 'صار خطأ أثناء حذف الرسالة.', ephemeral: true }).catch(() => {});
        }
      });
      return;
    }
    handleAddAdmin(interaction).catch((error) => console.warn('[delegated-delete] addadmin failed:', error.message));
  });
}

module.exports = {
  installDelegatedMessageDelete,
  parseMuteAdmin,
  parseDeleteAccess,
  canDelegatedDelete,
  memberHasDelegatedRole,
  DELETE_CONTEXT_NAME,
};
