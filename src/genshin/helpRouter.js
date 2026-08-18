'use strict';

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function isHelp(text) {
  return /^\s*(help|هيلب|مساعدة|مساعده|الأوامر|الاوامر|commands?)\s*$/iu.test(String(text || ''));
}

function helpText(lang) {
  if (lang === 'en') {
    return [
      '**Neverless Genshin — Help**',
      '`build Skirk` — artifacts, weapons, main stats and targets',
      '`Skirk team` / `Skirk f2p team` — published Premium/F2P teams',
      '`rate Skirk on my account` — rate a visible Showcase build',
      '`rate Skirk artifacts on my account` — compact RV/CV artifact review',
      '`improve Skirk artifacts` — text-only artifact improvement plan',
      '`Skirk stats on my account` — current account stats only',
      '`compare Skirk on my account` — compare with an older saved build',
      '`who should I build` — build priority from your visible roster',
      '`account summary` — top builds, best team and current priority',
      '`what is my account missing` — useful characters not visible for your strongest team shells',
      '`compare Skirk with @member` — compare the same visible character between two linked members',
      '`best team on my account` — strongest published team you can make; you can add off-Showcase characters with `I have X`',
      '`two Abyss teams` — two non-overlapping teams with current Game8 Floor 12 context',
      '`what changed` / `what changed Skirk` — latest saved build changes',
      '`rate team Sandrone on my account` — review Premium options from your Showcase',
      '`team combo Sandrone` — published Premium lineup + rotation when available',
      '`explain Furina` — role, skills, teams and constellation notes',
      '`Skirk leaderboard` — server ranking for that character',
      '`Neverless leaderboard` — linked-account strength ranking',
      '`my characters` — visible Showcase characters',
      '`link UID 7XXXXXXXXX` / `unlink UID` — manage your linked account',
      '',
      'Mention Neverless Bot in the Genshin channel before the command.',
    ].join('\n');
  }

  return [
    '**Neverless Genshin — Help**',
    '`بيلد Skirk` — الارتيفاكتات، الأسلحة والستات المطلوبة',
    '`تيم Skirk` / `تيم F2P Skirk` — تيمات Premium/F2P المنشورة',
    '`تقييم Skirk بحسابي` — تقييم الشخصية الظاهرة بالـShowcase',
    '`قيم ارتيفاكتات Skirk بحسابي` — تقييم مختصر للقطع بـRV وCV',
    '`تحسين ارتيفاكتات Skirk` — خطة تحسين نصية حسب بيلد الشخصية',
    '`إحصائيات Skirk بحسابي` — إحصائيات الحساب فقط',
    '`قارن Skirk بحسابي` — مقارنة البيلد بنسخة سابقة',
    '`مين ابني` — يرتب لك أولوية بناء الشخصيات الظاهرة',
    '`ملخص حسابي` — أقوى البيلدات، أفضل تيم وأولوية التطوير',
    '`شنو ناقص حسابي` — شخصيات مفيدة ناقصة من الـShowcase لتكميل أقوى التيمات',
    '`قارن Skirk مع @member` — مقارنة نفس الشخصية بين حسابين مربوطين',
    '`أفضل تيم عندي` — أقوى تيم منشور من الموجود؛ وإذا عندك شخصية خارج الـShowcase قل `عندي X`',
    '`تيمين Abyss` — تيمين بدون تكرار مع مراعاة Game8 Floor 12 الحالي',
    '`وش تغير` / `وش تغير Skirk` — آخر فرق محفوظ في البيلدات',
    '`قيم تيم Sandrone بحسابي` — يراجع تيمات Premium حسب الـShowcase',
    '`اشرح كومبو تيم Sandrone` — التيم والكومبو المنشور إذا توفر',
    '`اشرح Furina` — شرح الشخصية والتيمات والكونستليشن',
    '`ترتيب Skirk` — ترتيب الشخصية بالسيرفر',
    '`ترتيب Neverless` — ترتيب قوة الحسابات المربوطة',
    '`شخصياتي` — الشخصيات الظاهرة في Showcase',
    '`ربط UID 7XXXXXXXXX` / `فك ربط UID` — إدارة الحساب المربوط',
    '',
    'لازم تمنشن Neverless Bot داخل روم Genshin قبل الأمر.',
  ].join('\n');
}

async function handleHelpMessage(message) {
  const text = String(message?.content || '').trim();
  if (!isHelp(text)) return false;
  await message.channel.send({
    content: helpText(language(text)),
    allowedMentions: { users: [], repliedUser: false },
  });
  return true;
}

module.exports = { handleHelpMessage, helpText, isHelp };
