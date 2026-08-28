'use strict';

const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const PANEL_CHANNEL_ID = process.env.GAME_LOBBY_CHANNEL_ID || '1542716819327156244';
const PANEL_IMAGE_URL = process.env.GAME_LOBBY_IMAGE_URL || 'https://cdn.discordapp.com/attachments/1539226931319545936/1542720582905499678/EC1F6CB2-1A84-43F5-88D2-FEFF981F5047.png?ex=6a924201&is=6a90f081&hm=64e3530ece69a2bb5ed4ecda443e9ced2868885de1ced6556fed865fdd2cc0e3&';
const DATA_CHANNEL_NAME = 'neverless-data';
const STATE_PREFIX = 'NLGLOBBY1|';
const LOBBY_TOPIC_PREFIX = 'neverless-game-lobby:';
const DEFAULT_LIMIT = 4;
const MIN_LIMIT = 2;
const MAX_LIMIT = 20;
const REQUEST_TTL_MS = 30 * 60 * 1000;
const FINDER_VIEW_TTL_MS = 14 * 60 * 1000;
const MAX_SCAN_MESSAGES = 5000;

const lobbies = new Map();
const stateMessageIds = new Map();
const finderViews = new Map();
const pendingInteractions = new Map();
let installed = false;

function normalizeUid(value) {
  const uid = String(value || '').replace(/\D+/g, '');
  return /^\d{9,10}$/.test(uid) ? uid : null;
}

function normalizeServer(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (['eu', 'europe'].includes(text)) return 'EU';
  if (['na', 'northamerica', 'america', 'us'].includes(text)) return 'NA';
  if (['asia', 'as'].includes(text)) return 'ASIA';
  if (['tw', 'hktwmo', 'twhkmo', 'hongkong', 'macau'].includes(text)) return 'TW/HK/MO';
  return null;
}

function lobbyKey(guildId, lobbyId) {
  return `${guildId}:${lobbyId}`;
}

function encodeLobby(lobby) {
  const data = {
    id: lobby.id,
    guildId: lobby.guildId,
    game: 'genshin',
    ownerId: lobby.ownerId,
    members: lobby.members,
    locked: Boolean(lobby.locked),
    joinMode: lobby.joinMode === 'approve' ? 'approve' : 'free',
    limit: Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Number(lobby.limit) || DEFAULT_LIMIT)),
    textChannelId: lobby.textChannelId || null,
    voiceChannelId: lobby.voiceChannelId || null,
    parentId: lobby.parentId || null,
    controlMessageId: lobby.controlMessageId || null,
    pending: lobby.pending || [],
    createdAt: Number(lobby.createdAt) || Date.now(),
    updatedAt: Number(lobby.updatedAt) || Date.now(),
  };
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

function stateContent(lobby) {
  return `${STATE_PREFIX}${lobby.guildId}|${lobby.id}|${encodeLobby(lobby)}`;
}

function parseState(content) {
  const text = String(content || '').trim();
  if (!text.startsWith(STATE_PREFIX)) return null;
  const rest = text.slice(STATE_PREFIX.length);
  const first = rest.indexOf('|');
  const second = rest.indexOf('|', first + 1);
  if (first < 1 || second < 0) return null;
  const guildId = rest.slice(0, first);
  const lobbyId = rest.slice(first + 1, second);
  if (!/^\d{15,22}$/.test(guildId) || !/^[a-f0-9]{8,20}$/i.test(lobbyId)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(rest.slice(second + 1), 'base64url').toString('utf8'));
    if (!parsed || parsed.guildId !== guildId || parsed.id !== lobbyId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sanitizeLobby(raw, now = Date.now()) {
  if (!raw?.id || !raw?.guildId || !raw?.ownerId) return null;
  const members = Array.isArray(raw.members)
    ? raw.members
      .filter((row) => /^\d{15,22}$/.test(String(row?.userId || '')))
      .map((row) => ({
        userId: String(row.userId),
        uid: normalizeUid(row.uid) || String(row.uid || ''),
        server: normalizeServer(row.server) || String(row.server || 'EU'),
        joinedAt: Number(row.joinedAt) || now,
      }))
    : [];
  if (!members.some((row) => row.userId === String(raw.ownerId))) return null;
  const pending = Array.isArray(raw.pending)
    ? raw.pending.filter((row) => row?.id && now - Number(row.createdAt || 0) <= REQUEST_TTL_MS)
    : [];
  return {
    id: String(raw.id),
    guildId: String(raw.guildId),
    game: 'genshin',
    ownerId: String(raw.ownerId),
    members,
    locked: Boolean(raw.locked),
    joinMode: raw.joinMode === 'approve' ? 'approve' : 'free',
    limit: Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Number(raw.limit) || DEFAULT_LIMIT)),
    textChannelId: raw.textChannelId || null,
    voiceChannelId: raw.voiceChannelId || null,
    parentId: raw.parentId || null,
    controlMessageId: raw.controlMessageId || null,
    pending,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

function guildLobbies(guildId) {
  return [...lobbies.values()].filter((lobby) => lobby.guildId === String(guildId));
}

function memberLobby(guildId, userId) {
  return guildLobbies(guildId).find((lobby) => lobby.members.some((row) => row.userId === String(userId))) || null;
}

function nextOwnerId(lobby, leavingUserId) {
  const candidates = (lobby?.members || [])
    .filter((row) => row.userId !== String(leavingUserId))
    .sort((a, b) => Number(a.joinedAt) - Number(b.joinedAt));
  return candidates[0]?.userId || null;
}

function isFull(lobby) {
  return (lobby?.members?.length || 0) >= Number(lobby?.limit || DEFAULT_LIMIT);
}

function findableLobbies(guildId) {
  return guildLobbies(guildId)
    .filter((lobby) => !lobby.locked && !isFull(lobby))
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
}

function ownerProfile(lobby) {
  return lobby.members.find((row) => row.userId === lobby.ownerId) || lobby.members[0] || null;
}

function dataChannel(guild) {
  return guild?.channels?.cache?.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name === DATA_CHANNEL_NAME,
  ) || null;
}

async function fetchAllMessages(channel, limit = MAX_SCAN_MESSAGES) {
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

async function persistLobby(guild, lobby) {
  const channel = dataChannel(guild);
  if (!channel) {
    console.warn('[game-lobby] neverless-data channel not available; lobby state is temporarily memory-only.');
    return false;
  }
  lobby.updatedAt = Date.now();
  const key = lobbyKey(lobby.guildId, lobby.id);
  const content = stateContent(lobby);
  const knownId = stateMessageIds.get(key);
  let message = knownId ? await channel.messages.fetch(knownId).catch(() => null) : null;
  if (message) await message.edit(content);
  else {
    message = await channel.send(content);
    stateMessageIds.set(key, message.id);
  }
  return true;
}

async function deletePersistedLobby(guild, lobby) {
  const key = lobbyKey(lobby.guildId, lobby.id);
  const channel = dataChannel(guild);
  const messageId = stateMessageIds.get(key);
  stateMessageIds.delete(key);
  if (!channel || !messageId) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (message) await message.delete().catch(() => {});
}

function panelEmbed() {
  return new EmbedBuilder()
    .setColor(0x6f8bd8)
    .setTitle('Neverless Lobby')
    .setDescription('اختر اللعبة من القائمة لإنشاء لوبي أو البحث عن لوبي موجود.')
    .setImage(PANEL_IMAGE_URL)
    .setFooter({ text: 'Neverless • Game Lobby' });
}

function panelComponents() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('nll:game')
    .setPlaceholder('اختر اللعبة')
    .addOptions({ label: 'Genshin Impact', value: 'genshin', emoji: '✨', description: 'Create or find a Genshin lobby' });
  const refresh = new ButtonBuilder()
    .setCustomId('nll:panel-refresh')
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(refresh),
  ];
}

