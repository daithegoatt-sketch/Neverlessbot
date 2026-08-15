const http = require('node:http');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  OverwriteType,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
} = require('discord.js');

const { commands } = require('./src/commands');
const { getGuild, patchGuild } = require('./src/store');
const { ticketPanelComponents, createTicket, handleTicketButton } = require('./src/tickets');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const WELCOME_WIDTH = 1672;
const WELCOME_HEIGHT = 941;
const WELCOME_TEMPLATE = path.join(process.cwd(), 'assets', 'welcome-template.jpg');
const AUTO_ROLE_NAME = 'Neverless';

let welcomeTemplatePromise;
const inviteCache = new Map();
const inviteQueues = new Map();
const recentlyDeletedInvites = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function welcomeTemplate() {
  if (!welcomeTemplatePromise) welcomeTemplatePromise = loadImage(WELCOME_TEMPLATE);
  return welcomeTemplatePromise;
}

function fitWelcomeFont(ctx, text, maxWidth, startSize) {
  let size = startSize;
  while (size > 30) {
    ctx.font = `600 ${size}px serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  return 30;
}

async function buildWelcomeCard(member) {
  const canvas = createCanvas(WELCOME_WIDTH, WELCOME_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await welcomeTemplate(), 0, 0, WELCOME_WIDTH, WELCOME_HEIGHT);

  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 512 });
  const parsedAvatar = new URL(avatarUrl);
  if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(parsedAvatar.hostname)) {
    throw new Error('Unexpected Discord avatar host');
  }

  const avatar = await loadImage(avatarUrl);
  const cx = 390;
  const cy = 454;
  const radius = 188;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  const side = Math.min(avatar.width, avatar.height);
  ctx.drawImage(
    avatar,
    (avatar.width - side) / 2,
    (avatar.height - side) / 2,
    side,
    side,
    cx - radius,
    cy - radius,
    radius * 2,
    radius * 2,
  );
  ctx.restore();

  const name = member.displayName || member.user.globalName || member.user.username;
  const nameSize = fitWelcomeFont(ctx, name, 660, 58);
  ctx.font = `600 ${nameSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#efe5d2';
  ctx.shadowColor = 'rgba(0,0,0,.8)';
  ctx.shadowBlur = 8;
  ctx.fillText(name, 1020, 594);

  const number = String(member.guild.memberCount).padStart(4, '0');
  ctx.font = '500 31px serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#d9b985';
  ctx.shadowBlur = 5;
  ctx.fillText(`MEMBER #${number}`, 1565, 810);

  return canvas.toBuffer('image/png');
}

function canManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function snapshotInvite(invite) {
  return {
    code: invite.code,
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id || null,
    maxUses: invite.maxUses ?? 0,
    channelId: invite.channelId || invite.channel?.id || null,
  };
}

function snapshotInviteCollection(invites) {
  return new Map([...invites.values()].map((invite) => [invite.code, snapshotInvite(invite)]));
}

async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, snapshotInviteCollection(invites));
    return invites;
  } catch (error) {
    console.warn(`[invites] Cannot fetch invites for ${guild.name}: ${error.message}`);
    return null;
  }
}

function detectUsedInvite(before, currentInvites, deletedCandidates = []) {
  let best = null;

  for (const invite of currentInvites.values()) {
    const previous = before.get(invite.code);
    const oldUses = previous?.uses ?? 0;
    const newUses = invite.uses ?? 0;
    const delta = newUses - oldUses;

    if (delta > 0 && (!best || delta > best.delta)) {
      best = {
        code: invite.code,
        inviterId: invite.inviter?.id || previous?.inviterId || null,
        usesAfter: newUses,
        delta,
        disappeared: false,
      };
    }
  }

  if (best) return best;

  const now = Date.now();
  for (const item of deletedCandidates) {
    if (now - item.deletedAt > 15_000) continue;
    const previous = item.snapshot;
    if (!previous?.inviterId || !previous.maxUses) continue;

    if (previous.uses + 1 >= previous.maxUses) {
      return {
        code: previous.code,
        inviterId: previous.inviterId,
        usesAfter: Math.max(previous.maxUses, previous.uses + 1),
        delta: 1,
        disappeared: true,
      };
    }
  }

  for (const previous of before.values()) {
    if (currentInvites.has(previous.code)) continue;
    if (!previous.inviterId || !previous.maxUses) continue;
    if (previous.uses + 1 >= previous.maxUses) {
      return {
        code: previous.code,
        inviterId: previous.inviterId,
        usesAfter: Math.max(previous.maxUses, previous.uses + 1),
        delta: 1,
        disappeared: true,
      };
    }
  }

  return null;
}

