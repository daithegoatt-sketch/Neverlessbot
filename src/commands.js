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
      .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  ),
  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('فك الميوت عن عضو')
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  new SlashCommandBuilder()
    .setName('addadmin')
    .setDescription('تحديد رتبة تستطيع استخدام /mute و /unmute عبر Neverless فقط')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((o) => o.setName('role').setDescription('الرتبة المسموح لها بالميوت وفك الميوت').setRequired(true)),
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('إدارة الكلمات والإنذارات في Neverless AutoMod')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub
      .setName('addword')
      .setDescription('إضافة كلمة أو عبارة ممنوعة')
      .addStringOption((o) => o.setName('word').setDescription('الكلمة أو العبارة').setMinLength(1).setMaxLength(100).setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('removeword')
      .setDescription('حذف كلمة أو عبارة من AutoMod')
      .addStringOption((o) => o.setName('word').setDescription('الكلمة أو العبارة').setMinLength(1).setMaxLength(100).setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('removewarn')
      .setDescription('إزالة إنذارات AutoMod من عضو')
      .addUserOption((o) => o.setName('member').setDescription('العضو').setRequired(true))
      .addStringOption((o) => o
        .setName('type')
        .setDescription('نوع الإنذار المطلوب حذفه')
        .setRequired(true)
        .addChoices(
          { name: 'Spam', value: 'spam' },
          { name: 'Language', value: 'language' },
          { name: 'All', value: 'all' },
        )))
    .addSubcommand((sub) => sub.setName('list').setDescription('عرض الكلمات والعبارات الممنوعة')),
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
    .setName('broadcast')
    .setDescription('Admin: إرسال إعلان خاص لكل أعضاء السيرفر')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('message').setDescription('نص الرسالة').setMaxLength(4000).setRequired(true))
    .addStringOption((o) => o.setName('title').setDescription('عنوان الرسالة').setMaxLength(256).setRequired(false))
    .addStringOption((o) => o.setName('image_url').setDescription('رابط صورة اختياري').setRequired(false))
    .addStringOption((o) => o.setName('link_url').setDescription('رابط اختياري يظهر كزر').setRequired(false))
    .addStringOption((o) => o.setName('button_text').setDescription('اسم زر الرابط').setMaxLength(80).setRequired(false)),
  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Admin: إنشاء رسالة Embed في روم محدد')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) => o.setName('channel').setDescription('الروم المطلوب').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addStringOption((o) => o.setName('title').setDescription('عنوان الـEmbed').setMaxLength(256).setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('محتوى الـEmbed').setMaxLength(4000).setRequired(true))
    .addStringOption((o) => o.setName('image_url').setDescription('رابط صورة اختياري').setRequired(false))
    .addStringOption((o) => o.setName('link_url').setDescription('رابط اختياري يظهر كزر').setRequired(false))
    .addStringOption((o) => o.setName('button_text').setDescription('اسم زر الرابط').setMaxLength(80).setRequired(false)),
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