async function ensurePanel(client) {
  const channel = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.isSendable?.()) {
    console.warn(`[game-lobby] Panel channel ${PANEL_CHANNEL_ID} is unavailable.`);
    return null;
  }
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = recent?.find((message) =>
    message.author?.id === client.user?.id
    && message.components?.some((row) => row.components?.some((component) => component.customId === 'nll:game')),
  );
  const payload = { embeds: [panelEmbed()], components: panelComponents() };
  if (existing) {
    await existing.edit(payload).catch(() => {});
    return existing;
  }
  return channel.send(payload);
}

function gameMenuPayload() {
  const embed = new EmbedBuilder()
    .setColor(0x6f8bd8)
    .setTitle('✨ Genshin Impact')
    .setDescription('اختر إنشاء لوبي جديد أو البحث عن لوبي موجود.');
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nll:create').setLabel('Create Lobby').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('nll:find').setLabel('Find Lobby').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nll:game-refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function profileModal(customId, title) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('uid')
          .setLabel('Genshin UID')
          .setPlaceholder('مثال: 700123456')
          .setStyle(TextInputStyle.Short)
          .setMinLength(9)
          .setMaxLength(10)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('server')
          .setLabel('Server')
          .setPlaceholder('EU / NA / ASIA / TW-HK-MO')
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(12)
          .setRequired(true),
      ),
    );
}

function safeTextName(value, fallback) {
  const cleaned = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
  return cleaned || fallback;
}

function textOverwrites(guild, clientUserId, members) {
  const rows = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: clientUserId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];
  for (const member of members) rows.push({
    id: member.userId,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AddReactions,
    ],
  });
  return rows;
}

function voiceOverwrites(guild, clientUserId, members) {
  const rows = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    {
      id: clientUserId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.MoveMembers],
    },
  ];
  for (const member of members) rows.push({
    id: member.userId,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
      PermissionFlagsBits.Stream,
      PermissionFlagsBits.UseVAD,
    ],
  });
  return rows;
}

async function createLobbyChannels(guild, client, lobby, ownerName) {
  const panel = guild.channels.cache.get(PANEL_CHANNEL_ID);
  const parentId = lobby.parentId || panel?.parentId || null;
  lobby.parentId = parentId;
  const suffix = lobby.id.slice(0, 6);
  const textName = `genshin-${safeTextName(ownerName, `lobby-${suffix}`)}`.slice(0, 95);
  const voiceName = `Genshin • ${String(ownerName || `Lobby ${suffix}`).slice(0, 80)}`;

  let textChannel;
  let voiceChannel;
  try {
    textChannel = await guild.channels.create({
      name: textName,
      type: ChannelType.GuildText,
      parent: parentId || undefined,
      topic: `${LOBBY_TOPIC_PREFIX}${lobby.id}`,
      permissionOverwrites: textOverwrites(guild, client.user.id, lobby.members),
      reason: 'Neverless Genshin lobby',
    });
    voiceChannel = await guild.channels.create({
      name: voiceName,
      type: ChannelType.GuildVoice,
      parent: parentId || undefined,
      userLimit: lobby.limit,
      permissionOverwrites: voiceOverwrites(guild, client.user.id, lobby.members),
      reason: 'Neverless Genshin lobby',
    });
  } catch (error) {
    if (textChannel) await textChannel.delete().catch(() => {});
    if (voiceChannel) await voiceChannel.delete().catch(() => {});
    throw error;
  }
  lobby.textChannelId = textChannel.id;
  lobby.voiceChannelId = voiceChannel.id;
  return { textChannel, voiceChannel };
}

