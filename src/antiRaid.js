'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID || '1538557238627672164';
const DATA_CHANNEL_NAME = 'neverless-data';
const MARK_PREFIX = 'NLRAID2|mark|';
const SHORT_JOIN_WINDOW_MS = 10 * 1000;
const SHORT_JOIN_THRESHOLD = 8;
const LONG_JOIN_WINDOW_MS = 60 * 1000;
const LONG_JOIN_THRESHOLD = 15;
const RAID_MODE_MS = 10 * 60 * 1000;
const YOUNG_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_JOIN_MS = 30 * 60 * 1000;
const INITIAL_QUARANTINE_MS = 5 * 60 * 1000;
const RAID_MARK_MS = 30 * 60 * 1000;
const ESCALATION_TIMEOUT_MS = 10 * 60 * 1000;
const FLOOD_WINDOW_MS = 5 * 1000;
const FLOOD_MESSAGE_THRESHOLD = 7;
const MAX_SCAN_MESSAGES = 5000;

const guildStates = new Map();
const messageBursts = new Map();
const raidMarks = new Map();
const markMessageIds = new Map();
let installed = false;

function stateFor(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
    state = { joins: [], recentMembers: [], raidUntil: 0, activatedAt: 0 };
    guildStates.set(guildId, state);
  }
  return state;
}

function trimTimes(values, now, windowMs) {
  return (values || []).filter((value) => Number.isFinite(value) && now - value <= windowMs);
}

function joinFloodState(previous, now = Date.now()) {
  const recent = trimTimes(previous || [], now, LONG_JOIN_WINDOW_MS);
  recent.push(now);
  const shortCount = recent.filter((value) => now - value <= SHORT_JOIN_WINDOW_MS).length;
  const longCount = recent.length;
  return {
    joins: recent,
    triggered: shortCount >= SHORT_JOIN_THRESHOLD || longCount >= LONG_JOIN_THRESHOLD,
    shortCount,
    longCount,
  };
}

function accountAgeMs(member, now = Date.now()) {
  const created = Number(member?.user?.createdTimestamp);
  return Number.isFinite(created) ? Math.max(0, now - created) : Infinity;
}

function isSuspiciousRaidJoin(member, now = Date.now()) {
  if (!member?.user) return false;
  if (member.user.bot) return true;
  return accountAgeMs(member, now) < YOUNG_ACCOUNT_MS;
}

function raidActive(state, now = Date.now()) {
  return Boolean(state && Number(state.raidUntil) > now);
}

function isExemptMember(member) {
  if (!member?.guild) return true;
  if (member.id === member.guild.ownerId) return true;
  return member.permissions?.has?.(PermissionFlagsBits.Administrator) || false;
}

function messageBurst(previous, now = Date.now()) {
  const times = trimTimes(previous || [], now, FLOOD_WINDOW_MS);
  times.push(now);
  return { times, triggered: times.length >= FLOOD_MESSAGE_THRESHOLD };
}

function markKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function markContent(guildId, userId, mark) {
  return `${MARK_PREFIX}${guildId}|${userId}|${Math.floor(Number(mark.expiresAt) || 0)}|${Math.max(0, Number(mark.strikes) || 0)}`;
}

function parseMark(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(MARK_PREFIX)) return null;
  const [guildId, userId, rawExpires, rawStrikes] = value.slice(MARK_PREFIX.length).split('|');
  const expiresAt = Number(rawExpires);
  const strikes = Number(rawStrikes);
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
  if (!Number.isFinite(expiresAt) || !Number.isInteger(strikes) || strikes < 0 || strikes > 1) return null;
  return { guildId, userId, expiresAt, strikes };
}

function activeMark(mark, now = Date.now()) {
  return Boolean(mark && Number(mark.expiresAt) > now);
}

function markedAction(mark) {
  return Number(mark?.strikes) >= 1 ? 'kick' : 'timeout';
}

