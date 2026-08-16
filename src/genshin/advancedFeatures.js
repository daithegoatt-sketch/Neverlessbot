'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount } = require('./enkaClient');
const { getGuide, normalizeTeams } = require('./guideClient');
const { resolveCharacter, resolveCharacterMentions } = require('./characterResolver');
const { reviewTeam, accountTeamCandidates, formatReview, formatAccountCandidates, overlapCount } = require('./teamEvaluator');
const { explainCharacter } = require('./characterExplain');
const { findTeamRotation } = require('./kqmClient');
const {
  buildCharacterLeaderboard,
  buildNeverlessLeaderboard,
  formatCharacterLeaderboard,
  formatNeverlessLeaderboard,
} = require('./leaderboard');

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function accountPhrase(text) {
  return /بحسابي|في\s+حسابي|من\s+حسابي|my\s+account|in\s+my\s+account|on\s+my\s+account/i.test(text);
}

function isHelp(text) {
  return /^\s*(help|هيلب|مساعدة|مساعده|الأوامر|الاوامر|commands?)\s*$/iu.test(text);
}

function isTeamReview(text) {
  return /(?:قيم|قيّم|تقييم|حلل|rate|review|evaluate)\s*(?:لي\s*)?(?:تيمي|تيم|team)/iu.test(text)
    || /(?:تيمي|my\s+team).*(?:قيم|تقييم|rate|review)/iu.test(text);
}

function isTeamCombo(text) {
  return /(?:اشرح|شرح|explain)?\s*(?:كومبو|combo|rotation|روتيشن)\s*(?:تيم|team)/iu.test(text)
    || /(?:تيم|team).*(?:كومبو|combo|rotation|روتيشن)/iu.test(text);
}

function isCharacterExplain(text) {
  return /^(?:اشرح|شرح|explain|guide)\b/iu.test(String(text).trim()) && !isTeamCombo(text);
}

function isLeaderboard(text) {
  return /ترتيب|ليدربورد|leaderboard|ranking/iu.test(text);
}

async function send(message, text) {
  await message.channel.send({
    content: text,
    allowedMentions: { users: [], repliedUser: false },
  });
}

async function linkedAccount(message, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar'
      ? 'اربط حسابك أولًا: `ربط UID 729663359`.'
      : 'Link your account first: `link UID 729663359`.');
    return null;
  }
  try {
    return { uid, account: await fetchAccount(uid) };
  } catch {
    await send(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase من Enka الآن. تأكد أن **Show Character Details** مفعّل.'
      : 'I could not read the Showcase from Enka right now. Make sure **Show Character Details** is enabled.');
    return null;
  }
}

function helpText(lang) {
  if (lang === 'en') {
    return [
      '**Neverless Genshin — Help**',
      '`build Skirk` — artifacts, weapons, main stats and targets',
      '`Skirk team` / `Skirk f2p team` — published Premium/F2P teams',
      '`rate Skirk on my account` — rate a visible Showcase build',
      '`Skirk stats on my account` — current account stats only',
      '`compare Skirk on my account` — compare with an older saved build',
      '`rate team Sandrone on my account` — find and review up to 3 Premium options from your Showcase',
      '`rate my team Sandrone Yae Miko Qiqi Nicole` — inspect that exact visible team',
      '`team combo Sandrone` — strongest published Premium lineup + published rotation when available',
      '`team combo Sandrone Yae Miko Qiqi Nicole` — rotation for a specific reasonable lineup when a published match exists',
      '`explain Furina` — role, skills, strong teams and constellation notes',
      '`Skirk leaderboard` — linked server members ranked by that build',
      '`Neverless leaderboard` — account-strength ranking from visible linked Showcase builds',
      '`my characters` — characters Enka can see',
      '`link UID 729663359` / `unlink UID` — manage your linked account',
      '',
      'The bot only reads visible Showcase characters. Mention Neverless Bot in this channel before the command.',
    ].join('\n');
  }
  return [
    '**Neverless Genshin — Help**',
    '`بيلد Skirk` — الارتيفاكتات، الأسلحة، Main Stats والأرقام المستهدفة',
    '`تيم Skirk` / `تيم F2P Skirk` — التيمات المنشورة Premium/F2P',
    '`تقييم Skirk بحسابي` — تقييم بيلد الشخصية الظاهرة بالـShowcase',
    '`إحصائيات Skirk بحسابي` — إحصائيات حسابك فقط بدون تقييم',
    '`قارن Skirk بحسابي` — مقارنة البيلد الحالي بالنسخة السابقة',
    '`قيم تيم Sandrone بحسابي` — يفحص الـShowcase ويعرض حتى 3 احتمالات Premium مناسبة',
    '`قيم تيمي Sandrone Yae Miko Qiqi Nicole` — يدقق هذا التيم نفسه وبيلد كل شخصية ظاهرة',
    '`اشرح كومبو تيم Sandrone` — أقوى Premium lineup منشور + Rotation منشور إذا توفر',
    '`اشرح كومبو تيم Sandrone Yae Miko Qiqi Nicole` — كومبو التشكيلة المحددة إذا لقى لها Rotation موثوق',
    '`اشرح Furina` — دور الشخصية، مهاراتها، نقاط استخدامها والتيمات والكونستليشن',
    '`ترتيب Skirk` — ترتيب أعضاء السيرفر الرابطين حساباتهم وعندهم Skirk ظاهرة',
    '`ترتيب Neverless` — ترتيب قوة الحسابات حسب البيلدات الظاهرة والمقيمة',
    '`شخصياتي` — الشخصيات اللي Enka يقدر يشوفها',
    '`ربط UID 729663359` / `فك ربط UID` — إدارة الحساب المربوط',
    '',
    'البوت يقدر يفحص فقط الشخصيات الظاهرة في Character Showcase. لازم تمنشن Neverless Bot داخل هذا الروم.',
  ].join('\n');
}

