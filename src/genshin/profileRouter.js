'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot, listCharacters, accountSummary } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { evaluateBuild } = require('./buildEvaluator');
const { fetchAkashaPercentile } = require('./akashaClient');
const { buildNeverlessLeaderboard } = require('./leaderboard');
const { getEntries } = require('./buildHistory');
const { resolveCharacter } = require('./characterResolver');
const { getConstellation } = require('./dataClient');
const { formatStat } = require('./statProfile');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function isProfile(text) {
  return /^(?:بروفايلي|بروفايل(?:ي)?|ملفي|profile|my\s+profile)$/iu.test(String(text || '').trim());
}

function isHistory(text) {
  const value = String(text || '').trim();
  return /^(?:تاريخ|history)\s+.+/iu.test(value) || /.+\s+(?:history|تاريخ)$/iu.test(value);
}

function isC1Weapon(text) {
  const value = String(text || '');
  return /\bc1\b.*(?:سلاح|weapon)|(?:سلاح|weapon).*\bc1\b/iu.test(value);
}

async function send(message, content) {
  await message.channel.send({ content, allowedMentions: { users: [], repliedUser: false } });
}

function maskUid(uid) {
  const value = String(uid || '');
  if (value.length < 6) return value;
  return `${value.slice(0, 2)}${'•'.repeat(Math.max(3, value.length - 5))}${value.slice(-3)}`;
}

function topPercent(value) {
  const number = Number(value?.topPercent ?? value);
  return Number.isFinite(number) ? number : null;
}

function percentText(value) {
  const number = topPercent(value);
  if (!Number.isFinite(number)) return '—';
  if (number > 0 && number < 0.01) return 'Top <0.01%';
  return `Top ${number >= 10 ? Math.round(number) : Number(number.toFixed(2))}%`;
}

async function rateVisible(uid, account) {
  const rows = listCharacters(account).slice(0, 12);
  const rated = await Promise.all(rows.map(async (row) => {
    try {
      const character = findCharacter(account, row.name);
      const snapshot = getBuildSnapshot(character);
      const guide = await getGuide(row.name);
      if (!snapshot || !guide) return null;
      const akasha = await fetchAkashaPercentile(uid, row.name).catch(() => null);
      const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile: akasha });
      return { name: row.name, score: evaluation.score, akasha, snapshot };
    } catch {
      return null;
    }
  }));
  return rated.filter(Boolean);
}

async function handleProfile(message, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return true;
  }
  let account;
  try { account = await fetchAccount(uid); } catch {
    await send(message, lang === 'ar' ? 'ما قدرت أقرأ الـShowcase من Enka الآن.' : 'I could not read your Showcase from Enka right now.');
    return true;
  }
  const summary = accountSummary(account);
  const rated = await rateVisible(uid, account);
  const strongest = [...rated].sort((a, b) => b.score - a.score)[0] || null;
  const bestAkasha = [...rated].filter((row) => Number.isFinite(topPercent(row.akasha))).sort((a, b) => topPercent(a.akasha) - topPercent(b.akasha))[0] || null;

  let serverRank = null;
  let serverTotal = null;
  try {
    const board = await buildNeverlessLeaderboard(message.guild);
    const index = board.rows.findIndex((row) => String(row.discordUserId) === String(message.author.id));
    if (index >= 0) {
      serverRank = index + 1;
      serverTotal = board.rows.length;
    }
  } catch (error) {
    console.warn('[profile] server rank unavailable:', error.message);
  }

  const ar = lang === 'ar';
  const lines = [`**Neverless — ${ar ? 'بروفايلك' : 'Your Profile'}**`];
  lines.push(`${summary.nickname || (ar ? 'الحساب' : 'Account')} • AR ${summary.adventureRank ?? '?'} • UID ${maskUid(uid)}`);
  lines.push(`${ar ? 'الـShowcase' : 'Showcase'}: **${summary.characters.length}** ${ar ? 'شخصية ظاهرة' : 'visible characters'}`);
  if (strongest) lines.push(`${ar ? 'أقوى بيلد' : 'Strongest build'}: **${strongest.name} — ${strongest.score}% Neverless**`);
  if (bestAkasha) lines.push(`${ar ? 'أفضل Akasha' : 'Best Akasha'}: **${bestAkasha.name} — ${percentText(bestAkasha.akasha)}**`);
  if (serverRank) lines.push(`${ar ? 'ترتيب الحساب بالسيرفر' : 'Server account rank'}: **#${serverRank}/${serverTotal}**`);
  lines.push(ar ? 'يعتمد البروفايل على الشخصيات الظاهرة بالـShowcase.' : 'Profile data uses characters visible in Showcase.');
  await send(message, lines.join('\n'));
  return true;
}

