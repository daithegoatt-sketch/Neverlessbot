'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { DATA_DIR } = require('./store');

const GENERAL_CHAT_ID = '1537605789521543251';
const DATA_CHANNEL_NAME = 'neverless-data';
const USER_PREFIX = 'NLHID1|';
const GLOBAL_PREFIX = 'NLHIDG1|';
const ACTIVITY_PREFIX = 'NLACT1|';
const LOCAL_FILE = path.join(DATA_DIR, 'hidden-achievements.json');
const CATEGORY_NAME = '✦ Hidden Achievements';
const LOUNGE_NAME = '✦・secret-lounge';
const ACCESS_ROLE_NAME = 'Neverless Secret';
const FIRST_LEVEL = 20;
const ACTIVITY_POLL_MS = 5_000;
const VOICE_FLUSH_MS = 60_000;
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000;
const MAX_SCAN_MESSAGES = 5000;

const ACHIEVEMENTS = Object.freeze({
  message500: { name: 'First Echo', role: 'Hidden • First Echo', condition: 'وصلت إلى 500 رسالة مؤهلة في نظام نشاط Neverless.' },
  message1000: { name: 'A Thousand Words', role: 'Hidden • Thousand Words', condition: 'وصلت إلى 1,000 رسالة مؤهلة في نظام نشاط Neverless.' },
  streak7: { name: 'Still Here', role: 'Hidden • Still Here', condition: 'حافظت على نشاط مؤهل 7 أيام متتالية.' },
  streak14: { name: 'Unbroken', role: 'Hidden • Unbroken', condition: 'حافظت على نشاط مؤهل 14 يومًا متتاليًا.' },
  streak30: { name: 'Never Fades', role: 'Hidden • Never Fades', condition: 'حافظت على نشاط مؤهل 30 يومًا متتاليًا.' },
  voice400: { name: 'Voice in the Dark', role: 'Hidden • Voice in the Dark', condition: 'جمعت 400 دقيقة Voice مؤهلة مع أعضاء آخرين.' },
  voice1200: { name: 'After Hours', role: 'Hidden • After Hours', condition: 'جمعت 1,200 دقيقة Voice مؤهلة مع أعضاء آخرين.' },
  active45: { name: 'The Regular', role: 'Hidden • The Regular', condition: 'كنت نشطًا في 45 يومًا مختلفًا منذ تفعيل النظام.' },
  firstLevel20: { name: 'First Ascension', role: 'Hidden • First Ascension', condition: `كنت أول عضو يصل إلى Lv.${FIRST_LEVEL} بعد بدء سباق الإنجاز المخفي.` },
});

let state = { users: {}, global: {} };
let installed = false;
let targetGuild = null;
let dataChannel = null;
let category = null;
let accessRole = null;
let globalMessageId = null;
let persistQueue = Promise.resolve();
const userMessageIds = new Map();
const rewardRoles = new Map();
const activityXp = new Map();
const voiceSessions = new Map();
const userQueues = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function levelFromXp(xp) {
  const safe = cleanInt(xp);
  return Math.floor((Math.sqrt(1 + safe * 0.08) - 1) / 2);
}

function xpForLevel(level) {
  const safe = cleanInt(level);
  return 50 * safe * (safe + 1);
}

