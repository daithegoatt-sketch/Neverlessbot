'use strict';

const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const DATA_CHANNEL_NAME = 'neverless-data';
const PERSONAL_INVITE_PREFIX = 'NLPINV1|';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '1538557238627672164';
const MAX_SCAN_MESSAGES = 5000;

const inviteOwners = new Map(); // guildId:code -> ownerId
const ownerInvites = new Map(); // guildId:ownerId -> code
let readyPromise = Promise.resolve();

function inviteKey(guildId, code) {
  return `${guildId}:${code}`;
}

function ownerKey(guildId, ownerId) {
  return `${guildId}:${ownerId}`;
}

function parsePersonalInvite(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(PERSONAL_INVITE_PREFIX)) return null;
  const [, guildId, code, ownerId, updatedAt] = value.split('|');
  if (!/^\d{15,22}$/.test(guildId || '') || !/^[A-Za-z0-9_-]{2,32}$/.test(code || '') || !/^\d{15,22}$/.test(ownerId || '')) return null;
  return { guildId, code, ownerId, updatedAt: updatedAt || null };
}

function personalInviteOwner(guildId, code) {
  return inviteOwners.get(inviteKey(String(guildId), String(code))) || null;
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

async function loadInviteMappings(client) {
  const latestByOwner = new Map();
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
    if (!channel) continue;
    const messages = await fetchAllMessages(channel);
    for (const message of messages) {
      if (message.author?.id !== client.user.id) continue;
      const parsed = parsePersonalInvite(message.content);
      if (!parsed || parsed.guildId !== guild.id) continue;
      inviteOwners.set(inviteKey(guild.id, parsed.code), parsed.ownerId);
      const key = ownerKey(guild.id, parsed.ownerId);
      const timestamp = Date.parse(parsed.updatedAt || '') || Number(message.createdTimestamp) || 0;
      const previous = latestByOwner.get(key);
      if (!previous || timestamp >= previous.timestamp) latestByOwner.set(key, { code: parsed.code, timestamp });
    }
  }
  for (const [key, row] of latestByOwner) ownerInvites.set(key, row.code);
}

async function whenPersonalInvitesReady() {
  await readyPromise;
}

async function persistPersonalInvite(guild, code, ownerId) {
  const channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  const updatedAt = new Date().toISOString();
  if (channel) await channel.send(`${PERSONAL_INVITE_PREFIX}${guild.id}|${code}|${ownerId}|${updatedAt}`).catch(() => {});
  inviteOwners.set(inviteKey(guild.id, code), String(ownerId));
  ownerInvites.set(ownerKey(guild.id, ownerId), code);
}

