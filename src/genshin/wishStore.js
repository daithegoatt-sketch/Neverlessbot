'use strict';

const zlib = require('node:zlib');
const { ChannelType } = require('discord.js');

const DATA_CHANNEL_NAME = 'neverless-data';
const STATE_PREFIX = 'NLWISH1|';
const MAX_SCAN_MESSAGES = 5000;

const users = new Map();
const recordMessageIds = new Map();
let dataChannel = null;
let readyPromise = Promise.resolve();
let mutationQueue = Promise.resolve();

function defaultState(userId) {
  return {
    userId: String(userId),
    banner: 'flins',
    fivePity: 0,
    fourPity: 0,
    guaranteed5: false,
    guaranteed4: false,
    captureLosses: 0,
    totalWishes: 0,
    characters: {},
    weapons: {},
    updatedAt: Date.now(),
  };
}

function cleanInventory(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [name, count] of Object.entries(value)) {
    const n = Math.max(0, Math.min(9999, Math.floor(Number(count) || 0)));
    if (name && n > 0) out[String(name).slice(0, 100)] = n;
  }
  return out;
}

function sanitizeState(raw, fallbackUserId) {
  const base = defaultState(fallbackUserId || raw?.userId || '0');
  if (!raw || typeof raw !== 'object') return base;
  return {
    userId: String(raw.userId || fallbackUserId || base.userId),
    banner: ['flins', 'ineffa'].includes(String(raw.banner || '').toLowerCase()) ? String(raw.banner).toLowerCase() : 'flins',
    fivePity: Math.max(0, Math.min(89, Math.floor(Number(raw.fivePity) || 0))),
    fourPity: Math.max(0, Math.min(9, Math.floor(Number(raw.fourPity) || 0))),
    guaranteed5: Boolean(raw.guaranteed5),
    guaranteed4: Boolean(raw.guaranteed4),
    captureLosses: Math.max(0, Math.min(3, Math.floor(Number(raw.captureLosses) || 0))),
    totalWishes: Math.max(0, Math.floor(Number(raw.totalWishes) || 0)),
    characters: cleanInventory(raw.characters),
    weapons: cleanInventory(raw.weapons),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function encodeState(state) {
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(state), 'utf8'), { level: 9 }).toString('base64url');
}

function recordContent(state) {
  return `${STATE_PREFIX}${state.userId}|${encodeState(state)}`;
}

function parseRecord(content) {
  const text = String(content || '').trim();
  if (!text.startsWith(STATE_PREFIX)) return null;
  const rest = text.slice(STATE_PREFIX.length);
  const split = rest.indexOf('|');
  if (split < 1) return null;
  const userId = rest.slice(0, split);
  if (!/^\d{15,22}$/.test(userId)) return null;
  try {
    const raw = JSON.parse(zlib.inflateRawSync(Buffer.from(rest.slice(split + 1), 'base64url')).toString('utf8'));
    return sanitizeState(raw, userId);
  } catch {
    return null;
  }
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

async function initWishStore(client, wishChannelId) {
  readyPromise = (async () => {
    const wishChannel = client.channels.cache.get(wishChannelId)
      || await client.channels.fetch(wishChannelId).catch(() => null);
    const guild = wishChannel?.guild;
    if (!guild) throw new Error('WISH_GUILD_NOT_FOUND');

    dataChannel = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === DATA_CHANNEL_NAME,
    ) || null;
    if (!dataChannel) {
      console.warn('[wish] neverless-data not found; simulator state is memory-only until restart.');
      return;
    }

    const messages = await fetchAllMessages(dataChannel);
    const newest = new Map();
    for (const message of messages) {
      if (message.author?.id !== client.user.id) continue;
      const parsed = parseRecord(message.content);
      if (!parsed) continue;
      const previous = newest.get(parsed.userId);
      if (!previous || message.createdTimestamp > previous.createdTimestamp) {
        newest.set(parsed.userId, { state: parsed, messageId: message.id, createdTimestamp: message.createdTimestamp });
      }
    }

    for (const [userId, row] of newest.entries()) {
      users.set(userId, row.state);
      recordMessageIds.set(userId, row.messageId);
    }
    console.log(`[wish] Persistent simulator store ready with ${users.size} users.`);
  })().catch((error) => {
    dataChannel = null;
    console.warn(`[wish] Persistent store unavailable: ${error.message}`);
  });
  return readyPromise;
}

async function whenWishStoreReady() {
  await readyPromise;
}

function getWishUser(userId) {
  const id = String(userId);
  if (!users.has(id)) users.set(id, defaultState(id));
  return users.get(id);
}

async function persistState(state) {
  state.updatedAt = Date.now();
  users.set(state.userId, state);
  if (!dataChannel) return;

  const content = recordContent(state);
  if (content.length > 1950) throw new Error('WISH_STATE_TOO_LARGE');
  const knownId = recordMessageIds.get(state.userId);
  let message = knownId ? await dataChannel.messages.fetch(knownId).catch(() => null) : null;
  if (message) await message.edit(content);
  else {
    message = await dataChannel.send(content);
    recordMessageIds.set(state.userId, message.id);
  }
}

async function mutateWishUser(userId, fn) {
  const id = String(userId);
  let result;
  mutationQueue = mutationQueue.catch(() => {}).then(async () => {
    const state = sanitizeState(getWishUser(id), id);
    result = await fn(state);
    await persistState(state);
  });
  await mutationQueue;
  return result;
}

async function mutateWishPair(userA, userB, fn) {
  const a = String(userA);
  const b = String(userB);
  let result;
  mutationQueue = mutationQueue.catch(() => {}).then(async () => {
    const stateA = sanitizeState(getWishUser(a), a);
    const stateB = sanitizeState(getWishUser(b), b);
    result = await fn(stateA, stateB);
    await persistState(stateA);
    await persistState(stateB);
  });
  await mutationQueue;
  return result;
}

module.exports = {
  initWishStore,
  whenWishStoreReady,
  getWishUser,
  mutateWishUser,
  mutateWishPair,
  sanitizeState,
};
