'use strict';

const { getGuideByText } = require('./guides');
const { fetchGame8Guide } = require('./game8Client');

const CACHE_TTL = 12 * 60 * 60 * 1000;
const cache = new Map();
const nonEmpty = (value) => Array.isArray(value) && value.length > 0;

function normalizeTeams(value) {
  if (!value) return { premium: [], f2p: [] };
  if (Array.isArray(value)) return { premium: value, f2p: [] };
  return { premium: Array.isArray(value.premium) ? value.premium : [], f2p: Array.isArray(value.f2p) ? value.f2p : [] };
}

function mergeGuide(live, curated) {
  if (!live) return curated || null;
  if (!curated) return live;
  const lt = normalizeTeams(live.teams), ct = normalizeTeams(curated.teams);
  return {
    ...curated, ...live,
    role: live.role || curated.role,
    stats: {
      ...(curated.stats || {}), ...(live.stats || {}),
      main: nonEmpty(live.stats?.main) ? live.stats.main : curated.stats?.main || [],
      targets: nonEmpty(live.stats?.targets) ? live.stats.targets : curated.stats?.targets || [],
      priority: live.stats?.priority || curated.stats?.priority || null,
    },
    weapons: nonEmpty(live.weapons) ? live.weapons : curated.weapons || [],
    f2pWeapons: nonEmpty(live.f2pWeapons) ? live.f2pWeapons : curated.f2pWeapons || [],
    artifacts: nonEmpty(live.artifacts) ? live.artifacts : curated.artifacts || [],
    combos: nonEmpty(live.combos) ? live.combos : curated.combos || [],
    teams: { premium: nonEmpty(lt.premium) ? lt.premium : ct.premium, f2p: nonEmpty(lt.f2p) ? lt.f2p : ct.f2p },
  };
}

function validateGuide(guide) {
  if (!guide) return null;
  const teams = normalizeTeams(guide.teams);
  return {
    ...guide,
    weapons: (guide.weapons || []).filter(Boolean).slice(0, 10),
    f2pWeapons: (guide.f2pWeapons || []).filter(Boolean).slice(0, 6),
    artifacts: (guide.artifacts || []).filter(Boolean).slice(0, 6),
    combos: (guide.combos || []).filter(Boolean).slice(0, 8),
    teams: {
      premium: teams.premium.filter((team) => Array.isArray(team) && team.length === 4).slice(0, 12),
      f2p: teams.f2p.filter((team) => Array.isArray(team) && team.length === 4).slice(0, 10),
    },
  };
}

async function getGuide(name) {
  const key = String(name || '').toLowerCase(), cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const curated = getGuideByText(name);
  let live = null;
  try { live = await fetchGame8Guide(name); } catch (error) { console.warn(`[genshin] Game8 guide unavailable for ${name}: ${error.message}`); }
  const value = validateGuide(mergeGuide(live, curated));
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

module.exports = { getGuide, mergeGuide, normalizeTeams };
