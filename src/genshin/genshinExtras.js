'use strict';

const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter } = require('./enkaClient');
const { rateCurrentCharacter } = require('./liveAccountRating');
const { resolveCharacter, resolveCharacterMentions } = require('./characterResolver');
const { reviewArtifacts } = require('./artifactEvaluator');
const { accountTeamCandidates } = require('./teamEvaluator');
const { buildCharacterLeaderboard } = require('./leaderboard');
const { syncCharacterAchievement } = require('./achievementRoles');
const { formatStat, formatTarget } = require('./statProfile');
const { getCharacterNames, getCharacter } = require('./dataClient');
const { buildRatingCard } = require('./buildCard');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const QUIZ_TTL_MS = 2 * 60 * 1000;
const quizSessions = new Map();
let installed = false;

const ELEMENTS = ['Pyro', 'Hydro', 'Electro', 'Cryo', 'Anemo', 'Geo', 'Dendro'];
const WEAPONS = ['Sword', 'Claymore', 'Polearm', 'Bow', 'Catalyst'];
const REGIONS = ['Mondstadt', 'Liyue', 'Inazuma', 'Sumeru', 'Fontaine', 'Natlan', 'Nod-Krai', 'Snezhnaya'];

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function isQuiz(text) {
  return /^(?:genshin\s+)?(?:quiz|كويز|اختبار\s+قينشن)$/iu.test(String(text || '').trim());
}

function isFlexBuild(text) {
  return /^(?:فلكس|فليكس|flex|flix)\s+(?:بيلد|build)\b/iu.test(String(text || '').trim());
}

function isFinishedBuild(text) {
  const value = String(text || '').trim();
  return /(?:هل\s+)?(?:خلص|خلصت|مخلص)\s+(?:بيلدي|بيلد|البيلد)/iu.test(value)
    || /(?:is|am)\s+.*build\s+(?:done|finished)/iu.test(value);
}

function isWeakestPiece(text) {
  return /أضعف\s+(?:قطعة|قطعه)/iu.test(String(text || ''))
    || /weakest\s+(?:artifact|piece)/iu.test(String(text || ''));
}

function isBottleneck(text) {
  return /أضعف\s+شخصية\s+(?:ب|في)?\s*تيم/iu.test(String(text || ''))
    || /weakest\s+(?:character|build).*(?:team)/iu.test(String(text || ''));
}

function isStatReview(text) {
  return /^(?:قيم|قيّم)\s+(?:إحصائيات|احصائيات)\b/iu.test(String(text || '').trim())
    || /^rate\s+(?:the\s+)?stats\b/iu.test(String(text || '').trim());
}

function isServerCompare(text) {
  return /(?:قارن|مقارنة).*(?:بالسيرفر|مع\s+السيرفر)/iu.test(String(text || ''))
    || /compare.*(?:server|neverless server)/iu.test(String(text || ''));
}

function isWhyNot90(text) {
  return /(?:شنو|وش|ايش|إيش|ماذا)\s+يمنع.*(?:من|عن)\s*90/iu.test(String(text || ''))
    || /what.*(?:stops|keeps|prevents).*(?:90)/iu.test(String(text || ''));
}

function isExtrasRequest(text) {
  return isQuiz(text)
    || isFlexBuild(text)
    || isFinishedBuild(text)
    || isWeakestPiece(text)
    || isBottleneck(text)
    || isStatReview(text)
    || isServerCompare(text)
    || isWhyNot90(text);
}

async function send(message, content, options = {}) {
  await message.channel.send({
    content,
    files: options.files || [],
    components: options.components || [],
    allowedMentions: { users: [], repliedUser: false },
  });
}

async function linkedAccount(message, lang, forceRefresh = true) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar'
      ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.'
      : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return null;
  }
  try {
    return { uid, account: await fetchAccount(uid, { forceRefresh }) };
  } catch (error) {
    console.warn('[genshin-extras] Enka fetch failed:', error.message);
    await send(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن **Show Character Details** مفعّل.'
      : 'I could not read your Showcase right now. Make sure **Show Character Details** is enabled.');
    return null;
  }
}

