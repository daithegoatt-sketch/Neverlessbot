'use strict';

const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot, listCharacters } = require('./enkaClient');
const { getGuide, normalizeTeams } = require('./guideClient');
const { evaluateBuild, compareSnapshots, LABELS } = require('./buildEvaluator');
const { fetchAkashaPercentile } = require('./akashaClient');
const { resolveCharacter, resolveCharacterMentions } = require('./characterResolver');
const { premiumTeamsFor, premiumGroupForTeam } = require('./teamEvaluator');
const { getEntries, record } = require('./buildHistory');
const { formatStat } = require('./statProfile');
const { fetchCurrentAbyss } = require('./abyssClient');

const CONTEXT_TTL = 20 * 60 * 1000;
const contexts = new Map();

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function key(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sameName(a, b) {
  return key(a) === key(b);
}

function unique(values) {
  const out = [];
  for (const value of values || []) {
    if (!value || out.some((item) => sameName(item, value))) continue;
    out.push(value);
  }
  return out;
}

function isWhoBuild(text) {
  return /^(?:مين|منو|من)\s+(?:ابني|أبني|اطور|أطور)|who\s+should\s+i\s+build/iu.test(String(text || '').trim());
}

function isAccountSummary(text) {
  return /^(?:ملخص\s+حسابي|لخص\s+حسابي|خلاصة\s+حسابي|account\s+summary|summar(?:y|ize)\s+my\s+account)$/iu.test(String(text || '').trim());
}

function isAccountMissing(text) {
  return /^(?:شنو|وش|ايش|إيش|ماذا)\s+(?:ناقص|ينقص)\s+حسابي|^what(?:'s|\s+is)?\s+my\s+account\s+missing/iu.test(String(text || '').trim());
}

function isMemberCompare(text) {
  const value = String(text || '');
  return /(?:قارن|مقارنة|compare).*(?:<@!?\d+>|مع|with)/iu.test(value);
}

function isBestTeam(text) {
  return /(?:افضل|أفضل)\s+(?:تيم|فريق)\s+(?:عندي|بحسابي|في\s+حسابي)|best\s+team\s+(?:i\s+have|on\s+my\s+account|for\s+my\s+account)/iu.test(String(text || ''));
}

function isAbyssTeams(text) {
  return /(?:تيمين|فريقين).*(?:ابي[سث]|أبي[سث]|abyss)|(?:ابي[سث]|أبي[سث]|abyss).*(?:تيمين|فريقين|two\s+teams)|two\s+abyss\s+teams/iu.test(String(text || ''));
}

function isWhatChanged(text) {
  return /^(?:وش|شنو|ايش|إيش|ماذا)\s+تغير|^what(?:'s|\s+has)?\s+changed/iu.test(String(text || '').trim());
}

function isHaveFollowup(text) {
  return /^(?:عندي|موجود\s+عندي|املك|أملك|i\s+have)\b/iu.test(String(text || '').trim());
}

function getContext(message) {
  const id = `${message.guildId}:${message.author.id}`;
  const row = contexts.get(id);
  if (!row || Date.now() - row.updatedAt > CONTEXT_TTL) {
    contexts.delete(id);
    return null;
  }
  return row;
}

function setContext(message, value) {
  contexts.set(`${message.guildId}:${message.author.id}`, { ...value, updatedAt: Date.now() });
}

async function send(message, content) {
  await message.channel.send({ content, allowedMentions: { users: [], repliedUser: false } });
}

async function linked(message, lang, forceRefresh = true) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await send(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return null;
  }
  try {
    return { uid, account: await fetchAccount(uid, { forceRefresh }) };
  } catch (error) {
    console.warn('[account-advisor] Enka fetch failed:', error.message);
    await send(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن **Show Character Details** مفعّل.'
      : 'I could not read the Showcase right now. Make sure **Show Character Details** is enabled.');
    return null;
  }
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

async function rateVisible(uid, account, options = {}) {
  const rows = listCharacters(account);
  const rated = await mapLimit(rows, 3, async (row) => {
    const character = findCharacter(account, row.name);
    const snapshot = getBuildSnapshot(character);
    const guide = await getGuide(row.name).catch(() => null);
    if (!snapshot || !guide) return null;
    const akasha = options.akasha ? await fetchAkashaPercentile(uid, row.name).catch(() => null) : null;
    const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile: akasha });
    return { ...row, character, snapshot, guide, evaluation, score: evaluation.score, akasha };
  });
  return rated.filter(Boolean);
}

function visibleSet(account, extras = []) {
  return new Set([...listCharacters(account).map((row) => key(row.name)), ...extras.map(key)]);
}

async function utilityCounts(account) {
  const visible = listCharacters(account).map((row) => row.name);
  const available = new Set(visible.map(key));
  const counts = new Map(visible.map((name) => [key(name), 0]));
  for (const main of visible) {
    const guide = await getGuide(main).catch(() => null);
    for (const team of premiumTeamsFor(main, guide)) {
      const coverage = team.filter((name) => available.has(key(name))).length;
      if (coverage < 2) continue;
      team.forEach((name) => {
        if (available.has(key(name))) counts.set(key(name), (counts.get(key(name)) || 0) + 1);
      });
    }
  }
  return counts;
}

function topProblem(evaluation) {
  return evaluation?.notes?.find((note) => note.type === 'down')?.text
    || evaluation?.notes?.find((note) => note.type === 'warn')?.text
    || null;
}

async function handleWhoBuild(message, lang) {
  const data = await linked(message, lang);
  if (!data) return true;
  const [rated, utility] = await Promise.all([rateVisible(data.uid, data.account), utilityCounts(data.account)]);
  if (!rated.length) {
    await send(message, lang === 'ar' ? 'ما عندي شخصيات ظاهرة ببيانات كافية حتى أحدد الأولوية.' : 'I do not have enough visible build data to set a priority.');
    return true;
  }
  const ranked = rated.map((row) => {
    const use = utility.get(key(row.name)) || 0;
    const levelGap = Math.max(0, 90 - Number(row.level || 0));
    const priority = (100 - row.score) * 0.62 + Math.min(7, use) * 5.2 + levelGap * 0.08;
    return { ...row, utility: use, priority };
  }).sort((a, b) => b.priority - a.priority || b.utility - a.utility || a.score - b.score).slice(0, 3);

  const ar = lang === 'ar';
  const lines = [`**${ar ? 'مين تبني أول؟' : 'Who should you build first?'}**`];
  ranked.forEach((row, index) => {
    const reasons = [];
    const issue = topProblem(row.evaluation);
    if (issue) reasons.push(issue);
    if (row.utility >= 3) reasons.push(ar ? 'تفيد أكثر من تيم متاح عندك' : 'fits several teams you can already make');
    if (!reasons.length) reasons.push(ar ? 'أكثر شخصية عندها مساحة واضحة للتحسين' : 'has the clearest room to improve');
    lines.push(`${index + 1}. **${row.name}** — ${row.score}% Neverless\n   ${reasons.slice(0, 2).join(ar ? ' • ' : ' • ')}`);
  });
  lines.push(ar ? '\nالترتيب مبني على البيلد الحالي + فائدتها للتيمات اللي يقدر الـShowcase يكوّنها.' : '\nPriority uses current build quality plus how useful the character is to teams visible in your Showcase.');
  await send(message, lines.join('\n'));
  return true;
}

function teamGroupFor(guide, team) {
  return premiumGroupForTeam(guide, team) || (guide?.teamGroups || []).find((group) => group?.kind !== 'f2p' && (group.teams || []).some((published) => published.length === 4 && published.every((name) => team.some((member) => sameName(name, member))))) || null;
}

async function teamCatalog(account, extras = [], rated = null) {
  const visible = listCharacters(account).map((row) => row.name);
  const mains = unique([...visible, ...extras]);
  const available = visibleSet(account, extras);
  const scoreMap = new Map((rated || []).map((row) => [key(row.name), row.score]));
  const out = [];

  for (const main of mains) {
    const guide = await getGuide(main).catch(() => null);
    if (!guide) continue;
    const teams = premiumTeamsFor(main, guide);
    for (const team of teams) {
      if (team.length !== 4) continue;
      const owned = team.filter((name) => available.has(key(name)));
      const missing = team.filter((name) => !available.has(key(name)));
      const visibleScores = team.map((name) => scoreMap.get(key(name))).filter(Number.isFinite);
      const extraCount = team.filter((name) => extras.some((extra) => sameName(extra, name)) && !visible.some((v) => sameName(v, name))).length;
      const buildAverage = visibleScores.length ? visibleScores.reduce((a, b) => a + b, 0) / visibleScores.length : 72;
      const group = teamGroupFor(guide, team);
      const score = owned.length * 1000 + buildAverage * 2 + Math.min(4, visibleScores.length) * 8 - extraCount * 2;
      out.push({ main, team, owned, missing, coverage: owned.length, buildAverage, score, category: group?.category || null, role: group?.role || null, extrasUsed: team.filter((name) => extras.some((extra) => sameName(extra, name)) && !visible.some((v) => sameName(v, name))) });
    }
  }

  const deduped = [];
  for (const row of out.sort((a, b) => b.score - a.score)) {
    const teamKey = row.team.map(key).sort().join('|');
    if (deduped.some((item) => item.team.map(key).sort().join('|') === teamKey)) continue;
    deduped.push(row);
  }
  return deduped;
}

async function bestTeam(data, extras = []) {
  const rated = await rateVisible(data.uid, data.account);
  const catalog = await teamCatalog(data.account, extras, rated);
  return { rated, catalog, best: catalog[0] || null };
}

function formatBestTeam(result, extras, lang, followup = false) {
  const ar = lang === 'ar';
  const row = result.best;
  if (!row) return ar ? 'ما لقيت تيم Premium منشور أقدر أبنيه من الشخصيات الظاهرة بدون تخمين.' : 'I could not find a published Premium team from the visible characters without guessing.';
  const label = [row.category, row.role].filter(Boolean).join(' — ');
  const lines = [`**${followup ? (ar ? 'التيم بعد إضافة شخصيتك' : 'Team after adding your character') : (ar ? 'أفضل تيم متاح عندك' : 'Best team you can make')}**`];
  lines.push(row.team.join(' • '));
  if (label) lines.push(`${ar ? 'النوع' : 'Type'}: ${label}`);
  if (row.coverage < 4) lines.push(`${ar ? 'المتوفر من الـShowcase' : 'Visible/known'}: ${row.coverage}/4 • ${ar ? 'الناقص' : 'Missing'}: ${row.missing.join(', ')}`);
  if (row.extrasUsed.length) lines.push(ar
    ? `ملاحظة: حسبت **${row.extrasUsed.join(', ')}** على البيلد المقترح لأنها مو ظاهرة بالـShowcase، والتشكيلة نفسها منشورة ومتوافقة.`
    : `Note: **${row.extrasUsed.join(', ')}** is assumed to meet the recommended build because it is not visible in Showcase; the lineup itself is published and compatible.`);
  if (row.coverage === 3 && !row.extrasUsed.length) lines.push(ar ? 'إذا عندك شخصية إضافية خارج الـShowcase اكتب: `عندي اسم الشخصية` وأنا أعيد الاختيار.' : 'If you own another character outside Showcase, reply `I have CharacterName` and I will recalculate.');
  return lines.join('\n');
}

async function handleBestTeam(message, text, lang, followupExtras = null) {
  const data = await linked(message, lang);
  if (!data) return true;
  const mentioned = followupExtras || await resolveCharacterMentions(text, 8);
  const extras = unique(mentioned.filter((name) => !listCharacters(data.account).some((row) => sameName(row.name, name))));
  const context = getContext(message);
  const allExtras = followupExtras ? unique([...(context?.extras || []), ...extras]) : extras;
  const result = await bestTeam(data, allExtras);
  await send(message, formatBestTeam(result, allExtras, lang, Boolean(followupExtras)));
  setContext(message, { type: 'bestTeam', extras: allExtras });
  return true;
}

async function handleAccountSummary(message, lang) {
  const data = await linked(message, lang);
  if (!data) return true;
  const rated = await rateVisible(data.uid, data.account, { akasha: true });
  if (!rated.length) {
    await send(message, lang === 'ar' ? 'ما عندي شخصيات ظاهرة كفاية لعمل ملخص.' : 'Not enough visible build data for an account summary.');
    return true;
  }
  const strongest = [...rated].sort((a, b) => b.score - a.score).slice(0, 3);
  const weakest = [...rated].filter((row) => Number(row.level || 0) >= 70 || row.snapshot.artifacts.length >= 4).sort((a, b) => a.score - b.score)[0] || null;
  const teamResult = { rated, catalog: await teamCatalog(data.account, [], rated) };
  teamResult.best = teamResult.catalog[0] || null;
  const utility = await utilityCounts(data.account);
  const priority = [...rated].map((row) => ({ row, p: (100 - row.score) + Math.min(6, utility.get(key(row.name)) || 0) * 7 })).sort((a, b) => b.p - a.p)[0]?.row || null;
  const avg = Math.round((strongest.reduce((sum, row) => sum + row.score, 0) / strongest.length) * 10) / 10;
  const ar = lang === 'ar';
  const lines = [`**${ar ? 'ملخص حسابك' : 'Account Summary'}**`];
  lines.push(`${ar ? 'أقوى 3' : 'Top 3'}: ${strongest.map((row) => `${row.name} ${row.score}%`).join(' • ')}`);
  lines.push(`${ar ? 'متوسط أقوى 3' : 'Top-3 average'}: **${avg}%**`);
  if (teamResult.best) lines.push(`${ar ? 'أفضل تيم جاهز' : 'Best ready team'}: ${teamResult.best.team.join(' • ')}${teamResult.best.coverage < 4 ? ` (${teamResult.best.coverage}/4)` : ''}`);
  if (priority) lines.push(`${ar ? 'أولوية البناء' : 'Build priority'}: **${priority.name}** — ${priority.score}%`);
  if (weakest && (!priority || !sameName(weakest.name, priority.name))) lines.push(`${ar ? 'أضعف بيلد مكتمل نسبيًا' : 'Weakest reasonably built character'}: **${weakest.name}** — ${weakest.score}%`);
  await send(message, lines.join('\n'));
  return true;
}

async function handleMissing(message, lang) {
  const data = await linked(message, lang);
  if (!data) return true;
  const visible = listCharacters(data.account).map((row) => row.name);
  const owned = new Set(visible.map(key));
  const missing = new Map();

  for (const main of visible) {
    const guide = await getGuide(main).catch(() => null);
    for (const team of premiumTeamsFor(main, guide)) {
      const coverage = team.filter((name) => owned.has(key(name))).length;
      if (coverage < 2 || coverage === 4) continue;
      const group = teamGroupFor(guide, team);
      for (const name of team.filter((member) => !owned.has(key(member)))) {
        const item = missing.get(key(name)) || { name, points: 0, teams: new Set(), types: new Set() };
        item.points += coverage === 3 ? 5 : 2;
        item.teams.add(main);
        if (group?.category) item.types.add(group.category);
        missing.set(key(name), item);
      }
    }
  }

  const rows = [...missing.values()].sort((a, b) => b.points - a.points || b.teams.size - a.teams.size).slice(0, 4);
  const ar = lang === 'ar';
  if (!rows.length) {
    await send(message, ar ? 'حسب الشخصيات الظاهرة، عندك أكثر من تيم Premium مكتمل وما في نقص واضح أقدر أثبته من الـShowcase.' : 'From the visible characters, you already have complete Premium options and no clear missing piece I can prove from Showcase.');
    return true;
  }
  const lines = [`**${ar ? 'شنو ناقص حسابك؟' : 'What is your account missing?'}**`];
  rows.forEach((row, index) => {
    const uses = [...row.teams].slice(0, 3).join(', ');
    const types = [...row.types].slice(0, 2).join(' / ');
    lines.push(`${index + 1}. **${row.name}** — ${ar ? 'تكمل خيارات قوية مع' : 'unlocks strong options with'} ${uses}${types ? ` • ${types}` : ''}`);
  });
  lines.push(ar ? '\nمهم: هذا يعني **مو ظاهرة عندي**، مو شرط إنك ما تملكها؛ الـShowcase محدود.' : '\nImportant: this means **not visible to me**, not necessarily unowned; Showcase has a limit.');
  await send(message, lines.join('\n'));
  return true;
}

function topPercentText(value) {
  const number = Number(value?.topPercent ?? value);
  if (!Number.isFinite(number)) return '—';
  if (number > 0 && number < 0.01) return 'Top <0.01%';
  return `Top ${Number(number.toFixed(2))}%`;
}

async function ratedCharacter(uid, account, name) {
  const character = findCharacter(account, name);
  if (!character) return null;
  const snapshot = getBuildSnapshot(character);
  const guide = await getGuide(name).catch(() => null);
  if (!snapshot || !guide) return null;
  const akasha = await fetchAkashaPercentile(uid, name).catch(() => null);
  const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile: akasha });
  return { snapshot, guide, evaluation, akasha };
}