function dataChannel(guild) {
  return guild?.channels?.cache?.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name === DATA_CHANNEL_NAME,
  ) || null;
}

async function fetchAllDataMessages(channel, limit = MAX_SCAN_MESSAGES) {
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

async function persistMark(guild, userId, mark) {
  const channel = dataChannel(guild);
  if (!channel) return false;
  const key = markKey(guild.id, userId);
  const content = markContent(guild.id, userId, mark);
  const knownId = markMessageIds.get(key);
  let message = knownId ? await channel.messages.fetch(knownId).catch(() => null) : null;
  if (message) await message.edit(content);
  else {
    message = await channel.send(content);
    markMessageIds.set(key, message.id);
  }
  return true;
}

async function clearMark(guild, userId) {
  const key = markKey(guild.id, userId);
  raidMarks.delete(key);
  messageBursts.delete(key);
  const messageId = markMessageIds.get(key);
  markMessageIds.delete(key);
  const channel = dataChannel(guild);
  if (!channel || !messageId) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (message) await message.delete().catch(() => {});
}

async function loadGuildMarks(guild, now = Date.now()) {
  const channel = dataChannel(guild);
  if (!channel) return;
  const messages = await fetchAllDataMessages(channel);
  const latest = new Map();
  for (const message of messages) {
    if (message.author?.id !== guild.members.me?.id) continue;
    const parsed = parseMark(message.content);
    if (!parsed || parsed.guildId !== guild.id) continue;
    const key = markKey(parsed.guildId, parsed.userId);
    const previous = latest.get(key);
    if (!previous || message.createdTimestamp > previous.createdTimestamp) {
      latest.set(key, { ...parsed, messageId: message.id, createdTimestamp: message.createdTimestamp });
    }
  }

  for (const [key, mark] of latest) {
    markMessageIds.set(key, mark.messageId);
    if (mark.expiresAt > now) raidMarks.set(key, mark);
    else {
      const stale = await channel.messages.fetch(mark.messageId).catch(() => null);
      if (stale) await stale.delete().catch(() => {});
      markMessageIds.delete(key);
    }
  }
}

async function sendAlert(guild, text) {
  const channel = guild?.channels?.cache?.get(MOD_LOG_CHANNEL_ID);
  if (!channel?.isSendable?.()) return;
  await channel.send({ content: `🛡️ **Neverless Anti-Raid**\n${text}`, allowedMentions: { parse: [] } }).catch(() => {});
}

async function kickSuspicious(member, reason) {
  if (!member?.kickable) return false;
  try {
    await member.kick(reason);
    return true;
  } catch (error) {
    console.warn(`[anti-raid] Could not kick ${member.user?.tag || member.id}: ${error.message}`);
    return false;
  }
}

async function timeoutAtLeast(member, durationMs, reason, now = Date.now()) {
  if (!member?.moderatable) return false;
  const currentUntil = Number(member.communicationDisabledUntilTimestamp) || 0;
  const targetUntil = Math.max(currentUntil, now + durationMs);
  try {
    await member.timeout(Math.max(1, targetUntil - now), reason);
    return true;
  } catch (error) {
    console.warn(`[anti-raid] Could not timeout ${member.user?.tag || member.id}: ${error.message}`);
    return false;
  }
}

async function quarantineHuman(member, now = Date.now()) {
  const key = markKey(member.guild.id, member.id);
  const existing = raidMarks.get(key);
  if (activeMark(existing, now)) return false;

  const timedOut = await timeoutAtLeast(
    member,
    INITIAL_QUARANTINE_MS,
    'Neverless Anti-Raid: temporary quarantine during join flood',
    now,
  );
  if (!timedOut) return false;

  const mark = {
    guildId: member.guild.id,
    userId: member.id,
    expiresAt: now + RAID_MARK_MS,
    strikes: 0,
  };
  raidMarks.set(key, mark);
  await persistMark(member.guild, member.id, mark).catch(() => false);
  return true;
}

async function quarantineRecentWave(guild, state, now = Date.now(), skipMemberId = null) {
  const candidates = state.recentMembers.filter((row) => now - row.joinedAt <= LONG_JOIN_WINDOW_MS);
  let quarantined = 0;
  let botsRemoved = 0;
  for (const row of candidates) {
    if (skipMemberId && row.id === skipMemberId) continue;
    const member = guild.members.cache.get(row.id) || await guild.members.fetch(row.id).catch(() => null);
    if (!member || isExemptMember(member) || !isSuspiciousRaidJoin(member, now)) continue;
    if (member.user.bot) {
      if (await kickSuspicious(member, 'Neverless Anti-Raid: bot joined during raid wave')) botsRemoved += 1;
    } else if (await quarantineHuman(member, now)) quarantined += 1;
  }
  return { quarantined, botsRemoved };
}

async function activateRaidMode(guild, state, flood, now = Date.now(), currentMemberId = null) {
  const wasActive = raidActive(state, now);
  state.raidUntil = Math.max(state.raidUntil || 0, now + RAID_MODE_MS);
  if (!wasActive) state.activatedAt = now;

  const result = await quarantineRecentWave(guild, state, now, currentMemberId);
  if (!wasActive) {
    await sendAlert(
      guild,
      `تم تفعيل Raid Mode لمدة **10 دقائق** بعد موجة دخول (${flood.shortCount} خلال 10 ثواني / ${flood.longCount} خلال دقيقة).\nالحسابات القديمة تدخل طبيعي. الحسابات البشرية الجديدة المشتبه بها تأخذ **Timeout 5 دقائق + Raid Mark** بدل الطرد المباشر. تم عزل **${result.quarantined}** وطرد **${result.botsRemoved}** بوت مشبوه.`,
    );
  }
}

async function handleJoin(member) {
  if (!member?.guild || !member.user) return;
  const now = Date.now();
  const state = stateFor(member.guild.id);
  const flood = joinFloodState(state.joins, now);
  state.joins = flood.joins;
  state.recentMembers = state.recentMembers
    .filter((row) => now - row.joinedAt <= RECENT_JOIN_MS)
    .concat({ id: member.id, joinedAt: now });

  if (flood.triggered) await activateRaidMode(member.guild, state, flood, now, member.id);
  if (!raidActive(state, now) || isExemptMember(member) || !isSuspiciousRaidJoin(member, now)) return;

  if (member.user.bot) {
    const removed = await kickSuspicious(member, 'Neverless Anti-Raid: bot joined during raid mode');
    if (removed) await sendAlert(member.guild, `تم طرد بوت مشبوه دخل أثناء Raid Mode: **${member.user.tag || member.id}**.`);
    return;
  }

  const quarantined = await quarantineHuman(member, now);
  if (quarantined) {
    const ageHours = Math.floor(accountAgeMs(member, now) / (60 * 60 * 1000));
    await sendAlert(member.guild, `تم وضع حساب مشتبه به في **Timeout 5 دقائق** مع Raid Mark: **${member.user.tag || member.id}** (عمر الحساب تقريبًا ${ageHours} ساعة).`);
  }
}

function mentionFlood(message) {
  const users = message.mentions?.users?.size || 0;
  const roles = message.mentions?.roles?.size || 0;
  return Boolean(message.mentions?.everyone) || users + roles >= 5;
}

async function deleteBurstMessages(rows) {
  for (const row of rows || []) await row.delete().catch(() => {});
}

async function handleMarkedOffense(message, mark, rows, now = Date.now()) {
  const key = markKey(message.guildId, message.author.id);
  messageBursts.delete(key);
  await deleteBurstMessages(rows.map((row) => row.message));

  if (markedAction(mark) === 'kick') {
    const kicked = await kickSuspicious(message.member, 'Neverless Anti-Raid: repeated hostile behavior while raid-marked');
    if (kicked) {
      await clearMark(message.guild, message.author.id);
      await sendAlert(message.guild, `تم طرد <@${message.author.id}> بعد تكرار سلوك Raid وهو ما زال تحت المراقبة.`);
    }
    return;
  }

  const timedOut = await timeoutAtLeast(
    message.member,
    ESCALATION_TIMEOUT_MS,
    'Neverless Anti-Raid: hostile behavior while raid-marked',
    now,
  );
  if (!timedOut) return;

  const next = {
    ...mark,
    strikes: 1,
    expiresAt: now + ESCALATION_TIMEOUT_MS + RAID_MARK_MS,
  };
  raidMarks.set(key, next);
  await persistMark(message.guild, message.author.id, next).catch(() => false);
  await sendAlert(message.guild, `تم إعطاء <@${message.author.id}> **Timeout 10 دقائق** بسبب سلوك غير طبيعي أثناء Raid Mark. إذا كررها قبل انتهاء الـMark سيتم طرده.`);
}

async function handleMessage(message) {
  if (!message?.guildId || message.author?.bot || !message.member || isExemptMember(message.member)) return;
  const now = Date.now();
  const key = markKey(message.guildId, message.author.id);
  const mark = raidMarks.get(key);
  if (!activeMark(mark, now)) {
    if (mark) await clearMark(message.guild, message.author.id);
    return;
  }

  const previous = messageBursts.get(key) || [];
  const current = previous.filter((row) => now - row.at <= FLOOD_WINDOW_MS);
  current.push({ at: now, message });
  messageBursts.set(key, current);

  const burst = messageBurst(current.map((row) => row.at).slice(0, -1), now);
  if (!burst.triggered && !mentionFlood(message)) return;
  await handleMarkedOffense(message, mark, current, now);
}

async function cleanupExpiredMarks(client, now = Date.now()) {
  for (const [key, mark] of [...raidMarks.entries()]) {
    if (activeMark(mark, now)) continue;
    const guild = client.guilds.cache.get(mark.guildId);
    raidMarks.delete(key);
    messageBursts.delete(key);
    if (guild) await clearMark(guild, mark.userId).catch(() => {});
  }
}

function installAntiRaid(client) {
  if (installed) return;
  installed = true;

  client.once('ready', () => {
    Promise.all([...client.guilds.cache.values()].map((guild) => loadGuildMarks(guild)))
      .catch((error) => console.warn('[anti-raid] Could not restore raid marks:', error.message));
    const timer = setInterval(() => {
      cleanupExpiredMarks(client).catch((error) => console.warn('[anti-raid] Mark cleanup failed:', error.message));
    }, 5 * 60 * 1000);
    timer.unref?.();
  });

  client.on('guildMemberAdd', (member) => {
    handleJoin(member).catch((error) => console.error('[anti-raid] join handler failed:', error));
  });
  client.on('messageCreate', (message) => {
    handleMessage(message).catch((error) => console.error('[anti-raid] message handler failed:', error));
  });
  console.log('[anti-raid] Join-flood quarantine + persistent raid marks installed.');
}

module.exports = {
  installAntiRaid,
  joinFloodState,
  accountAgeMs,
  isSuspiciousRaidJoin,
  raidActive,
  messageBurst,
  activeMark,
  markedAction,
  parseMark,
  constants: {
    SHORT_JOIN_WINDOW_MS,
    SHORT_JOIN_THRESHOLD,
    LONG_JOIN_WINDOW_MS,
    LONG_JOIN_THRESHOLD,
    RAID_MODE_MS,
    YOUNG_ACCOUNT_MS,
    INITIAL_QUARANTINE_MS,
    RAID_MARK_MS,
    ESCALATION_TIMEOUT_MS,
    FLOOD_WINDOW_MS,
    FLOOD_MESSAGE_THRESHOLD,
  },
};
