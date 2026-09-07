'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuild, patchGuild } = require('./store');

const SUPPORT_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ManageMessages,
];

function isTicketChannel(channel, config) {
  return Boolean(
    channel?.type === ChannelType.GuildText
    && channel.topic?.includes('neverless-ticket-owner:')
    && (!config?.ticketCategoryId || channel.parentId === config.ticketCategoryId),
  );
}

async function applySupportRoleToOpenTickets(guild, previousRoleId, nextRoleId, config) {
  await guild.channels.fetch().catch(() => null);
  const tickets = [...guild.channels.cache.values()].filter((channel) => isTicketChannel(channel, config));
  let updated = 0;

  for (const channel of tickets) {
    try {
      if (previousRoleId && previousRoleId !== nextRoleId && channel.permissionOverwrites.cache.has(previousRoleId)) {
        await channel.permissionOverwrites.delete(previousRoleId, 'Neverless support role changed');
      }
      await channel.permissionOverwrites.edit(nextRoleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
        ManageMessages: true,
      }, { reason: 'Neverless ticket support access' });
      updated += 1;
    } catch (error) {
      console.warn(`[ticket-support] Failed to update ${channel.name}: ${error.message}`);
    }
  }

  return updated;
}

async function handleAddSupport(interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'addsupport' || !interaction.guild) return false;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'هذا الأمر للإدارة فقط.', ephemeral: true });
    return true;
  }

  const role = interaction.options.getRole('role', true);
  if (role.id === interaction.guild.roles.everyone.id) {
    await interaction.reply({ content: 'ما تقدر تستخدم رتبة @everyone كرتبة دعم.', ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const before = getGuild(interaction.guildId);
  const previousRoleId = before.supportRoleId || null;

  await patchGuild(interaction.guildId, { supportRoleId: role.id });
  const after = getGuild(interaction.guildId);
  const updated = await applySupportRoleToOpenTickets(
    interaction.guild,
    previousRoleId,
    role.id,
    after,
  );

  await interaction.editReply({
    content: [
      `تم تحديد ${role} كرتبة **Ticket Support** بدون إعادة إعداد نظام التذاكر.`,
      `تم تحديث صلاحيات **${updated}** تذكرة مفتوحة حاليًا.`,
      'الرتبة تقدر تشوف التذاكر وتكتب فيها وتستخدم خيارات الدعم الموجودة، بدون إعطائها صلاحيات إدارة عامة من هذا النظام.',
    ].join('\n'),
    allowedMentions: { roles: [] },
  });
  return true;
}

function installTicketSupport(client) {
  if (client.__neverlessTicketSupportInstalled) return;
  client.__neverlessTicketSupportInstalled = true;
  client.on('interactionCreate', (interaction) => {
    handleAddSupport(interaction).catch((error) => {
      console.error('[ticket-support] /addsupport failed:', error);
      if (!interaction.isRepliable?.()) return;
      const payload = { content: 'صار خطأ أثناء تحديث رتبة الدعم.', ephemeral: true };
      if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
      else interaction.reply(payload).catch(() => {});
    });
  });
}

module.exports = {
  SUPPORT_ALLOW,
  isTicketChannel,
  applySupportRoleToOpenTickets,
  handleAddSupport,
  installTicketSupport,
};
