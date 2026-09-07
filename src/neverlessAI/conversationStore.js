'use strict';

const zlib = require('node:zlib');
const { getTurns, appendTurn } = require('./memory');

const DATA_CHANNEL_NAME = 'neverless-data';
const RECORD_PREFIX = 'NLAIC1|';
const MAX_SCAN_MESSAGES = 1000;
const MAX_REMOTE_TURNS = 8;

const loadedUsers = new Set();
const recordMessageIds = new Map();
const dataChannels = new Map();
let writeQueue = Promise.resolve();

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactTurns(turns, count = MAX_REMOTE_TURNS, maxChars = 420) {
  return (Array.isArray(turns) ? turns : [])
    .filter((row) => row && ['user', 'assistant'].includes(row.role) && row.content)
    .slice(-count)
    .map((row) => [row.role === 'assistant' ? 'a' : 'u', clean(row.content, maxChars)]);
}

function pack(value) {
  const raw = Buffer.from(JSON.stringify(value), 'utf8');
  return zlib.deflateRawSync(raw, { level: 9 }).toString('base64url');
}

function unpack(value) {
  try {
    const raw = zlib.inflateRawSync(Buffer.from(String(value || ''), 'base64url')).toString('utf8');
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.t) ? parsed.t : [];
    return rows
      .filter((row) => Array.isArray(row) && ['u', 'a'].includes(row[0]) && row[1])
      .slice(-MAX_REMOTE_TURNS)
      .map((row) => ({ role: row[0] === 'a' ? 'assistant' : 'user', content: clean(row[1], 600) }));
  } catch {
    return [];
  }
}

function recordContent(guildId, userId, turns) {
  const plans = [
    [8, 420],
    [8, 320],
    [6, 320],
    [6, 240],
    [4, 240],
    [4, 180],
    [2, 180],
  ];
  for (const [count, chars] of plans) {
    const payload = pack({ t: compactTurns(turns, count, chars) });
    const content = `${RECORD_PREFIX}${guildId}|${userId}|${payload}`;
    if (content.length <= 1900) return content;
  }
  return null;
}

function parseRecord(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(RECORD_PREFIX)) return null;
  const parts = value.split('|');
  if (parts.length !== 4) return null;
  const [, guildId, userId, payload] = parts;
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
  return { guildId, userId, turns: unpack(payload) };
}

async function getDataChannel(guild) {
  const cached = dataChannels.get(guild.id);
  if (cached?.guildId === guild.id) return cached;
  let channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  }
  if (channel) dataChannels.set(guild.id, channel);
  return channel;
}

async function findRemoteRecord(guild, userId, botUserId) {
  const channel = await getDataChannel(guild);
  if (!channel) return null;
  const prefix = `${RECORD_PREFIX}${guild.id}|${userId}|`;
  let before;
  let scanned = 0;
  while (scanned < MAX_SCAN_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    scanned += batch.size;
    for (const message of batch.values()) {
      if (botUserId && message.author?.id !== botUserId) continue;
      if (!String(message.content || '').startsWith(prefix)) continue;
      const parsed = parseRecord(message.content);
      if (!parsed) continue;
      recordMessageIds.set(key(guild.id, userId), message.id);
      return parsed;
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return null;
}

async function hydrateConversation(guild, userId, botUserId) {
  const id = key(guild.id, userId);
  if (loadedUsers.has(id)) return getTurns(userId);
  loadedUsers.add(id);

  const local = getTurns(userId);
  if (local.length) return local;

  const remote = await findRemoteRecord(guild, userId, botUserId).catch(() => null);
  for (const turn of remote?.turns || []) appendTurn(userId, turn.role, turn.content);
  return getTurns(userId);
}

function persistConversation(guild, userId, botUserId) {
  const id = key(guild.id, userId);
  const content = recordContent(guild.id, userId, getTurns(userId));
  if (!content) return Promise.resolve();

  writeQueue = writeQueue.then(async () => {
    const channel = await getDataChannel(guild);
    if (!channel) return;
    let message = null;
    const knownId = recordMessageIds.get(id);
    if (knownId) message = await channel.messages.fetch(knownId).catch(() => null);
    if (!message) {
      const remote = await findRemoteRecord(guild, userId, botUserId).catch(() => null);
      const remoteId = recordMessageIds.get(id);
      if (remote && remoteId) message = await channel.messages.fetch(remoteId).catch(() => null);
    }
    if (message) await message.edit(content);
    else {
      message = await channel.send(content);
      recordMessageIds.set(id, message.id);
    }
  }).catch((error) => console.warn('[neverless-ai] Conversation persistence failed:', error.message));

  return writeQueue;
}

module.exports = {
  hydrateConversation,
  persistConversation,
  parseRecord,
  recordContent,
  MAX_REMOTE_TURNS,
};
