'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const { DATA_DIR } = require('../store');
const { levelFromXp } = require('../activityV2');
const { getLinkedUid, whenAccountStoreReady } = require('../genshin/accountStore');
const { getEntries } = require('../genshin/buildHistory');
const { resolveCharacter } = require('../genshin/characterResolver');
const { ACHIEVEMENTS } = require('../hiddenAchievementsV3');
const {
  searchMessages,
  getMessage,
  firstMessageForMember,
  recentMessages,
  indexStats,
} = require('./messageIndex');

const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden-achievements-v2.json');

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
}

async function resolveMember(guild, query, fallback = null) {
  const raw = String(query || '').trim();
  if (!raw) return fallback;
  const mention = raw.match(/^<@!?(\d{15,22})>$/)?.[1];
  const id = mention || (/^\d{15,22}$/.test(raw) ? raw : null);
  if (id) return guild.members.cache.get(id) || guild.members.fetch(id).catch(() => null);
  await guild.members.fetch().catch(() => null);
  const wanted = normalize(raw);
  const members = [...guild.members.cache.values()].filter((member) => !member.user.bot);
  return members.find((member) => [member.displayName, member.user.username, member.user.globalName].some((name) => normalize(name) === wanted))
    || members.find((member) => [member.displayName, member.user.username, member.user.globalName].some((name) => normalize(name).includes(wanted)))
    || null;
}

