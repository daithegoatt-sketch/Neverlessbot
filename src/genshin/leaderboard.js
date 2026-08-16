'use strict';

const { getAllLinkedUsers } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { fetchAkashaPercentile } = require('./akashaClient');
const { evaluateBuild } = require('./buildEvaluator');

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

function key(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await mapper(items[index], index); } catch { results[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function linkedGuildUsers(guild) {
  const links = getAllLinkedUsers();
  const rows = await mapLimit(links, 5, async (link) => {
    const member = guild.members.cache.get(link.discordUserId)
      || await guild.members.fetch(link.discordUserId).catch(() => null);
    return member ? {
      ...link,
      member,
      displayName: member.displayName || member.user?.globalName || member.user?.username || link.discordUserId,
    } : null;
  });
  return rows.filter(Boolean);
}

function topText(value) {
  const number = Number(value?.topPercent ?? value);
  return Number.isFinite(number) ? `Top ${number}%` : '—';
}

async function buildCharacterLeaderboard(guild, characterName) {
  const cacheKey = `${guild.id}:char:${key(characterName)}`;
  const cached = cache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;

  const guide = await getGuide(characterName);
  if (!guide) return { characterName, rows: [] };
  const users = await linkedGuildUsers(guild);
  const rows = await mapLimit(users.slice(0, 60), 3, async (link) => {
    const account = await fetchAccount(link.uid);
    const character = findCharacter(account, characterName);
    if (!character) return null;
    const snapshot = getBuildSnapshot(character);
    const akasha = await fetchAkashaPercentile(link.uid, characterName).catch(() => null);
    const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile: akasha });
    return {
      discordUserId: link.discordUserId,
      displayName: link.displayName,
      uid: link.uid,
      score: evaluation.score,
      akasha,
      snapshot,
    };
  });

  const clean = rows.filter(Boolean).sort((a, b) =>
    b.score - a.score
    || (Number(a.akasha?.topPercent ?? a.akasha) || 999) - (Number(b.akasha?.topPercent ?? b.akasha) || 999),
  );
  const value = { characterName, rows: clean };
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

function roughSnapshotScore(snapshot) {
  const artifacts = snapshot?.artifacts || [];
  const avgLevel = artifacts.length
    ? artifacts.reduce((sum, item) => sum + (Number(item.level) || 0), 0) / artifacts.length
    : 0;
  const cv = (Number(snapshot?.stats?.critRate) || 0) * 2 + (Number(snapshot?.stats?.critDmg) || 0);
  return artifacts.length * 30 + avgLevel * 2 + Math.min(320, cv) * 0.25 + (Number(snapshot?.weapon?.level) || 0) * 0.2;
}

async function buildAccountScore(link) {
  const account = await fetchAccount(link.uid);
  const candidates = (account?.characters || [])
    .map((character) => ({ character, snapshot: getBuildSnapshot(character) }))
    .filter((row) => row.snapshot?.name)
    .sort((a, b) => roughSnapshotScore(b.snapshot) - roughSnapshotScore(a.snapshot))
    .slice(0, 8);

  const rated = [];
  for (const row of candidates) {
    const guide = await getGuide(row.snapshot.name);
    if (!guide) continue;
    const akasha = await fetchAkashaPercentile(link.uid, row.snapshot.name).catch(() => null);
    const evaluation = evaluateBuild(row.snapshot, guide, { akashaPercentile: akasha });
    rated.push({ name: row.snapshot.name, score: evaluation.score, akasha });
    if (rated.length >= 6) break;
  }

  if (!rated.length) return null;
  rated.sort((a, b) => b.score - a.score);
  const average = rated.reduce((sum, row) => sum + row.score, 0) / rated.length;
  const breadth = Math.min(1, rated.length / 6);
  const accountScore = Math.round(average * (0.65 + 0.35 * breadth) * 10) / 10;
  return {
    discordUserId: link.discordUserId,
    displayName: link.displayName,
    uid: link.uid,
    accountScore,
    averageBuild: Math.round(average * 10) / 10,
    ratedCount: rated.length,
    topBuilds: rated.slice(0, 3),
  };
}

async function buildNeverlessLeaderboard(guild) {
  const cacheKey = `${guild.id}:account`;
  const cached = cache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const users = await linkedGuildUsers(guild);
  const rows = await mapLimit(users.slice(0, 40), 2, buildAccountScore);
  const clean = rows.filter(Boolean).sort((a, b) => b.accountScore - a.accountScore || b.averageBuild - a.averageBuild);
  const value = { rows: clean };
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

function formatCharacterLeaderboard(board, lang = 'ar') {
  const ar = lang === 'ar';
  if (!board.rows.length) return ar
    ? `ما فيه أعضاء رابطين حساباتهم وعندهم **${board.characterName}** ظاهرة في Showcase حاليًا.`
    : `No linked members currently have **${board.characterName}** visible in Showcase.`;
  const lines = [`**${ar ? 'ترتيب' : 'Leaderboard'} ${board.characterName} — Neverless**`];
  board.rows.slice(0, 12).forEach((row, index) => {
    lines.push(`${index + 1}. **@${row.displayName}** — **${row.score}% Neverless** • Akasha ${topText(row.akasha)}`);
  });
  lines.push(ar ? '\nالترتيب يعتمد على آخر Showcase ظاهر للحسابات المربوطة.' : '\nRanking uses the latest visible Showcase builds from linked accounts.');
  return lines.join('\n');
}

function formatNeverlessLeaderboard(board, lang = 'ar') {
  const ar = lang === 'ar';
  if (!board.rows.length) return ar ? 'ما فيه حسابات مربوطة كفاية لبناء الترتيب.' : 'Not enough linked accounts to build the leaderboard.';
  const lines = [`**${ar ? 'ترتيب Neverless — قوة الحسابات الظاهرة' : 'Neverless Account Leaderboard'}**`];
  board.rows.slice(0, 10).forEach((row, index) => {
    const best = row.topBuilds.map((item) => `${item.name} ${item.score}%`).join(' • ');
    lines.push(`${index + 1}. **@${row.displayName}** — **${row.accountScore}** ${ar ? 'نقطة' : 'pts'} • ${row.ratedCount} ${ar ? 'بيلدات مقيمة' : 'rated builds'}`);
    if (best) lines.push(`   ${best}`);
  });
  lines.push(ar
    ? '\nAccount Score يحسب أفضل البيلدات الظاهرة ويوازن بين قوة البيلد وعدد الشخصيات القوية؛ هو ترتيب Neverless وليس AR أو عدد الشخصيات الكامل بالحساب.'
    : '\nAccount Score uses the strongest visible rated builds and rewards both quality and breadth; it is a Neverless score, not AR or full roster size.');
  return lines.join('\n');
}

function clearLeaderboardCache() {
  cache.clear();
}

module.exports = {
  buildCharacterLeaderboard,
  buildNeverlessLeaderboard,
  formatCharacterLeaderboard,
  formatNeverlessLeaderboard,
  clearLeaderboardCache,
};
