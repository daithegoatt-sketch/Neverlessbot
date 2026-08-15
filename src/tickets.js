const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');

const SUPPORT_ROLE_NAMES = ['support', 'support team', 'الدعم', 'دعم'];

function ticketPanelComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket:create')
    .setPlaceholder('اختر نوع التذكرة')
    .addOptions(
      { label: 'شكوى أو مشكلة', value: 'problem', emoji: '⚠️', description: 'مشكلة، شكوى أو طلب مساعدة' },
      { label: 'قدم اقتراحك', value: 'suggestion', emoji: '💡', description: 'شارك اقتراحك مع الإدارة' },
      { label: 'استفسار', value: 'question', emoji: '❓', description: 'اسأل عن أي شيء يخص السيرفر' },
    );
  return [new ActionRowBuilder().addComponents(menu)];
}

function ticketControls() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:transcript').setLabel('حفظ المحادثة').setEmoji('🧾').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:leave').setLabel('Leave / مغادرة').setEmoji('🚪').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket:lock').setLabel('Lock / قفل').setEmoji('🔒').setStyle(ButtonStyle.Primary),
  )];
}

function ticketTypeName(value) {
  return { problem: 'شكوى أو مشكلة', suggestion: 'اقتراح', question: 'استفسار' }[value] || 'تذكرة';
}

function sanitizeChannelName(name) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 45) || 'member';
}

function resolveSupportRole(guild, config) {
  if (config.supportRoleId) {
    const configured = guild.roles.cache.get(config.supportRoleId);
    if (configured) return configured;
  }

  return guild.roles.cache.find((role) => SUPPORT_ROLE_NAMES.includes(role.name.trim().toLowerCase())) || null;
}

function isStaff(member, config) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (config.supportRoleId && member.roles.cache.has(config.supportRoleId)) return true;
  return member.roles.cache.some((role) => SUPPORT_ROLE_NAMES.includes(role.name.trim().toLowerCase()));
}

async function createTicket(interaction, config) {
  if (!config.ticketCategoryId) {
    return interaction.reply({ content: 'تصنيف التذاكر غير محدد.', ephemeral: true });
  }

  const guild = interaction.guild;
  const category = guild.channels.cache.get(config.ticketCategoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return interaction.reply({ content: 'تصنيف التذاكر غير موجود أو تم حذفه.', ephemeral: true });
  }

  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.topic?.includes(`neverless-ticket-owner:${interaction.user.id}`),
  );
  if (existing) return interaction.reply({ content: `لديك تذكرة مفتوحة بالفعل: ${existing}`, ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const type = interaction.values[0];
  const supportRole = resolveSupportRole(guild, config);

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  if (supportRole) {
    permissionOverwrites.push({
      id: supportRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: `ticket-${sanitizeChannelName(interaction.member.displayName)}`,
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId,
    topic: `neverless-ticket-owner:${interaction.user.id};type:${type}`,
    permissionOverwrites,
  });

  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle(`تذكرة: ${ticketTypeName(type)}`)
    .setDescription(`أهلاً ${interaction.user}\nاكتب تفاصيل طلبك هنا وسيقوم فريق الدعم بالرد عليك.`)
    .setFooter({ text: 'NeverLess Support' })
    .setTimestamp();

  const mentionLine = supportRole ? `${interaction.user} ${supportRole}` : `${interaction.user}`;
  await channel.send({ content: mentionLine, embeds: [embed], components: ticketControls() });
  await interaction.editReply({ content: `تم فتح تذكرتك: ${channel}` });
}

function getTicketOwnerId(channel) {
  return channel.topic?.match(/neverless-ticket-owner:(\d+)/)?.[1] || null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function fetchAllMessages(channel, maxMessages = 2000) {
  const collected = [];
  let before;
  while (collected.length < maxMessages) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, maxMessages - collected.length), before });
    if (!batch.size) break;
    collected.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function buildTranscript(channel) {
  const messages = await fetchAllMessages(channel);
  const rows = messages.map((message) => {
    const attachments = [...message.attachments.values()]
      .map((a) => `<div><a href="${escapeHtml(a.url)}">Attachment: ${escapeHtml(a.name || a.url)}</a></div>`)
      .join('');
    return `<div class="msg"><div class="meta"><b>${escapeHtml(message.author.tag || message.author.username)}</b> · ${escapeHtml(message.createdAt.toISOString())}</div><div class="body">${escapeHtml(message.content || '').replaceAll('\n', '<br>')}</div>${attachments}</div>`;
  }).join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(channel.name)}</title><style>body{font-family:Arial,sans-serif;background:#0b1220;color:#e6e6e6;padding:24px}.msg{padding:12px 0;border-bottom:1px solid #26324a}.meta{color:#d9b985;margin-bottom:6px}.body{overflow-wrap:anywhere}a{color:#9fc4ff}</style></head><body><h1>${escapeHtml(channel.name)}</h1>${rows}</body></html>`;
}

async function handleTicketButton(interaction, config) {
  const ownerId = getTicketOwnerId(interaction.channel);
  if (!ownerId) return false;

  if (interaction.customId === 'ticket:transcript') {
    if (!isStaff(interaction.member, config)) {
      await interaction.reply({ content: 'هذا الخيار مخصص للإدارة وفريق الدعم.', ephemeral: true });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const html = await buildTranscript(interaction.channel);
    const file = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `${interaction.channel.name}-transcript.html` });
    await interaction.editReply({ content: 'تم تجهيز نسخة المحادثة.', files: [file] });
    return true;
  }

  if (interaction.customId === 'ticket:lock') {
    if (!isStaff(interaction.member, config)) {
      await interaction.reply({ content: 'القفل متاح للإدارة وفريق الدعم فقط.', ephemeral: true });
      return true;
    }
    await interaction.channel.permissionOverwrites.edit(ownerId, { SendMessages: false });
    await interaction.reply({ content: '🔒 تم قفل التذكرة. العضو يستطيع رؤيتها لكن لا يستطيع الكتابة.' });
    return true;
  }

  if (interaction.customId === 'ticket:leave') {
    if (isStaff(interaction.member, config)) {
      await interaction.reply({ content: 'سيتم إغلاق التذكرة نهائياً خلال 5 ثوانٍ.' });
      setTimeout(() => interaction.channel.delete('NeverLess ticket closed by staff').catch(console.error), 5000);
      return true;
    }

    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'هذه التذكرة ليست لك.', ephemeral: true });
      return true;
    }

    await interaction.reply({ content: 'تمت مغادرتك للتذكرة.', ephemeral: true });
    await interaction.channel.permissionOverwrites.edit(ownerId, { ViewChannel: false });
    return true;
  }

  return false;
}

module.exports = {
  ticketPanelComponents,
  createTicket,
  handleTicketButton,
  isStaff,
  resolveSupportRole,
};