function totalInviteUsesFor(currentInvites, inviterId, usedInvite) {
  let total = 0;
  for (const invite of currentInvites.values()) {
    if (invite.inviter?.id === inviterId) total += invite.uses ?? 0;
  }

  if (usedInvite?.disappeared && usedInvite.inviterId === inviterId) {
    total += usedInvite.usesAfter;
  }

  return total;
}

async function resolveInviterUnlocked(member) {
  const guild = member.guild;
  const before = inviteCache.get(guild.id) || new Map();
  const deleted = recentlyDeletedInvites.get(guild.id) || [];
  let currentInvites = null;
  let usedInvite = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      currentInvites = await guild.invites.fetch();
      usedInvite = detectUsedInvite(before, currentInvites, deleted);
      if (usedInvite) break;
    } catch (error) {
      console.warn(`[invites] Fetch attempt ${attempt + 1} failed in ${guild.name}: ${error.message}`);
      break;
    }

    if (attempt < 3) await sleep(700);
  }

  if (!currentInvites) {
    return { user: null, count: null, code: null };
  }

  inviteCache.set(guild.id, snapshotInviteCollection(currentInvites));
  recentlyDeletedInvites.set(
    guild.id,
    deleted.filter((item) => Date.now() - item.deletedAt <= 15_000),
  );

  if (!usedInvite?.inviterId) {
    console.warn(`[invites] Could not identify inviter for ${member.user.tag}. This can happen with vanity URLs or missing Manage Guild access.`);
    return { user: null, count: null, code: null };
  }

  const user = await client.users.fetch(usedInvite.inviterId).catch(() => null);
  const count = totalInviteUsesFor(currentInvites, usedInvite.inviterId, usedInvite);
  return { user, count, code: usedInvite.code };
}

function resolveInviter(member) {
  const guildId = member.guild.id;
  const previous = inviteQueues.get(guildId) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => resolveInviterUnlocked(member));

  const queued = task.finally(() => {
    if (inviteQueues.get(guildId) === queued) inviteQueues.delete(guildId);
  });
  inviteQueues.set(guildId, queued);

  return task;
}

async function assignAutoRole(member) {
  if (member.user.bot) return;

  try {
    const role = member.guild.roles.cache.find((item) => item.name === AUTO_ROLE_NAME);
    if (!role) {
      console.warn(`[autorole] Role "${AUTO_ROLE_NAME}" was not found in ${member.guild.name}.`);
      return;
    }
    if (!member.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      console.warn(`[autorole] Missing Manage Roles permission in ${member.guild.name}.`);
      return;
    }
    if (!role.editable) {
      console.warn(`[autorole] Bot role must be above "${AUTO_ROLE_NAME}".`);
      return;
    }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'NeverLess automatic member role');
    }
  } catch (error) {
    console.error(`[autorole] Failed for ${member.user.tag}:`, error);
  }
}

async function findExistingTicketPanel(channel) {
  let before;
  let scanned = 0;

  while (scanned < 300) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) return null;

    for (const message of batch.values()) {
      if (message.author.id !== client.user.id) continue;
      const hasTicketMenu = message.components.some((row) => row.components.some((component) => component.customId === 'ticket:create'));
      if (hasTicketMenu) return message;
    }

    scanned += batch.size;
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  return null;
}

async function ensureTicketPanel(guild) {
  const config = getGuild(guild.id);
  const channel = guild.channels.cache.get(config.ticketPanelChannelId);
  if (!channel?.isSendable()) {
    console.warn(`[tickets] Ticket channel ${config.ticketPanelChannelId} was not found or is not sendable.`);
    return;
  }

  const existing = await findExistingTicketPanel(channel);
  if (existing) {
    await patchGuild(guild.id, { ticketPanelMessageId: existing.id });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x15233a)
    .setTitle('أهلاً بك في قسم التذاكر')
    .setDescription('• افتح تذكرتك\n\nاختر نوع التذكرة من القائمة بالأسفل.')
    .setFooter({ text: 'NeverLess Support' });

  if (config.ticketPanelImageUrl) embed.setImage(config.ticketPanelImageUrl);

  const panel = await channel.send({ embeds: [embed], components: ticketPanelComponents() });
  await patchGuild(guild.id, { ticketPanelMessageId: panel.id });
  console.log(`[tickets] Restored ticket panel in ${guild.name}.`);
}