function chooseMainFromTeam(names, reviews) {
  if (!names.length) return null;
  if (!reviews?.length) return names[0];
  reviews.sort((a, b) => b.overlap - a.overlap);
  return reviews[0]?.name || names[0];
}

async function detectMainCharacter(names) {
  if (!names.length) return null;
  const reviews = [];
  for (const name of names) {
    const guide = await getGuide(name).catch(() => null);
    const premium = normalizeTeams(guide?.teams).premium;
    let best = 0;
    for (const team of premium) best = Math.max(best, overlapCount(names, team));
    reviews.push({ name, overlap: best });
  }
  return chooseMainFromTeam(names, reviews);
}

async function handleTeamReview(message, text, lang) {
  const linked = await linkedAccount(message, lang);
  if (!linked) return true;
  const names = await resolveCharacterMentions(text, 6);
  if (!names.length) {
    await send(message, lang === 'ar' ? 'حدد الشخصية أو أسماء التيم، مثال: `قيم تيم Sandrone بحسابي`.' : 'Include the main character or team names.');
    return true;
  }

  if (names.length >= 4 || /تيمي|my\s+team/i.test(text)) {
    const team = names.slice(0, 4);
    if (team.length < 4) {
      await send(message, lang === 'ar' ? `عرفت ${team.join(', ')} فقط. اكتب الأربع شخصيات إذا تبي تدقيق تيم محدد.` : `I only found ${team.join(', ')}. Include all four characters for an exact team review.`);
      return true;
    }
    const main = await detectMainCharacter(team);
    const review = await reviewTeam(linked.uid, linked.account, main, team);
    await send(message, formatReview(review, lang, { partial: review.rows.some((row) => !row.visible) }));
    return true;
  }

  const main = names[0];
  if (!accountPhrase(text)) {
    await send(message, lang === 'ar'
      ? `إذا تبي تقييم حسب حسابك قل: \`قيم تيم ${main} بحسابي\`، أو اكتب الأربع شخصيات: \`قيم تيمي ${main} ...\`.`
      : `For a Showcase-based review use \`rate team ${main} on my account\`, or list all four characters.`);
    return true;
  }
  const result = await accountTeamCandidates(linked.uid, linked.account, main, 3);
  await send(message, formatAccountCandidates(result, main, lang));
  return true;
}