function kuwaitDay(now = Date.now()) {
  const local = new Date(Number(now) + KUWAIT_OFFSET_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

function dayNumber(day) {
  const match = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function normalizeUserRecord(input = {}) {
  return {
    lastActiveDay: String(input.lastActiveDay || ''),
    currentStreak: cleanInt(input.currentStreak),
    bestStreak: cleanInt(input.bestStreak),
    activeDays: cleanInt(input.activeDays),
    voiceMs: cleanInt(input.voiceMs),
    roomId: /^\d{15,22}$/.test(String(input.roomId || '')) ? String(input.roomId) : null,
    achievements: input.achievements && typeof input.achievements === 'object' ? input.achievements : {},
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function userRecord(userId) {
  const id = String(userId);
  state.users[id] = normalizeUserRecord(state.users[id] || {});
  return state.users[id];
}

function normalizeGlobal(input = {}) {
  return {
    launchedAt: input.launchedAt || null,
    announcedAt: input.announcedAt || null,
    raceWinnerId: /^\d{15,22}$/.test(String(input.raceWinnerId || '')) ? String(input.raceWinnerId) : null,
    raceWinnerAt: input.raceWinnerAt || null,
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
function decode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function parseUserMessage(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(USER_PREFIX)) return null;
  const [guildId, userId, payload] = value.slice(USER_PREFIX.length).split('|');
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
  const record = decode(payload);
  return record ? { guildId, userId, record: normalizeUserRecord(record) } : null;
}

function parseGlobalMessage(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(GLOBAL_PREFIX)) return null;
  const rest = value.slice(GLOBAL_PREFIX.length);
  const split = rest.indexOf('|');
  if (split < 0) return null;
  const guildId = rest.slice(0, split);
  const global = decode(rest.slice(split + 1));
  return /^\d{15,22}$/.test(guildId) && global ? { guildId, global: normalizeGlobal(global) } : null;
}

function parseActivityXp(content) {
  const parts = String(content || '').trim().split('|');
  if (parts[0] !== 'NLACT1' || parts.length < 4) return null;
  if (!/^\d{15,22}$/.test(parts[1] || '') || !/^\d{15,22}$/.test(parts[2] || '')) return null;
  return { guildId: parts[1], userId: parts[2], allXp: cleanInt(parts[3]) };
}

function ensureLocalLoaded() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    state = { users: parsed.users || {}, global: normalizeGlobal(parsed.global || {}) };
    for (const [id, record] of Object.entries(state.users)) state.users[id] = normalizeUserRecord(record);
  } catch (error) {
    console.warn('[hidden-achievements] Local load failed:', error.message);
  }
}

async function writeLocal() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(LOCAL_FILE, JSON.stringify(state, null, 2));
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

function persistUser(guild, userId) {
  const id = String(userId);
  const record = userRecord(id);
  record.updatedAt = new Date().toISOString();
  persistQueue = persistQueue.then(async () => {
    await writeLocal();
    if (!dataChannel || dataChannel.guildId !== guild.id) return;
    const content = `${USER_PREFIX}${guild.id}|${id}|${encode(record)}`;
    const knownId = userMessageIds.get(id);
    let message = knownId ? await dataChannel.messages.fetch(knownId).catch(() => null) : null;
    if (message) await message.edit(content);
    else {
      message = await dataChannel.send(content);
      userMessageIds.set(id, message.id);
    }
  }).catch((error) => console.warn('[hidden-achievements] User persistence failed:', error.message));
  return persistQueue;
}

function persistGlobal(guild) {
  state.global = normalizeGlobal(state.global);
  state.global.updatedAt = new Date().toISOString();
  persistQueue = persistQueue.then(async () => {
    await writeLocal();
    if (!dataChannel || dataChannel.guildId !== guild.id) return;
    const content = `${GLOBAL_PREFIX}${guild.id}|${encode(state.global)}`;
    let message = globalMessageId ? await dataChannel.messages.fetch(globalMessageId).catch(() => null) : null;
    if (message) await message.edit(content);
    else {
      message = await dataChannel.send(content);
      globalMessageId = message.id;
    }
  }).catch((error) => console.warn('[hidden-achievements] Global persistence failed:', error.message));
  return persistQueue;
}

async function waitForDataChannel(guild) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const found = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.());
    if (found) return found;
    await guild.channels.fetch().catch(() => null);
    await sleep(750);
  }
  return guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
}

async function loadRemoteState(guild) {
  dataChannel = await waitForDataChannel(guild);
  if (!dataChannel) return;
  const messages = await fetchAllMessages(dataChannel);
  const latestUsers = new Map();
  let latestGlobal = null;

  for (const message of messages) {
    if (message.author?.id !== guild.members.me?.id) continue;
    const hidden = parseUserMessage(message.content);
    if (hidden?.guildId === guild.id) {
      const previous = latestUsers.get(hidden.userId);
      if (!previous || message.createdTimestamp > previous.createdTimestamp) latestUsers.set(hidden.userId, { ...hidden, messageId: message.id, createdTimestamp: message.createdTimestamp });
    }
    const global = parseGlobalMessage(message.content);
    if (global?.guildId === guild.id && (!latestGlobal || message.createdTimestamp > latestGlobal.createdTimestamp)) latestGlobal = { ...global, messageId: message.id, createdTimestamp: message.createdTimestamp };
    const activity = parseActivityXp(message.content);
    if (activity?.guildId === guild.id) activityXp.set(activity.userId, Math.max(activityXp.get(activity.userId) || 0, activity.allXp));
  }

  for (const [userId, row] of latestUsers) {
    state.users[userId] = normalizeUserRecord(row.record);
    userMessageIds.set(userId, row.messageId);
  }
  if (latestGlobal) {
    state.global = normalizeGlobal(latestGlobal.global);
    globalMessageId = latestGlobal.messageId;
  } else state.global = normalizeGlobal(state.global);
  await writeLocal();
}