function tempVoiceControls(channelId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`temp:limit:${channelId}`).setLabel('تحديد العدد').setEmoji('👥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`temp:lock:${channelId}`).setLabel('قفل الروم').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`temp:open:${channelId}`).setLabel('فتح الروم').setEmoji('🔓').setStyle(ButtonStyle.Success),
  )];
}

function tempOwnerId(channel) {
  const overwrite = channel.permissionOverwrites.cache.find(
    (entry) => entry.type === OverwriteType.Member && entry.id !== channel.guild.members.me?.id,
  );
  return overwrite?.id || null;
}

function canControlTemp(member, channel) {
  return member.permissions.has(PermissionFlagsBits.Administrator) || tempOwnerId(channel) === member.id;
}

async function initializeGuild(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`Registered ${commands.length} commands in ${guild.name}`);
  } catch (error) {
    console.error(`Failed to register commands in ${guild.name}:`, error);
  }

  await cacheGuildInvites(guild);
  await ensureTicketPanel(guild).catch((error) => console.error('[tickets] Failed to ensure panel:', error));
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await initializeGuild(guild);
  }
});

client.on('guildCreate', initializeGuild);

client.on('inviteCreate', (invite) => {
  const guildId = invite.guild?.id;
  if (!guildId) return;
  const current = new Map(inviteCache.get(guildId) || []);
  current.set(invite.code, snapshotInvite(invite));
  inviteCache.set(guildId, current);
});

client.on('inviteDelete', (invite) => {
  const guildId = invite.guild?.id;
  if (!guildId) return;

  const cached = inviteCache.get(guildId)?.get(invite.code) || snapshotInvite(invite);
  const list = recentlyDeletedInvites.get(guildId) || [];
  list.push({ snapshot: cached, deletedAt: Date.now() });
  recentlyDeletedInvites.set(guildId, list.slice(-20));
});

