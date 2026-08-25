'use strict';

const {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { whenAccountStoreReady, getAllLinkedUsers, unlinkUid } = require('./genshin/accountStore');
const { clearLeaderboardCache } = require('./genshin/leaderboard');

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '1538557238627672164';
const DATA_CHANNEL_NAME = 'neverless-data';
const LINK_CONFIG_PREFIX = 'NLCFG1|links|';
const MUTE_ADMIN_CONFIG_PREFIX = 'NLCFG1|muteadmin|';
const TIMER_PREFIX = 'NLMOD1|';
const INDEFINITE_TIMEOUT_ROLE = 'Neverless Indefinite Timeout';
const VC_MUTE_ROLE = 'Neverless VC Muted';
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

const allowedLinkChannels = new Map();
const configMessageIds = new Map();
const muteAdminRoles = new Map();
const muteAdminMessageIds = new Map();
const timerMessageIds = new Map();
const timers = new Map();
const filteredDeletes = new Set();
const pendingMemberActions = new Map();
const pendingBulkDeletes = new Map();
let installed = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDuration(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i);
  if (!match) return NaN;
  const number = Number(match[1]);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const ms = number * units[match[2].toLowerCase()];
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : NaN;
}

function durationText(ms) {
  if (!Number.isFinite(ms)) return 'دائم';
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function safe(value, max = 900) {
  const text = String(value || '').replace(/```/g, 'ˋˋˋ').trim();
  if (!text) return '(empty)';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isLogOrDataChannel(channel) {
  return channel?.id === LOG_CHANNEL_ID || channel?.name === DATA_CHANNEL_NAME;
}

function logChannel(guild) {
  const channel = guild?.channels?.cache?.get(LOG_CHANNEL_ID);
  return channel?.isSendable?.() ? channel : null;
}

async function logEvent(guild, title, description, fields = []) {
  const channel = logChannel(guild);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(title)
    .setDescription(safe(description, 3800))
    .setTimestamp();
  if (fields.length) embed.addFields(fields.slice(0, 20).map((field) => ({
    name: safe(field.name, 250),
    value: safe(field.value, 1000),
    inline: Boolean(field.inline),
  })));
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

function dataChannel(guild) {
  return guild?.channels?.cache?.find((channel) => channel.type === ChannelType.GuildText && channel.name === DATA_CHANNEL_NAME) || null;
}

async function fetchAllDataMessages(channel, limit = 5000) {
  const out = [];
  let before;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return out;
}

function configKey(guildId) {
  return String(guildId);
}

function timerKey(guildId, userId, type) {
  return `${guildId}:${userId}:${type}`;
}

function parseConfig(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(LINK_CONFIG_PREFIX)) return null;
  const rest = value.slice(LINK_CONFIG_PREFIX.length);
  const split = rest.indexOf('|');
  if (split < 0) return null;
  const guildId = rest.slice(0, split);
  const ids = rest.slice(split + 1).split(',').map((item) => item.trim()).filter((item) => /^\d{15,22}$/.test(item));
  return /^\d{15,22}$/.test(guildId) ? { guildId, ids } : null;
}

function parseMuteAdminConfig(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(MUTE_ADMIN_CONFIG_PREFIX)) return null;
  const rest = value.slice(MUTE_ADMIN_CONFIG_PREFIX.length);
  const [guildId, roleId] = rest.split('|');
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(roleId || '')) return null;
  return { guildId, roleId };
}

function parseTimer(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(TIMER_PREFIX)) return null;
  const [, type, guildId, userId, expiresAt] = value.split('|');
  const expires = Number(expiresAt);
  if (type !== 'vc' || !/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '') || !Number.isFinite(expires)) return null;
  return { type, guildId, userId, expiresAt: expires };
}

async function persistAllowedLinks(guild) {
  const channel = dataChannel(guild);
  if (!channel) return;
  const ids = [...(allowedLinkChannels.get(guild.id) || new Set())];
  const content = `${LINK_CONFIG_PREFIX}${guild.id}|${ids.join(',')}`;
  const existingId = configMessageIds.get(configKey(guild.id));
  let message = existingId ? await channel.messages.fetch(existingId).catch(() => null) : null;
  if (message) await message.edit(content).catch(() => {});
  else {
    message = await channel.send(content).catch(() => null);
    if (message) configMessageIds.set(configKey(guild.id), message.id);
  }
}

async function persistMuteAdminRole(guild) {
  const channel = dataChannel(guild);
  const roleId = muteAdminRoles.get(guild.id);
  if (!channel || !roleId) return;
  const content = `${MUTE_ADMIN_CONFIG_PREFIX}${guild.id}|${roleId}`;
  const key = configKey(guild.id);
  const existingId = muteAdminMessageIds.get(key);
  let message = existingId ? await channel.messages.fetch(existingId).catch(() => null) : null;
  if (message) await message.edit(content).catch(() => {});
  else {
    message = await channel.send(content).catch(() => null);
    if (message) muteAdminMessageIds.set(key, message.id);
  }
}

async function persistTimer(guild, userId, type, expiresAt) {
  const channel = dataChannel(guild);
  if (!channel) return;
  const key = timerKey(guild.id, userId, type);
  const content = `${TIMER_PREFIX}${type}|${guild.id}|${userId}|${expiresAt}`;
  const existingId = timerMessageIds.get(key);
  let message = existingId ? await channel.messages.fetch(existingId).catch(() => null) : null;
  if (message) await message.edit(content).catch(() => {});
  else {
    message = await channel.send(content).catch(() => null);
    if (message) timerMessageIds.set(key, message.id);
  }
}

async function deleteTimerRecord(guild, userId, type) {
  const key = timerKey(guild.id, userId, type);
  const timeout = timers.get(key);
  if (timeout) clearTimeout(timeout);
  timers.delete(key);
  const channel = dataChannel(guild);
  const messageId = timerMessageIds.get(key);
  if (channel && messageId) {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) await message.delete().catch(() => {});
  }
  timerMessageIds.delete(key);
}

async function ensureRole(guild, name) {
  let role = guild.roles.cache.find((item) => item.name === name) || null;
  if (!role) role = await guild.roles.create({ name, permissions: [], reason: 'Neverless moderation' });
  return role;
}

async function clearVcMute(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  const role = guild.roles.cache.find((item) => item.name === VC_MUTE_ROLE) || null;
  if (member && role && member.roles.cache.has(role.id)) await member.roles.remove(role, 'Neverless timed VC mute expired').catch(() => {});
  if (member?.voice?.channelId && member.voice.serverMute) await member.voice.setMute(false, 'Neverless timed VC mute expired').catch(() => {});
  await deleteTimerRecord(guild, userId, 'vc');
}

function scheduleVcUnmute(guild, userId, expiresAt) {
  const key = timerKey(guild.id, userId, 'vc');
  const old = timers.get(key);
  if (old) clearTimeout(old);
  const run = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      clearVcMute(guild, userId).catch(() => {});
      return;
    }
    const timer = setTimeout(run, Math.min(remaining, 2_000_000_000));
    timer.unref?.();
    timers.set(key, timer);
  };
  run();
}

async function loadPersistentModeration(guild) {
  await whenAccountStoreReady().catch(() => {});
  const channel = dataChannel(guild);
  if (!channel) return;
  const messages = await fetchAllDataMessages(channel);
  let latestConfig = null;
  let latestMuteAdmin = null;
  const latestTimers = new Map();

  for (const message of messages) {
    if (message.author?.id !== guild.members.me?.id) continue;
    const config = parseConfig(message.content);
    if (config?.guildId === guild.id && (!latestConfig || message.createdTimestamp > latestConfig.createdTimestamp)) {
      latestConfig = { ...config, messageId: message.id, createdTimestamp: message.createdTimestamp };
    }
    const muteAdmin = parseMuteAdminConfig(message.content);
    if (muteAdmin?.guildId === guild.id && (!latestMuteAdmin || message.createdTimestamp > latestMuteAdmin.createdTimestamp)) {
      latestMuteAdmin = { ...muteAdmin, messageId: message.id, createdTimestamp: message.createdTimestamp };
    }
    const timer = parseTimer(message.content);
    if (timer?.guildId === guild.id) {
      const key = timerKey(timer.guildId, timer.userId, timer.type);
      const previous = latestTimers.get(key);
      if (!previous || message.createdTimestamp > previous.createdTimestamp) latestTimers.set(key, { ...timer, messageId: message.id, createdTimestamp: message.createdTimestamp });
    }
  }

  allowedLinkChannels.set(guild.id, new Set(latestConfig?.ids || []));
  if (latestConfig) configMessageIds.set(configKey(guild.id), latestConfig.messageId);

  if (latestMuteAdmin) {
    muteAdminRoles.set(guild.id, latestMuteAdmin.roleId);
    muteAdminMessageIds.set(configKey(guild.id), latestMuteAdmin.messageId);
  } else {
    muteAdminRoles.delete(guild.id);
  }

  for (const timer of latestTimers.values()) {
    const key = timerKey(timer.guildId, timer.userId, timer.type);
    timerMessageIds.set(key, timer.messageId);
    if (timer.expiresAt <= Date.now()) await clearVcMute(guild, timer.userId);
    else scheduleVcUnmute(guild, timer.userId, timer.expiresAt);
  }
}

async function refreshIndefiniteTimeouts(guild) {
  const role = guild.roles.cache.find((item) => item.name === INDEFINITE_TIMEOUT_ROLE);
  if (!role) return;
  await guild.members.fetch().catch(() => null);
  for (const member of role.members.values()) {
    if (!member.moderatable) continue;
    const until = Number(member.communicationDisabledUntilTimestamp) || 0;
    if (until < Date.now() + REFRESH_THRESHOLD_MS) {
      await member.timeout(MAX_TIMEOUT_MS, 'Neverless indefinite timeout refresh').catch(() => {});
    }
  }
}

function hasExternalLink(content) {
  const value = String(content || '');
  return /(?:https?:\/\/|www\.)\S+|(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/iu.test(value);
}

function isLinkAllowed(message) {
  if (message.member?.permissions?.has(PermissionFlagsBits.Administrator) || message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;
  return allowedLinkChannels.get(message.guildId)?.has(message.channelId) || false;
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles?.cache?.has?.(roleId)) return true;
  return Array.isArray(member.roles) && member.roles.includes(roleId);
}

function hasMuteAccess(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) return true;
  const roleId = muteAdminRoles.get(interaction.guildId);
  return memberHasRole(interaction.member, roleId);
}

function delegatedMuteOnly(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) return false;
  return hasMuteAccess(interaction);
}

async function requireMuteAccess(interaction) {
  if (hasMuteAccess(interaction)) return true;
  await interaction.reply({ content: 'ليس لديك صلاحية استخدام هذا الأمر.', ephemeral: true });
  return false;
}

async function ensureDelegatedTargetAllowed(interaction, member) {
  if (!delegatedMuteOnly(interaction)) return true;
  if (member.id === interaction.guild.ownerId || member.permissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'الرتبة المخولة بالميوت لا تستطيع استخدام الأمر على مالك السيرفر أو Administrator.', ephemeral: true });
    return false;
  }
  const actorHighest = interaction.member?.roles?.highest;
  const targetHighest = member.roles?.highest;
  if (actorHighest?.comparePositionTo && targetHighest && actorHighest.comparePositionTo(targetHighest) <= 0) {
    await interaction.reply({ content: 'لا تستطيع استخدام الميوت على عضو رتبته مساوية أو أعلى من رتبتك.', ephemeral: true });
    return false;
  }
  return true;
}

async function handleLinkFilter(message) {
  if (!message?.guildId || message.author?.bot || !hasExternalLink(message.content) || isLogOrDataChannel(message.channel)) return;
  if (isLinkAllowed(message)) return;
  filteredDeletes.add(message.id);
  setTimeout(() => filteredDeletes.delete(message.id), 5000).unref?.();
  await message.delete().catch(() => {});
  await logEvent(message.guild, '🔗 Blocked Link', `تم حذف رابط خارج الرومات المسموحة.`, [
    { name: 'Member', value: `${message.author.tag} (${message.author.id})`, inline: true },
    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
    { name: 'Content', value: message.content || '(empty)' },
  ]);
}

async function recentAudit(guild, type, targetId, maxAge = 12_000) {
  const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
  if (!logs) return null;
  const now = Date.now();
  return logs.entries.find((entry) => entry.target?.id === targetId && now - entry.createdTimestamp <= maxAge) || null;
}

async function handleMemberRemove(member) {
  await sleep(900);
  const pending = pendingMemberActions.get(`${member.guild.id}:${member.id}`);
  if (pending && Date.now() - pending.at <= 12_000) {
    pendingMemberActions.delete(`${member.guild.id}:${member.id}`);
    await logEvent(member.guild, pending.action === 'ban' ? '🔨 Member Banned' : '👢 Member Kicked', `${member.user.tag} (${member.id})`, [
      { name: 'By', value: `${pending.executorTag} (${pending.executorId})`, inline: true },
      { name: 'Reason', value: pending.reason || 'No reason' },
    ]);
    return;
  }

  const ban = await recentAudit(member.guild, AuditLogEvent.MemberBanAdd, member.id);
  if (ban) {
    await logEvent(member.guild, '🔨 Member Banned', `${member.user.tag} (${member.id})`, [
      { name: 'By', value: ban.executor ? `${ban.executor.tag} (${ban.executor.id})` : 'Unknown', inline: true },
      { name: 'Reason', value: ban.reason || 'No reason' },
    ]);
    return;
  }
  const kick = await recentAudit(member.guild, AuditLogEvent.MemberKick, member.id);
  if (kick) {
    await logEvent(member.guild, '👢 Member Kicked', `${member.user.tag} (${member.id})`, [
      { name: 'By', value: kick.executor ? `${kick.executor.tag} (${kick.executor.id})` : 'Unknown', inline: true },
      { name: 'Reason', value: kick.reason || 'No reason' },
    ]);
  }
}

async function handleMessageDelete(message) {
  if (!message?.guild || isLogOrDataChannel(message.channel) || filteredDeletes.has(message.id)) return;
  await logEvent(message.guild, '🗑️ Message Deleted', `Message ID: ${message.id}`, [
    { name: 'Author', value: message.author ? `${message.author.tag} (${message.author.id})` : 'Unknown', inline: true },
    { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
    { name: 'Content', value: message.content || '(content unavailable)' },
  ]);
}

async function handleMessageUpdate(oldMessage, newMessage) {
  if (!newMessage?.guild || isLogOrDataChannel(newMessage.channel)) return;
  const before = String(oldMessage?.content || '');
  const after = String(newMessage?.content || '');
  if (before === after) return;
  await logEvent(newMessage.guild, '✏️ Message Edited', `Message ID: ${newMessage.id}`, [
    { name: 'Author', value: newMessage.author ? `${newMessage.author.tag} (${newMessage.author.id})` : 'Unknown', inline: true },
    { name: 'Channel', value: `<#${newMessage.channelId}>`, inline: true },
    { name: 'Before', value: before || '(empty)' },
    { name: 'After', value: after || '(empty)' },
  ]);
}