function joinModeText(lobby) {
  return lobby.joinMode === 'approve' ? 'Require Approve 🔴' : 'Free to Join 🟢';
}

function lobbyEmbed(lobby) {
  const lines = lobby.members
    .slice()
    .sort((a, b) => Number(a.joinedAt) - Number(b.joinedAt))
    .map((row) => `${row.userId === lobby.ownerId ? '👑' : '•'} <@${row.userId}> — UID **${row.uid}** • **${row.server}**`);
  return new EmbedBuilder()
    .setColor(lobby.locked ? 0x8e7a8e : 0x57c785)
    .setTitle('✨ Genshin Lobby')
    .setDescription(lines.join('\n') || 'لا يوجد أعضاء.')
    .addFields(
      { name: 'Owner', value: `<@${lobby.ownerId}>`, inline: true },
      { name: 'Members', value: `${lobby.members.length}/${lobby.limit}`, inline: true },
      { name: 'Join', value: lobby.locked ? 'Locked 🔒' : 'Unlocked 🔓', inline: true },
      { name: 'Access', value: joinModeText(lobby), inline: true },
      { name: 'Voice', value: lobby.voiceChannelId ? `<#${lobby.voiceChannelId}>` : '—', inline: true },
    )
    .setFooter({ text: 'Owner controls are restricted to the current lobby owner.' });
}

function lobbyControls(lobby) {
  const hasTransfer = lobby.members.some((row) => row.userId !== lobby.ownerId);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nll:unlock:${lobby.id}`).setLabel('Unlock').setEmoji('🔓').setStyle(ButtonStyle.Success).setDisabled(!lobby.locked),
      new ButtonBuilder().setCustomId(`nll:lock:${lobby.id}`).setLabel('Lock').setEmoji('🩷').setStyle(ButtonStyle.Secondary).setDisabled(lobby.locked),
      new ButtonBuilder().setCustomId(`nll:transfer:${lobby.id}`).setLabel('Transfer').setEmoji('🟡').setStyle(ButtonStyle.Primary).setDisabled(!hasTransfer),
      new ButtonBuilder().setCustomId(`nll:limit:${lobby.id}`).setLabel('Join Limit').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nll:approve:${lobby.id}`).setLabel('Approve').setStyle(ButtonStyle.Primary).setDisabled(lobby.joinMode === 'approve'),
      new ButtonBuilder().setCustomId(`nll:free:${lobby.id}`).setLabel('Free to Join').setStyle(ButtonStyle.Success).setDisabled(lobby.joinMode === 'free'),
      new ButtonBuilder().setCustomId(`nll:kick:${lobby.id}`).setLabel('Kick').setStyle(ButtonStyle.Danger).setDisabled(!hasTransfer),
      new ButtonBuilder().setCustomId(`nll:leave:${lobby.id}`).setLabel('Leave').setStyle(ButtonStyle.Danger),
    ),
  ];
}