client.on('guildMemberAdd', async (member) => {
  await assignAutoRole(member);

  const config = getGuild(member.guild.id);
  const inviteInfo = await resolveInviter(member);
  const channel = member.guild.channels.cache.get(config.welcomeChannelId);

  if (!channel?.isSendable()) {
    console.warn(`[welcome] Welcome channel ${config.welcomeChannelId} was not found or is not sendable.`);
    return;
  }

  try {
    const card = await buildWelcomeCard(member);
    await channel.send({ files: [{ attachment: card, name: `welcome-${member.user.id}.png` }] });

    const inviterMention = inviteInfo.user ? `<@${inviteInfo.user.id}>` : 'Unknown';
    const invitedCount = Number.isInteger(inviteInfo.count) ? inviteInfo.count : 'Unknown';

    await channel.send({
      content: [
        `• welcome to neverless: <@${member.user.id}>`,
        `• invited by: ${inviterMention}`,
        `• ${inviterMention} invited: ${invitedCount}`,
      ].join('\n'),
      allowedMentions: {
        users: inviteInfo.user ? [member.user.id, inviteInfo.user.id] : [member.user.id],
      },
    });
  } catch (error) {
    console.error('[welcome] Failed:', error);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const temp = getGuild(guild.id).tempVoice;
  if (!temp?.lobbyId || !temp?.categoryId) return;

  if (newState.channelId === temp.lobbyId && oldState.channelId !== temp.lobbyId && newState.member) {
    try {
      const owner = newState.member;
      const room = await guild.channels.create({
        name: `${owner.displayName}'s room`.slice(0, 90),
        type: ChannelType.GuildVoice,
        parent: temp.categoryId,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        ],
      });

      await owner.voice.setChannel(room);

      if (room.isSendable()) {
        await room.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x15233a)
              .setTitle('إدارة رومك الصوتي')
              .setDescription('هذه الخيارات متاحة لمالك الروم، والإدارة تستطيع التحكم أيضاً.'),
          ],
          components: tempVoiceControls(room.id),
        });
      }
    } catch (error) {
      console.error('[tempvoice] Failed to create room:', error);
    }
  }

  if (
    oldState.channel
    && oldState.channel.parentId === temp.categoryId
    && oldState.channel.id !== temp.lobbyId
    && tempOwnerId(oldState.channel)
  ) {
    setTimeout(async () => {
      const channel = guild.channels.cache.get(oldState.channelId);
      if (channel && channel.members.size === 0) {
        await channel.delete('NeverLess temporary voice room empty').catch(console.error);
      }
    }, 2500);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'welcome') {
        if (!canManageGuild(interaction)) return interaction.reply({ content: 'ليس لديك صلاحية.', ephemeral: true });
        const channel = interaction.options.getChannel('channel', true);
        await patchGuild(interaction.guildId, { welcomeChannelId: channel.id });
        return interaction.reply({ content: `تم تحديد ${channel} كروم Welcome.`, ephemeral: true });
      }

      if (interaction.commandName === 'rules') {
        if (!canManageGuild(interaction)) return interaction.reply({ content: 'ليس لديك صلاحية.', ephemeral: true });
        const channel = interaction.options.getChannel('channel', true);
        const rulesText = interaction.options.getString('rules', true);
        const imageUrl = interaction.options.getString('image_url', true);

        try {
          const parsed = new URL(imageUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
        } catch {
          return interaction.reply({ content: 'رابط الصورة غير صالح.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setColor(0x15233a)
          .setTitle('NeverLess Rules')
          .setDescription(rulesText)
          .setImage(imageUrl)
          .setFooter({ text: 'NeverLess' });

        const message = await channel.send({ embeds: [embed] });
        await patchGuild(interaction.guildId, { rulesChannelId: channel.id, rulesMessageId: message.id });
        return interaction.reply({ content: `تم إرسال القوانين في ${channel}.`, ephemeral: true });
      }

      if (interaction.commandName === 'ticket-setup') {
        if (!canManageGuild(interaction)) return interaction.reply({ content: 'ليس لديك صلاحية.', ephemeral: true });
        const channel = interaction.options.getChannel('channel', true);
        const category = interaction.options.getChannel('category', true);
        const supportRole = interaction.options.getRole('support_role', true);
        const imageUrl = interaction.options.getString('image_url') || getGuild(interaction.guildId).ticketPanelImageUrl;

        const embed = new EmbedBuilder()
          .setColor(0x15233a)
          .setTitle('أهلاً بك في قسم التذاكر')
          .setDescription('• افتح تذكرتك\n\nاختر نوع التذكرة من القائمة بالأسفل.')
          .setFooter({ text: 'NeverLess Support' });
        if (imageUrl) embed.setImage(imageUrl);

        const panel = await channel.send({ embeds: [embed], components: ticketPanelComponents() });
        await patchGuild(interaction.guildId, {
          ticketPanelChannelId: channel.id,
          ticketPanelMessageId: panel.id,
          ticketCategoryId: category.id,
          supportRoleId: supportRole.id,
          ticketPanelImageUrl: imageUrl,
        });
        return interaction.reply({ content: `تم إعداد نظام التذاكر في ${channel}.`, ephemeral: true });
      }

      if (interaction.commandName === 'tempvoice') {
        if (!canManageGuild(interaction)) return interaction.reply({ content: 'ليس لديك صلاحية.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const categoryName = interaction.options.getString('category_name') || 'TEMP VOICE';
        const lobbyName = interaction.options.getString('lobby_name') || '➕ Create Room';
        const category = await interaction.guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
        const lobby = await interaction.guild.channels.create({ name: lobbyName, type: ChannelType.GuildVoice, parent: category.id });
        await patchGuild(interaction.guildId, { tempVoice: { categoryId: category.id, lobbyId: lobby.id } });
        return interaction.editReply({ content: `تم إنشاء ${category} و ${lobby}. أي عضو يدخل روم الإنشاء سيحصل على روم مؤقت باسمه.` });
      }

      if (interaction.commandName === 'kick') {
        const user = interaction.options.getUser('user', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'العضو غير موجود في السيرفر.', ephemeral: true });
        if (!member.kickable) return interaction.reply({ content: 'لا أستطيع طرد هذا العضو. تأكد أن رتبة البوت أعلى منه.', ephemeral: true });
        const reason = interaction.options.getString('reason') || `Kicked by ${interaction.user.tag}`;
        await member.kick(reason);
        return interaction.reply({ content: `تم طرد ${user.tag}.` });
      }

      if (interaction.commandName === 'ban') {
        const user = interaction.options.getUser('user', true);
        const days = interaction.options.getInteger('delete_days') ?? 0;
        const reason = interaction.options.getString('reason') || `Banned by ${interaction.user.tag}`;
        await interaction.guild.members.ban(user.id, { deleteMessageSeconds: days * 86400, reason });
        return interaction.reply({ content: `تم حظر ${user.tag}.` });
      }

      if (interaction.commandName === 'lock' || interaction.commandName === 'unlock') {
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'اختر روم نصي.', ephemeral: true });
        }
        const lock = interaction.commandName === 'lock';
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: lock ? false : null });
        return interaction.reply({ content: lock ? `🔒 تم قفل ${channel}.` : `🔓 تم فتح ${channel}.` });
      }

      if (interaction.commandName === 'clear') {
        if (!interaction.channel?.isTextBased() || !('bulkDelete' in interaction.channel)) {
          return interaction.reply({ content: 'هذا الأمر يعمل في الشاتات النصية فقط.', ephemeral: true });
        }
        const amount = interaction.options.getInteger('amount', true);
        await interaction.deferReply({ ephemeral: true });
        const deleted = await interaction.channel.bulkDelete(amount, true);
        return interaction.editReply({ content: `تم حذف ${deleted.size} رسالة. الرسائل الأقدم من 14 يوماً لا يمكن حذفها بالمسح الجماعي.` });
      }

      if (interaction.commandName === 'move') {
        const user = interaction.options.getUser('user', true);
        const target = interaction.options.getChannel('channel', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member?.voice.channelId) return interaction.reply({ content: 'العضو ليس داخل روم صوتي.', ephemeral: true });
        await member.voice.setChannel(target);
        return interaction.reply({ content: `تم سحب ${user} إلى ${target}.` });
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:create') {
      return createTicket(interaction, getGuild(interaction.guildId));
    }

    if (interaction.isButton() && interaction.customId.startsWith('ticket:')) {
      const handled = await handleTicketButton(interaction, getGuild(interaction.guildId));
      if (handled) return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('temp:')) {
      const [, action, channelId] = interaction.customId.split(':');
      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice || !tempOwnerId(channel)) {
        return interaction.reply({ content: 'الروم لم يعد موجوداً.', ephemeral: true });
      }
      if (!canControlTemp(interaction.member, channel)) {
        return interaction.reply({ content: 'هذه الخيارات لمالك الروم أو الإدارة فقط.', ephemeral: true });
      }

      if (action === 'lock') {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
        await channel.permissionOverwrites.edit(tempOwnerId(channel), { Connect: true, ViewChannel: true });
        return interaction.reply({ content: '🔒 تم قفل الروم.', ephemeral: true });
      }

      if (action === 'open') {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: true });
        return interaction.reply({ content: '🔓 تم فتح الروم.', ephemeral: true });
      }

      if (action === 'limit') {
        const input = new TextInputBuilder()
          .setCustomId('limit')
          .setLabel('عدد الأعضاء')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0 = بدون حد، أو رقم من 1 إلى 99')
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true);

        const modal = new ModalBuilder()
          .setCustomId(`temp-limit:${channel.id}`)
          .setTitle('تحديد عدد أعضاء الروم')
          .addComponents(new ActionRowBuilder().addComponents(input));

        return interaction.showModal(modal);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('temp-limit:')) {
      const channelId = interaction.customId.split(':')[1];
      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice || !tempOwnerId(channel)) {
        return interaction.reply({ content: 'الروم لم يعد موجوداً.', ephemeral: true });
      }
      if (!canControlTemp(interaction.member, channel)) {
        return interaction.reply({ content: 'لا تملك صلاحية التحكم بهذا الروم.', ephemeral: true });
      }

      const limit = Number(interaction.fields.getTextInputValue('limit').trim());
      if (!Number.isInteger(limit) || limit < 0 || limit > 99) {
        return interaction.reply({ content: 'اكتب رقماً من 0 إلى 99.', ephemeral: true });
      }

      await channel.setUserLimit(limit);
      return interaction.reply({
        content: limit === 0 ? 'تم إلغاء حد الأعضاء.' : `تم تحديد الحد إلى ${limit} أعضاء.`,
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error('[interaction] Unhandled error:', error);
    const payload = { content: 'حدث خطأ أثناء تنفيذ الأمر. راجع Logs في Railway.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, bot: client.user?.tag || 'starting' }));
}).listen(port, '0.0.0.0', () => console.log(`Health server listening on ${port}`));

client.login(process.env.DISCORD_TOKEN);
