'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter } = require('./enkaClient');
const { rateCurrentCharacter } = require('./liveAccountRating');
const { resolveCharacter } = require('./characterResolver');
const { formatStat, formatTarget } = require('./statProfile');
const { blockersForRated } = require('./genshinExtras');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function isStatReviewRequest(text) {
  const value = String(text || '').trim();
  return /^(?:قيم|قيّم)\s+(?:إحصائيات|احصائيات)(?=\s|$)/u.test(value)
    || /^rate\s+(?:the\s+)?stats(?=\s|$)/i.test(value);
}

function ratingTargetFromText(text) {
  const value = String(text || '').trim();
  const arabic = value.match(/^(?:شنو|وش|ايش|إيش|ماذا)\s+يمنع\s+.+?\s+(?:من|عن)\s*(\d{1,3})\s*%?\s*$/u);
  const english = value.match(/^what.*(?:stops|keeps|prevents).*?(?:from|below)\s*(\d{1,3})\s*%?\s*$/i);
  const number = Number((arabic || english)?.[1]);
  return Number.isInteger(number) && number >= 1 && number <= 100 ? number : null;
}

function isLegacyFlexAttempt(text) {
  const value = String(text || '').trim();
  return /^(?:فلكس|فليكس|flex|flix)\s+(?:بيلد|build)(?=\s|$)/iu.test(value);
}

function isLegacyQuizAttempt(text) {
  return /^(?:genshin\s+)?(?:quiz|كويز|اختبار\s+قينشن)$/iu.test(String(text || '').trim());
}

function isCorrectionRequest(text) {
  return isStatReviewRequest(text)
    || ratingTargetFromText(text) != null
    || isLegacyFlexAttempt(text)
    || isLegacyQuizAttempt(text);
}

async function send(message, content) {
  await message.channel.send({
    content,
    allowedMentions: { users: [], repliedUser: false },
  });
}

async function linkedRatedCharacter(message, text, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return null;
  }

  const characterName = await resolveCharacter(text).catch(() => null);
  if (!characterName) {
    await send(message, lang === 'ar' ? 'حدد اسم الشخصية داخل الطلب.' : 'Include the character name in the request.');
    return null;
  }

  let account;
  try {
    account = await fetchAccount(uid, { forceRefresh: true });
  } catch (error) {
    console.warn('[genshin-extras-corrections] Enka fetch failed:', error.message);
    await send(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن Show Character Details مفعّل.'
      : 'I could not read your Showcase right now. Make sure Show Character Details is enabled.');
    return null;
  }

  const character = findCharacter(account, characterName);
  if (!character) {
    await send(message, lang === 'ar'
      ? `**${characterName}** غير ظاهرة بالتفاصيل في الـShowcase حاليًا.`
      : `**${characterName}** is not visible with details in your Showcase.`);
    return null;
  }

  const rated = await rateCurrentCharacter(uid, account, characterName).catch(() => null);
  if (!rated) {
    await send(message, lang === 'ar'
      ? `أقدر أشوف **${characterName}** لكن ما عندي Guide موثوق كفاية حتى أحللها.`
      : `I can see **${characterName}**, but I do not have a reliable enough guide to analyze it.`);
    return null;
  }

  return { uid, account, characterName, rated };
}

