'use strict';

const { TextChannel } = require('discord.js');

const CLAIM_PREFIX = 'hidden:claim:';
const SECRET_TOPIC_PREFIX = 'neverless-hidden-owner:';
const inFlight = new Map();
let installed = false;
let originalSend = null;

function claimCustomId(payload) {
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  for (const row of rows) {
    const components = Array.isArray(row?.components) ? row.components : row?.data?.components;
    for (const component of components || []) {
      const customId = component?.data?.custom_id || component?.customId || component?.custom_id;
      if (String(customId || '').startsWith(CLAIM_PREFIX)) return String(customId);
    }
  }
  return null;
}

function messageClaimCustomId(message) {
  for (const row of message?.components || []) {
    for (const component of row?.components || []) {
      const customId = component?.customId || component?.data?.custom_id || component?.custom_id;
      if (String(customId || '').startsWith(CLAIM_PREFIX)) return String(customId);
    }
  }
  return null;
}

function isSecretClaimChannel(channel) {
  return Boolean(channel?.guildId && String(channel.topic || '').startsWith(SECRET_TOPIC_PREFIX));
}

async function fetchRecent(channel, max = 500) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, max - out.length), before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return out;
}

async function findExistingClaim(channel, customId) {
  const messages = await fetchRecent(channel, 200);
  return messages
    .filter((message) => messageClaimCustomId(message) === customId)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0] || null;
}

async function dedupeChannel(channel) {
  if (!isSecretClaimChannel(channel)) return 0;
  const messages = await fetchRecent(channel, 500);
  const groups = new Map();
  for (const message of messages) {
    const customId = messageClaimCustomId(message);
    if (!customId) continue;
    const rows = groups.get(customId) || [];
    rows.push(message);
    groups.set(customId, rows);
  }

  let removed = 0;
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const duplicate of rows.slice(1)) {
      if (!duplicate.deletable) continue;
      const deleted = await duplicate.delete().then(() => true).catch(() => false);
      if (deleted) removed += 1;
    }
  }
  return removed;
}

async function cleanupGuild(guild) {
  await guild.channels.fetch().catch(() => null);
  let removed = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!isSecretClaimChannel(channel)) continue;
    removed += await dedupeChannel(channel);
  }
  if (removed) console.log(`[hidden-achievement-guard] Removed ${removed} duplicate claim messages.`);
  return removed;
}

function installSendGuard() {
  const proto = TextChannel?.prototype;
  if (!proto?.send || proto.__neverlessHiddenClaimGuard) return false;

  originalSend = proto.send;
  Object.defineProperty(proto, '__neverlessHiddenClaimGuard', { value: true, configurable: true });
  proto.send = function guardedSend(payload) {
    const customId = claimCustomId(payload);
    if (!customId || !isSecretClaimChannel(this)) return originalSend.call(this, payload);

    const key = `${this.id}:${customId}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const pending = (async () => {
      const previous = await findExistingClaim(this, customId);
      if (previous) return previous;
      return originalSend.call(this, payload);
    })().finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  };
  return true;
}

function installHiddenAchievementGuard(client) {
  if (installed) return;
  installed = true;
  installSendGuard();
  client.once('ready', () => {
    for (const guild of client.guilds.cache.values()) {
      cleanupGuild(guild).catch((error) => console.warn('[hidden-achievement-guard] Cleanup failed:', error.message));
    }
  });
}

module.exports = {
  installHiddenAchievementGuard,
  claimCustomId,
  messageClaimCustomId,
  isSecretClaimChannel,
  dedupeChannel,
};