async function resolveChannel(guild, query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const mention = raw.match(/^<#(\d{15,22})>$/)?.[1];
  const id = mention || (/^\d{15,22}$/.test(raw) ? raw : null);
  if (id) return guild.channels.cache.get(id) || guild.channels.fetch(id).catch(() => null);
  const wanted = normalize(raw.replace(/^#/, ''));
  return [...guild.channels.cache.values()].find((channel) => normalize(channel.name) === wanted)
    || [...guild.channels.cache.values()].find((channel) => normalize(channel.name).includes(wanted))
    || null;
}

function canRead(requester, channel) {
  if (!requester || !channel) return false;
  const permissions = channel.permissionsFor?.(requester);
  return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.ReadMessageHistory));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function compactHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const snapshot = entry.snapshot || {};
  const evaluation = entry.evaluation || {};
  const stats = snapshot.stats || entry.stats || {};
  return {
    saved_at: entry.savedAt || entry.createdAt || entry.timestamp || null,
    score: entry.score ?? evaluation.score ?? entry.rating ?? null,
    raw_score: entry.rawScore ?? evaluation.rawScore ?? null,
    akasha_percent: entry.akashaPercentile ?? entry.akasha?.topPercent ?? entry.akasha ?? null,
    weapon: snapshot.weapon?.name || entry.weapon?.name || entry.weapon || null,
    refinement: snapshot.weapon?.refinement || entry.weapon?.refinement || null,
    stats: {
      crit_rate: stats.critRate ?? null,
      crit_dmg: stats.critDmg ?? null,
      er: stats.er ?? stats.energyRecharge ?? null,
      atk: stats.atk ?? null,
      hp: stats.hp ?? null,
      em: stats.em ?? null,
    },
  };
}

function hiddenRecordFor(userId) {
  const parsed = readJson(HIDDEN_FILE);
  const row = parsed?.users?.[String(userId)];
  if (!row) return null;
  if (Object.prototype.hasOwnProperty.call(row, 'h')) {
    const achievements = {};
    for (const [id, values] of Object.entries(row.h || {})) {
      if (!ACHIEVEMENTS[id] || !Array.isArray(values)) continue;
      achievements[id] = { unlockedAt: values[0] || null, claimedAt: values[1] || null };
    }
    return { currentStreak: Number(row.s) || 0, bestStreak: Number(row.b) || 0, activeDays: Number(row.a) || 0, voiceMs: Number(row.v) || 0, achievements };
  }
  return row;
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'search_server_messages',
    description: 'Search archived Discord messages the requesting member is allowed to see. Use for questions about what someone said, when something was discussed, or finding an old message.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or phrase to search for. Can be empty when filters are enough.' },
        member: { type: 'string', description: 'Optional member mention, ID, username or display name.' },
        channel: { type: 'string', description: 'Optional channel mention, ID or name.' },
        after: { type: 'string', description: 'Optional ISO date/time lower bound.' },
        before: { type: 'string', description: 'Optional ISO date/time upper bound.' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_first_server_message',
    description: 'Get the earliest currently indexed Discord message for a member, with an archive-complete flag. Never call it definitively the first message if archive_complete is false.',
    parameters: {
      type: 'object',
      properties: { member: { type: 'string', description: 'Member mention, ID, username or display name. Empty means the requester.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_message_by_id',
    description: 'Read one indexed Discord message by message ID if the requester is allowed to see its channel.',
    parameters: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_recent_channel_messages',
    description: 'Read recent indexed messages from a channel the requester can see, useful as source material for a summary.',
    parameters: {
      type: 'object',
      properties: { channel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
      required: ['channel'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_member_activity',
    description: 'Read Neverless Activity XP, level and invite count for a server member without changing anything.',
    parameters: {
      type: 'object',
      properties: { member: { type: 'string', description: 'Member mention, ID, username or display name. Empty means requester.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_genshin_rating_history',
    description: 'Read saved Neverless Genshin build rating history for a character. This is read-only and uses the existing linked UID/history system.',
    parameters: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Member mention, ID, username or display name. Empty means requester.' },
        character: { type: 'string', description: 'Genshin character name.' },
      },
      required: ['character'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_hidden_achievement_progress',
    description: 'Read already-unlocked Hidden Achievement progress. Only the member themself or an Administrator may read it. Never reveal undiscovered achievement conditions.',
    parameters: {
      type: 'object',
      properties: { member: { type: 'string', description: 'Member mention, ID, username or display name. Empty means requester.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_server_archive_status',
    description: 'Check how much of the Discord message archive is indexed and whether historical backfill is complete for channels the requester can see.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function createServerToolExecutor(context) {
  const { guild, requester } = context;
  return async function execute(name, args = {}) {
    if (!guild || !requester) return { error: 'NO_GUILD_CONTEXT' };

    if (name === 'search_server_messages') {
      const member = args.member ? await resolveMember(guild, args.member) : null;
      const channel = args.channel ? await resolveChannel(guild, args.channel) : null;
      if (args.member && !member) return { error: 'MEMBER_NOT_FOUND' };
      if (args.channel && !channel) return { error: 'CHANNEL_NOT_FOUND' };
      if (channel && !canRead(requester, channel)) return { error: 'NO_CHANNEL_ACCESS' };
      const results = searchMessages(guild, requester, {
        query: args.query || '',
        authorId: member?.id || null,
        channelId: channel?.id || null,
        after: args.after || null,
        before: args.before || null,
        limit: args.limit || 8,
      });
      return { results, ...indexStats(guild, requester) };
    }

    if (name === 'get_first_server_message') {
      const member = args.member ? await resolveMember(guild, args.member) : requester;
      if (!member) return { error: 'MEMBER_NOT_FOUND' };
      return { member: { id: member.id, name: member.displayName }, ...firstMessageForMember(guild, requester, member.id) };
    }

    if (name === 'get_message_by_id') {
      const row = getMessage(guild, requester, args.message_id);
      return row ? { message: row } : { error: 'MESSAGE_NOT_FOUND_OR_NOT_VISIBLE' };
    }

    if (name === 'get_recent_channel_messages') {
      const channel = await resolveChannel(guild, args.channel);
      if (!channel) return { error: 'CHANNEL_NOT_FOUND' };
      if (!canRead(requester, channel)) return { error: 'NO_CHANNEL_ACCESS' };
      return { channel: { id: channel.id, name: channel.name }, messages: recentMessages(guild, requester, channel.id, args.limit || 20), ...indexStats(guild, requester) };
    }

    if (name === 'get_member_activity') {
      const member = args.member ? await resolveMember(guild, args.member) : requester;
      if (!member) return { error: 'MEMBER_NOT_FOUND' };
      const parsed = readJson(ACTIVITY_FILE);
      const row = parsed?.guilds?.[guild.id]?.users?.[member.id];
      if (!row) return { member: { id: member.id, name: member.displayName }, activity: null };
      const xp = Number(row.allXp) || 0;
      return {
        member: { id: member.id, name: member.displayName },
        activity: { total_xp: xp, level: levelFromXp(xp), qualified_messages_estimate: Math.floor(xp / 10), invites: Number(row.invites) || 0, updated_at: row.updatedAt || null },
      };
    }

    if (name === 'get_genshin_rating_history') {
      const member = args.member ? await resolveMember(guild, args.member) : requester;
      if (!member) return { error: 'MEMBER_NOT_FOUND' };
      await whenAccountStoreReady().catch(() => {});
      const uid = getLinkedUid(member.id);
      if (!uid) return { member: { id: member.id, name: member.displayName }, linked: false, history: [] };
      const character = await resolveCharacter(args.character).catch(() => null) || String(args.character || '').trim();
      const entries = getEntries(member.id, uid, character).map(compactHistoryEntry).filter(Boolean);
      return { member: { id: member.id, name: member.displayName }, linked: true, character, history: entries };
    }

    if (name === 'get_hidden_achievement_progress') {
      const member = args.member ? await resolveMember(guild, args.member) : requester;
      if (!member) return { error: 'MEMBER_NOT_FOUND' };
      if (member.id !== requester.id && !isAdmin(requester)) return { error: 'PRIVATE_MEMBER_DATA' };
      const row = hiddenRecordFor(member.id);
      if (!row) return { member: { id: member.id, name: member.displayName }, progress: null };
      const unlocked = Object.entries(row.achievements || {}).filter(([, progress]) => progress?.unlockedAt).map(([id, progress]) => ({
        id,
        name: ACHIEVEMENTS[id]?.name || id,
        unlocked_at: progress.unlockedAt,
        claimed_at: progress.claimedAt || null,
      }));
      return {
        member: { id: member.id, name: member.displayName },
        progress: { current_streak: Number(row.currentStreak) || 0, best_streak: Number(row.bestStreak) || 0, active_days: Number(row.activeDays) || 0, qualified_voice_minutes: Math.floor((Number(row.voiceMs) || 0) / 60_000), unlocked },
      };
    }

    if (name === 'get_server_archive_status') return indexStats(guild, requester);
    return { error: 'UNKNOWN_TOOL' };
  };
}

module.exports = {
  TOOL_DEFINITIONS,
  createServerToolExecutor,
  resolveMember,
  resolveChannel,
  compactHistoryEntry,
  hiddenRecordFor,
};