async function handleBulkDelete(messages, channel) {
  if (!channel?.guild || isLogOrDataChannel(channel)) return;
  const pending = pendingBulkDeletes.get(channel.id);
  if (pending && Date.now() - pending.at > 12_000) pendingBulkDeletes.delete(channel.id);
  await logEvent(channel.guild, '🧹 Messages Bulk Deleted', `${messages.size} messages deleted in <#${channel.id}>.`, pending ? [
    { name: 'By', value: `${pending.executorTag} (${pending.executorId})` },
  ] : []);
}

async function getTargetMember(interaction) {
  const user = interaction.options.getUser('user', true);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ content: 'العضو غير موجود في السيرفر.', ephemeral: true });
    return null;
  }
  return member;
}

async function handleTimeout(interaction) {
  const member = await getTargetMember(interaction);
  if (!member) return true;
  if (!await ensureDelegatedTargetAllowed(interaction, member)) return true;
  if (!member.moderatable) {
    await interaction.reply({ content: 'ما أقدر أعمل Timeout لهذا العضو. تأكد أن رتبة البوت أعلى منه.', ephemeral: true });
    return true;
  }
  const rawDuration = interaction.options.getString('duration');
  const duration = parseDuration(rawDuration);
  if (Number.isNaN(duration)) {
    await interaction.reply({ content: 'صيغة المدة غير صحيحة. أمثلة: `10m` `2h` `1d` `1w`.', ephemeral: true });
    return true;
  }
  if (Number.isFinite(duration) && duration > MAX_TIMEOUT_MS) {
    await interaction.reply({ content: 'Discord يسمح بحد أقصى 28 يوم للـTimeout المؤقت.', ephemeral: true });
    return true;
  }

  const reason = interaction.options.getString('reason') || `By ${interaction.user.tag}`;
  const marker = await ensureRole(interaction.guild, INDEFINITE_TIMEOUT_ROLE);
  if (Number.isFinite(duration)) {
    if (member.roles.cache.has(marker.id)) await member.roles.remove(marker, 'Switching to timed timeout').catch(() => {});
    await member.timeout(duration, reason);
  } else {
    if (!member.roles.cache.has(marker.id)) await member.roles.add(marker, 'Neverless indefinite timeout marker');
    await member.timeout(MAX_TIMEOUT_MS, reason);
  }

  await interaction.reply({
    content: Number.isFinite(duration) ? `تم إعطاء ${member} Timeout لمدة **${durationText(duration)}**.` : `تم إعطاء ${member} Timeout **بدون مدة** إلى أن تشيله الإدارة.`,
  });
  await logEvent(interaction.guild, '🔇 Member Timeout', `${member.user.tag} (${member.id})`, [
    { name: 'By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
    { name: 'Duration', value: Number.isFinite(duration) ? durationText(duration) : 'Until admin removes it', inline: true },
    { name: 'Reason', value: reason },
  ]);
  return true;
}

async function handleUntimeout(interaction) {
  const member = await getTargetMember(interaction);
  if (!member) return true;
  if (!await ensureDelegatedTargetAllowed(interaction, member)) return true;
  const marker = interaction.guild.roles.cache.find((item) => item.name === INDEFINITE_TIMEOUT_ROLE);
  if (marker && member.roles.cache.has(marker.id)) await member.roles.remove(marker, 'Neverless untimeout').catch(() => {});
  await member.timeout(null, `Removed by ${interaction.user.tag}`).catch(() => {});
  await interaction.reply({ content: `تم فك الـTimeout عن ${member}.` });
  await logEvent(interaction.guild, '🔊 Timeout Removed', `${member.user.tag} (${member.id})`, [
    { name: 'By', value: `${interaction.user.tag} (${interaction.user.id})` },
  ]);
  return true;
}

async function handleVcMute(interaction) {
  const member = await getTargetMember(interaction);
  if (!member) return true;
  const rawDuration = interaction.options.getString('duration');
  const duration = parseDuration(rawDuration);
  if (Number.isNaN(duration)) {
    await interaction.reply({ content: 'صيغة المدة غير صحيحة. أمثلة: `10m` `2h` `1d` `1w`.', ephemeral: true });
    return true;
  }

  const role = await ensureRole(interaction.guild, VC_MUTE_ROLE);
  if (!member.roles.cache.has(role.id)) await member.roles.add(role, `VC muted by ${interaction.user.tag}`);
  if (member.voice.channelId && !member.voice.serverMute) await member.voice.setMute(true, `VC muted by ${interaction.user.tag}`).catch(() => {});

  if (Number.isFinite(duration)) {
    const expiresAt = Date.now() + duration;
    await persistTimer(interaction.guild, member.id, 'vc', expiresAt);
    scheduleVcUnmute(interaction.guild, member.id, expiresAt);
  } else {
    await deleteTimerRecord(interaction.guild, member.id, 'vc');
  }

  const reason = interaction.options.getString('reason') || `By ${interaction.user.tag}`;
  await interaction.reply({ content: Number.isFinite(duration) ? `تم إعطاء ${member} VC Mute لمدة **${durationText(duration)}**.` : `تم إعطاء ${member} VC Mute بدون مدة.` });
  await logEvent(interaction.guild, '🎙️ VC Mute', `${member.user.tag} (${member.id})`, [
    { name: 'By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
    { name: 'Duration', value: Number.isFinite(duration) ? durationText(duration) : 'Until admin removes it', inline: true },
    { name: 'Reason', value: reason },
  ]);
  return true;
}

async function handleVcUnmute(interaction) {
  const member = await getTargetMember(interaction);
  if (!member) return true;
  const role = interaction.guild.roles.cache.find((item) => item.name === VC_MUTE_ROLE) || null;
  if (role && member.roles.cache.has(role.id)) await member.roles.remove(role, `VC unmuted by ${interaction.user.tag}`).catch(() => {});
  if (member.voice.channelId && member.voice.serverMute) await member.voice.setMute(false, `VC unmuted by ${interaction.user.tag}`).catch(() => {});
  await deleteTimerRecord(interaction.guild, member.id, 'vc');
  await interaction.reply({ content: `تم فك VC Mute عن ${member}.` });
  await logEvent(interaction.guild, '🎙️ VC Mute Removed', `${member.user.tag} (${member.id})`, [
    { name: 'By', value: `${interaction.user.tag} (${interaction.user.id})` },
  ]);
  return true;
}

async function handleLinksCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const set = allowedLinkChannels.get(interaction.guildId) || new Set();
  allowedLinkChannels.set(interaction.guildId, set);

  if (sub === 'allow') {
    const channel = interaction.options.getChannel('channel', true);
    set.add(channel.id);
    await persistAllowedLinks(interaction.guild);
    await interaction.reply({ content: `تم السماح بالروابط في ${channel}.`, ephemeral: true });
    return true;
  }
  if (sub === 'remove') {
    const channel = interaction.options.getChannel('channel', true);
    set.delete(channel.id);
    await persistAllowedLinks(interaction.guild);
    await interaction.reply({ content: `تم إلغاء السماح بالروابط في ${channel}.`, ephemeral: true });
    return true;
  }
  const list = [...set].map((id) => `<#${id}>`);
  await interaction.reply({ content: list.length ? `الرومات المسموح فيها روابط:\n${list.join('\n')}` : 'ما فيه رومات مستثناة حاليًا.', ephemeral: true });
  return true;
}

async function handleAddAdmin(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'هذا الأمر للـAdministrator فقط.', ephemeral: true });
    return true;
  }
  const role = interaction.options.getRole('role', true);
  if (role.id === interaction.guild.id) {
    await interaction.reply({ content: 'لا يمكن اختيار رتبة @everyone.', ephemeral: true });
    return true;
  }
  if (role.managed) {
    await interaction.reply({ content: 'اختر رتبة عادية وليست رتبة يديرها Bot أو Integration.', ephemeral: true });
    return true;
  }

  muteAdminRoles.set(interaction.guildId, role.id);
  await persistMuteAdminRole(interaction.guild);
  await interaction.reply({
    content: `تم تحديد ${role} كرتبة مخولة باستخدام **/mute** و **/unmute** فقط عبر Neverless.`,
    allowedMentions: { roles: [] },
    ephemeral: true,
  });
  await logEvent(interaction.guild, '🛡️ Mute Admin Role Updated', `${role.name} (${role.id})`, [
    { name: 'By', value: `${interaction.user.tag} (${interaction.user.id})` },
    { name: 'Access', value: '/mute + /unmute only' },
  ]);
  return true;
}