async function handleTeamCombo(message, text, lang) {
  const names = await resolveCharacterMentions(text, 6);
  if (!names.length) {
    await send(message, lang === 'ar' ? 'حدد اسم الشخصية أو الأربع شخصيات في التيم.' : 'Include the main character or all four team members.');
    return true;
  }

  let main;
  let team;
  if (names.length >= 4) {
    team = names.slice(0, 4);
    main = await detectMainCharacter(team);
  } else {
    main = names[0];
    const guide = await getGuide(main);
    team = normalizeTeams(guide?.teams).premium[0] || null;
    if (!team) {
      await send(message, lang === 'ar' ? `ما عندي Premium team منشور كفاية لـ **${main}** حتى أبني عليه الكومبو.` : `I do not have a published Premium team for **${main}** to base the combo on.`);
      return true;
    }
  }

  const guide = await getGuide(main);
  const premium = normalizeTeams(guide?.teams).premium;
  const bestOverlap = Math.max(0, ...premium.map((published) => overlapCount(team, published)));
  if (names.length >= 4 && bestOverlap < 3) {
    await send(message, lang === 'ar'
      ? `التيم **${team.join(' • ')}** ما يطابق Premium lineup منشور بشكل كافي عندي، لذلك ما راح أخترع Rotation له.`
      : `**${team.join(' • ')}** does not match a published Premium lineup closely enough, so I will not invent a rotation.`);
    return true;
  }

  const rotation = await findTeamRotation(main, team).catch(() => null);
  const lines = [`**${main} — ${lang === 'ar' ? 'شرح كومبو التيم' : 'Team Combo'}**`, team.join(' • ')];
  if (rotation?.rotation && rotation.matchedMembers >= Math.min(3, team.length)) {
    lines.push(`\n**Rotation:** ${rotation.rotation}`);
    lines.push(lang === 'ar' ? 'الترتيب مأخوذ من Sample Rotation منشور في KQM.' : 'This sequence is from a published KQM sample rotation.');
  } else if (guide?.combos?.length) {
    lines.push(`\n**${lang === 'ar' ? 'كومبو الشخصية المنشور' : 'Published character combo'}:** ${guide.combos[0]}`);
    lines.push(lang === 'ar' ? 'ما لقيت Rotation كامل لنفس الأربع شخصيات، لذلك ما راح أركب ترتيب من عندي.' : 'I could not find a full rotation for the exact four, so I will not invent one.');
  } else {
    lines.push(lang === 'ar' ? '\nما لقيت Rotation منشور موثوق لنفس التشكيلة حاليًا.' : '\nI could not find a reliable published rotation for this exact lineup right now.');
  }
  await send(message, lines.join('\n'));
  return true;
}

async function handleLeaderboard(message, text, lang) {
  if (/neverless|نيفرلس|الحسابات|accounts?/iu.test(text)) {
    const board = await buildNeverlessLeaderboard(message.guild);
    await send(message, formatNeverlessLeaderboard(board, lang));
    return true;
  }
  const characterName = await resolveCharacter(text);
  if (!characterName) {
    await send(message, lang === 'ar' ? 'حدد الشخصية، مثال: `ترتيب Skirk` أو اكتب `ترتيب Neverless`.' : 'Include a character, e.g. `Skirk leaderboard`, or use `Neverless leaderboard`.');
    return true;
  }
  const board = await buildCharacterLeaderboard(message.guild, characterName);
  await send(message, formatCharacterLeaderboard(board, lang));
  return true;
}

async function handleAdvancedMessage(message) {
  const text = String(message?.content || '').trim();
  if (!text) return false;
  const lang = language(text);

  if (isHelp(text)) {
    await send(message, helpText(lang));
    return true;
  }
  if (isLeaderboard(text)) return handleLeaderboard(message, text, lang);
  if (isTeamReview(text)) return handleTeamReview(message, text, lang);
  if (isTeamCombo(text)) return handleTeamCombo(message, text, lang);
  if (isCharacterExplain(text)) {
    const characterName = await resolveCharacter(text);
    if (!characterName) {
      await send(message, lang === 'ar' ? 'حدد اسم الشخصية بعد كلمة `اشرح`.' : 'Include the character name after `explain`.');
      return true;
    }
    const explanation = await explainCharacter(characterName, lang);
    await send(message, explanation || (lang === 'ar' ? `ما قدرت أجيب شرح موثوق لـ **${characterName}** حاليًا.` : `I could not retrieve a reliable explanation for **${characterName}** right now.`));
    return true;
  }
  return false;
}

module.exports = { handleAdvancedMessage, helpText, isTeamReview, isTeamCombo, isLeaderboard };
