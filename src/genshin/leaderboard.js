'use strict';

const { getAllLinkedUsers } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { fetchAkashaPercentile } = require('./akashaClient');
const { evaluateBuild } = require('./buildEvaluator');
const { reviewArtifacts } = require('./artifactEvaluator');
const { formatStat } = require('./statProfile');

const CACHE_TTL = 90 * 1000;
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

function topPercent(value) {
  const number = Number(value?.topPercent ?? value);
  return Number.isFinite(number) ? number : null;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return null;
  if (value > 0 && value < 0.01) return '<0.01';
  if (value >= 10) return String(Math.round(value));
  const rounded = Number(value.toFixed(2));
  if (rounded === 0 && value > 0) return '<0.01';
  return rounded.toString();
}

function akashaText(value) {
  const percent = topPercent(value);
  if (!Number.isFinite(percent)) return '—';
  return `Top ${formatPercent(percent)}%`;
}

function buildStrengths(evaluation, max = 3) {
  if (!evaluation) return [];
  const stats = (evaluation.relevantStats || [])
    .filter((row) => row.status === 'ok' && Number.isFinite(row.value))
    .sort((a, b) => (b.ratio || 0) - (a.ratio || 0) || (b.weight || 0) - (a.weight || 0))
    .slice(0, max)
    .map((row) => `${row.label} ${formatStat(row.key, row.value)}`);
  if (stats.length < max && evaluation.mainStatScore === 100) stats.push('Main Stats 100%');
  if (stats.length < max && evaluation.artifactSetScore === 100) stats.push('Set 100%');
  return stats.slice(0, max);
}

async function rateCharacter(uid, character, snapshot, guide) {
  const akasha = await fetchAkashaPercentile(uid, snapshot.name).catch(() => null);
  const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile: akasha });
  const artifacts = reviewArtifacts(snapshot, guide);
  return {
    name: snapshot.name,
    score: evaluation.score,
    akasha,
    evaluation,
    artifactQuality: artifacts.averageUsefulRv,
    strengths: buildStrengths(evaluation),
  };
}

async function buildCharacterLeaderboard(guild, characterName) {
  const cacheKey = `${guild.id}:char:${key(characterName)}`;
  const cached = cache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;

  const guide = await getGuide(characterName);
  if (!guide) return { characterName, rows: [] };
  const users = await linkedGuildUsers(guild);
  const rows = await mapLimit(users.slice(0, 60), 3, async (link) => {
    const account = await fetchAccount(link.uid, { forceRefresh: true });
    const character = findCharacter(account, characterName);
    if (!character) return null;
    const snapshot = getBuildSnapshot(character);
    const rated = await rateCharacter(link.uid, character, snapshot, guide);
    return {
      discordUserId: link.discordUserId,
      displayName: link.displayName,
      uid: link.uid,
      score: rated.score,
      akasha: rated.akasha,
      snapshot,
      evaluation: rated.evaluation,
      artifactQuality: rated.artifactQuality,
      strengths: rated.strengths,
    };
  });

  const clean = rows.filter(Boolean).sort((a, b) =>
    b.score - a.score
    || (topPercent(a.akasha) ?? 999) - (topPercent(b.akasha) ?? 999)
    || b.artifactQuality - a.artifactQuality,
  );
  const value = { characterName, rows: clean };
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

function accountScoreFromRated(rated) {
  const top = [...rated].sort((a, b) =>
    b.score - a.score
    || (topPercent(a.akasha) ?? 999) - (topPercent(b.akasha) ?? 999)
    || b.artifactQuality - a.artifactQuality,
  ).slice(0, 3);
  if (!top.length) return { accountScore: 0, topBuilds: [], topAverage: 0 };

  const weights = [0.45, 0.33, 0.22];
  let weighted = 0;
  let usedWeight = 0;
  top.forEach((row, index) => {
    const weight = weights[index] || 0;
    weighted += row.score * weight;
    usedWeight += weight;
  });
  const normalized = usedWeight ? weighted / usedWeight : 0;
  const coverage = Math.min(1, rated.length / 3);
  const accountScore = Math.round(normalized * (0.9 + 0.1 * coverage) * 10) / 10;
  const topAverage = Math.round((top.reduce((sum, row) => sum + row.score, 0) / top.length) * 10) / 10;
  return { accountScore, topBuilds: top, topAverage };
}

async function buildAccountScore(link) {
  const account = await fetchAccount(link.uid, { forceRefresh: true });
  const candidates = (account?.characters || [])
    .map((character) => ({ character, snapshot: getBuildSnapshot(character) }))
    .filter((row) => row.snapshot?.name);

  const rated = [];
  for (const row of candidates) {
    const guide = await getGuide(row.snapshot.name).catch(() => null);
    if (!guide) continue;
    const result = await rateCharacter(link.uid, row.character, row.snapshot, guide);
    rated.push(result);
  }

  if (!rated.length) return null;
  const scored = accountScoreFromRated(rated);
  return {
    discordUserId: link.discordUserId,
    displayName: link.displayName,
    uid: link.uid,
    accountScore: scored.accountScore,
    averageBuild: scored.topAverage,
    ratedCount: rated.length,
    visibleCount: candidates.length,
    topBuilds: scored.topBuilds,
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

function getCachedNeverlessLeaderboard(guild) {
  if (!guild?.id) return null;
  const cached = cache.get(`${guild.id}:account`);
  return cached?.expiresAt > Date.now() ? cached.value : null;
}

function formatCharacterLeaderboard(board, lang = 'ar') {
  const ar = lang === 'ar';
  if (!board.rows.length) return ar
    ? `ما فيه أعضاء رابطين حساباتهم وعندهم **${board.characterName}** ظاهرة في Showcase حاليًا.`
    : `No linked members currently have **${board.characterName}** visible in Showcase.`;
  const lines = [`**${ar ? 'ترتيب' : 'Leaderboard'} ${board.characterName} — Neverless**`];
  board.rows.slice(0, 10).forEach((row, index) => {
    lines.push(`${index + 1}. <@${row.discordUserId}> — **${row.score}% Neverless** • Akasha ${akashaText(row.akasha)}`);
  });
  return lines.join('\n');
}

function formatNeverlessLeaderboard(board, lang = 'ar') {
  const ar = lang === 'ar';
  if (!board.rows.length) return ar ? 'ما فيه حسابات مربوطة كفاية لبناء الترتيب.' : 'Not enough linked accounts to build the leaderboard.';
  const lines = [`**${ar ? 'ترتيب Neverless' : 'Neverless Account Leaderboard'}**`];
  board.rows.slice(0, 10).forEach((row, index) => {
    lines.push(`${index + 1}. <@${row.discordUserId}> — **${row.accountScore}% Neverless**`);
    const builds = row.topBuilds.slice(0, 3).map((item) => `${item.name} ${item.score}%`).join(' • ');
    if (builds) lines.push(`   ${builds}`);
  });
  return lines.join('\n');
}

function clearLeaderboardCache() {
  cache.clear();
}

module.exports = {
  buildCharacterLeaderboard,
  buildNeverlessLeaderboard,
  getCachedNeverlessLeaderboard,
  formatCharacterLeaderboard,
  formatNeverlessLeaderboard,
  clearLeaderboardCache,
  accountScoreFromRated,
  buildStrengths,
};
