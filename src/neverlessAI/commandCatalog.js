'use strict';

const { commands } = require('../commands');

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#/@<>-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PUBLIC_COMMANDS = Object.freeze([
  {
    syntax: '#رابط',
    kind: 'message',
    scope: 'public',
    description: 'إنشاء أو جلب رابط الدعوة الشخصي للعضو في Neverless.',
    aliases: ['رابط السيرفر', 'invite', 'server invite', 'دعوة'],
  },
  {
    syntax: 'توب',
    kind: 'message',
    scope: 'activity-channel',
    channelId: '1538570405617598505',
    description: 'ترتيب نشاط الأعضاء الإجمالي. ويمكن إضافة يومي/أسبوعي/شهري.',
    aliases: ['top', 'توب يومي', 'توب أسبوعي', 'توب اسبوعي', 'توب شهري', 'activity leaderboard', 'اكثر متفاعل'],
  },
  {
    syntax: 'توب دعوات',
    kind: 'message',
    scope: 'activity-channel',
    channelId: '1538570405617598505',
    description: 'ترتيب دعوات أعضاء Neverless.',
    aliases: ['top invites', 'ترتيب الدعوات', 'اكثر دعوات'],
  },
  {
    syntax: 'دعواتي',
    kind: 'message',
    scope: 'activity-channel',
    channelId: '1538570405617598505',
    description: 'عرض عدد دعوات العضو.',
    aliases: ['my invites', 'دعوات'],
  },
  {
    syntax: '-نك <الاسم>',
    kind: 'message',
    scope: 'public',
    description: 'تغيير لقبك داخل السيرفر. استخدام -نك بدون اسم يزيل لقبك.',
    aliases: ['nickname', 'غير اسمي', 'لقبي'],
  },
  {
    syntax: 'ربط UID 7XXXXXXXXX',
    kind: 'message',
    scope: 'genshin',
    description: 'ربط حساب Genshin بالعضو بعد التحقق من UID.',
    aliases: ['link uid', 'ربط حساب قينشن', 'uid'],
  },
  {
    syntax: 'فك ربط UID',
    kind: 'message',
    scope: 'genshin',
    description: 'فك حساب Genshin المربوط بالعضو.',
    aliases: ['unlink uid', 'الغاء ربط', 'إلغاء ربط'],
  },
  {
    syntax: 'شخصياتي',
    kind: 'message',
    scope: 'genshin',
    description: 'عرض شخصيات الحساب المربوط/Showcase حسب نظام Neverless.',
    aliases: ['my characters', 'شخصيات حسابي'],
  },
  {
    syntax: 'تقييم <Character> بحسابي',
    example: 'تقييم Skirk بحسابي',
    kind: 'message',
    scope: 'genshin',
    description: 'تشغيل تقييم Neverless الحقيقي للشخصية الظاهرة في Showcase.',
    aliases: ['قيم بيلدي', 'تقييم البيلد', 'rate character', 'rate build', 'تقييم سكيرك'],
  },
  {
    syntax: 'قيم احصائيات <Character>',
    example: 'قيم احصائيات Skirk',
    kind: 'message',
    scope: 'genshin',
    description: 'مراجعة إحصائيات الشخصية عبر نظام Neverless.',
    aliases: ['قيم إحصائيات', 'rate stats', 'احصائيات الشخصية'],
  },
  {
    syntax: 'شنو يمنع <Character> من 90',
    example: 'شنو يمنع Skirk من 90',
    kind: 'message',
    scope: 'genshin',
    description: 'شرح أهم العوائق التي تمنع البيلد من الوصول للهدف وفق تقييم Neverless.',
    aliases: ['وش يمنع', 'why not 90', 'رفع التقييم'],
  },
  {
    syntax: '-فلكس بيلد <Character>',
    example: '-فلكس بيلد Skirk',
    kind: 'message',
    scope: 'public',
    description: 'عرض Flex Build للشخصية من الحساب المربوط.',
    aliases: ['-flex build', '-فليكس بيلد', 'flex build'],
  },
  {
    syntax: '-كويز',
    kind: 'message',
    scope: 'public',
    description: 'بدء Genshin Quiz.',
    aliases: ['-quiz', 'كويز قينشن'],
  },
  {
    syntax: '-تيم المسرح الحالي',
    kind: 'message',
    scope: 'public',
    description: 'عرض معلومات Imaginarium Theater الحالي والعناصر وOpening Cast وSpecial Guests.',
    aliases: ['المسرح الحالي', 'theater current', 'imaginarium theater'],
  },
  {
    syntax: '-تيم المسرح <Easy|Normal|Hard|Visionary|Lunar>',
    example: '-تيم المسرح Hard',
    kind: 'message',
    scope: 'public',
    description: 'بناء Route للمسرح حسب الصعوبة مع Vigor والبوسات والتفاعلات.',
    aliases: ['تيم المسرح سهل', 'تيم المسرح صعب', 'theater team', 'theater plan'],
  },
  {
    syntax: '-بنر',
    kind: 'message',
    scope: 'public',
    description: 'عرض البنر الحالي من المصدر المستخدم في Neverless. ويمكن طلب القادم أو بنر الأسلحة.',
    aliases: ['-بانر', '-بنر القادم', '-بنر اسلحة', '-banner', 'البنر الحالي'],
  },
  {
    syntax: '-أكواد',
    kind: 'message',
    scope: 'public',
    description: 'عرض أكواد Genshin الفعالة التي يتحقق منها Neverless.',
    aliases: ['-اكواد', '-codes', 'اكواد قينشن'],
  },
  {
    syntax: '-ريديم <code>',
    kind: 'message',
    scope: 'public',
    description: 'إعطاء رابط الاسترداد الرسمي لكود Genshin.',
    aliases: ['-redeem', 'استرداد كود'],
  },
  {
    syntax: '-كويست <اسم المهمة>',
    kind: 'message',
    scope: 'public',
    description: 'البحث عن شرح فيديو للمهمة.',
    aliases: ['-quest', 'شرح مهمة'],
  },
  {
    syntax: '-flex neverless',
    kind: 'message',
    scope: 'public',
    description: 'عرض صاحب Top Neverless الحالي وبيلداته الأقوى.',
    aliases: ['-فلكس Neverless', '-فليكس Neverless', 'top neverless'],
  },
  {
    syntax: '@Neverless Bot Hall of fame',
    kind: 'mention',
    scope: 'public',
    description: 'عرض Neverless Hall of Fame لأصحاب Top Neverless منذ تفعيل القاعة.',
    aliases: ['قاعة الأبطال', 'Hall of Fame', 'قاعه الابطال'],
  },
]);

function slashCatalog() {
  return (commands || []).map((command) => ({
    syntax: `/${command.name}`,
    kind: 'slash',
    scope: command.default_member_permissions ? 'staff-or-permissioned' : 'server',
    description: command.description || '',
    aliases: [command.name],
  }));
}

function allCommands() {
  return [...PUBLIC_COMMANDS, ...slashCatalog()];
}

function scoreEntry(entry, query) {
  const wanted = normalize(query);
  if (!wanted) return 1;
  const haystack = normalize([
    entry.syntax,
    entry.example,
    entry.description,
    ...(entry.aliases || []),
  ].filter(Boolean).join(' '));
  if (haystack.includes(wanted)) return 100 + wanted.length;
  const tokens = wanted.split(' ').filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 12 : 5;
  }
  return score;
}

function searchCommandCatalog(query, limit = 12) {
  return allCommands()
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.syntax.localeCompare(b.entry.syntax))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 12)))
    .map(({ entry }) => entry);
}

module.exports = {
  PUBLIC_COMMANDS,
  allCommands,
  searchCommandCatalog,
};