async function handleStatReview(message, text, lang) {
  const data = await linkedRatedCharacter(message, text, lang);
  if (!data) return true;

  const evaluation = data.rated.evaluation;
  const rows = evaluation.relevantStats || [];
  const ar = lang === 'ar';
  const lines = [
    `**${data.rated.name} — ${ar ? 'تقييم إحصائيات حسابك' : 'Your Stat Review'}**`,
    `Neverless: **${data.rated.score}%**`,
  ];

  if (!rows.length) {
    lines.push(ar
      ? 'المصدر الحالي ما يعطي Breakpoints رقمية كفاية لهذه الشخصية، لذلك ما راح أخترع أرقام مستهدفة.'
      : 'The current source does not provide enough numeric breakpoints for this character, so I will not invent targets.');
    if (data.rated.guide?.stats?.priority) {
      lines.push(`${ar ? 'أولوية الستات المنشورة' : 'Published stat priority'}: ${data.rated.guide.stats.priority}`);
    }
    await send(message, lines.join('\n'));
    return true;
  }

  for (const row of rows) {
    const effective = Number(row.effectiveValue);
    let status;
    if (row.key === 'critRate' && effective > 100) status = ar ? '⚠ Overcap واضح' : '⚠ Clear overcap';
    else if (row.status === 'down') status = ar ? '❌ ناقص' : '❌ Low';
    else if (row.status === 'warn') status = ar ? '⚠ زائد عن الاحتياج' : '⚠ Above useful target';
    else status = ar ? '✅ محقق الهدف' : '✅ Target met';

    const combat = Number(row.combatBonus) > 0
      ? ` (${ar ? 'فعلي بالتأثيرات' : 'effective'} ${formatStat(row.key, effective)})`
      : '';
    lines.push(`• **${row.label}** ${formatStat(row.key, Number(row.value))}${combat} — ${status} • ${ar ? 'الهدف' : 'target'} ${formatTarget(row.target)}`);
  }

  const low = rows.filter((row) => row.status === 'down').length;
  const over = rows.filter((row) => row.status === 'warn').length
    + rows.filter((row) => row.key === 'critRate' && Number(row.effectiveValue) > 100).length;
  if (!low && !over) {
    lines.push(ar ? '\nالستات ذات الأهداف الرقمية متوازنة حاليًا.' : '\nStats with numeric targets are currently balanced.');
  }

  await send(message, lines.join('\n'));
  return true;
}

async function handleRatingTarget(message, text, lang, target) {
  const data = await linkedRatedCharacter(message, text, lang);
  if (!data) return true;

  const ar = lang === 'ar';
  const score = Number(data.rated.score) || 0;
  if (score >= target) {
    await send(message,
      `**${data.rated.name}** ${ar ? 'بالفعل وصلت' : 'already reached'} **${score}% Neverless** — ${ar ? `ما فيه شيء يمنعها من ${target}.` : `nothing is keeping it below ${target}.`}`,
    );
    return true;
  }

  const blockers = blockersForRated(data.rated, lang);
  const gap = Math.max(0, target - score);
  const lines = [
    `**${ar ? 'شنو يمنع' : 'What keeps'} ${data.rated.name} ${ar ? `من ${target}؟` : `from ${target}?`}**`,
    `${ar ? 'الحالي' : 'Current'}: **${score}% Neverless** • ${ar ? 'الهدف' : 'Target'}: **${target}%** • ${ar ? 'الفارق' : 'Gap'}: **${gap}**`,
  ];

  if (blockers.length) {
    lines.push(`\n**${ar ? 'أكبر العوائق بالترتيب' : 'Biggest blockers'}:**`);
    blockers.slice(0, 3).forEach((row, index) => lines.push(`${index + 1}. ${row.text}`));
  } else {
    lines.push(ar
      ? 'ما عندي نقص رقمي واضح من الـGuide؛ الفرق المتبقي غالبًا من جودة السابستات/Akasha ومكونات التقييم الأخرى.'
      : 'There is no clear numeric guide deficit; the remaining gap is most likely substat/Akasha quality and other rating components.');
  }

  lines.push(ar
    ? '\nما أعطي خصم نقاط وهمي لكل سبب؛ هذه الأولويات مأخوذة من نفس مكونات تقييم Neverless.'
    : '\nI do not invent per-issue point deductions; these priorities come from the same Neverless rating components.');
  await send(message, lines.join('\n'));
  return true;
}

async function handleExtrasCorrectionsMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return false;
  const text = String(message.content || '').trim();
  if (!text || !isCorrectionRequest(text)) return false;
  const lang = language(text);

  if (isLegacyQuizAttempt(text)) {
    await send(message, lang === 'ar' ? 'الكويز صار Public بكل الرومات: `-كويز`.' : 'Quiz is now public in every channel: `-quiz`.');
    return true;
  }
  if (isLegacyFlexAttempt(text)) {
    await send(message, lang === 'ar' ? 'Flex Build صار Public بكل الرومات: `-فلكس بيلد Skirk`.' : 'Flex Build is now public in every channel: `-flex build Skirk`.');
    return true;
  }
  if (isStatReviewRequest(text)) return handleStatReview(message, text, lang);

  const target = ratingTargetFromText(text);
  if (target != null) return handleRatingTarget(message, text, lang, target);
  return false;
}

module.exports = {
  handleExtrasCorrectionsMessage,
  isCorrectionRequest,
  isStatReviewRequest,
  ratingTargetFromText,
  isLegacyFlexAttempt,
  isLegacyQuizAttempt,
};