function historyRelevant(entry) {
  const rows = entry?.evaluation?.relevantStats || [];
  return rows
    .filter((row) => Number.isFinite(row?.value))
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 2)
    .map((row) => `${row.label || row.key} ${formatStat(row.key, row.value)}`);
}

async function handleHistory(message, text, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first.');
    return true;
  }
  const characterName = await resolveCharacter(text).catch(() => null);
  if (!characterName) {
    await send(message, lang === 'ar' ? 'حدد الشخصية، مثال: `تاريخ Skirk`.' : 'Include a character, e.g. `history Skirk`.');
    return true;
  }
  const entries = getEntries(message.author.id, uid, characterName);
  if (!entries.length) {
    await send(message, lang === 'ar'
      ? `ما عندي تاريخ محفوظ لـ **${characterName}** حتى الآن. التاريخ ينحفظ لما تطلب تقييم الشخصية ويتغير البيلد.`
      : `I do not have saved history for **${characterName}** yet. History is saved when you rate the character after changing the build.`);
    return true;
  }
  const ar = lang === 'ar';
  const lines = [`**${characterName} — ${ar ? 'تاريخ البيلد' : 'Build History'}**`];
  entries.slice(-10).forEach((entry, index) => {
    const unix = Math.floor((Date.parse(entry.savedAt || '') || Date.now()) / 1000);
    const score = Number(entry?.evaluation?.score);
    const extras = historyRelevant(entry);
    const weapon = entry?.snapshot?.weapon?.name;
    const detail = [...extras, weapon ? `${ar ? 'السلاح' : 'Weapon'}: ${weapon}` : null].filter(Boolean).join(' • ');
    lines.push(`${index + 1}. <t:${unix}:d> — **${Number.isFinite(score) ? `${score}%` : '?'} Neverless**${detail ? `\n   ${detail}` : ''}`);
  });
  await send(message, lines.join('\n'));
  return true;
}

function firstSentence(text, max = 230) {
  const value = String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!value) return '—';
  const sentence = value.match(/^.*?[.!?](?:\s|$)/)?.[0] || value;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

