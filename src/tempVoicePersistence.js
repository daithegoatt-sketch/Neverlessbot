'use strict';

const { ChannelType, OverwriteType, PermissionFlagsBits } = require('discord.js');
const { getGuild, patchGuild } = require('./store');
const { whenAccountStoreReady } = require('./genshin/accountStore');

const DATA_CHANNEL_NAME = 'neverless-data';
const TEMP_VOICE_PREFIX = 'NLTEMP1|';
const DEFAULT_CATEGORY_NAME = 'TEMP VOICE';
const DEFAULT_LOBBY_NAME = '➕ Create Room';
const MAX_SCAN_MESSAGES = 5000;

const configMessageIds = new Map();
let installed = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTempVoice(value) {
  const categoryId = String(value?.categoryId || '');
  const lobbyId = String(value?.lobbyId || '');
  if (!/^\d{15,22}$/.test(categoryId) || !/^\d{15,22}$/.test(lobbyId)) return null;
  return { categoryId, lobbyId };
}

function recordContent(guildId, tempVoice) {
  return `${TEMP_VOICE_PREFIX}${guildId}|${tempVoice.categoryId}|${tempVoice.lobbyId}`;
}

function parseRecord(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(TEMP_VOICE_PREFIX)) return null;
  const [guildId, categoryId, lobbyId] = value.slice(TEMP_VOICE_PREFIX.length).split('|');
  if (!/^\d{15,22}$/.test(guildId || '')
    || !/^\d{15,22}$/.test(categoryId || '')
    || !/^\d{15,22}$/.test(lobbyId || '')) return null;
  return { guildId, categoryId, lobbyId };
}

function dataChannel(guild) {
  return guild?.channels?.cache?.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name === DATA_CHANNEL_NAME,
  ) || null;
}

function tempVoiceIsLive(guild, tempVoice) {
  const config = normalizeTempVoice(tempVoice);
  if (!config) return false;
  const category = guild.channels.cache.get(config.categoryId);
  const lobby = guild.channels.cache.get(config.lobbyId);
  return category?.type === ChannelType.GuildCategory
    && lobby?.type === ChannelType.GuildVoice
    && lobby.parentId === category.id;
}

async function findRemoteRecord(guild) {
  await whenAccountStoreReady().catch(() => {});
  const channel = dataChannel(guild);
  if (!channel) return null;

  let before;
  let scanned = 0;
  while (scanned < MAX_SCAN_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;

    for (const message of batch.values()) {
      if (message.author?.id !== guild.members.me?.id) continue;
      const parsed = parseRecord(message.content);
      if (parsed?.guildId === guild.id) {
        return { ...parsed, messageId: message.id };
      }
    }

    scanned += batch.size;
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return null;
}

async function persistTempVoice(guild, tempVoice) {
  const config = normalizeTempVoice(tempVoice);
  if (!config) return false;
  await whenAccountStoreReady().catch(() => {});
  const channel = dataChannel(guild);
  if (!channel) {
    console.warn('[tempvoice-store] neverless-data channel not found; using local config only.');
    return false;
  }

  const content = recordContent(guild.id, config);
  const knownId = configMessageIds.get(guild.id);
  let message = knownId ? await channel.messages.fetch(knownId).catch(() => null) : null;
  if (message) {
    await message.edit(content).catch(() => {});
  } else {
    message = await channel.send(content).catch(() => null);
    if (!message) return false;
    configMessageIds.set(guild.id, message.id);
  }
  return true;
}

function discoverExistingTempVoice(guild) {
  const channels = [...guild.channels.cache.values()];
  const exactLobby = channels.find(
    (channel) => channel.type === ChannelType.GuildVoice
      && channel.name === DEFAULT_LOBBY_NAME
      && channel.parentId,
  );
  if (exactLobby) return { categoryId: exactLobby.parentId, lobbyId: exactLobby.id };

  const defaultCategory = channels.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === DEFAULT_CATEGORY_NAME,
  );
  if (!defaultCategory) return null;

  const candidates = channels.filter((channel) => {
    if (channel.type !== ChannelType.GuildVoice || channel.parentId !== defaultCategory.id) return false;
    const hasMemberOverwrite = channel.permissionOverwrites?.cache?.some(
      (overwrite) => overwrite.type === OverwriteType.Member,
    );
    return !hasMemberOverwrite;
  });
  if (candidates.length !== 1) return null;
  return { categoryId: defaultCategory.id, lobbyId: candidates[0].id };
}

async function restoreTempVoice(guild) {
  const remote = await findRemoteRecord(guild).catch(() => null);
  if (remote) configMessageIds.set(guild.id, remote.messageId);

  if (remote && tempVoiceIsLive(guild, remote)) {
    await patchGuild(guild.id, {
      tempVoice: { categoryId: remote.categoryId, lobbyId: remote.lobbyId },
    });
    console.log(`[tempvoice-store] Restored Temp VC in ${guild.name}.`);
    return true;
  }

  const local = normalizeTempVoice(getGuild(guild.id).tempVoice);
  if (local && tempVoiceIsLive(guild, local)) {
    await persistTempVoice(guild, local).catch(() => false);
    console.log(`[tempvoice-store] Migrated local Temp VC config in ${guild.name}.`);
    return true;
  }

  const discovered = discoverExistingTempVoice(guild);
  if (discovered && tempVoiceIsLive(guild, discovered)) {
    await patchGuild(guild.id, { tempVoice: discovered });
    await persistTempVoice(guild, discovered).catch(() => false);
    console.log(`[tempvoice-store] Recovered existing Temp VC channels in ${guild.name}.`);
    return true;
  }

  return false;
}

async function captureTempVoiceAfterCommand(interaction) {
  if (!interaction?.guildId || interaction.commandName !== 'tempvoice') return;
  const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  if (!canManage) return;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(500);
    const current = normalizeTempVoice(getGuild(interaction.guildId).tempVoice);
    if (!current || !tempVoiceIsLive(interaction.guild, current)) continue;
    await persistTempVoice(interaction.guild, current);
    console.log(`[tempvoice-store] Saved Temp VC config in ${interaction.guild.name}.`);
    return;
  }
  console.warn(`[tempvoice-store] Could not capture Temp VC setup in ${interaction.guild?.name || interaction.guildId}.`);
}

function installTempVoicePersistence(client) {
  if (installed) return;
  installed = true;

  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      await restoreTempVoice(guild).catch((error) => {
        console.warn(`[tempvoice-store] Restore failed in ${guild.name}: ${error.message}`);
      });
    }
  });

  client.on('guildCreate', (guild) => {
    restoreTempVoice(guild).catch(() => {});
  });

  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'tempvoice') return;
    captureTempVoiceAfterCommand(interaction).catch((error) => {
      console.warn('[tempvoice-store] Save after command failed:', error.message);
    });
  });
}

module.exports = {
  installTempVoicePersistence,
  parseRecord,
  recordContent,
  normalizeTempVoice,
};