async function linkedRatedCharacter(message, text, lang) {
  const characterName = await resolveCharacter(text).catch(() => null);
  if (!characterName) {
    await send(message, lang === 'ar'
      ? 'حدد الشخصية داخل الطلب، مثال: `شنو يمنع Skirk من 90`.'
      : 'Include the character name in the request.');
    return null;
  }
  const linked = await linkedAccount(message, lang, true);
  if (!linked) return null;
  const visible = findCharacter(linked.account, characterName);
  if (!visible) {
    await send(message, lang === 'ar'
      ? `**${characterName}** غير ظاهرة بالتفاصيل في الـShowcase حاليًا.`
      : `**${characterName}** is not visible with details in your Showcase.`);
    return null;
  }
  const rated = await rateCurrentCharacter(linked.uid, linked.account, characterName).catch(() => null);
  if (!rated) {
    await send(message, lang === 'ar'
      ? `أقدر أشوف **${characterName}** لكن ما عندي Guide موثوق كفاية حتى أحلل البيلد.`
      : `I can see **${characterName}**, but I do not have a reliable enough guide to analyze the build.`);
    return null;
  }
  return { ...linked, characterName, rated };
}

function topPercent(value) {
  const number = Number(value?.topPercent ?? value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatTop(value) {
  const number = topPercent(value);
  if (!Number.isFinite(number)) return '—';
  if (number < 0.01) return 'Top <0.01%';
  return `Top ${number >= 10 ? Math.round(number) : Number(number.toFixed(2))}%`;
}

function blockersForRated(rated, lang = 'ar') {
  const ar = lang === 'ar';
  const evaluation = rated?.evaluation;
  if (!evaluation) return [];
  const blockers = [];

  for (const row of evaluation.relevantStats || []) {
    if (row.status !== 'down') continue;
    const severity = Math.max(1, (1 - Number(row.ratio || 0)) * Number(row.weight || 1) * 100);
    blockers.push({
      type: 'stat',
      severity,
      text: ar
        ? `${row.label}: **${formatStat(row.key, Number(row.effectiveValue))}** بينما الهدف **${formatTarget(row.target)}**`
        : `${row.label}: **${formatStat(row.key, Number(row.effectiveValue))}** vs target **${formatTarget(row.target)}**`,
    });
  }

  if (evaluation.artifactCount < 5) {
    blockers.push({
      type: 'completion',
      severity: 120,
      text: ar ? `الآرتيفاكتات غير مكتملة: **${evaluation.artifactCount}/5**` : `Artifacts incomplete: **${evaluation.artifactCount}/5**`,
    });
  } else if (evaluation.artifactAvgLevel < 20) {
    blockers.push({
      type: 'completion',
      severity: Math.max(10, (20 - evaluation.artifactAvgLevel) * 12),
      text: ar ? `متوسط مستوى الآرتيفاكت **+${evaluation.artifactAvgLevel}/20**` : `Average artifact level is **+${evaluation.artifactAvgLevel}/20**`,
    });
  }

  if (evaluation.mainStatScore < 100) {
    blockers.push({
      type: 'main',
      severity: (100 - evaluation.mainStatScore) * 1.1,
      text: ar ? `مطابقة Main Stats فقط **${evaluation.mainStatScore}%**` : `Main Stat match is only **${evaluation.mainStatScore}%**`,
    });
  }
  if (evaluation.artifactSetScore < 100) {
    blockers.push({
      type: 'set',
      severity: (100 - evaluation.artifactSetScore) * 0.7,
      text: ar ? `مطابقة الـArtifact Set **${evaluation.artifactSetScore}%**` : `Artifact Set match is **${evaluation.artifactSetScore}%**`,
    });
  }
  if (evaluation.weaponScore < 80) {
    blockers.push({
      type: 'weapon',
      severity: (100 - evaluation.weaponScore) * 0.45,
      text: ar ? `السلاح يعطي مطابقة **${evaluation.weaponScore}%** مع الخيارات المنشورة` : `Weapon match is **${evaluation.weaponScore}%** against published options`,
    });
  }

  const artifacts = reviewArtifacts(rated.snapshot, rated.guide);
  const weakest = artifacts.prioritized?.[0] || null;
  if (weakest && (weakest.usefulRv < 550 || !weakest.mainMatch || weakest.level < 20)) {
    const reasons = [];
    if (!weakest.mainMatch) reasons.push(ar ? 'Main Stat غير مناسب' : 'wrong main stat');
    if (weakest.level < 20) reasons.push(`+${weakest.level}/20`);
    if (weakest.usefulRv < 550) reasons.push(`RV ${weakest.usefulRv}%`);
    blockers.push({
      type: 'piece',
      severity: Math.max(8, (550 - weakest.usefulRv) / 6) + (!weakest.mainMatch ? 50 : 0),
      text: `${ar ? 'أضعف قطعة' : 'Weakest piece'}: **${weakest.slotLabel}** — ${reasons.join(' • ')}`,
    });
  }

  return blockers.sort((a, b) => b.severity - a.severity);
}

async function handleFlexBuild(message, text, lang) {
  const data = await linkedRatedCharacter(message, text, lang);
  if (!data) return true;
  const { rated } = data;
  const s = rated.snapshot.stats || {};
  const lines = [
    `**${rated.name} — Flex Build**`,
    `Neverless: **${rated.score}%** • Akasha: **${formatTop(rated.akasha)}**`,
    `CR **${formatStat('critRate', s.critRate)}** • CD **${formatStat('critDmg', s.critDmg)}** • ER **${formatStat('er', s.er)}**`,
    `${lang === 'ar' ? 'السلاح' : 'Weapon'}: **${rated.snapshot.weapon?.name || '—'}${rated.snapshot.weapon?.refinement ? ` R${rated.snapshot.weapon.refinement}` : ''}**`,
  ];

  let files = [];
  try {
    const characterData = await getCharacter(rated.name).catch(() => null);
    const card = await buildRatingCard(
      rated.character,
      rated.snapshot,
      rated.evaluation,
      null,
      { characterData, akashaPercentile: rated.akasha },
    );
    files = [{ attachment: card, name: `${rated.name.replace(/[^a-z0-9]+/gi, '-')}-flex.png` }];
  } catch (error) {
    console.warn('[genshin-extras] Flex card failed:', error.message);
  }

  await send(message, lines.join('\n'), { files });
  return true;
}

async function handleFinishedBuild(message, text, lang) {
  const data = await linkedRatedCharacter(message, text, lang);
  if (!data) return true;
  const { rated } = data;
  const blockers = blockersForRated(rated, lang);
  const down = (rated.evaluation.notes || []).filter((note) => note.type === 'down');
  const complete = rated.score >= 90
    && rated.evaluation.artifactCount === 5
    && rated.evaluation.artifactAvgLevel >= 19.5
    && down.length === 0;
  const almost = !complete && rated.score >= 86 && down.length === 0;
  const ar = lang === 'ar';
  const verdict = complete
    ? (ar ? 'نعم — بيلدك يعتبر **مكتمل عمليًا**.' : 'Yes — this build is **practically finished**.')
    : almost
      ? (ar ? 'قريب جدًا — البيلد **شبه مكتمل** والتحسينات المتبقية صغيرة.' : 'Very close — the build is **nearly finished**.')
      : (ar ? 'لا، ما زالت فيه مساحة واضحة للتحسين.' : 'No — there is still clear room to improve.');
  const lines = [`**${rated.name} — ${ar ? 'هل خلص بيلدي؟' : 'Is my build finished?'}**`, `Neverless: **${rated.score}%**`, verdict];
  if (!complete && blockers.length) {
    lines.push(`\n**${ar ? 'أهم شيء باقي' : 'Main remaining issue'}:**`);
    blockers.slice(0, 2).forEach((row) => lines.push(`• ${row.text}`));
  }
  await send(message, lines.join('\n'));
  return true;
}

async function handleWeakestPiece(message, text, lang) {
  const data = await linkedRatedCharacter(message, text, lang);
  if (!data) return true;
  const report = reviewArtifacts(data.rated.snapshot, data.rated.guide);
  const row = report.prioritized?.[0] || null;
  if (!row) {
    await send(message, lang === 'ar' ? 'ما لقيت آرتيفاكتات كفاية أفحصها.' : 'I could not find enough artifacts to inspect.');
    return true;
  }
  const ar = lang === 'ar';
  const reasons = [];
  if (!row.mainMatch) reasons.push(ar ? `Main Stat الحالي **${row.mainStat}** غير مطابق` : `current Main Stat **${row.mainStat}** does not match`);
  if (row.level < 20) reasons.push(`${ar ? 'المستوى' : 'level'} +${row.level}/20`);
  reasons.push(`RV **${row.usefulRv}%**`);
  reasons.push(`CV **${row.cv}**`);
  const lines = [
    `**${data.rated.name} — ${ar ? 'أضعف قطعة عندك' : 'Weakest artifact'}**`,
    `**${row.slotLabel}** — ${row.set || '—'}`,
    reasons.join(' • '),
  ];
  if (row.mainOptions?.length && !row.mainMatch) lines.push(`${ar ? 'المطلوب' : 'Recommended'}: **${row.mainOptions.join(' / ')}**`);
  lines.push(ar
    ? 'هذا الاختيار مبني على نفس RV/Main Stat/أولوية الستات المستخدمة في تقييم الآرتيفاكتات الحالي.'
    : 'This uses the same RV/Main Stat/stat-priority logic as the existing artifact review.');
  await send(message, lines.join('\n'));
  return true;
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try { out[index] = await mapper(items[index], index); } catch { out[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return out;
}

async function explicitTeamRows(uid, account, names) {
  return mapLimit(names, 4, async (name) => {
    const visible = findCharacter(account, name);
    if (!visible) return { name, visible: false, score: null, rated: null };
    const rated = await rateCurrentCharacter(uid, account, name).catch(() => null);
    return { name, visible: true, score: rated?.score ?? null, rated };
  });
}

function formatBottleneck(rows, team, lang, sourceNote = null) {
  const ar = lang === 'ar';
  const visible = rows.filter((row) => row.visible);
  const missing = rows.filter((row) => !row.visible).map((row) => row.name);
  const rated = visible.filter((row) => Number.isFinite(Number(row.score)));
  const weakest = [...rated].sort((a, b) => Number(a.score) - Number(b.score))[0] || null;
  const lines = [`**${ar ? 'أضعف شخصية بالتيم' : 'Team bottleneck'}**`, team.join(' • ')];
  if (sourceNote) lines.push(sourceNote);

  if (missing.length) {
    lines.push(ar
      ? `استطعت تحديد **${visible.length} شخصيات** من أصل ${team.length}، بينما **${missing.join(', ')}** غير ظاهرة في الـShowcase.`
      : `I could inspect **${visible.length}/${team.length}** characters; **${missing.join(', ')}** is not visible in Showcase.`);
  }

  if (rated.length) {
    lines.push(`\n**${ar ? 'تقييم البيلدات الظاهرة' : 'Visible build ratings'}:**`);
    rated.sort((a, b) => Number(b.score) - Number(a.score)).forEach((row) => lines.push(`• ${row.name}: **${row.score}%**`));
  }
  if (weakest) lines.push(`\n${ar ? 'الأضعف حسب تقييم Neverless للبيلد الحالي' : 'Weakest by current Neverless build rating'}: **${weakest.name} — ${weakest.score}%**`);
  else lines.push(ar ? '\nما عندي تقييمات صالحة كفاية حتى أحدد الأضعف.' : '\nI do not have enough valid ratings to identify the weakest build.');
  return lines.join('\n');
}

async function handleBottleneck(message, text, lang) {
  const linked = await linkedAccount(message, lang, true);
  if (!linked) return true;
  const names = await resolveCharacterMentions(text, 6).catch(() => []);
  if (!names.length) {
    await send(message, lang === 'ar'
      ? 'حدد الشخصية الرئيسية أو الأربع شخصيات، مثال: `أضعف شخصية بتيم Sandrone بحسابي`.'
      : 'Include the main character or all four team members.');
    return true;
  }

  if (names.length >= 4) {
    const team = names.slice(0, 4);
    const rows = await explicitTeamRows(linked.uid, linked.account, team);
    await send(message, formatBottleneck(rows, team, lang));
    return true;
  }

  if (names.length !== 1) {
    await send(message, lang === 'ar'
      ? 'اكتب الشخصية الرئيسية فقط حتى أختار التيم المنشور المناسب، أو اكتب **الأربع شخصيات** إذا عندك تيم محدد.'
      : 'Use only the main character for a published team candidate, or list all four characters for an exact team.');
    return true;
  }

  const main = names[0];
  const result = await accountTeamCandidates(linked.uid, linked.account, main, 1).catch(() => null);
  const candidate = result?.candidates?.[0] || null;
  if (!candidate) {
    await send(message, lang === 'ar'
      ? `ما لقيت Premium team منشور كفاية لـ **${main}** أقدر أبني عليه المقارنة بدون تخمين.`
      : `I could not find a published Premium team for **${main}** to use without guessing.`);
    return true;
  }
  const rows = candidate.rows.map((row) => ({
    name: row.name,
    visible: row.visible,
    score: row.score,
    rated: row,
  }));
  const note = lang === 'ar'
    ? 'التيم المختار مأخوذ من أفضل Premium candidate منشور المتوافق مع الـShowcase الحالي.'
    : 'The team is the best published Premium candidate compatible with the current Showcase.';
  await send(message, formatBottleneck(rows, candidate.team, lang, note));
  return true;
}

async function handleStatReview(message, text, lang) {
  const data = await linkedRatedCharacter(message, text, lang);
  if (!data) return true;
  const evaluation = data.rated.evaluation;
  const rows = evaluation.relevantStats || [];
  const ar = lang === 'ar';
  const lines = [`**${data.rated.name} — ${ar ? 'تقييم الإحصائيات' : 'Stat Review'}**`, `Neverless: **${data.rated.score}%**`];

  if (!rows.length) {
    lines.push(ar
      ? 'المصدر الحالي ما يعطي Breakpoints رقمية كفاية لهذه الشخصية، لذلك ما راح أخترع Overcap أو أرقام مستهدفة.'
      : 'The current source does not provide enough numeric breakpoints for this character, so I will not invent overcap targets.');
    if (data.rated.guide?.stats?.priority) lines.push(`${ar ? 'أولوية الستات المنشورة' : 'Published stat priority'}: ${data.rated.guide.stats.priority}`);
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
  const over = rows.filter((row) => row.status === 'warn').length + rows.filter((row) => row.key === 'critRate' && Number(row.effectiveValue) > 100).length;
  if (!low && !over) lines.push(ar ? '\nالستات ذات الأهداف الرقمية متوازنة حاليًا.' : '\nStats with numeric targets are currently balanced.');
  await send(message, lines.join('\n'));
  return true;
}

async function handleServerCompare(message, text, lang) {
  const characterName = await resolveCharacter(text).catch(() => null);
  if (!characterName) {
    await send(message, lang === 'ar' ? 'حدد الشخصية، مثال: `قارن Skirk بالسيرفر`.' : 'Include a character, e.g. `compare Skirk with the server`.');
    return true;
  }
  if (!getLinkedUid(message.author.id)) {
    await send(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first.');
    return true;
  }

  const board = await buildCharacterLeaderboard(message.guild, characterName);
  await syncCharacterAchievement(message.guild, board).catch(() => false);
  const index = board.rows.findIndex((row) => String(row.discordUserId) === String(message.author.id));
  if (index < 0) {
    await send(message, lang === 'ar'
      ? `ما قدرت ألقى **${characterName}** ظاهرة ومقيمة بحسابك ضمن ترتيب السيرفر الحالي.`
      : `I could not find a visible rated **${characterName}** for you in the current server leaderboard.`);
    return true;
  }

  const row = board.rows[index];
  const avg = board.rows.reduce((sum, item) => sum + Number(item.score || 0), 0) / Math.max(1, board.rows.length);
  const top = board.rows[0];
  const delta = Math.round((row.score - avg) * 10) / 10;
  const ar = lang === 'ar';
  const lines = [
    `**${characterName} — ${ar ? 'مقارنة السيرفر' : 'Server Benchmark'}**`,
    `${ar ? 'تقييمك' : 'Your rating'}: **${row.score}%**`,
    `${ar ? 'ترتيبك' : 'Rank'}: **#${index + 1}/${board.rows.length}**`,
    `${ar ? 'متوسط السيرفر' : 'Server average'}: **${Math.round(avg * 10) / 10}%** (${delta >= 0 ? '+' : ''}${delta})`,
    `${ar ? 'أعلى تقييم' : 'Top rating'}: **${top.score}%**${top.discordUserId === row.discordUserId ? ` — ${ar ? 'أنت المتصدر' : 'you are #1'}` : ''}`,
    `Akasha: **${formatTop(row.akasha)}**`,
  ];
  await send(message, lines.join('\n'));
  return true;
}

async function handleWhyNot90(message, text, lang) {
  const data = await linkedRatedCharacter(message, text, lang);
  if (!data) return true;
  const ar = lang === 'ar';
  if (data.rated.score >= 90) {
    await send(message, `**${data.rated.name}** ${ar ? 'بالفعل وصلت' : 'already reached'} **${data.rated.score}% Neverless** — ${ar ? 'ما فيه شيء يمنعها من 90.' : 'nothing is keeping it below 90.'}`);
    return true;
  }

  const blockers = blockersForRated(data.rated, lang);
  const lines = [`**${ar ? 'شنو يمنع' : 'What keeps'} ${data.rated.name} ${ar ? 'من 90؟' : 'from 90?'}**`, `${ar ? 'الحالي' : 'Current'}: **${data.rated.score}% Neverless**`];
  if (blockers.length) {
    lines.push(`\n**${ar ? 'أكبر العوائق بالترتيب' : 'Biggest blockers'}:**`);
    blockers.slice(0, 3).forEach((row, index) => lines.push(`${index + 1}. ${row.text}`));
  } else {
    lines.push(ar
      ? 'ما عندي نقص رقمي واضح من الـGuide؛ الفرق المتبقي غالبًا من جودة السابستات/Akasha مقارنة بالبيلدات الأقوى.'
      : 'There is no clear numeric guide deficit; the remaining gap is most likely substat/Akasha quality relative to stronger builds.');
  }
  lines.push(ar
    ? '\nما أعطي خصم نقاط وهمي لكل سبب؛ هذه الأولويات مأخوذة من مكونات نفس تقييم Neverless الحالي.'
    : '\nI do not invent per-issue point deductions; these priorities come from the same Neverless evaluation components.');
  await send(message, lines.join('\n'));
  return true;
}

function shuffle(values) {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const j = Math.floor(Math.random() * (index + 1));
    [out[index], out[j]] = [out[j], out[index]];
  }
  return out;
}

function canonicalOption(value, pool) {
  const text = String(value || '').toLowerCase();
  return pool.find((item) => text === item.toLowerCase() || text.includes(item.toLowerCase())) || null;
}

function quizQuestionFromCharacter(name, data, lang) {
  const ar = lang === 'ar';
  const candidates = [];
  const element = canonicalOption(data?.elementText || data?.element || data?.vision, ELEMENTS);
  const weapon = canonicalOption(data?.weaponText || data?.weapon || data?.weaponType, WEAPONS);
  const region = canonicalOption(data?.region || data?.nation, REGIONS);
  if (element) candidates.push({
    prompt: ar ? `**Genshin Quiz**\nما عنصر **${name}**؟` : `**Genshin Quiz**\nWhat is **${name}**'s element?`,
    correct: element,
    pool: ELEMENTS,
  });
  if (weapon) candidates.push({
    prompt: ar ? `**Genshin Quiz**\nشنو نوع سلاح **${name}**؟` : `**Genshin Quiz**\nWhat weapon type does **${name}** use?`,
    correct: weapon,
    pool: WEAPONS,
  });
  if (region) candidates.push({
    prompt: ar ? `**Genshin Quiz**\n**${name}** مرتبطة بأي منطقة؟` : `**Genshin Quiz**\nWhich region is **${name}** associated with?`,
    correct: region,
    pool: REGIONS,
  });
  if (!candidates.length) return null;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const wrong = shuffle(chosen.pool.filter((item) => item !== chosen.correct)).slice(0, 3);
  const options = shuffle([chosen.correct, ...wrong]);
  return { ...chosen, options, correctIndex: options.indexOf(chosen.correct) };
}

async function makeQuiz(lang) {
  const names = await getCharacterNames();
  for (const name of shuffle(names).slice(0, 12)) {
    const data = await getCharacter(name).catch(() => null);
    const question = quizQuestionFromCharacter(name, data, lang);
    if (question) return question;
  }
  return null;
}

function quizRow(session, disabled = false) {
  return new ActionRowBuilder().addComponents(session.options.map((option, index) =>
    new ButtonBuilder()
      .setCustomId(`gquiz:${session.id}:${index}`)
      .setLabel(option.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)));
}

async function handleQuiz(message, lang) {
  const question = await makeQuiz(lang).catch(() => null);
  if (!question) {
    await send(message, lang === 'ar' ? 'ما قدرت أجهز سؤال الآن، حاول مرة ثانية.' : 'I could not prepare a quiz question right now. Try again.');
    return true;
  }
  const id = crypto.randomBytes(5).toString('hex');
  const session = {
    ...question,
    id,
    userId: String(message.author.id),
    lang,
    expiresAt: Date.now() + QUIZ_TTL_MS,
  };
  quizSessions.set(id, session);
  const timer = setTimeout(() => quizSessions.delete(id), QUIZ_TTL_MS + 1000);
  timer.unref?.();
  await send(message, `${session.prompt}\n${lang === 'ar' ? 'اختر الإجابة:' : 'Choose an answer:'}`, { components: [quizRow(session)] });
  return true;
}

async function handleQuizInteraction(interaction) {
  if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith('gquiz:')) return false;
  const [, id, rawIndex] = interaction.customId.split(':');
  const session = quizSessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    quizSessions.delete(id);
    await interaction.reply({ content: 'انتهى وقت هذا السؤال.', ephemeral: true }).catch(() => {});
    return true;
  }
  if (String(interaction.user.id) !== session.userId) {
    await interaction.reply({ content: 'هذا السؤال لصاحب الكويز. اكتب `quiz` وسو سؤال خاص فيك.', ephemeral: true }).catch(() => {});
    return true;
  }
  const index = Number(rawIndex);
  const correct = index === session.correctIndex;
  quizSessions.delete(id);
  const result = correct
    ? (session.lang === 'ar' ? '✅ **إجابة صحيحة!**' : '✅ **Correct!**')
    : (session.lang === 'ar' ? `❌ **خطأ.** الإجابة الصحيحة: **${session.correct}**` : `❌ **Wrong.** Correct answer: **${session.correct}**`);
  await interaction.update({
    content: `${session.prompt}\n\n${result}`,
    components: [quizRow(session, true)],
    allowedMentions: { parse: [] },
  }).catch(() => {});
  return true;
}

async function handleGenshinExtrasMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return false;
  const text = String(message.content || '').trim();
  if (!text || !isExtrasRequest(text)) return false;
  const lang = language(text);

  if (isQuiz(text)) return handleQuiz(message, lang);
  if (isFlexBuild(text)) return handleFlexBuild(message, text, lang);
  if (isFinishedBuild(text)) return handleFinishedBuild(message, text, lang);
  if (isWeakestPiece(text)) return handleWeakestPiece(message, text, lang);
  if (isBottleneck(text)) return handleBottleneck(message, text, lang);
  if (isStatReview(text)) return handleStatReview(message, text, lang);
  if (isServerCompare(text)) return handleServerCompare(message, text, lang);
  if (isWhyNot90(text)) return handleWhyNot90(message, text, lang);
  return false;
}

function installGenshinExtras(client) {
  if (installed) return;
  installed = true;
  client.on('interactionCreate', (interaction) => {
    Promise.resolve(handleQuizInteraction(interaction)).catch((error) => {
      console.error('[genshin-extras] quiz interaction error:', error);
    });
  });
}

module.exports = {
  handleGenshinExtrasMessage,
  installGenshinExtras,
  isExtrasRequest,
  isQuiz,
  isFlexBuild,
  isFinishedBuild,
  isWeakestPiece,
  isBottleneck,
  isStatReview,
  isServerCompare,
  isWhyNot90,
  blockersForRated,
  quizQuestionFromCharacter,
};
