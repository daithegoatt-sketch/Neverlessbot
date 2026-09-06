'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const { DATA_DIR } = require('../store');

const INDEX_FILE = path.join(DATA_DIR, 'neverless-ai-messages.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'neverless-ai-index-state.json');
const DATA_CHANNEL_NAME = 'neverless-data';
const BACKFILL_PAGES_PER_CHANNEL = 2;
const BACKFILL_CHANNELS_PER_CYCLE = 4;
const BACKFILL_INTERVAL_MS = 60_000;
const MAX_RESULTS = 20;

const byId = new Map();
let backfillState = { channels: {} };
let backfillTimer = null;
let writeQueue = Promise.resolve();
let runningBackfill = false;

function clean(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return [...new Set(normalize(value).split(' ').filter((token) => token.length >= 2))].slice(0, 24);
}

function isInternalChannel(channel) {
  return !channel || channel.name === DATA_CHANNEL_NAME || String(channel.name || '').startsWith('secret-');
}

function isIndexableChannel(channel) {
  return Boolean(
    channel?.guild
    && !isInternalChannel(channel)
    && channel.isTextBased?.()
    && channel.messages?.fetch,
  );
}

function recordFromMessage(message) {
  if (!message?.guildId || !message.id || isInternalChannel(message.channel)) return null;
  const content = clean(message.content, 1800);
  const attachmentText = message.attachments?.size
    ? [...message.attachments.values()].slice(0, 4).map((item) => clean(item.name || item.url, 120)).join(' ')
    : '';
  if (!content && !attachmentText) return null;
  return {
    id: String(message.id),
    guildId: String(message.guildId),
    channelId: String(message.channelId),
    authorId: String(message.author?.id || ''),
    authorName: clean(message.member?.displayName || message.author?.globalName || message.author?.username || 'Unknown', 120),
    bot: Boolean(message.author?.bot),
    content: content || `[attachment] ${attachmentText}`,
    createdTimestamp: Number(message.createdTimestamp) || Date.now(),
    editedTimestamp: Number(message.editedTimestamp) || null,
    replyTo: message.reference?.messageId ? String(message.reference.messageId) : null,
  };
}

function appendLine(row) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = `${JSON.stringify(row)}\n`;
  writeQueue = writeQueue.then(() => fs.promises.appendFile(INDEX_FILE, line)).catch((error) => {
    console.warn('[neverless-ai-index] Append failed:', error.message);
  });
  return writeQueue;
}

function upsertRecord(row, persist = true) {
  if (!row?.id) return false;
  if (row.deleted) byId.delete(String(row.id));
  else byId.set(String(row.id), row);
  if (persist) appendLine(row);
  return true;
}

function captureMessage(message) {
  const row = recordFromMessage(message);
  return row ? upsertRecord(row, true) : false;
}

function removeMessage(message) {
  if (!message?.id) return;
  upsertRecord({ id: String(message.id), deleted: true, deletedAt: Date.now() }, true);
}

function loadIndex() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const lines = fs.readFileSync(INDEX_FILE, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.id) upsertRecord(row, false);
        } catch {}
      }
    } catch (error) {
      console.warn('[neverless-ai-index] Index load failed:', error.message);
    }
  }
  if (fs.existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (parsed?.channels && typeof parsed.channels === 'object') backfillState = parsed;
    } catch (error) {
      console.warn('[neverless-ai-index] State load failed:', error.message);
    }
  }
}
loadIndex();

function saveBackfillState() {
  const snapshot = JSON.stringify(backfillState, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(STATE_FILE, snapshot)).catch((error) => {
    console.warn('[neverless-ai-index] State write failed:', error.message);
  });
  return writeQueue;
}

function channelState(channelId) {
  const id = String(channelId);
  backfillState.channels[id] ||= { before: null, complete: false, updatedAt: null };
  return backfillState.channels[id];
}

function canBotRead(channel) {
  const me = channel?.guild?.members?.me;
  if (!me) return false;
  const permissions = channel.permissionsFor?.(me);
  return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.ReadMessageHistory));
}

function canMemberRead(channel, member) {
  if (!channel || !member) return false;
  const permissions = channel.permissionsFor?.(member);
  return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.ReadMessageHistory));
}