async function handleC1Weapon(message, text, lang) {
  const characterName = await resolveCharacter(text).catch(() => null);
  if (!characterName) {
    await send(message, lang === 'ar' ? 'حدد الشخصية، مثال: `C1 ولا سلاح Skirk`.' : 'Include a character, e.g. `Skirk C1 or weapon`.');
    return true;
  }
  const [guide, constellations] = await Promise.all([
    getGuide(characterName).catch(() => null),
    getConstellation(characterName).catch(() => null),
  ]);
  const c1 = constellations?.c1 || null;
  const weapons = (guide?.weapons || []).filter(Boolean).slice(0, 3);
  const bestWeapon = weapons[0] || null;
  if (!c1 || !bestWeapon) {
    await send(message, lang === 'ar'
      ? `ما عندي بيانات موثوقة كفاية حتى أقارن C1 والسلاح لـ **${characterName}** بدون تخمين.`
      : `I do not have enough reliable data to compare C1 and weapon for **${characterName}** without guessing.`);
    return true;
  }

  let current = null;
  const uid = getLinkedUid(message.author.id);
  if (uid) {
    try {
      const account = await fetchAccount(uid);
      const character = findCharacter(account, characterName);
      if (character) current = getBuildSnapshot(character);
    } catch {}
  }

  const ar = lang === 'ar';
  let verdict;
  let reason;
  if (current?.constellation >= 1) {
    verdict = ar ? 'السلاح أقرب' : 'Weapon is the relevant upgrade';
    reason = ar ? 'شخصيتك الظاهرة عندها C1 بالفعل.' : 'Your visible character already has C1.';
  } else if (current?.weapon?.name && current.weapon.name.toLowerCase() === bestWeapon.toLowerCase()) {
    verdict = 'C1';
    reason = ar ? `أنت تستخدم **${bestWeapon}** بالفعل، لذلك C1 هو التطوير المباشر التالي.` : `You already use **${bestWeapon}**, so C1 is the direct next upgrade.`;
  } else if (current?.weapon?.name) {
    const rank = weapons.findIndex((name) => name.toLowerCase() === current.weapon.name.toLowerCase());
    if (rank >= 0) {
      verdict = 'C1';
      reason = ar
        ? `سلاحك الحالي **${current.weapon.name}** موجود ضمن أفضل ${weapons.length} خيارات Game8؛ لذلك C1 أقرب كقيمة إضافية بدل استبدال سلاح قوي أصلًا.`
        : `Your current **${current.weapon.name}** is already in Game8's top ${weapons.length}, so C1 is the closer incremental upgrade.`;
    } else {
      verdict = ar ? `السلاح — ${bestWeapon}` : `Weapon — ${bestWeapon}`;
      reason = ar
        ? `سلاحك الحالي **${current.weapon.name}** مو ضمن أعلى خيارات Game8 الحالية، بينما **${bestWeapon}** في المركز الأول.`
        : `Your current **${current.weapon.name}** is outside Game8's current top options while **${bestWeapon}** is ranked first.`;
    }
  } else {
    verdict = ar ? 'يعتمد على سلاحك الحالي' : 'Depends on your current weapon';
    reason = ar
      ? `إذا عندك واحد من أفضل الخيارات (${weapons.join('، ')}) فـC1 أقرب؛ إذا لا، **${bestWeapon}** أقرب. اربط الحساب وأظهر الشخصية حتى أحسمها حسب سلاحك.`
      : `If you already have one of the top options (${weapons.join(', ')}), C1 is closer; otherwise **${bestWeapon}** is closer. Link and show the character for an account-specific call.`;
  }

  const lines = [`**${characterName} — C1 ولا سلاح؟**`, `**${ar ? 'الخلاصة' : 'Verdict'}: ${verdict}**`, reason, '', `**C1 — ${c1.name || 'C1'}:** ${firstSentence(c1.description)}`, `**${ar ? 'أفضل أسلحة Game8' : 'Game8 top weapons'}:** ${weapons.join(' • ')}`];
  lines.push(ar ? 'المقارنة ما تستخدم أرقام Damage مخترعة؛ تعتمد على بيلدك الظاهر + ترتيب الأسلحة المنشور وتأثير C1 من بيانات اللعبة.' : 'This does not invent damage percentages; it uses your visible build, published weapon ranking, and the in-game C1 effect.');
  await send(message, lines.join('\n'));
  return true;
}

async function handleProfileMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return false;
  const text = String(message.content || '').trim();
  if (!text) return false;
  const lang = language(text);
  if (isProfile(text)) return handleProfile(message, lang);
  if (isC1Weapon(text)) return handleC1Weapon(message, text, lang);
  if (isHistory(text)) return handleHistory(message, text, lang);
  return false;
}

module.exports = {
  handleProfileMessage,
  isProfile,
  isHistory,
  isC1Weapon,
  maskUid,
  percentText,
  firstSentence,
};