async function ensureRole(guild, name) {
  let role = guild.roles.cache.find((item) => item.name === name) || null;
  if (!role) role = await guild.roles.create({ name, permissions: [], hoist: false, mentionable: false, reason: 'Neverless hidden achievement reward' });
  return role;
}

async function ensureRewardStructure(guild) {
  accessRole = await ensureRole(guild, ACCESS_ROLE_NAME);
  for (const [id, achievement] of Object.entries(ACHIEVEMENTS)) rewardRoles.set(id, await ensureRole(guild, achievement.role));

  category = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === CATEGORY_NAME) || null;
  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] },
      ],
      reason: 'Neverless hidden achievement rewards',
    });
  }

  let lounge = guild.channels.cache.find((channel) => channel.parentId === category.id && channel.name === LOUNGE_NAME) || null;
  if (!lounge) {
    lounge = await guild.channels.create({
      name: LOUNGE_NAME,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: 'Shared room for members who claimed a Neverless hidden achievement.',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: accessRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
        { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
      ],
      reason: 'Neverless Secret lounge',
    });
    await lounge.send({ embeds: [new EmbedBuilder().setColor(0x4f456b).setTitle('Neverless Secret').setDescription('هذا الروم يفتح بعد Claim لأول Hidden Achievement. الرتبة لا تعطي أي صلاحيات إدارية.')] }).catch(() => {});
  }
}

