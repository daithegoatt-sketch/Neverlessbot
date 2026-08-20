'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, accountSummary } = require('./enkaClient');
const { rateVisibleAccount } = require('./liveAccountRating');
const { getCachedNeverlessLeaderboard } = require('./leaderboard');
const { getEntries } = require('./buildHistory');
const { resolveCharacter } = require('./characterResolver');
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
  return Number.isFinite(number) && number > 0 ? number : null;
}

function percentText(value) {
  const number = topPercent(value);
  if (!Number.isFinite(number)) return '—';
  if (number < 0.01) return 'Top <0.01%';
  return `Top ${number >= 10 ? Math.round(number) : Number(number.toFixed(2))}%`;
}

function formatCurrentRatings(rated, lang = 'ar') {
  const rows = [...(rated || [])]
    .filter((row) => Number.isFinite(Number(row?.score)) && Number(row.score) > 0)
    .sort((a, b) => b.score - a.score);
  if (!rows.length) return [];
  const label = lang === 'ar' ? '**تقييمات Neverless الحالية:**' : '**Current Neverless ratings:**';
  const lines = [label];
  for (let index = 0; index < rows.length; index += 4) {
    lines.push(rows.slice(index, index + 4).map((row) => `${row.name} **${row.score}%**`).join(' • '));
  }
  return lines;
}

async function handleProfile(message, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return true;
  }

  let account;
  try {
    // fetchAccount follows Enka's ttl, then refreshes automatically. No manual character
    // rating is required; every visible Showcase build is evaluated here.
    account = await fetchAccount(uid);
  } catch {
    await send(message, lang === 'ar' ? 'ما قدرت أقرأ الـShowcase من Enka الآن.' : 'I could not read your Showcase from Enka right now.');
    return true;
  }

  const summary = accountSummary(account);
  const current = await rateVisibleAccount(uid, account);
  const rated = current.rated;
  const strongest = [...rated].sort((a, b) => b.score - a.score)[0] || null;
  const bestAkasha = [...rated]
    .filter((row) => Number.isFinite(topPercent(row.akasha)))
    .sort((a, b) => topPercent(a.akasha) - topPercent(b.akasha))[0] || null;

  const board = getCachedNeverlessLeaderboard(message.guild);
  let serverRank = null;
  let serverTotal = null;
  if (board?.rows?.length) {
    const index = board.rows.findIndex((row) => String(row.discordUserId) === String(message.author.id));
    if (index >= 0) {
      serverRank = index + 1;
      serverTotal = board.rows.length;
    }
  }

  const ar = lang === 'ar';
  const lines = [`**Neverless — ${ar ? 'بروفايلك' : 'Your Profile'}**`];
  lines.push(`${summary.nickname || (ar ? 'الحساب' : 'Account')} • AR ${summary.adventureRank ?? '?'} • UID ${maskUid(uid)}`);
  lines.push(`${ar ? 'الـShowcase' : 'Showcase'}: **${summary.characters.length}** ${ar ? 'شخصية ظاهرة' : 'visible characters'} • ${ar ? 'تقييم صالح' : 'valid ratings'} **${rated.length}**`);
  lines.push(...formatCurrentRatings(rated, lang));

  if (strongest) lines.push(`${ar ? 'أقوى بيلد' : 'Strongest build'}: **${strongest.name} — ${strongest.score}% Neverless**`);
  if (bestAkasha) lines.push(`${ar ? 'أفضل Akasha' : 'Best Akasha'}: **${bestAkasha.name} — ${percentText(bestAkasha.akasha)}**`);
  if (serverRank) lines.push(`${ar ? 'ترتيب الحساب بالسيرفر' : 'Server account rank'}: **#${serverRank}/${serverTotal}**`);

  if (!rated.length) {
    lines.push(ar
      ? 'ما فيه تقييم Neverless صالح أقدر أحسبه من الـShowcase الحالي. أي نتيجة **0%** ما تظهر بالبروفايل.'
      : 'There is no valid Neverless rating I can calculate from the current Showcase. Any **0%** result is hidden from the profile.');
  }

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

async function handleProfileMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return false;
  const text = String(message.content || '').trim();
  if (!text) return false;
  const lang = language(text);
  if (isProfile(text)) return handleProfile(message, lang);
  if (isHistory(text)) return handleHistory(message, text, lang);
  return false;
}

module.exports = {
  handleProfileMessage,
  isProfile,
  isHistory,
  maskUid,
  percentText,
  formatCurrentRatings,
};
