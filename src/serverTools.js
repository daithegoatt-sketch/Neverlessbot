'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const DATA_CHANNEL_NAME = 'neverless-data';
const PERSONAL_INVITE_PREFIX = 'NLPINV1|';
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
  if (!channel) return;
  const updatedAt = new Date().toISOString();
  await channel.send(`${PERSONAL_INVITE_PREFIX}${guild.id}|${code}|${ownerId}|${updatedAt}`).catch(() => {});
  inviteOwners.set(inviteKey(guild.id, code), String(ownerId));
  ownerInvites.set(ownerKey(guild.id, ownerId), code);
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

async function handleBroadcast(interaction) {
  if (!adminOnly(interaction)) {
    await interaction.reply({ content: 'هذا الأمر للإدارة فقط.', ephemeral: true });
    return true;
  }
  const message = interaction.options.getString('message', true);
  const title = interaction.options.getString('title') || 'Neverless';
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
  const payload = messagePayload({
    title,
    message,
    imageUrl,
    linkUrl,
    buttonText: interaction.options.getString('button_text') || null,
  });

  let sent = 0;
  let failed = 0;
  const batchSize = 5;
  for (let index = 0; index < members.length; index += batchSize) {
    const batch = members.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((member) => member.send(payload).then(() => true).catch(() => false)));
    sent += results.filter(Boolean).length;
    failed += results.filter((value) => !value).length;
    if (index + batchSize < members.length) await new Promise((resolve) => setTimeout(resolve, 350));
  }

  await interaction.editReply({ content: `تم إرسال الـBroadcast.\nنجح: **${sent}**\nتعذر الإرسال: **${failed}**` });
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
  if (!/^(?:#\s*)?(?:رابط|invite)$/iu.test(text)) return false;
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
  await message.reply({
    content: `رابطك الشخصي للسيرفر:\nhttps://discord.gg/${invite.code}`,
    allowedMentions: { repliedUser: false },
  });
  return true;
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
    readyPromise = loadInviteMappings(client).catch((error) => {
      console.warn('[server-tools] invite mapping load failed:', error.message);
    });
  });
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
}

module.exports = {
  installServerTools,
  personalInviteOwner,
  whenPersonalInvitesReady,
  parsePersonalInvite,
  validUrl,
  messagePayload,
};
