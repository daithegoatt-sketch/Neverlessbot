const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

function addDurationAndReason(command) {
  return command
    .addStringOption((o) => o.setName('duration').setDescription('اختياري: 10m / 2h / 1d / 1w — اتركه فاضي للميوت الدائم').setMaxLength(20).setRequired(false))
    .addStringOption((o) => o.setName('reason').setDescription('السبب').setMaxLength(400).setRequired(false));
}

const commands = [
  new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('تحديد روم الترحيب بالأعضاء الجدد')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('روم الWelcome').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('إرسال Embed القوانين في روم محدد')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('روم القوانين').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption((o) => o.setName('rules').setDescription('نص القوانين').setMaxLength(4000).setRequired(true))
    .addStringOption((o) => o.setName('image_url').setDescription('رابط الصورة أسفل القوانين').setRequired(true)),
  new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('إعداد لوحة التذاكر')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('الروم الذي ستظهر فيه لوحة التذاكر').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addChannelOption((o) => o.setName('category').setDescription('التصنيف الذي ستفتح داخله التذاكر').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addRoleOption((o) => o.setName('support_role').setDescription('رتبة فريق الدعم').setRequired(true))
    .addStringOption((o) => o.setName('image_url').setDescription('صورة اختيارية للوحة التذاكر').setRequired(false)),
  new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('إنشاء نظام الرومات الصوتية المؤقتة')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('category_name').setDescription('اسم التصنيف').setMaxLength(90).setRequired(false))
    .addStringOption((o) => o.setName('lobby_name').setDescription('اسم روم إنشاء الغرفة').setMaxLength(90).setRequired(false)),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('طرد عضو من السيرفر')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('السبب').setMaxLength(400).setRequired(false)),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('حظر عضو من السيرفر')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true))
    .addIntegerOption((o) => o.setName('delete_days').setDescription('حذف رسائل آخر كم يوم (0-7)').setMinValue(0).setMaxValue(7).setRequired(false))
    .addStringOption((o) => o.setName('reason').setDescription('السبب').setMaxLength(400).setRequired(false)),
  addDurationAndReason(
    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('ميوت/Timeout للعضو، والمدة اختيارية')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  ),
  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('فك الميوت عن عضو')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  addDurationAndReason(
    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Timeout للعضو، والمدة اختيارية')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  ),
  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('فك الـTimeout عن عضو')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  addDurationAndReason(
    new SlashCommandBuilder()
      .setName('mutevc')
      .setDescription('منع عضو من الكلام بالصوت، والمدة اختيارية')
      .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
      .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  ),
  new SlashCommandBuilder()
    .setName('unmutevc')
    .setDescription('فك VC Mute عن عضو')
    .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  new SlashCommandBuilder()
    .setName('links')
    .setDescription('إدارة الرومات المسموح فيها نشر الروابط')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub
      .setName('allow')
      .setDescription('السماح بالروابط في روم')
      .addChannelOption((o) => o.setName('channel').setDescription('الروم').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('إلغاء السماح بالروابط في روم')
      .addChannelOption((o) => o.setName('channel').setDescription('الروم').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand((sub) => sub.setName('list').setDescription('عرض الرومات المسموح فيها روابط')),
  new SlashCommandBuilder()
    .setName('uid-unlink')
    .setDescription('Admin: فك UID مربوط بعضو آخر')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('uid').setDescription('UID المطلوب فك ربطه').setMinLength(9).setMaxLength(10).setRequired(true)),
  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('قفل الكتابة في شات')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('channel').setDescription('الروم، أو اتركه فارغاً للروم الحالي').addChannelTypes(ChannelType.GuildText).setRequired(false)),
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('فتح الكتابة في شات')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((o) => o.setName('channel').setDescription('الروم، أو اتركه فارغاً للروم الحالي').addChannelTypes(ChannelType.GuildText).setRequired(false)),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('مسح عدد محدد من الرسائل')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName('amount').setDescription('من 1 إلى 100').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('سحب عضو من روم صوتي إلى روم صوتي آخر')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('الروم الصوتي الهدف').addChannelTypes(ChannelType.GuildVoice).setRequired(true)),
].map((command) => command.toJSON());

module.exports = { commands };
