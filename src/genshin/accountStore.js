'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { DATA_DIR } = require('../store');

const FILE = path.join(DATA_DIR, 'genshin-users.json');
const DATA_CHANNEL_NAME = 'neverless-data';
const RECORD_PREFIX = 'NLUID1|';
const MAX_SCAN_MESSAGES = 5000;

let state = { users: {} };
let writeQueue = Promise.resolve();
let discordChannel = null;
let recordMessageIds = new Map();
let readyPromise = Promise.resolve();

function ensureLoaded() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.users) state = parsed;
  } catch (error) {
    console.error('[genshin-store] Failed to read user links:', error);
  }
}

ensureLoaded();

function writeLocal() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(FILE, snapshot));
  return writeQueue;
}

function parseRecord(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(RECORD_PREFIX)) return null;
  const [, discordUserId, uid, updatedAt] = value.split('|');
  if (!/^\d{15,22}$/.test(discordUserId || '') || !/^\d{9,10}$/.test(uid || '')) return null;
  return {
    discordUserId,
    uid,
    updatedAt: updatedAt || null,
  };
}

function recordContent(discordUserId, uid, updatedAt) {
  return `${RECORD_PREFIX}${discordUserId}|${uid}|${updatedAt || new Date().toISOString()}`;
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

async function ensureDataChannel(client, genshinChannelId) {
  const genshinChannel = client.channels.cache.get(genshinChannelId)
    || await client.channels.fetch(genshinChannelId).catch(() => null);
  const guild = genshinChannel?.guild;
  if (!guild) throw new Error('GENSHIN_GUILD_NOT_FOUND');

  let channel = guild.channels.cache.find((item) => item.type === ChannelType.GuildText && item.name === DATA_CHANNEL_NAME) || null;
  if (!channel) {
    channel = await guild.channels.create({
      name: DATA_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Neverless internal persistent data. Do not delete.',
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ],
      reason: 'Neverless persistent Genshin UID storage',
    });
  }
  return channel;
}

async function initDiscordPersistence(client, genshinChannelId) {
  readyPromise = (async () => {
    try {
      discordChannel = await ensureDataChannel(client, genshinChannelId);
      recordMessageIds = new Map();
      const messages = await fetchAllMessages(discordChannel);
      const remote = {};

      for (const message of messages) {
        if (message.author?.id !== client.user.id) continue;
        const parsed = parseRecord(message.content);
        if (!parsed) continue;
        const previous = remote[parsed.discordUserId];
        const currentTime = Date.parse(parsed.updatedAt || '') || Number(message.createdTimestamp) || 0;
        const previousTime = Date.parse(previous?.updatedAt || '') || previous?.createdTimestamp || 0;
        if (!previous || currentTime >= previousTime) {
          remote[parsed.discordUserId] = {
            uid: parsed.uid,
            updatedAt: parsed.updatedAt || new Date(message.createdTimestamp).toISOString(),
            createdTimestamp: Number(message.createdTimestamp) || 0,
          };
          recordMessageIds.set(parsed.discordUserId, message.id);
        }
      }

      // Discord is the persistent source of truth after a deploy. Existing local data is
      // kept only for users that have not been migrated to the Discord-backed store yet.
      state.users = {
        ...state.users,
        ...Object.fromEntries(Object.entries(remote).map(([id, value]) => [id, { uid: value.uid, updatedAt: value.updatedAt }])),
      };

      // Migrate any local-only UID links into the private Discord data channel once.
      for (const [discordUserId, value] of Object.entries(state.users)) {
        if (!value?.uid || recordMessageIds.has(discordUserId)) continue;
        const message = await discordChannel.send(recordContent(discordUserId, value.uid, value.updatedAt));
        recordMessageIds.set(discordUserId, message.id);
      }

      await writeLocal();
      console.log(`[genshin-store] Persistent UID store ready with ${Object.keys(state.users).length} linked users.`);
    } catch (error) {
      discordChannel = null;
      console.warn(`[genshin-store] Discord persistence unavailable; using local fallback: ${error.message}`);
    }
  })();
  return readyPromise;
}

async function whenAccountStoreReady() {
  await readyPromise;
}

function getLinkedUid(discordUserId) {
  return state.users[String(discordUserId)]?.uid || null;
}

function getAllLinkedUsers() {
  return Object.entries(state.users)
    .filter(([, value]) => /^\d{9,10}$/.test(String(value?.uid || '')))
    .map(([discordUserId, value]) => ({
      discordUserId,
      uid: String(value.uid),
      updatedAt: value.updatedAt || null,
    }));
}

async function linkUid(discordUserId, uid) {
  const id = String(discordUserId);
  const cleanUid = String(uid);
  const updatedAt = new Date().toISOString();
  state.users[id] = { uid: cleanUid, updatedAt };
  await writeLocal();

  if (discordChannel) {
    const content = recordContent(id, cleanUid, updatedAt);
    const existingId = recordMessageIds.get(id);
    let message = existingId ? await discordChannel.messages.fetch(existingId).catch(() => null) : null;
    if (message) await message.edit(content);
    else {
      message = await discordChannel.send(content);
      recordMessageIds.set(id, message.id);
    }
  }
  return state.users[id];
}

async function unlinkUid(discordUserId) {
  const id = String(discordUserId);
  delete state.users[id];
  await writeLocal();

  const existingId = recordMessageIds.get(id);
  if (discordChannel && existingId) {
    const message = await discordChannel.messages.fetch(existingId).catch(() => null);
    if (message) await message.delete().catch(() => {});
    recordMessageIds.delete(id);
  }
}

module.exports = {
  getLinkedUid,
  getAllLinkedUsers,
  linkUid,
  unlinkUid,
  initDiscordPersistence,
  whenAccountStoreReady,
};
