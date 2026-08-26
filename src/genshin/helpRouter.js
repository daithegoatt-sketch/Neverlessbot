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
      '`flex build Skirk` — compact shareable build/rating card',
      '`is my Skirk build finished` — tells you if meaningful farming is still needed',
      '`weakest artifact Skirk` — finds the first piece worth replacing',
      '`weakest character team Sandrone` — team bottleneck from published/explicit Showcase members',
      '`rate stats Skirk` — checks numeric targets and useful overcap',
      '`compare Skirk with server` — benchmark against linked server builds',
      '`what prevents Skirk from 90` — biggest blockers below 90 Neverless',
      '`quiz` — interactive Genshin question',
      '`who should I build` — build priority from your visible roster',
      '`account summary` — top builds, best team and current priority',
      '`what is my account missing` — useful characters not visible for your strongest team shells',
      '`compare Skirk with @member` — compare the same visible character between two linked members',
      '`best team on my account` — strongest published team you can make; you can add off-Showcase characters with `I have X`',
      '`two Abyss teams` — two non-overlapping teams with current Game8 Floor 12 context',
      '`what changed` / `what changed Skirk` — latest saved build changes',
      '`profile` — compact linked-account profile from valid saved ratings',
      '`history Skirk` — saved Neverless build history for that character',
      '`rate team Sandrone on my account` — review Premium options from your Showcase',
      '`team combo Sandrone` — published Premium lineup + rotation when available',
      '`explain Furina` — role, skills, teams and constellation notes',
      '`Skirk leaderboard` — server ranking for that character',
      '`Neverless leaderboard` — linked-account strength ranking',
      '`my characters` — visible Showcase characters',
      '`-codes` — currently active redemption codes',
      '`-banner countdown` — official time remaining on the current banner',
      '`-redeem` / `-redeem CODE` — official HoYoverse redemption link',
      '`-banner` / `-upcoming banner` — current or officially announced upcoming character wishes',
      '`-weapon banner` / `-upcoming weapon banner` — current or officially announced weapon wish',
      '`-quest <quest name>` — find a direct Genshin quest walkthrough video',
      '`link UID 7XXXXXXXXX` / `unlink UID` — manage your linked account',
      '',
      'Top Character and Top Neverless achievement roles are assigned automatically from the same linked Showcase leaderboard logic.',
      'Commands starting with `-` work in every server channel without a mention. Account/profile commands require mentioning Neverless Bot in the Genshin bot channel.',
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
    '`فلكس بيلد Skirk` — بطاقة مختصرة للبيلد والتقييم للمشاركة',
    '`هل خلص بيلد Skirk` — يحدد إذا البيلد عمليًا مكتمل أو يحتاج Farming',
    '`أضعف قطعة عندي في Skirk` — يحدد أول قطعة تستحق التغيير',
    '`أضعف شخصية بتيم Sandrone بحسابي` — يحدد Bottleneck من التيم المنشور أو الأربع شخصيات التي تكتبها',
    '`قيم احصائيات Skirk` — يفحص الأهداف الرقمية والـOvercap المفيد',
    '`قارن Skirk بالسيرفر` — يقارن بيلدك مع الحسابات المربوطة بالسيرفر',
    '`شنو يمنع Skirk من 90` — يرتب أكبر العوائق تحت 90 Neverless',
    '`كويز` — سؤال Genshin تفاعلي',
    '`مين ابني` — يرتب لك أولوية بناء الشخصيات الظاهرة',
    '`ملخص حسابي` — أقوى البيلدات، أفضل تيم وأولوية التطوير',
    '`شنو ناقص حسابي` — شخصيات مفيدة ناقصة من الـShowcase لتكميل أقوى التيمات',
    '`قارن Skirk مع @member` — مقارنة نفس الشخصية بين حسابين مربوطين',
    '`أفضل تيم عندي` — أقوى تيم منشور من الموجود؛ وإذا عندك شخصية خارج الـShowcase قل `عندي X`',
    '`تيمين Abyss` — تيمين بدون تكرار مع مراعاة Game8 Floor 12 الحالي',
    '`وش تغير` / `وش تغير Skirk` — آخر فرق محفوظ في البيلدات',
    '`بروفايلي` — ملخص حسابك من آخر تقييمات Neverless الصالحة',
    '`تاريخ Skirk` — سجل تقييمات Neverless المحفوظة للشخصية',
    '`قيم تيم Sandrone بحسابي` — يراجع تيمات Premium حسب الـShowcase',
    '`اشرح كومبو تيم Sandrone` — التيم والكومبو المنشور إذا توفر',
    '`اشرح Furina` — شرح الشخصية والتيمات والكونستليشن',
    '`ترتيب Skirk` — ترتيب الشخصية بالسيرفر',
    '`ترتيب Neverless` — ترتيب قوة الحسابات المربوطة',
    '`شخصياتي` — الشخصيات الظاهرة في Showcase',
    '`-كود` — الأكواد الفعالة حاليًا فقط',
    '`-كم باقي على البنر` — الوقت الرسمي المتبقي للبنر الحالي',
    '`-ريديم` / `-ريديم CODE` — رابط الاسترداد الرسمي من HoYoverse',
    '`-بنر` / `-البنر القادم` — البنر الحالي أو القادم المعلن رسميًا',
    '`-بنر الاسلحه` / `-بنر الاسلحه القادم` — بنر الأسلحة الحالي أو القادم المعلن رسميًا',
    '`-كويست اسم الكويست` — يجيب لك شرح فيديو مباشر للكويست',
    '`ربط UID 7XXXXXXXXX` / `فك ربط UID` — إدارة الحساب المربوط',
    '',
    'رتب Top Character وTop Neverless تنعطى تلقائيًا من نفس منطق ترتيب الحسابات والـShowcase المربوط.',
    'الأوامر اللي تبدأ بـ`-` تشتغل بكل رومات السيرفر بدون منشن. أوامر الحساب والبروفايل تحتاج منشن Neverless Bot داخل روم البوت.',
  ].join('\n');
}

function splitHelp(content, max = 1900) {
  const lines = String(content || '').split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function handleHelpMessage(message) {
  const text = String(message?.content || '').trim();
  if (!isHelp(text)) return false;
  for (const chunk of splitHelp(helpText(language(text)))) {
    await message.channel.send({
      content: chunk,
      allowedMentions: { users: [], repliedUser: false },
    });
  }
  return true;
}

module.exports = { handleHelpMessage, helpText, isHelp, splitHelp };
