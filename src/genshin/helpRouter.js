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
      '`artifact doctor` — interactive character/slot menu for build upgrades',
      '`improve Skirk artifacts` — direct Artifact Doctor plan for one character',
      '`pick best Skirk Circlet artifact` — compare 1–10 screenshots directly',
      '`Skirk stats on my account` — current account stats only',
      '`compare Skirk on my account` — compare with an older saved build',
      '`rate team Sandrone on my account` — review Premium options from your Showcase',
      '`team combo Sandrone` — published Premium lineup + rotation when available',
      '`explain Furina` — role, skills, teams and constellation notes',
      '`Skirk leaderboard` — server ranking for that character',
      '`Neverless leaderboard` — linked-account strength ranking',
      '`my characters` — visible Showcase characters',
      '`link UID 7XXXXXXXXX` / `unlink UID` — manage your linked account',
      '',
      'Mention Neverless Bot in the Genshin channel before the command. During an active Artifact Doctor session, follow-up image messages do not need another mention.',
    ].join('\n');
  }

  return [
    '**Neverless Genshin — Help**',
    '`بيلد Skirk` — الارتيفاكتات، الأسلحة والستات المطلوبة',
    '`تيم Skirk` / `تيم F2P Skirk` — تيمات Premium/F2P المنشورة',
    '`تقييم Skirk بحسابي` — تقييم الشخصية الظاهرة بالـShowcase',
    '`قيم ارتيفاكتات Skirk بحسابي` — تقييم مختصر للقطع بـRV وCV',
    '`طبيب الارتيفاكتات` — واجهة تفاعلية لاختيار الشخصية والقطع وإرسال الصور',
    '`تحسين ارتيفاكتات Skirk` — خطة تطوير مباشرة حسب بيلد الشخصية',
    '`اختر أفضل Circlet ارتيفاكت لـ Skirk` — مقارنة 1–10 صور مباشرة',
    '`إحصائيات Skirk بحسابي` — إحصائيات الحساب فقط',
    '`قارن Skirk بحسابي` — مقارنة البيلد بنسخة سابقة',
    '`قيم تيم Sandrone بحسابي` — يراجع تيمات Premium حسب الـShowcase',
    '`اشرح كومبو تيم Sandrone` — التيم والكومبو المنشور إذا توفر',
    '`اشرح Furina` — شرح الشخصية والتيمات والكونستليشن',
    '`ترتيب Skirk` — ترتيب الشخصية بالسيرفر',
    '`ترتيب Neverless` — ترتيب قوة الحسابات المربوطة',
    '`شخصياتي` — الشخصيات الظاهرة في Showcase',
    '`ربط UID 7XXXXXXXXX` / `فك ربط UID` — إدارة الحساب المربوط',
    '',
    'لازم تمنشن Neverless Bot داخل روم Genshin قبل الأمر. داخل جلسة طبيب الارتيفاكتات، رسائل الصور التالية ما تحتاج منشن جديد.',
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