async function ensureClaimRoom(guild, userId) {
  const record = userRecord(userId);
  let room = record.roomId ? guild.channels.cache.get(record.roomId) : null;
  if (!room && record.roomId) room = await guild.channels.fetch(record.roomId).catch(() => null);
  if (!room) room = guild.channels.cache.find((channel) => channel.topic?.includes(`neverless-hidden-owner:${userId}`)) || null;
  if (room) {
    if (record.roomId !== room.id) { record.roomId = room.id; await persistUser(guild, userId); }
    return room;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return null;
  room = await guild.channels.create({
    name: `secret-${String(userId).slice(-6)}`,
    type: ChannelType.GuildText,
    parent: category?.id || null,
    topic: `neverless-hidden-owner:${userId}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ],
    reason: 'Neverless hidden achievement claim room',
  });
  record.roomId = room.id;
  await persistUser(guild, userId);
  return room;
}

function claimRow(achievementId, userId, disabled = false) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`hidden:claim:${achievementId}:${userId}`)
    .setLabel(disabled ? 'Claimed' : 'Claim Now')
    .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(disabled));
}

function unlockEmbed(achievement) {
  return new EmbedBuilder()
    .setColor(0x66578a)
    .setTitle('🏆 Hidden Achievement Unlocked')
    .setDescription([
      `حصلت على إنجاز مخفي: **${achievement.name}**`,
      '',
      `**الشرط الذي انكشف:** ${achievement.condition}`,
      '',
      `اضغط **Claim Now** للحصول على رتبة **${achievement.role}**. أول Claim يفتح أيضًا **Neverless Secret** والـSecret Lounge وأوامر Premium.`,
    ].join('\n'))
    .setFooter({ text: 'Hidden Achievements • Neverless' });
}

async function ensureClaimPrompt(guild, userId, achievementId) {
  const achievement = ACHIEVEMENTS[achievementId];
  const record = userRecord(userId);
  const progress = record.achievements[achievementId];
  if (!achievement || !progress?.unlockedAt || progress.claimedAt) return;
  const room = await ensureClaimRoom(guild, userId);
  if (!room) return;
  if (progress.messageId && await room.messages.fetch(progress.messageId).catch(() => null)) return;

  const message = await room.send({
    content: `<@${userId}> مبروك، حصلت على إنجاز مخفي.`,
    embeds: [unlockEmbed(achievement)],
    components: [claimRow(achievementId, userId)],
    allowedMentions: { users: [userId] },
  });
  progress.messageId = message.id;
  progress.notifiedAt = new Date().toISOString();
  await persistUser(guild, userId);
}

async function unlockAchievement(guild, userId, achievementId) {
  if (!ACHIEVEMENTS[achievementId]) return false;
  const record = userRecord(userId);
  if (record.achievements[achievementId]?.unlockedAt) {
    if (!record.achievements[achievementId].claimedAt) await ensureClaimPrompt(guild, userId, achievementId);
    return false;
  }
  record.achievements[achievementId] = { unlockedAt: new Date().toISOString(), claimedAt: null, notifiedAt: null, messageId: null };
  await persistUser(guild, userId);
  await ensureClaimPrompt(guild, userId, achievementId);
  return true;
}

function standardAchievementIds(record, xp = 0) {
  const ids = [];
  const messages = Math.floor(cleanInt(xp) / 10);
  const voiceMinutes = Math.floor(cleanInt(record.voiceMs) / 60_000);
  if (messages >= 500) ids.push('message500');
  if (messages >= 1000) ids.push('message1000');
  if (record.bestStreak >= 7) ids.push('streak7');
  if (record.bestStreak >= 14) ids.push('streak14');
  if (record.bestStreak >= 30) ids.push('streak30');
  if (voiceMinutes >= 400) ids.push('voice400');
  if (voiceMinutes >= 1200) ids.push('voice1200');
  if (record.activeDays >= 45) ids.push('active45');
  return ids;
}

async function evaluateUser(guild, userId) {
  const record = userRecord(userId);
  for (const achievementId of standardAchievementIds(record, activityXp.get(String(userId)) || 0)) await unlockAchievement(guild, userId, achievementId);
}

function advanceStreak(record, day) {
  if (record.lastActiveDay === day) return false;
  const previous = dayNumber(record.lastActiveDay);
  const current = dayNumber(day);
  record.currentStreak = previous != null && current != null && current - previous === 1 ? cleanInt(record.currentStreak) + 1 : 1;
  record.bestStreak = Math.max(cleanInt(record.bestStreak), record.currentStreak);
  record.activeDays = cleanInt(record.activeDays) + 1;
  record.lastActiveDay = day;
  return true;
}

function qualifiesForDailyActivity(message) {
  if (!message?.guildId || message.author?.bot || message.system) return false;
  const text = String(message.content || '').trim();
  if (/^[-#]/u.test(text)) return false;
  return text.length >= 3 || Boolean(message.attachments?.size) || Boolean(message.stickers?.size);
}

function queueUser(userId, task) {
  const id = String(userId);
  const previous = userQueues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const queued = current.finally(() => { if (userQueues.get(id) === queued) userQueues.delete(id); });
  userQueues.set(id, queued);
  return current;
}

async function markActiveDay(message) {
  const record = userRecord(message.author.id);
  if (!advanceStreak(record, kuwaitDay(message.createdTimestamp || Date.now()))) return;
  await persistUser(message.guild, message.author.id);
  await evaluateUser(message.guild, message.author.id);
}

function updateActivityXp(guild, userId, nextXp, allowRace = true) {
  const id = String(userId);
  const previous = activityXp.get(id) || 0;
  const next = Math.max(previous, cleanInt(nextXp));
  activityXp.set(id, next);
  if (allowRace && !state.global.raceWinnerId && previous < xpForLevel(FIRST_LEVEL) && next >= xpForLevel(FIRST_LEVEL)) {
    state.global.raceWinnerId = id;
    state.global.raceWinnerAt = new Date().toISOString();
    persistGlobal(guild).catch(() => {});
    queueUser(id, async () => { await unlockAchievement(guild, id, 'firstLevel20'); await evaluateUser(guild, id); }).catch(() => {});
  } else if (next > previous) queueUser(id, () => evaluateUser(guild, id)).catch(() => {});
}

async function pollActivityFile(guild) {
  let parsed;
  try { parsed = JSON.parse(await fs.promises.readFile(path.join(DATA_DIR, 'activity.json'), 'utf8')); } catch { return; }
  const users = parsed?.guilds?.[guild.id]?.users || {};
  for (const [userId, record] of Object.entries(users)) updateActivityXp(guild, userId, cleanInt(record?.allXp), true);
}

function qualifiedVoiceMembers(channel) {
  if (!channel?.isVoiceBased?.() || channel.guild?.afkChannelId === channel.id) return [];
  return [...channel.members.values()].filter((member) => !member.user.bot && !member.voice?.deaf);
}

async function accumulateVoiceSession(session, now = Date.now()) {
  const elapsed = Math.max(0, Number(now) - Number(session.startedAt || now));
  if (!elapsed || !targetGuild || session.guildId !== targetGuild.id) return;
  const record = userRecord(session.userId);
  record.voiceMs = cleanInt(record.voiceMs) + elapsed;
  session.startedAt = now;
  await persistUser(targetGuild, session.userId);
  await evaluateUser(targetGuild, session.userId);
}

async function reconcileVoice(guild) {
  const now = Date.now();
  const active = new Map();
  for (const channel of guild.channels.cache.values()) {
    const humans = qualifiedVoiceMembers(channel);
    if (humans.length < 2) continue;
    for (const member of humans) active.set(member.id, channel.id);
  }
  for (const [key, session] of [...voiceSessions.entries()]) {
    if (session.guildId !== guild.id) continue;
    const channelId = active.get(session.userId);
    if (!channelId || channelId !== session.channelId) {
      await accumulateVoiceSession(session, now);
      voiceSessions.delete(key);
    }
  }
  for (const [userId, channelId] of active) {
    const key = `${guild.id}:${userId}`;
    if (!voiceSessions.has(key)) voiceSessions.set(key, { guildId: guild.id, userId, channelId, startedAt: now });
  }
}

async function flushVoice(guild) {
  const now = Date.now();
  for (const session of voiceSessions.values()) if (session.guildId === guild.id) await queueUser(session.userId, () => accumulateVoiceSession(session, now));
}

async function restoreMemberRewards(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return;
  const claimed = Object.entries(userRecord(userId).achievements).filter(([, row]) => row?.claimedAt);
  if (!claimed.length) return;
  if (accessRole && !member.roles.cache.has(accessRole.id)) await member.roles.add(accessRole, 'Restore Neverless Secret access').catch(() => {});
  for (const [id] of claimed) {
    const role = rewardRoles.get(id);
    if (role && !member.roles.cache.has(role.id)) await member.roles.add(role, 'Restore hidden achievement reward').catch(() => {});
  }
}

function parseClaimCustomId(customId) {
  const match = String(customId || '').match(/^hidden:claim:([a-zA-Z0-9_-]+):(\d{15,22})$/);
  return match && ACHIEVEMENTS[match[1]] ? { achievementId: match[1], userId: match[2] } : null;
}

async function handleClaim(interaction) {
  if (!interaction.isButton?.() || !interaction.guild) return false;
  const parsed = parseClaimCustomId(interaction.customId);
  if (!parsed) return false;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({ content: 'هذه الجائزة تخص صاحب الإنجاز فقط.', ephemeral: true });
    return true;
  }
  const record = userRecord(parsed.userId);
  const progress = record.achievements[parsed.achievementId];
  if (!progress?.unlockedAt) {
    await interaction.reply({ content: 'هذا الإنجاز غير مسجل على حسابك.', ephemeral: true });
    return true;
  }
  if (progress.claimedAt) {
    await interaction.reply({ content: 'الجائزة مستلمة بالفعل.', ephemeral: true });
    return true;
  }

  await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(parsed.userId).catch(() => null);
  const rewardRole = rewardRoles.get(parsed.achievementId) || await ensureRole(interaction.guild, ACHIEVEMENTS[parsed.achievementId].role).catch(() => null);
  if (!member || !rewardRole || !accessRole) {
    await interaction.followUp({ content: 'تعذر تجهيز الجائزة الآن. جرّب بعد قليل.', ephemeral: true });
    return true;
  }
  try {
    await member.roles.add([rewardRole.id, accessRole.id], `Claimed hidden achievement: ${ACHIEVEMENTS[parsed.achievementId].name}`);
  } catch {
    await interaction.followUp({ content: 'البوت ما قدر يعطي الرتبة بسبب ترتيب الرتب أو الصلاحيات.', ephemeral: true });
    return true;
  }
  progress.claimedAt = new Date().toISOString();
  await persistUser(interaction.guild, parsed.userId);
  await interaction.message.edit({ components: [claimRow(parsed.achievementId, parsed.userId, true)] }).catch(() => {});
  await interaction.followUp({ content: `تم استلام **${ACHIEVEMENTS[parsed.achievementId].name}**. حصلت على **${rewardRole.name}** وفتح لك **Neverless Secret** والـSecret Lounge وأوامر Premium.`, ephemeral: true });
  return true;
}

function parseHiddenCommand(text) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (/^-(?:hidden|انجازات\s+مخفيه|انجازات\s+مخفية|الانجازات\s+المخفيه|الانجازات\s+المخفية)$/iu.test(value) || /^-hidden\s+achievements$/iu.test(value)) return { type: 'about' };
  if (/^-hidden\s+stats$/iu.test(value) || /^-مخفي\s+(?:احصائياتي|إحصائياتي)$/u.test(value)) return { type: 'stats' };
  if (/^-hidden\s+card$/iu.test(value) || /^-مخفي\s+بطاقتي$/u.test(value)) return { type: 'card' };
  return null;
}

function hasSecretAccess(member) {
  return Boolean(accessRole && member?.roles?.cache?.has(accessRole.id));
}

async function handleHiddenCommand(message, command) {
  if (command.type === 'about') {
    const extra = hasSecretAccess(message.member) ? '\n\n**Neverless Secret:** `-hidden stats` • `-hidden card`' : '';
    await message.reply({ embeds: [new EmbedBuilder().setColor(0x4f456b).setTitle('Hidden Achievements').setDescription(`داخل Neverless توجد إنجازات مخفية. شروطها وعددها غير معلنين. بعض الإنجازات مرتبطة بالاستمرارية والنشاط والمشاركة داخل المجتمع. إذا حققت واحدًا، البوت يفتح لك Claim خاص تلقائيًا.${extra}`)], allowedMentions: { repliedUser: false } });
    return true;
  }
  if (!hasSecretAccess(message.member)) {
    await message.reply({ content: 'هذا أمر من مزايا **Neverless Secret** ويُفتح بعد Claim لأول Hidden Achievement.', allowedMentions: { repliedUser: false } });
    return true;
  }

  const record = userRecord(message.author.id);
  if (command.type === 'stats') {
    const xp = activityXp.get(message.author.id) || 0;
    const lines = [
      `**Qualified Messages:** ${Math.floor(xp / 10).toLocaleString('en-US')}`,
      `**Activity Level:** Lv.${levelFromXp(xp)}`,
      `**Current Streak:** ${record.currentStreak} يوم`,
      `**Best Streak:** ${record.bestStreak} يوم`,
      `**Active Days:** ${record.activeDays} يوم`,
      `**Qualified Voice:** ${Math.floor(record.voiceMs / 60_000).toLocaleString('en-US')} دقيقة`,
    ];
    await message.reply({ embeds: [new EmbedBuilder().setColor(0x4f456b).setTitle('Neverless Secret — Your Stats').setDescription(lines.join('\n')).setFooter({ text: 'يعرض أرقامك فقط؛ شروط الإنجازات التي لم تكتشفها تبقى مخفية.' })], allowedMentions: { repliedUser: false } });
    return true;
  }

  const claimed = Object.entries(record.achievements)
    .filter(([id, progress]) => progress?.claimedAt && ACHIEVEMENTS[id])
    .map(([id, progress]) => ({ id, progress, achievement: ACHIEVEMENTS[id] }))
    .sort((a, b) => Date.parse(a.progress.claimedAt) - Date.parse(b.progress.claimedAt));
  const lines = claimed.length ? claimed.map((row) => `🏆 **${row.achievement.name}** — <t:${Math.floor(Date.parse(row.progress.claimedAt) / 1000)}:d>`) : ['ما عندك إنجاز Claimed مسجل حاليًا.'];
  await message.reply({ embeds: [new EmbedBuilder().setColor(0x4f456b).setTitle('Neverless Secret — Hidden Card').setDescription(lines.join('\n').slice(0, 3900))], allowedMentions: { repliedUser: false } });
  return true;
}

async function announceSystem(guild) {
  if (state.global.announcedAt) return;
  const channel = guild.channels.cache.get(GENERAL_CHAT_ID) || await guild.channels.fetch(GENERAL_CHAT_ID).catch(() => null);
  if (!channel?.isSendable?.()) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(0x4f456b).setTitle('🏆 Hidden Achievements').setDescription('تم تفعيل إنجازات مخفية داخل Neverless. شروطها وعددها غير معلنين. بعضها يعتمد على الاستمرارية والنشاط والمشاركة. إذا حققت واحدًا، Neverless راح يفتح لك مكافأتك الخاصة تلقائيًا.')] });
  state.global.announcedAt = new Date().toISOString();
  await persistGlobal(guild);
}

async function restoreAndEvaluate(guild) {
  for (const [userId, record] of Object.entries(state.users)) {
    await restoreMemberRewards(guild, userId);
    for (const [id, progress] of Object.entries(record.achievements || {})) if (ACHIEVEMENTS[id] && progress?.unlockedAt && !progress.claimedAt) await ensureClaimPrompt(guild, userId, id);
  }
  for (const userId of activityXp.keys()) await evaluateUser(guild, userId);
}

async function initialize(client) {
  ensureLocalLoaded();
  const general = client.channels.cache.get(GENERAL_CHAT_ID) || await client.channels.fetch(GENERAL_CHAT_ID).catch(() => null);
  const guild = general?.guild;
  if (!guild) return console.warn(`[hidden-achievements] General chat ${GENERAL_CHAT_ID} not found.`);
  targetGuild = guild;
  await loadRemoteState(guild);
  await ensureRewardStructure(guild);
  state.global = normalizeGlobal(state.global);
  if (!state.global.launchedAt) { state.global.launchedAt = new Date().toISOString(); await persistGlobal(guild); }
  await restoreAndEvaluate(guild);
  await announceSystem(guild).catch((error) => console.warn('[hidden-achievements] Announcement failed:', error.message));
  await reconcileVoice(guild);
  console.log(`[hidden-achievements] Ready with ${Object.keys(ACHIEVEMENTS).length} hidden achievements.`);
}

function installHiddenAchievements(client) {
  if (installed) return;
  installed = true;
  client.once('ready', () => initialize(client).catch((error) => console.error('[hidden-achievements] Initialization failed:', error)));
  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;
    const command = parseHiddenCommand(message.content);
    if (command) return void handleHiddenCommand(message, command).catch((error) => console.error('[hidden-achievements] Command failed:', error));
    if (!targetGuild || message.guildId !== targetGuild.id || !qualifiesForDailyActivity(message)) return;
    queueUser(message.author.id, () => markActiveDay(message)).catch((error) => console.warn('[hidden-achievements] Daily activity failed:', error.message));
  });
  client.on('interactionCreate', (interaction) => handleClaim(interaction).catch((error) => console.error('[hidden-achievements] Claim failed:', error)));
  client.on('voiceStateUpdate', (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    if (targetGuild && guild?.id === targetGuild.id) reconcileVoice(guild).catch((error) => console.warn('[hidden-achievements] Voice reconcile failed:', error.message));
  });
  client.on('guildMemberAdd', (member) => {
    if (!targetGuild || member.guild.id !== targetGuild.id || member.user.bot) return;
    queueUser(member.id, async () => {
      await restoreMemberRewards(member.guild, member.id);
      const record = state.users[member.id];
      if (!record) return;
      for (const [id, progress] of Object.entries(record.achievements || {})) if (ACHIEVEMENTS[id] && progress?.unlockedAt && !progress.claimedAt) await ensureClaimPrompt(member.guild, member.id, id);
    }).catch(() => {});
  });
  setInterval(() => { if (targetGuild) pollActivityFile(targetGuild).catch((error) => console.warn('[hidden-achievements] Activity poll failed:', error.message)); }, ACTIVITY_POLL_MS).unref?.();
  setInterval(() => { if (targetGuild) flushVoice(targetGuild).catch((error) => console.warn('[hidden-achievements] Voice flush failed:', error.message)); }, VOICE_FLUSH_MS).unref?.();
}

module.exports = {
  installHiddenAchievements,
  ACHIEVEMENTS,
  kuwaitDay,
  advanceStreak,
  levelFromXp,
  xpForLevel,
  standardAchievementIds,
  parseHiddenCommand,
  parseClaimCustomId,
  qualifiesForDailyActivity,
};