async function refreshControl(guild, lobby) {
  const channel = guild.channels.cache.get(lobby.textChannelId) || await guild.channels.fetch(lobby.textChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  let message = lobby.controlMessageId ? await channel.messages.fetch(lobby.controlMessageId).catch(() => null) : null;
  const payload = { embeds: [lobbyEmbed(lobby)], components: lobbyControls(lobby), allowedMentions: { parse: [] } };
  if (message) await message.edit(payload).catch(() => {});
  else {
    message = await channel.send(payload);
    lobby.controlMessageId = message.id;
    await persistLobby(guild, lobby).catch(() => false);
  }
  return message;
}

function findSelect(guild) {
  const open = findableLobbies(guild.id).slice(0, 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('nll:find-select')
    .setPlaceholder(open.length ? 'اختر اللوبي' : 'لا توجد لوبيات متاحة')
    .setDisabled(!open.length);
  if (!open.length) menu.addOptions({ label: 'لا توجد لوبيات متاحة', value: 'none' });
  else {
    menu.addOptions(open.map((lobby) => {
      const owner = guild.members.cache.get(lobby.ownerId);
      const nickname = owner?.displayName || owner?.user?.globalName || owner?.user?.username || `Lobby ${lobby.id.slice(0, 5)}`;
      const server = ownerProfile(lobby)?.server || '—';
      return {
        label: String(nickname).slice(0, 100),
        value: lobby.id,
        description: `${lobby.members.length}/${lobby.limit} • ${joinModeText(lobby)} • ${server}`.slice(0, 100),
      };
    }));
  }
  return menu;
}

function findPayload(guild) {
  const openCount = findableLobbies(guild.id).length;
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x6f8bd8)
      .setTitle('Find Genshin Lobby')
      .setDescription(openCount ? `اللوبيات المتاحة الآن: **${openCount}**` : 'لا توجد لوبيات مفتوحة حاليًا.')],
    components: [
      new ActionRowBuilder().addComponents(findSelect(guild)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nll:find-refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function finderViewKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function rememberFinderView(interaction) {
  finderViews.set(finderViewKey(interaction), { interaction, createdAt: Date.now() });
}

async function refreshFinderViews(guild) {
  const now = Date.now();
  for (const [key, row] of [...finderViews.entries()]) {
    if (!key.startsWith(`${guild.id}:`)) continue;
    if (now - row.createdAt > FINDER_VIEW_TTL_MS) {
      finderViews.delete(key);
      continue;
    }
    await row.interaction.editReply(findPayload(guild)).catch(() => finderViews.delete(key));
  }
}

async function updateLobby(guild, lobby) {
  await persistLobby(guild, lobby).catch(() => false);
  await refreshControl(guild, lobby).catch(() => {});
  await refreshFinderViews(guild).catch(() => {});
}

async function addMemberPermissions(guild, lobby, userId) {
  const text = guild.channels.cache.get(lobby.textChannelId) || await guild.channels.fetch(lobby.textChannelId).catch(() => null);
  const voice = guild.channels.cache.get(lobby.voiceChannelId) || await guild.channels.fetch(lobby.voiceChannelId).catch(() => null);
  await text?.permissionOverwrites?.edit(userId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
    AddReactions: true,
  }).catch(() => {});
  await voice?.permissionOverwrites?.edit(userId, {
    ViewChannel: true,
    Connect: true,
    Speak: true,
    Stream: true,
    UseVAD: true,
  }).catch(() => {});
}

async function removeMemberPermissions(guild, lobby, userId) {
  const text = guild.channels.cache.get(lobby.textChannelId) || await guild.channels.fetch(lobby.textChannelId).catch(() => null);
  const voice = guild.channels.cache.get(lobby.voiceChannelId) || await guild.channels.fetch(lobby.voiceChannelId).catch(() => null);
  await text?.permissionOverwrites?.delete(userId).catch(() => {});
  await voice?.permissionOverwrites?.delete(userId).catch(() => {});
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  if (member?.voice?.channelId === lobby.voiceChannelId) await member.voice.disconnect('Left Neverless lobby').catch(() => {});
}

async function addMemberToLobby(guild, lobby, userId, uid, server) {
  if (lobby.members.some((row) => row.userId === userId)) return true;
  if (isFull(lobby)) return false;
  lobby.members.push({ userId, uid, server, joinedAt: Date.now() });
  await addMemberPermissions(guild, lobby, userId);
  await updateLobby(guild, lobby);
  return true;
}

async function destroyLobby(guild, lobby) {
  lobbies.delete(lobby.id);
  for (const request of lobby.pending || []) pendingInteractions.delete(request.id);
  const text = guild.channels.cache.get(lobby.textChannelId) || await guild.channels.fetch(lobby.textChannelId).catch(() => null);
  const voice = guild.channels.cache.get(lobby.voiceChannelId) || await guild.channels.fetch(lobby.voiceChannelId).catch(() => null);
  await deletePersistedLobby(guild, lobby).catch(() => {});
  if (voice) await voice.delete('Neverless lobby empty').catch(() => {});
  if (text) await text.delete('Neverless lobby empty').catch(() => {});
  await refreshFinderViews(guild).catch(() => {});
}

async function leaveLobby(guild, lobby, userId) {
  const leaving = lobby.members.find((row) => row.userId === userId);
  if (!leaving) return { left: false, destroyed: false, newOwnerId: null };
  const wasOwner = lobby.ownerId === userId;
  const newOwnerId = wasOwner ? nextOwnerId(lobby, userId) : null;
  lobby.members = lobby.members.filter((row) => row.userId !== userId);
  lobby.pending = (lobby.pending || []).filter((row) => row.userId !== userId);

  if (!lobby.members.length) {
    await destroyLobby(guild, lobby);
    return { left: true, destroyed: true, newOwnerId: null };
  }

  if (wasOwner && newOwnerId) lobby.ownerId = newOwnerId;
  await removeMemberPermissions(guild, lobby, userId);
  await updateLobby(guild, lobby);

  if (wasOwner && newOwnerId) {
    const channel = guild.channels.cache.get(lobby.textChannelId);
    await channel?.send({
      content: `👑 خرج مالك اللوبي. تم نقل الملكية تلقائيًا إلى <@${newOwnerId}>.`,
      allowedMentions: { users: [newOwnerId] },
    }).catch(() => {});
  }
  return { left: true, destroyed: false, newOwnerId };
}

function ownerOnly(interaction, lobby) {
  return lobby && interaction.user.id === lobby.ownerId;
}

function memberOptions(guild, lobby, excludeOwner = true) {
  return lobby.members
    .filter((row) => !excludeOwner || row.userId !== lobby.ownerId)
    .slice(0, 25)
    .map((row) => {
      const member = guild.members.cache.get(row.userId);
      const name = member?.displayName || member?.user?.username || row.userId;
      return { label: String(name).slice(0, 100), value: row.userId, description: `${row.server} • UID ${row.uid}`.slice(0, 100) };
    });
}

function requestEmbed(request) {
  return new EmbedBuilder()
    .setColor(0xe2b85c)
    .setTitle('طلب انضمام إلى اللوبي')
    .setDescription(`<@${request.userId}> طلب الانضمام.`)
    .addFields(
      { name: 'UID', value: request.uid, inline: true },
      { name: 'Server', value: request.server, inline: true },
    );
}

function requestComponents(lobbyId, requestId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nll:req-accept:${lobbyId}:${requestId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`nll:req-reject:${lobbyId}:${requestId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  )];
}

async function ensureRequestMessage(guild, lobby, request) {
  const channel = guild.channels.cache.get(lobby.textChannelId) || await guild.channels.fetch(lobby.textChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  let message = request.messageId ? await channel.messages.fetch(request.messageId).catch(() => null) : null;
  const payload = { embeds: [requestEmbed(request)], components: requestComponents(lobby.id, request.id), allowedMentions: { users: [request.userId] } };
  if (message) await message.edit(payload).catch(() => {});
  else {
    message = await channel.send(payload);
    request.messageId = message.id;
    await persistLobby(guild, lobby).catch(() => false);
  }
}

async function notifyRequester(client, request, accepted, lobby) {
  const text = accepted
    ? `✅ قام مالك اللوبي <@${lobby.ownerId}> بقبول طلبك. دخلت اللوبي مباشرة: <#${lobby.textChannelId}> • <#${lobby.voiceChannelId}>`
    : `❌ قام مالك اللوبي <@${lobby.ownerId}> برفض طلبك.`;
  const source = pendingInteractions.get(request.id);
  pendingInteractions.delete(request.id);
  if (source) {
    const ok = await source.followUp({ content: text, ephemeral: true, allowedMentions: { users: [lobby.ownerId] } })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  const user = await client.users.fetch(request.userId).catch(() => null);
  await user?.send({ content: text, allowedMentions: { users: [lobby.ownerId] } }).catch(() => {});
}

async function handleCreateModal(interaction, client) {
  const existing = memberLobby(interaction.guildId, interaction.user.id);
  if (existing) {
    await interaction.reply({ content: `أنت موجود بالفعل في <#${existing.textChannelId}>. اخرج منه قبل إنشاء لوبي جديد.`, ephemeral: true });
    return;
  }
  const uid = normalizeUid(interaction.fields.getTextInputValue('uid'));
  const server = normalizeServer(interaction.fields.getTextInputValue('server'));
  if (!uid || !server) {
    await interaction.reply({ content: 'تأكد من UID والسيرفر. السيرفرات المدعومة: EU / NA / ASIA / TW-HK-MO.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const member = interaction.member;
  const lobby = {
    id: crypto.randomBytes(6).toString('hex'),
    guildId: guild.id,
    ownerId: interaction.user.id,
    members: [{ userId: interaction.user.id, uid, server, joinedAt: Date.now() }],
    locked: false,
    joinMode: 'free',
    limit: DEFAULT_LIMIT,
    textChannelId: null,
    voiceChannelId: null,
    parentId: guild.channels.cache.get(PANEL_CHANNEL_ID)?.parentId || null,
    controlMessageId: null,
    pending: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    const ownerName = member?.displayName || interaction.user.globalName || interaction.user.username;
    await createLobbyChannels(guild, client, lobby, ownerName);
    lobbies.set(lobby.id, lobby);
    await persistLobby(guild, lobby);
    await refreshControl(guild, lobby);
    await refreshFinderViews(guild);
    await interaction.editReply(`تم إنشاء اللوبي.\n💬 <#${lobby.textChannelId}>\n🔊 <#${lobby.voiceChannelId}>`);
  } catch (error) {
    lobbies.delete(lobby.id);
    console.error('[game-lobby] create failed:', error);
    await interaction.editReply('ما قدرت أنشئ اللوبي. تأكد أن البوت يملك Manage Channels وإدارة الصلاحيات.');
  }
}

async function handleJoinModal(interaction, client, lobbyId) {
  const guild = interaction.guild;
  const lobby = lobbies.get(lobbyId);
  if (!lobby || lobby.guildId !== interaction.guildId || lobby.locked) {
    await interaction.reply({ content: 'هذا اللوبي لم يعد متاحًا للدخول.', ephemeral: true });
    return;
  }
  const existing = memberLobby(interaction.guildId, interaction.user.id);
  if (existing) {
    await interaction.reply({ content: existing.id === lobby.id ? `أنت داخل هذا اللوبي بالفعل: <#${existing.textChannelId}>` : `أنت موجود حاليًا في <#${existing.textChannelId}>. اخرج منه أولًا.`, ephemeral: true });
    return;
  }
  if (isFull(lobby)) {
    await interaction.reply({ content: 'اللوبي ممتلئ حاليًا.', ephemeral: true });
    return;
  }
  const uid = normalizeUid(interaction.fields.getTextInputValue('uid'));
  const server = normalizeServer(interaction.fields.getTextInputValue('server'));
  if (!uid || !server) {
    await interaction.reply({ content: 'تأكد من UID والسيرفر. السيرفرات المدعومة: EU / NA / ASIA / TW-HK-MO.', ephemeral: true });
    return;
  }

  if (lobby.joinMode === 'free') {
    await interaction.deferReply({ ephemeral: true });
    const joined = await addMemberToLobby(guild, lobby, interaction.user.id, uid, server);
    if (!joined) await interaction.editReply('اللوبي امتلأ قبل إتمام دخولك.');
    else await interaction.editReply(`دخلت اللوبي مباشرة.\n💬 <#${lobby.textChannelId}>\n🔊 <#${lobby.voiceChannelId}>`);
    return;
  }

  const existingRequest = (lobby.pending || []).find((row) => row.userId === interaction.user.id);
  if (existingRequest) {
    await interaction.reply({ content: 'عندك طلب انضمام معلّق لهذا اللوبي بالفعل.', ephemeral: true });
    return;
  }
  const request = {
    id: crypto.randomBytes(5).toString('hex'),
    userId: interaction.user.id,
    uid,
    server,
    createdAt: Date.now(),
    messageId: null,
  };
  lobby.pending.push(request);
  await persistLobby(guild, lobby).catch(() => false);
  await ensureRequestMessage(guild, lobby, request);
  await interaction.reply({ content: 'تم إرسال طلبك لمالك اللوبي. سيصلك الرد هنا إذا بقيت الجلسة مفتوحة، أو في الخاص كخيار احتياطي.', ephemeral: true });
  pendingInteractions.set(request.id, interaction);
}

async function handleOwnerButton(interaction, action, lobby) {
  if (!ownerOnly(interaction, lobby)) {
    await interaction.reply({ content: 'هذا الزر لمالك اللوبي فقط.', ephemeral: true });
    return;
  }
  const guild = interaction.guild;
  if (action === 'unlock' || action === 'lock' || action === 'approve' || action === 'free') {
    if (action === 'unlock') lobby.locked = false;
    if (action === 'lock') lobby.locked = true;
    if (action === 'approve') lobby.joinMode = 'approve';
    if (action === 'free') lobby.joinMode = 'free';
    await interaction.deferUpdate();
    await updateLobby(guild, lobby);
    return;
  }
  if (action === 'transfer') {
    const options = memberOptions(guild, lobby, true);
    if (!options.length) {
      await interaction.reply({ content: 'لا يوجد عضو آخر لنقل الملكية له.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: 'اختر المالك الجديد:',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`nll:transfer-select:${lobby.id}`).setPlaceholder('اختر العضو').addOptions(options),
      )],
      ephemeral: true,
    });
    return;
  }
  if (action === 'kick') {
    const options = memberOptions(guild, lobby, true);
    if (!options.length) {
      await interaction.reply({ content: 'لا يوجد عضو لطرده من اللوبي.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: 'اختر العضو الذي تريد إخراجه:',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`nll:kick-select:${lobby.id}`).setPlaceholder('اختر العضو').addOptions(options),
      )],
      ephemeral: true,
    });
    return;
  }
  if (action === 'limit') {
    const minimum = Math.max(MIN_LIMIT, lobby.members.length);
    const options = [];
    for (let limit = minimum; limit <= MAX_LIMIT; limit += 1) options.push({ label: `${limit} members`, value: String(limit) });
    await interaction.reply({
      content: `الحد الحالي: **${lobby.limit}**`,
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`nll:limit-select:${lobby.id}`).setPlaceholder('حدد Join Limit').addOptions(options),
      )],
      ephemeral: true,
    });
  }
}

async function handleRequestDecision(interaction, client, accepted, lobbyId, requestId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || !ownerOnly(interaction, lobby)) {
    await interaction.reply({ content: 'هذا الطلب يستطيع مالك اللوبي الحالي التعامل معه فقط.', ephemeral: true });
    return;
  }
  const request = (lobby.pending || []).find((row) => row.id === requestId);
  if (!request) {
    await interaction.reply({ content: 'هذا الطلب منتهي أو تم التعامل معه.', ephemeral: true });
    return;
  }
  if (accepted) {
    const existing = memberLobby(interaction.guildId, request.userId);
    if (existing && existing.id !== lobby.id) {
      await interaction.reply({ content: 'العضو دخل لوبي آخر بالفعل.', ephemeral: true });
      return;
    }
    if (isFull(lobby)) {
      await interaction.reply({ content: 'اللوبي ممتلئ، ارفع Join Limit أولًا.', ephemeral: true });
      return;
    }
    if (!existing) await addMemberToLobby(interaction.guild, lobby, request.userId, request.uid, request.server);
  }
  lobby.pending = lobby.pending.filter((row) => row.id !== requestId);
  await updateLobby(interaction.guild, lobby);
  const resultEmbed = requestEmbed(request)
    .setColor(accepted ? 0x57c785 : 0xd95c5c)
    .setFooter({ text: accepted ? 'Accepted' : 'Rejected' });
  await interaction.update({ embeds: [resultEmbed], components: [], allowedMentions: { parse: [] } }).catch(() => {});
  await notifyRequester(client, request, accepted, lobby);
}

async function handleInteraction(interaction, client) {
  if (!interaction.guild || !interaction.customId?.startsWith('nll:')) return false;

  if (interaction.isStringSelectMenu?.() && interaction.customId === 'nll:game') {
    if (interaction.values[0] !== 'genshin') return true;
    await interaction.reply({ ...gameMenuPayload(), ephemeral: true });
    return true;
  }
  if (interaction.isButton?.() && interaction.customId === 'nll:panel-refresh') {
    await interaction.update({ embeds: [panelEmbed()], components: panelComponents() });
    return true;
  }
  if (interaction.isButton?.() && interaction.customId === 'nll:game-refresh') {
    await interaction.update(gameMenuPayload());
    return true;
  }
  if (interaction.isButton?.() && interaction.customId === 'nll:create') {
    const existing = memberLobby(interaction.guildId, interaction.user.id);
    if (existing) {
      await interaction.reply({ content: `أنت موجود بالفعل في <#${existing.textChannelId}>. اخرج منه أولًا.`, ephemeral: true });
      return true;
    }
    await interaction.showModal(profileModal('nll:create-modal', 'Create Genshin Lobby'));
    return true;
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'nll:create-modal') {
    await handleCreateModal(interaction, client);
    return true;
  }
  if (interaction.isButton?.() && interaction.customId === 'nll:find') {
    await interaction.reply({ ...findPayload(interaction.guild), ephemeral: true });
    rememberFinderView(interaction);
    return true;
  }
  if (interaction.isButton?.() && interaction.customId === 'nll:find-refresh') {
    await interaction.update(findPayload(interaction.guild));
    rememberFinderView(interaction);
    return true;
  }
  if (interaction.isStringSelectMenu?.() && interaction.customId === 'nll:find-select') {
    const lobbyId = interaction.values[0];
    if (lobbyId === 'none') {
      await interaction.reply({ content: 'لا توجد لوبيات متاحة.', ephemeral: true });
      return true;
    }
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.locked || isFull(lobby)) {
      await interaction.reply({ content: 'هذا اللوبي لم يعد متاحًا. اضغط Refresh.', ephemeral: true });
      return true;
    }
    await interaction.showModal(profileModal(`nll:join-modal:${lobby.id}`, 'Join Genshin Lobby'));
    return true;
  }
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('nll:join-modal:')) {
    await handleJoinModal(interaction, client, interaction.customId.split(':')[2]);
    return true;
  }

  const ownerButton = interaction.isButton?.() && interaction.customId.match(/^nll:(unlock|lock|transfer|limit|approve|free|kick):([a-f0-9]+)$/i);
  if (ownerButton) {
    const [, action, lobbyId] = ownerButton;
    const lobby = lobbies.get(lobbyId);
    if (!lobby) {
      await interaction.reply({ content: 'هذا اللوبي لم يعد موجودًا.', ephemeral: true });
      return true;
    }
    await handleOwnerButton(interaction, action, lobby);
    return true;
  }

  const leaveMatch = interaction.isButton?.() && interaction.customId.match(/^nll:leave:([a-f0-9]+)$/i);
  if (leaveMatch) {
    const lobby = lobbies.get(leaveMatch[1]);
    if (!lobby || !lobby.members.some((row) => row.userId === interaction.user.id)) {
      await interaction.reply({ content: 'أنت لست عضوًا في هذا اللوبي.', ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await leaveLobby(interaction.guild, lobby, interaction.user.id);
    await interaction.editReply(result.destroyed ? 'غادرت اللوبي وتم حذفه لأنه أصبح فارغًا.' : 'غادرت اللوبي وتم إخفاء شاته وصوته عنك.');
    return true;
  }

  const transferMatch = interaction.isStringSelectMenu?.() && interaction.customId.match(/^nll:transfer-select:([a-f0-9]+)$/i);
  if (transferMatch) {
    const lobby = lobbies.get(transferMatch[1]);
    if (!lobby || !ownerOnly(interaction, lobby)) {
      await interaction.reply({ content: 'لم تعد مالك هذا اللوبي.', ephemeral: true });
      return true;
    }
    const target = interaction.values[0];
    if (!lobby.members.some((row) => row.userId === target) || target === lobby.ownerId) {
      await interaction.reply({ content: 'العضو غير متاح لنقل الملكية.', ephemeral: true });
      return true;
    }
    lobby.ownerId = target;
    await updateLobby(interaction.guild, lobby);
    await interaction.update({ content: `تم نقل ملكية اللوبي إلى <@${target}>.`, components: [], allowedMentions: { users: [target] } });
    return true;
  }

  const kickMatch = interaction.isStringSelectMenu?.() && interaction.customId.match(/^nll:kick-select:([a-f0-9]+)$/i);
  if (kickMatch) {
    const lobby = lobbies.get(kickMatch[1]);
    if (!lobby || !ownerOnly(interaction, lobby)) {
      await interaction.reply({ content: 'لم تعد مالك هذا اللوبي.', ephemeral: true });
      return true;
    }
    const target = interaction.values[0];
    if (target === lobby.ownerId || !lobby.members.some((row) => row.userId === target)) {
      await interaction.reply({ content: 'العضو غير موجود في اللوبي.', ephemeral: true });
      return true;
    }
    lobby.members = lobby.members.filter((row) => row.userId !== target);
    await removeMemberPermissions(interaction.guild, lobby, target);
    await updateLobby(interaction.guild, lobby);
    const user = await client.users.fetch(target).catch(() => null);
    await user?.send(`تم إخراجك من Genshin Lobby بواسطة <@${lobby.ownerId}>.`).catch(() => {});
    await interaction.update({ content: `تم إخراج <@${target}> من اللوبي.`, components: [], allowedMentions: { users: [target] } });
    return true;
  }

  const limitMatch = interaction.isStringSelectMenu?.() && interaction.customId.match(/^nll:limit-select:([a-f0-9]+)$/i);
  if (limitMatch) {
    const lobby = lobbies.get(limitMatch[1]);
    if (!lobby || !ownerOnly(interaction, lobby)) {
      await interaction.reply({ content: 'لم تعد مالك هذا اللوبي.', ephemeral: true });
      return true;
    }
    const limit = Number(interaction.values[0]);
    if (!Number.isInteger(limit) || limit < lobby.members.length || limit < MIN_LIMIT || limit > MAX_LIMIT) {
      await interaction.reply({ content: 'Join Limit غير صالح.', ephemeral: true });
      return true;
    }
    lobby.limit = limit;
    const voice = interaction.guild.channels.cache.get(lobby.voiceChannelId);
    await voice?.setUserLimit(limit, 'Neverless lobby join limit').catch(() => {});
    await updateLobby(interaction.guild, lobby);
    await interaction.update({ content: `تم تغيير Join Limit إلى **${limit}**.`, components: [] });
    return true;
  }

  const requestMatch = interaction.isButton?.() && interaction.customId.match(/^nll:req-(accept|reject):([a-f0-9]+):([a-f0-9]+)$/i);
  if (requestMatch) {
    await handleRequestDecision(interaction, client, requestMatch[1] === 'accept', requestMatch[2], requestMatch[3]);
    return true;
  }

  return false;
}

async function restorePermissions(guild, client, lobby) {
  const text = guild.channels.cache.get(lobby.textChannelId) || await guild.channels.fetch(lobby.textChannelId).catch(() => null);
  const voice = guild.channels.cache.get(lobby.voiceChannelId) || await guild.channels.fetch(lobby.voiceChannelId).catch(() => null);
  if (text) await text.permissionOverwrites.set(textOverwrites(guild, client.user.id, lobby.members), 'Restore Neverless lobby').catch(() => {});
  if (voice) {
    await voice.permissionOverwrites.set(voiceOverwrites(guild, client.user.id, lobby.members), 'Restore Neverless lobby').catch(() => {});
    await voice.setUserLimit(lobby.limit).catch(() => {});
  }
}

async function restoreLobby(guild, client, lobby) {
  const validMembers = [];
  for (const row of lobby.members) {
    const member = guild.members.cache.get(row.userId) || await guild.members.fetch(row.userId).catch(() => null);
    if (member) validMembers.push(row);
  }
  lobby.members = validMembers;
  if (!lobby.members.length) {
    await destroyLobby(guild, lobby);
    return;
  }
  if (!lobby.members.some((row) => row.userId === lobby.ownerId)) {
    lobby.ownerId = [...lobby.members].sort((a, b) => Number(a.joinedAt) - Number(b.joinedAt))[0].userId;
  }

  let text = lobby.textChannelId ? await guild.channels.fetch(lobby.textChannelId).catch(() => null) : null;
  let voice = lobby.voiceChannelId ? await guild.channels.fetch(lobby.voiceChannelId).catch(() => null) : null;
  if (!text || !voice) {
    if (text) await text.delete('Rebuilding incomplete Neverless lobby').catch(() => {});
    if (voice) await voice.delete('Rebuilding incomplete Neverless lobby').catch(() => {});
    const owner = guild.members.cache.get(lobby.ownerId) || await guild.members.fetch(lobby.ownerId).catch(() => null);
    const ownerName = owner?.displayName || owner?.user?.username || `Lobby ${lobby.id.slice(0, 6)}`;
    await createLobbyChannels(guild, client, lobby, ownerName);
  }
  await restorePermissions(guild, client, lobby);
  await refreshControl(guild, lobby);
  for (const request of lobby.pending) await ensureRequestMessage(guild, lobby, request);
  await persistLobby(guild, lobby).catch(() => false);
}

async function loadGuildLobbies(guild, client) {
  const channel = dataChannel(guild);
  if (!channel) return;
  const messages = await fetchAllMessages(channel);
  const latest = new Map();
  for (const message of messages) {
    if (message.author?.id !== client.user?.id) continue;
    const parsed = parseState(message.content);
    if (!parsed || parsed.guildId !== guild.id) continue;
    const key = lobbyKey(parsed.guildId, parsed.id);
    const previous = latest.get(key);
    if (!previous || message.createdTimestamp > previous.createdTimestamp) latest.set(key, { parsed, message });
  }
  for (const [key, row] of latest) {
    const lobby = sanitizeLobby(row.parsed);
    if (!lobby) continue;
    lobbies.set(lobby.id, lobby);
    stateMessageIds.set(key, row.message.id);
    await restoreLobby(guild, client, lobby).catch((error) => console.error(`[game-lobby] restore ${lobby.id} failed:`, error));
  }
}

async function restoreAll(client) {
  await ensurePanel(client).catch((error) => console.error('[game-lobby] panel restore failed:', error));
  for (const guild of client.guilds.cache.values()) await loadGuildLobbies(guild, client).catch(() => {});
  console.log(`[game-lobby] Restored ${lobbies.size} lobby state(s).`);
}

async function handleGuildMemberRemove(member) {
  const lobby = memberLobby(member.guild.id, member.id);
  if (!lobby) return;
  await leaveLobby(member.guild, lobby, member.id);
}

function installGameLobby(client) {
  if (installed) return;
  installed = true;
  client.once('ready', () => {
    setTimeout(() => restoreAll(client).catch((error) => console.error('[game-lobby] restore failed:', error)), 3500).unref?.();
  });
  client.on('interactionCreate', (interaction) => {
    Promise.resolve(handleInteraction(interaction, client)).catch((error) => console.error('[game-lobby] interaction failed:', error));
  });
  client.on('guildMemberRemove', (member) => {
    handleGuildMemberRemove(member).catch((error) => console.error('[game-lobby] member remove failed:', error));
  });
  console.log('[game-lobby] Independent Genshin lobby system installed.');
}

module.exports = {
  installGameLobby,
  handleInteraction,
  normalizeUid,
  normalizeServer,
  stateContent,
  parseState,
  sanitizeLobby,
  nextOwnerId,
  findableLobbies,
  constants: {
    PANEL_CHANNEL_ID,
    DEFAULT_LIMIT,
    MIN_LIMIT,
    MAX_LIMIT,
    REQUEST_TTL_MS,
  },
};