async function backfillChannel(channel) {
  if (!isIndexableChannel(channel) || !canBotRead(channel)) return;
  const state = channelState(channel.id);
  if (state.complete) return;
  let before = state.before || undefined;
  for (let page = 0; page < BACKFILL_PAGES_PER_CHANNEL; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) {
      state.complete = true;
      break;
    }
    const rows = [...batch.values()];
    for (const message of rows) {
      const row = recordFromMessage(message);
      if (row && !byId.has(row.id)) upsertRecord(row, true);
    }
    const oldest = rows.reduce((best, message) => (!best || message.createdTimestamp < best.createdTimestamp ? message : best), null);
    before = oldest?.id;
    state.before = before || state.before;
    state.updatedAt = new Date().toISOString();
    if (batch.size < 100) {
      state.complete = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
}

async function backfillCycle(guild) {
  if (runningBackfill) return;
  runningBackfill = true;
  try {
    await guild.channels.fetch().catch(() => null);
    const channels = [...guild.channels.cache.values()]
      .filter((channel) => isIndexableChannel(channel) && canBotRead(channel) && !channelState(channel.id).complete)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .slice(0, BACKFILL_CHANNELS_PER_CYCLE);
    for (const channel of channels) await backfillChannel(channel);
    await saveBackfillState();
  } finally {
    runningBackfill = false;
  }
}

function startBackfill(guild) {
  setTimeout(() => backfillCycle(guild).catch((error) => console.warn('[neverless-ai-index] Backfill failed:', error.message)), 15_000).unref?.();
  if (backfillTimer) clearInterval(backfillTimer);
  backfillTimer = setInterval(() => {
    backfillCycle(guild).catch((error) => console.warn('[neverless-ai-index] Backfill failed:', error.message));
  }, BACKFILL_INTERVAL_MS);
  backfillTimer.unref?.();
}

function scoreRow(row, queryTokens) {
  if (!queryTokens.length) return 1;
  const text = normalize(`${row.authorName} ${row.content}`);
  let score = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) score += token.length >= 5 ? 3 : 2;
  }
  const phrase = normalize(queryTokens.join(' '));
  if (phrase && text.includes(phrase)) score += 5;
  return score;
}

function jumpUrl(row) {
  return `https://discord.com/channels/${row.guildId}/${row.channelId}/${row.id}`;
}

function publicRow(row, guild) {
  const channel = guild.channels.cache.get(row.channelId);
  return {
    message_id: row.id,
    channel_id: row.channelId,
    channel: channel?.name || row.channelId,
    author_id: row.authorId,
    author: row.authorName,
    content: row.content,
    timestamp: new Date(row.createdTimestamp).toISOString(),
    jump_url: jumpUrl(row),
  };
}

function searchMessages(guild, member, options = {}) {
  const queryTokens = tokenize(options.query || '');
  const authorId = options.authorId ? String(options.authorId) : null;
  const channelId = options.channelId ? String(options.channelId) : null;
  const after = options.after ? Date.parse(options.after) : NaN;
  const before = options.before ? Date.parse(options.before) : NaN;
  const limit = Math.max(1, Math.min(MAX_RESULTS, Number(options.limit) || 8));
  const rows = [];

  for (const row of byId.values()) {
    if (row.guildId !== guild.id) continue;
    if (authorId && row.authorId !== authorId) continue;
    if (channelId && row.channelId !== channelId) continue;
    if (Number.isFinite(after) && row.createdTimestamp < after) continue;
    if (Number.isFinite(before) && row.createdTimestamp > before) continue;
    const channel = guild.channels.cache.get(row.channelId);
    if (!canMemberRead(channel, member)) continue;
    const score = scoreRow(row, queryTokens);
    if (queryTokens.length && score <= 0) continue;
    rows.push({ row, score });
  }

  rows.sort((a, b) => b.score - a.score || b.row.createdTimestamp - a.row.createdTimestamp);
  return rows.slice(0, limit).map(({ row }) => publicRow(row, guild));
}

function getMessage(guild, member, messageId) {
  const row = byId.get(String(messageId));
  if (!row || row.guildId !== guild.id) return null;
  const channel = guild.channels.cache.get(row.channelId);
  return canMemberRead(channel, member) ? publicRow(row, guild) : null;
}

function archiveCompleteForMember(guild, member) {
  const visible = [...guild.channels.cache.values()].filter((channel) => isIndexableChannel(channel) && canMemberRead(channel, member));
  return visible.every((channel) => Boolean(channelState(channel.id).complete));
}

function firstMessageForMember(guild, requester, authorId) {
  let first = null;
  for (const row of byId.values()) {
    if (row.guildId !== guild.id || row.authorId !== String(authorId)) continue;
    const channel = guild.channels.cache.get(row.channelId);
    if (!canMemberRead(channel, requester)) continue;
    if (!first || row.createdTimestamp < first.createdTimestamp) first = row;
  }
  return {
    message: first ? publicRow(first, guild) : null,
    archive_complete: archiveCompleteForMember(guild, requester),
  };
}

function recentMessages(guild, member, channelId, limit = 30) {
  const rows = searchMessages(guild, member, { channelId, limit: Math.max(1, Math.min(20, limit)) });
  return rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function indexStats(guild, member) {
  let visibleMessages = 0;
  const visibleChannels = new Set();
  for (const row of byId.values()) {
    if (row.guildId !== guild.id) continue;
    const channel = guild.channels.cache.get(row.channelId);
    if (!canMemberRead(channel, member)) continue;
    visibleMessages += 1;
    visibleChannels.add(row.channelId);
  }
  return {
    visible_messages: visibleMessages,
    visible_channels: visibleChannels.size,
    archive_complete: archiveCompleteForMember(guild, member),
  };
}

module.exports = {
  captureMessage,
  removeMessage,
  startBackfill,
  backfillCycle,
  searchMessages,
  getMessage,
  firstMessageForMember,
  recentMessages,
  indexStats,
  normalize,
  tokenize,
  isIndexableChannel,
};