function applyPersonalInviteOwner(guild, invite) {
  if (!invite?.code) return invite;
  const ownerId = personalInviteOwner(guild.id, invite.code);
  if (!ownerId) return invite;
  // Discord creates the invite as the bot, but #رابط is intentionally owned by the
  // requesting member. Existing welcome/activity invite logic reads invite.inviter.id,
  // so expose the persisted member owner on every later invite fetch.
  const owner = guild.client.users.cache.get(ownerId) || { id: ownerId };
  try {
    Object.defineProperty(invite, 'inviter', {
      value: owner,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch {
    try { invite.inviter = owner; } catch {}
  }
  return invite;
}

function patchInviteManager(guild) {
  const manager = guild?.invites;
  if (!manager || manager.__neverlessPersonalInvitePatched) return;
  const originalFetch = manager.fetch.bind(manager);
  manager.fetch = async (...args) => {
    const result = await originalFetch(...args);
    if (result?.values && typeof result.values === 'function') {
      for (const invite of result.values()) applyPersonalInviteOwner(guild, invite);
    } else if (result?.code) {
      applyPersonalInviteOwner(guild, result);
    }
    return result;
  };
  try {
    Object.defineProperty(manager, '__neverlessPersonalInvitePatched', { value: true, configurable: true });
  } catch {
    manager.__neverlessPersonalInvitePatched = true;
  }
}

function validUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function adminOnly(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function messagePayload({ title, message, imageUrl, linkUrl, buttonText }) {
  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(String(title || 'Neverless').slice(0, 256))
    .setDescription(String(message || '').slice(0, 4000))
    .setFooter({ text: 'Neverless' })
    .setTimestamp();
  if (imageUrl) embed.setImage(imageUrl);

  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  if (linkUrl) {
    payload.components = [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(linkUrl)
        .setLabel(String(buttonText || 'فتح الرابط').slice(0, 80)),
    )];
  }
  return payload;
}

function splitPlainMessage(content, max = 1900) {
  const value = String(content || '').trim();
  if (!value) return [];
  const chunks = [];
  let remaining = value;

  while (remaining.length > max) {
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt < Math.floor(max * 0.55)) splitAt = remaining.lastIndexOf(' ', max);
    if (splitAt < Math.floor(max * 0.55)) splitAt = max;
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function broadcastPayloads({ title, message, imageUrl, linkUrl }) {
  const textParts = [];
  if (title) textParts.push(`**${String(title).slice(0, 256)}**`);
  if (message) textParts.push(String(message).trim());

  const payloads = splitPlainMessage(textParts.join('\n'))
    .map((content) => ({ content, allowedMentions: { parse: [] } }));

  const previewLines = [linkUrl, imageUrl].filter(Boolean);
  if (previewLines.length) {
    const previewText = previewLines.join('\n');
    const last = payloads[payloads.length - 1];
    if (last && `${last.content}\n${previewText}`.length <= 2000) {
      last.content = `${last.content}\n${previewText}`;
    } else {
      payloads.push({ content: previewText, allowedMentions: { parse: [] } });
    }
  }

  return payloads.length ? payloads : [{ content: 'Neverless', allowedMentions: { parse: [] } }];
}

async function sendBroadcast(member, payloads) {
  for (const payload of payloads) await member.send(payload);
}

async function handleBroadcast(interaction) {
  if (!adminOnly(interaction)) {
    await interaction.reply({ content: 'هذا الأمر للإدارة فقط.', ephemeral: true });
    return true;
  }
  const message = interaction.options.getString('message', true);
  const title = interaction.options.getString('title') || null;
  const rawImage = interaction.options.getString('image_url');
  const rawLink = interaction.options.getString('link_url');
  const imageUrl = rawImage ? validUrl(rawImage) : null;
  const linkUrl = rawLink ? validUrl(rawLink) : null;
  if (rawImage && !imageUrl) {
    await interaction.reply({ content: 'رابط الصورة غير صالح.', ephemeral: true });
    return true;
  }
  if (rawLink && !linkUrl) {
    await interaction.reply({ content: 'الرابط غير صالح.', ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const fetched = await interaction.guild.members.fetch().catch(() => null);
  const members = fetched ? [...fetched.values()].filter((member) => !member.user.bot) : [];
  const payloads = broadcastPayloads({ title, message, imageUrl, linkUrl });

  let sent = 0;
  let failed = 0;
  const batchSize = 5;
  for (let index = 0; index < members.length; index += batchSize) {
    const batch = members.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((member) => sendBroadcast(member, payloads).then(() => true).catch(() => false)));
    sent += results.filter(Boolean).length;
    failed += results.filter((value) => !value).length;
    if (index + batchSize < members.length) await new Promise((resolve) => setTimeout(resolve, 350));
  }

  await interaction.editReply({ content: `تم إرسال الـBroadcast كرسالة عادية.\nنجح: **${sent}**\nتعذر الإرسال: **${failed}**` });
  return true;
}

async function handleEmbed(interaction) {
  if (!adminOnly(interaction)) {
    await interaction.reply({ content: 'هذا الأمر للإدارة فقط.', ephemeral: true });
    return true;
  }
  const channel = interaction.options.getChannel('channel', true);
  if (!channel?.isSendable?.()) {
    await interaction.reply({ content: 'الروم غير قابل لإرسال الرسائل.', ephemeral: true });
    return true;
  }
  const message = interaction.options.getString('message', true);
  const title = interaction.options.getString('title', true);
  const rawImage = interaction.options.getString('image_url');
  const rawLink = interaction.options.getString('link_url');
  const imageUrl = rawImage ? validUrl(rawImage) : null;
  const linkUrl = rawLink ? validUrl(rawLink) : null;
  if (rawImage && !imageUrl) {
    await interaction.reply({ content: 'رابط الصورة غير صالح.', ephemeral: true });
    return true;
  }
  if (rawLink && !linkUrl) {
    await interaction.reply({ content: 'الرابط غير صالح.', ephemeral: true });
    return true;
  }

  await channel.send(messagePayload({
    title,
    message,
    imageUrl,
    linkUrl,
    buttonText: interaction.options.getString('button_text') || null,
  }));
  await interaction.reply({ content: `تم إرسال الـEmbed في ${channel}.`, ephemeral: true });
  return true;
}

async function handlePersonalInvite(message) {
  const text = String(message.content || '').trim();
  if (!/^#\s*(?:رابط|invite)$/iu.test(text)) return false;
  if (!message.channel?.createInvite) {
    await message.reply({ content: 'ما أقدر أنشئ رابط من هذا الروم.', allowedMentions: { repliedUser: false } });
    return true;
  }

  await whenPersonalInvitesReady();
  const existingCode = ownerInvites.get(ownerKey(message.guildId, message.author.id));
  if (existingCode) {
    const invites = await message.guild.invites.fetch().catch(() => null);
    if (invites?.has(existingCode)) {
      await message.reply({ content: `رابطك الشخصي للسيرفر:\nhttps://discord.gg/${existingCode}`, allowedMentions: { repliedUser: false } });
      return true;
    }
  }

  const invite = await message.channel.createInvite({
    maxAge: 0,
    maxUses: 0,
    unique: true,
    reason: `Personal invite requested by ${message.author.tag} (${message.author.id})`,
  }).catch(() => null);
  if (!invite) {
    await message.reply({ content: 'ما قدرت أنشئ الرابط. تأكد أن البوت عنده صلاحية Create Invite.', allowedMentions: { repliedUser: false } });
    return true;
  }

  await persistPersonalInvite(message.guild, invite.code, message.author.id);
  applyPersonalInviteOwner(message.guild, invite);
  await message.reply({
    content: `رابطك الشخصي للسيرفر:\nhttps://discord.gg/${invite.code}`,
    allowedMentions: { repliedUser: false },
  });
  return true;
}

async function recentRemovalAction(member) {
  const now = Date.now();
  for (const type of [AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick]) {
    const logs = await member.guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
    if (!logs) continue;
    const match = logs.entries.find((entry) => entry.target?.id === member.id && now - entry.createdTimestamp <= 15_000);
    if (match) return match;
  }
  return null;
}

async function handleNaturalLeave(member) {
  // Moderation has its own kick/ban log. Delay and check audit logs so a kick or ban
  // is not duplicated as a voluntary leave.
  await new Promise((resolve) => setTimeout(resolve, 2300));
  const moderationAction = await recentRemovalAction(member);
  if (moderationAction) return;
  const channel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
  if (!channel?.isSendable?.()) return;
  const user = member.user;
  const embed = new EmbedBuilder()
    .setColor(0x6b7280)
    .setTitle('🚪 Member Left')
    .setDescription(`${user?.tag || 'Unknown'} (${member.id})`)
    .addFields(
      { name: 'Member', value: `<@${member.id}> (${member.id})`, inline: true },
      { name: 'Members Now', value: String(member.guild.memberCount), inline: true },
    )
    .setTimestamp();
  if (member.joinedTimestamp) embed.addFields({ name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true });
  if (user?.createdTimestamp) embed.addFields({ name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true });
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand?.() || !interaction.guild) return false;
  if (interaction.commandName === 'broadcast') return handleBroadcast(interaction);
  if (interaction.commandName === 'embed') return handleEmbed(interaction);
  return false;
}

function installServerTools(client) {
  if (client.__neverlessServerToolsInstalled) return;
  client.__neverlessServerToolsInstalled = true;
  client.once('ready', () => {
    for (const guild of client.guilds.cache.values()) patchInviteManager(guild);
    readyPromise = loadInviteMappings(client).catch((error) => {
      console.warn('[server-tools] invite mapping load failed:', error.message);
    });
  });
  client.on('guildCreate', (guild) => patchInviteManager(guild));
  client.on('interactionCreate', (interaction) => {
    handleInteraction(interaction).catch((error) => {
      console.error('[server-tools] interaction failed:', error);
      if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        interaction.reply({ content: 'صار خطأ أثناء تنفيذ الأمر.', ephemeral: true }).catch(() => {});
      }
    });
  });
  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;
    handlePersonalInvite(message).catch((error) => console.error('[server-tools] personal invite failed:', error));
  });
  client.on('guildMemberRemove', (member) => {
    handleNaturalLeave(member).catch((error) => console.error('[server-tools] leave log failed:', error));
  });
}

module.exports = {
  installServerTools,
  personalInviteOwner,
  whenPersonalInvitesReady,
  parsePersonalInvite,
  validUrl,
  messagePayload,
  splitPlainMessage,
  broadcastPayloads,
  patchInviteManager,
  applyPersonalInviteOwner,
};