async function handleMemberCompare(message, text, lang) {
  const target = [...(message.mentions?.users?.values?.() || [])].find((user) => user.id !== message.author.id && !user.bot);
  if (!target) {
    await send(message, lang === 'ar' ? 'منشن العضو اللي تبي تقارن معه، مثال: `قارن Skirk مع @member`.' : 'Mention the member, e.g. `compare Skirk with @member`.');
    return true;
  }
  const characterName = await resolveCharacter(text);
  if (!characterName) {
    await send(message, lang === 'ar' ? 'حدد الشخصية أيضًا، مثال: `قارن Skirk مع @member`.' : 'Include the character name too.');
    return true;
  }
  const myUid = getLinkedUid(message.author.id);
  const otherUid = getLinkedUid(target.id);
  if (!myUid || !otherUid) {
    await send(message, lang === 'ar' ? 'لازم الحسابين يكونون مربوطين بالبوت أولًا.' : 'Both Discord users need a linked Genshin account first.');
    return true;
  }
  const [myAccount, otherAccount] = await Promise.all([fetchAccount(myUid, { forceRefresh: true }), fetchAccount(otherUid, { forceRefresh: true })]);
  const [mine, other] = await Promise.all([ratedCharacter(myUid, myAccount, characterName), ratedCharacter(otherUid, otherAccount, characterName)]);
  if (!mine || !other) {
    await send(message, lang === 'ar' ? `لازم **${characterName}** تكون ظاهرة بالتفاصيل في Showcase عند الطرفين.` : `**${characterName}** must be visible with details in both Showcases.`);
    return true;
  }
  const ar = lang === 'ar';
  const lines = [`**${characterName} — ${ar ? 'مقارنة' : 'Comparison'}**`];
  lines.push(`${ar ? 'أنت' : 'You'} — **${mine.evaluation.score}% Neverless** • Akasha ${topPercentText(mine.akasha)}`);
  lines.push(`<@${target.id}> — **${other.evaluation.score}% Neverless** • Akasha ${topPercentText(other.akasha)}`);
  const keys = unique([...mine.evaluation.relevantStats.map((row) => row.key), ...other.evaluation.relevantStats.map((row) => row.key)]).slice(0, 5);
  if (keys.length) {
    lines.push(`\n**${ar ? 'الفرق بالستات المهمة' : 'Relevant stat differences'}**`);
    for (const statKey of keys) {
      const a = Number(mine.snapshot.stats?.[statKey]);
      const b = Number(other.snapshot.stats?.[statKey]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const delta = Math.round((a - b) * 10) / 10;
      lines.push(`• ${LABELS[statKey] || statKey}: ${formatStat(statKey, a)} vs ${formatStat(statKey, b)} (${delta > 0 ? '+' : ''}${formatStat(statKey, delta)})`);
    }
  }
  const scoreDelta = mine.evaluation.score - other.evaluation.score;
  lines.push(`\n${ar ? 'فرق Neverless' : 'Neverless gap'}: **${scoreDelta > 0 ? '+' : ''}${scoreDelta}%** ${ar ? 'لك' : 'for you'}`);
  await send(message, lines.join('\n'));
  return true;
}

function normalizeTag(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function abyssAffinity(candidate, tags) {
  if (!tags?.length) return 0;
  const category = normalizeTag(candidate.category);
  const team = candidate.team.map(normalizeTag).join(' ');
  let score = 0;
  for (const tag of tags) {
    const needle = normalizeTag(tag);
    if (needle && category.includes(needle)) score += 45;
    else if (needle && team.includes(needle)) score += 6;
  }
  return score;
}

function bestAbyssPair(catalog, abyss = null) {
  let best = null;
  const candidates = catalog.slice(0, 80);
  for (const first of candidates) {
    for (const second of candidates) {
      if (first === second) continue;
      if (first.team.some((name) => second.team.some((other) => sameName(name, other)))) continue;
      const coverage = first.coverage + second.coverage;
      const sourceBonus = abyssAffinity(first, abyss?.firstHalfTags) + abyssAffinity(second, abyss?.secondHalfTags);
      const score = coverage * 2000 + first.buildAverage + second.buildAverage + sourceBonus;
      if (!best || score > best.score) best = { first, second, score, sourceBonus };
    }
  }
  return best;
}

async function handleAbyss(message, text, lang) {
  const data = await linked(message, lang);
  if (!data) return true;
  const names = await resolveCharacterMentions(text, 10);
  const extras = unique(names.filter((name) => !listCharacters(data.account).some((row) => sameName(row.name, name))));
  const rated = await rateVisible(data.uid, data.account);
  const catalog = await teamCatalog(data.account, extras, rated);
  let abyss = null;
  try { abyss = await fetchCurrentAbyss(); } catch (error) { console.warn('[account-advisor] Abyss source unavailable:', error.message); }
  const pair = bestAbyssPair(catalog, abyss);
  const ar = lang === 'ar';
  if (!pair) {
    await send(message, ar ? 'ما قدرت أطلع تيمين منشورين بدون تكرار شخصيات من الموجود بالـShowcase.' : 'I could not build two published teams without repeating characters from the visible roster.');
    return true;
  }
  const lines = [`**${ar ? 'تيمين Abyss من حسابك' : 'Two Abyss teams from your account'}**`];
  lines.push(`1. ${pair.first.team.join(' • ')}${pair.first.category ? ` — ${pair.first.category}` : ''}`);
  lines.push(`2. ${pair.second.team.join(' • ')}${pair.second.category ? ` — ${pair.second.category}` : ''}`);
  if (pair.first.missing.length || pair.second.missing.length) {
    lines.push(`${ar ? 'الناقص من المرئي' : 'Missing from visible roster'}: ${unique([...pair.first.missing, ...pair.second.missing]).join(', ') || '—'}`);
  }
  if (extras.length) lines.push(ar ? `حسبت ${extras.join(', ')} على البيلد المقترح لأنها خارج الـShowcase.` : `Assumed recommended builds for ${extras.join(', ')} because they are outside Showcase.`);
  if (abyss) {
    const tags1 = abyss.firstHalfTags.slice(0, 3).join(' / ');
    const tags2 = abyss.secondHalfTags.slice(0, 3).join(' / ');
    lines.push(`\n**${ar ? 'مراعاة Abyss الحالي' : 'Current Abyss context'}**`);
    if (tags1) lines.push(`${ar ? 'النصف الأول' : 'First half'}: ${tags1}`);
    if (tags2) lines.push(`${ar ? 'النصف الثاني' : 'Second half'}: ${tags2}`);
    if (abyss.blessing) lines.push(`${ar ? 'البركة' : 'Blessing'}: ${abyss.blessing.replace(/^Blessing of the Abyssal Moon:\s*/i, '')}`);
    lines.push(ar ? 'المصدر: Game8 Floor 12 الحالي؛ إذا حدثت الصفحة يتحدث الترجيح معها.' : 'Source: current Game8 Floor 12 page; recommendations refresh with the page.');
  } else {
    lines.push(ar ? '\nتعذر تحديث Buff الحالي الآن؛ اخترت أقوى تيمين منشورين بدون تكرار حسب البيلد والتوافق.' : '\nCurrent Abyss buff could not be refreshed, so I chose the strongest published non-overlapping teams by build and compatibility.');
  }
  await send(message, lines.join('\n'));
  return true;
}

function snapshotKey(snapshot) {
  return JSON.stringify({ stats: snapshot?.stats, weapon: snapshot?.weapon, sets: snapshot?.setCounts, artifacts: snapshot?.artifacts?.map((item) => [item.slot, item.set, item.mainStat, item.level, item.substats]) });
}

function previousDifferent(entries, currentSnapshot) {
  const currentKey = snapshotKey(currentSnapshot);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (snapshotKey(entries[i]?.snapshot) !== currentKey) return entries[i];
  }
  return null;
}

async function handleWhatChanged(message, text, lang) {
  const data = await linked(message, lang);
  if (!data) return true;
  const requested = await resolveCharacterMentions(text, 4);
  const names = requested.length ? requested : listCharacters(data.account).map((row) => row.name);
  const changes = [];
  for (const name of names) {
    const current = await ratedCharacter(data.uid, data.account, name);
    if (!current) continue;
    const entries = getEntries(message.author.id, data.uid, name);
    const baseline = previousDifferent(entries, current.snapshot);
    if (!baseline) continue;
    const comparison = compareSnapshots(baseline, { snapshot: current.snapshot, evaluation: current.evaluation });
    const changedStats = Object.entries(comparison.deltas).filter(([, delta]) => Math.abs(delta) >= 0.1);
    if (!comparison.scoreDelta && !changedStats.length) continue;
    changes.push({ name, current, comparison, changedStats, baseline });
    const latest = entries.at(-1);
    if (!latest || snapshotKey(latest.snapshot) !== snapshotKey(current.snapshot)) await record(message.author.id, data.uid, name, { snapshot: current.snapshot, evaluation: current.evaluation });
  }
  const ar = lang === 'ar';
  if (!changes.length) {
    await send(message, ar ? 'ما عندي تغيير مختلف محفوظ أقدر أعرضه الآن. التغييرات تظهر بعد ما يكون عندي بيلد أقدم محفوظ للشخصية.' : 'I do not have a different saved build change to show right now. Changes appear once an older build has been saved.');
    return true;
  }
  const lines = [`**${ar ? 'آخر التغييرات' : 'Latest changes'}**`];
  changes.slice(0, 5).forEach((row) => {
    const delta = row.comparison.scoreDelta;
    lines.push(`\n**${row.name}** — Neverless ${row.comparison.previousScore}% → ${row.comparison.currentScore}% (${delta > 0 ? '+' : ''}${delta})`);
    row.changedStats.slice(0, 4).forEach(([statKey, value]) => lines.push(`• ${LABELS[statKey] || statKey}: ${value > 0 ? '+' : ''}${formatStat(statKey, value)}`));
  });
  await send(message, lines.join('\n'));
  return true;
}

async function handleAccountAdvisorMessage(message) {
  const text = String(message?.content || '').trim();
  if (!text) return false;
  const lang = language(text);

  const context = getContext(message);
  if (context?.type === 'bestTeam' && isHaveFollowup(text)) {
    const names = await resolveCharacterMentions(text, 8);
    if (names.length) return handleBestTeam(message, text, lang, names);
  }

  if (isWhoBuild(text)) return handleWhoBuild(message, lang);
  if (isAccountSummary(text)) return handleAccountSummary(message, lang);
  if (isAccountMissing(text)) return handleMissing(message, lang);
  if (isMemberCompare(text)) return handleMemberCompare(message, text, lang);
  if (isAbyssTeams(text)) return handleAbyss(message, text, lang);
  if (isBestTeam(text)) return handleBestTeam(message, text, lang);
  if (isWhatChanged(text)) return handleWhatChanged(message, text, lang);
  return false;
}

module.exports = {
  handleAccountAdvisorMessage,
  isWhoBuild,
  isAccountSummary,
  isAccountMissing,
  isMemberCompare,
  isBestTeam,
  isAbyssTeams,
  isWhatChanged,
  bestAbyssPair,
  abyssAffinity,
  formatBestTeam,
};