async function handleAdminUidUnlink(interaction) {
  const uid = interaction.options.getString('uid', true).trim();
  if (!/^\d{9,10}$/.test(uid)) {
    await interaction.reply({ content: 'UID غير صالح.', ephemeral: true });
    return true;
  }
  const owner = getAllLinkedUsers().find((row) => String(row.uid) === uid);
  if (!owner) {
    await interaction.reply({ content: 'هذا الـUID مو مربوط بأي عضو حاليًا.', ephemeral: true });
    return true;
  }
  await unlinkUid(owner.discordUserId);
  clearLeaderboardCache();
  await interaction.reply({ content: `تم فك UID **${uid}** من <@${owner.discordUserId}>.`, allowedMentions: { users: [] }, ephemeral: true });
  await logEvent(interaction.guild, '🔗 UID Force Unlinked', `UID ${uid}`, [
    { name: 'Member', value: `<@${owner.discordUserId}> (${owner.discordUserId})`, inline: true },
    { name: 'By', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
  ]);
  return true;
}

async function handleModerationInteraction(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;

  // Capture the executor of the existing kick/ban/clear commands without changing their logic.
  if (interaction.commandName === 'kick' || interaction.commandName === 'ban') {
    const user = interaction.options.getUser('user');
    if (user) {
      pendingMemberActions.set(`${interaction.guildId}:${user.id}`, {
        action: interaction.commandName,
        executorId: interaction.user.id,
        executorTag: interaction.user.tag,
        reason: interaction.options.getString('reason') || null,
        at: Date.now(),
      });
      setTimeout(() => pendingMemberActions.delete(`${interaction.guildId}:${user.id}`), 15_000).unref?.();
    }
    return false;
  }
  if (interaction.commandName === 'clear') {
    pendingBulkDeletes.set(interaction.channelId, { executorId: interaction.user.id, executorTag: interaction.user.tag, at: Date.now() });
    setTimeout(() => pendingBulkDeletes.delete(interaction.channelId), 15_000).unref?.();
    return false;
  }

  if (interaction.commandName === 'addadmin') return handleAddAdmin(interaction);
  if (interaction.commandName === 'mute') {
    if (!await requireMuteAccess(interaction)) return true;
    return handleTimeout(interaction);
  }
  if (interaction.commandName === 'unmute') {
    if (!await requireMuteAccess(interaction)) return true;
    return handleUntimeout(interaction);
  }
  if (interaction.commandName === 'timeout') return handleTimeout(interaction);
  if (interaction.commandName === 'untimeout') return handleUntimeout(interaction);
  if (interaction.commandName === 'mutevc') return handleVcMute(interaction);
  if (interaction.commandName === 'unmutevc') return handleVcUnmute(interaction);
  if (interaction.commandName === 'links') return handleLinksCommand(interaction);
  if (interaction.commandName === 'uid-unlink') return handleAdminUidUnlink(interaction);
  return false;
}

async function enforceVcMute(oldState, newState) {
  if (!newState?.member || !newState.channelId || oldState.channelId === newState.channelId) return;
  const role = newState.guild.roles.cache.find((item) => item.name === VC_MUTE_ROLE);
  if (role && newState.member.roles.cache.has(role.id) && !newState.serverMute) {
    await newState.setMute(true, 'Neverless persistent VC mute').catch(() => {});
  }
}

function installModeration(client) {
  if (installed) return;
  installed = true;

  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      await loadPersistentModeration(guild).catch((error) => console.warn('[moderation] persistence:', error.message));
      await refreshIndefiniteTimeouts(guild).catch(() => {});
    }
    const timer = setInterval(() => {
      for (const guild of client.guilds.cache.values()) refreshIndefiniteTimeouts(guild).catch(() => {});
    }, 6 * 60 * 60 * 1000);
    timer.unref?.();
  });

  client.on('guildCreate', (guild) => loadPersistentModeration(guild).catch(() => {}));
  client.on('interactionCreate', (interaction) => {
    Promise.resolve(handleModerationInteraction(interaction)).catch((error) => {
      console.error('[moderation] interaction error:', error);
      if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        interaction.reply({ content: 'صار خطأ أثناء تنفيذ أمر الإدارة.', ephemeral: true }).catch(() => {});
      }
    });
  });
  client.on('messageCreate', (message) => handleLinkFilter(message).catch(() => {}));
  client.on('messageDelete', (message) => handleMessageDelete(message).catch(() => {}));
  client.on('messageUpdate', (before, after) => handleMessageUpdate(before, after).catch(() => {}));
  client.on('messageDeleteBulk', (messages, channel) => handleBulkDelete(messages, channel).catch(() => {}));
  client.on('guildMemberRemove', (member) => handleMemberRemove(member).catch(() => {}));
  client.on('voiceStateUpdate', (oldState, newState) => enforceVcMute(oldState, newState).catch(() => {}));
}

module.exports = {
  installModeration,
  handleModerationInteraction,
  parseDuration,
  hasExternalLink,
  parseMuteAdminConfig,
  memberHasRole,
  hasMuteAccess,
  LOG_CHANNEL_ID,
};
