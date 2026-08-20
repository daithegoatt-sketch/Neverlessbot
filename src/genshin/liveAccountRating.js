'use strict';

const { findCharacter, getBuildSnapshot } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { fetchAkashaPercentile } = require('./akashaClient');
const { evaluateBuild } = require('./buildEvaluator');
const { reviewArtifacts } = require('./artifactEvaluator');

const CACHE_TTL = 90 * 1000;
const cache = new Map();

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

function snapshotSignature(snapshot) {
  if (!snapshot?.name) return null;
  return JSON.stringify({
    name: snapshot.name,
    level: snapshot.level,
    constellation: snapshot.constellation,
    weapon: [snapshot.weapon?.name, snapshot.weapon?.level, snapshot.weapon?.refinement],
    stats: snapshot.stats,
    artifacts: (snapshot.artifacts || []).map((item) => ({
      slot: item.slot,
      set: item.set,
      level: item.level,
      mainStat: item.mainStat,
      mainValue: item.mainValue,
      substats: (item.substats || []).map((sub) => [sub.fightProp || sub.name, sub.numericValue]),
    })),
  });
}

function validRatedRows(rows) {
  return (rows || []).filter((row) => Number.isFinite(Number(row?.score)) && Number(row.score) > 0);
}

async function rateSnapshot(uid, character, snapshot, options = {}) {
  if (!snapshot?.name) return null;
  const guide = await getGuide(snapshot.name).catch(() => null);
  if (!guide) return null;
  const akasha = await fetchAkashaPercentile(uid, snapshot.name, {
    forceRefresh: Boolean(options.forceAkashaRefresh),
  }).catch(() => null);
  const evaluation = evaluateBuild(snapshot, guide, { akashaPercentile: akasha });
  const artifacts = reviewArtifacts(snapshot, guide);
  return {
    name: snapshot.name,
    score: evaluation.score,
    akasha,
    evaluation,
    artifactQuality: artifacts.averageUsefulRv,
    snapshot,
    guide,
    character,
  };
}

async function rateCurrentCharacter(uid, account, characterName, options = {}) {
  const character = findCharacter(account, characterName);
  if (!character) return null;
  const snapshot = getBuildSnapshot(character);
  return rateSnapshot(uid, character, snapshot, options);
}

async function rateVisibleAccount(uid, account, options = {}) {
  const candidates = (account?.characters || [])
    .map((character) => ({ character, snapshot: getBuildSnapshot(character) }))
    .filter((row) => row.snapshot?.name);
  const signature = candidates.map((row) => snapshotSignature(row.snapshot)).join('|');
  const cacheKey = String(uid || '');
  const cached = cache.get(cacheKey);
  if (!options.bypassCache && cached?.expiresAt > Date.now() && cached.signature === signature) {
    return cached.value;
  }

  const rows = await mapLimit(candidates, 4, (row) => rateSnapshot(uid, row.character, row.snapshot, options));
  const rated = validRatedRows(rows.filter(Boolean));
  const ratedNames = new Set(rated.map((row) => row.name.toLowerCase()));
  const value = {
    rated,
    visibleCount: candidates.length,
    unratedNames: candidates.map((row) => row.snapshot.name).filter((name) => !ratedNames.has(name.toLowerCase())),
    signature,
  };
  cache.set(cacheKey, { signature, value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

function clearLiveRatingCache(uid = null) {
  if (uid == null) cache.clear();
  else cache.delete(String(uid));
}

module.exports = {
  rateCurrentCharacter,
  rateVisibleAccount,
  validRatedRows,
  snapshotSignature,
  clearLiveRatingCache,
};
