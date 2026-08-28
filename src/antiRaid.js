'use strict';

const { PermissionFlagsBits } = require('discord.js');

const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID || '1538557238627672164';
const SHORT_JOIN_WINDOW_MS = 10 * 1000;
const SHORT_JOIN_THRESHOLD = 8;
const LONG_JOIN_WINDOW_MS = 60 * 1000;
const LONG_JOIN_THRESHOLD = 15;
const RAID_MODE_MS = 10 * 60 * 1000;
const YOUNG_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_JOIN_MS = 30 * 60 * 1000;
const FLOOD_WINDOW_MS = 5 * 1000;
const FLOOD_MESSAGE_THRESHOLD = 7;
const RAID_TIMEOUT_MS = 10 * 60 * 1000;

const guildStates = new Map();
const messageBursts = new Map();
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

async function quarantineRecentWave(guild, state, now = Date.now(), skipMemberId = null) {
  const candidates = state.recentMembers.filter((row) => now - row.joinedAt <= LONG_JOIN_WINDOW_MS);
  let removed = 0;
  for (const row of candidates) {
    if (skipMemberId && row.id === skipMemberId) continue;
    const member = guild.members.cache.get(row.id) || await guild.members.fetch(row.id).catch(() => null);
    if (!member || isExemptMember(member) || !isSuspiciousRaidJoin(member, now)) continue;
    if (await kickSuspicious(member, 'Neverless Anti-Raid: suspicious account in join flood')) removed += 1;
  }
  return removed;
}

async function activateRaidMode(guild, state, flood, now = Date.now(), currentMemberId = null) {
  const wasActive = raidActive(state, now);
  state.raidUntil = Math.max(state.raidUntil || 0, now + RAID_MODE_MS);
  if (!wasActive) state.activatedAt = now;

  const removed = await quarantineRecentWave(guild, state, now, currentMemberId);
  if (!wasActive) {
    await sendAlert(
      guild,
      `تم تفعيل Raid Mode لمدة **10 دقائق** بعد موجة دخول (${flood.shortCount} خلال 10 ثواني / ${flood.longCount} خلال دقيقة).\nالحسابات الطبيعية القديمة مسموح لها بالدخول؛ تم إيقاف **${removed}** حساب/بوت مشبوه من الموجة.`,
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
  const removed = await kickSuspicious(member, 'Neverless Anti-Raid: suspicious account joined during raid mode');
  if (removed) {
    const ageHours = Math.floor(accountAgeMs(member, now) / (60 * 60 * 1000));
    await sendAlert(member.guild, `تم إيقاف حساب مشبوه دخل أثناء Raid Mode: **${member.user.tag || member.id}** (عمر الحساب تقريبًا ${ageHours} ساعة).`);
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

async function handleMessage(message) {
  if (!message?.guildId || message.author?.bot || !message.member) return;
  const state = stateFor(message.guildId);
  const now = Date.now();
  if (!raidActive(state, now) || isExemptMember(message.member)) return;

  const joinedAt = Number(message.member.joinedTimestamp);
  if (!Number.isFinite(joinedAt) || now - joinedAt > RECENT_JOIN_MS) return;

  const key = `${message.guildId}:${message.author.id}`;
  const previous = messageBursts.get(key) || [];
  const current = previous.filter((row) => now - row.at <= FLOOD_WINDOW_MS);
  current.push({ at: now, message });
  messageBursts.set(key, current);

  const burst = messageBurst(current.map((row) => row.at).slice(0, -1), now);
  if (!burst.triggered && !mentionFlood(message)) return;

  messageBursts.delete(key);
  await deleteBurstMessages(current.map((row) => row.message));

  if (message.member.moderatable) {
    await message.member.timeout(RAID_TIMEOUT_MS, 'Neverless Anti-Raid: message flood during raid mode').catch(() => {});
  }
  await sendAlert(message.guild, `تم إيقاف سبام سريع من <@${message.author.id}> أثناء Raid Mode وحذف الرسائل الأخيرة.`);
}

function installAntiRaid(client) {
  if (installed) return;
  installed = true;
  client.on('guildMemberAdd', (member) => {
    handleJoin(member).catch((error) => console.error('[anti-raid] join handler failed:', error));
  });
  client.on('messageCreate', (message) => {
    handleMessage(message).catch((error) => console.error('[anti-raid] message handler failed:', error));
  });
  console.log('[anti-raid] Conservative join-flood protection installed.');
}

module.exports = {
  installAntiRaid,
  joinFloodState,
  accountAgeMs,
  isSuspiciousRaidJoin,
  raidActive,
  messageBurst,
  constants: {
    SHORT_JOIN_WINDOW_MS,
    SHORT_JOIN_THRESHOLD,
    LONG_JOIN_WINDOW_MS,
    LONG_JOIN_THRESHOLD,
    RAID_MODE_MS,
    YOUNG_ACCOUNT_MS,
    FLOOD_WINDOW_MS,
    FLOOD_MESSAGE_THRESHOLD,
  },
};
