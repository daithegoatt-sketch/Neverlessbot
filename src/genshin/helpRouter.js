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
      '`rate Skirk artifacts on my account` — artifact RV + CV and weakest-link review',
      '`improve Skirk artifacts` — Artifact Doctor fixes the weakest piece around the build targets',
      '`improve Skirk artifacts, raise CRIT Rate to 80` — Doctor with a specific stat target',
      '`pick best Skirk Circlet artifact` — start screenshot picker; then send 1–10 artifact screenshots',
      '`Skirk stats on my account` — current account stats only',
      '`compare Skirk on my account` — compare with an older saved build',
      '`rate team Sandrone on my account` — review Premium options from your Showcase',
      '`rate my team Sandrone Yae Miko Qiqi Nicole` — inspect a specific four-character team',
      '`team combo Sandrone` — published Premium lineup + rotation when available',
      '`explain Furina` — role, skills, teams and constellation notes',
      '`Skirk leaderboard` — server ranking for that character',
      '`Neverless leaderboard` — linked-account strength ranking',
      '`my characters` — visible Showcase characters',
      '`link UID 7XXXXXXXXX` / `unlink UID` — manage your linked account',
      '',
      'Mention Neverless Bot in the Genshin channel before the command. During an active Artifact Picker session, the next image batch can be sent without another mention.',
    ].join('\n');
  }

  return [
    '**Neverless Genshin — Help**',
    '`بيلد Skirk` — الارتيفاكتات، الأسلحة والستات المطلوبة',
    '`تيم Skirk` / `تيم F2P Skirk` — تيمات Premium/F2P المنشورة',
    '`تقييم Skirk بحسابي` — تقييم الشخصية الظاهرة بالـShowcase',
    '`قيم ارتيفاكتات Skirk بحسابي` — تقييم القطع بالـRV والـCV وتحديد أضعف حلقة',
    '`تحسين ارتيفاكتات Skirk` — Artifact Doctor يحسن أضعف قطعة حسب تارقت البيلد',
    '`تحسين ارتيفاكتات Skirk ارفع الكريت ريت إلى 80` — تحسين بهدف Stat محدد',
    '`اختر أفضل Circlet ارتيفاكت لـ Skirk` — يبدأ اختيار أفضل قطعة من الصور؛ بعدها أرسل 1–10 صور',
    '`إحصائيات Skirk بحسابي` — إحصائيات الحساب فقط',
    '`قارن Skirk بحسابي` — مقارنة البيلد بنسخة سابقة',
    '`قيم تيم Sandrone بحسابي` — يراجع تيمات Premium حسب الـShowcase',
    '`قيم تيمي Sandrone Yae Miko Qiqi Nicole` — يدقق تيم محدد',
    '`اشرح كومبو تيم Sandrone` — التيم والكومبو المنشور إذا توفر',
    '`اشرح Furina` — شرح الشخصية والتيمات والكونستليشن',
    '`ترتيب Skirk` — ترتيب الشخصية بالسيرفر',
    '`ترتيب Neverless` — ترتيب قوة الحسابات المربوطة',
    '`شخصياتي` — الشخصيات الظاهرة في Showcase',
    '`ربط UID 7XXXXXXXXX` / `فك ربط UID` — إدارة الحساب المربوط',
    '',
    'الأوامر تبدأ بمنشن Neverless Bot داخل روم Genshin. بعد بدء Artifact Picker تقدر ترسل دفعة الصور التالية بدون منشن جديد.',
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
