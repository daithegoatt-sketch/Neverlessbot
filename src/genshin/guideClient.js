'use strict';

const { getGuideByText } = require('./guides');
const { fetchGame8Guide } = require('./game8Client');
const { fetchGame8TeamGroups, dedupeTeams } = require('./teamGroupClient');

const CACHE_TTL = 12 * 60 * 60 * 1000;
const cache = new Map();
const nonEmpty = (value) => Array.isArray(value) && value.length > 0;

function normalizeTeams(value) {
  if (!value) return { premium: [], f2p: [] };
  if (Array.isArray(value)) return { premium: value, f2p: [] };
  return { premium: Array.isArray(value.premium) ? value.premium : [], f2p: Array.isArray(value.f2p) ? value.f2p : [] };
}

function teamsFromGroups(groups) {
  const premium = [];
  const f2p = [];
  for (const group of groups || []) {
    const target = group.kind === 'f2p' ? f2p : premium;
    target.push(...(group.teams || []));
  }
  return { premium: dedupeTeams(premium), f2p: dedupeTeams(f2p) };
}

function mergeGuide(live, curated) {
  if (!live) return curated || null;
  if (!curated) return live;
  const lt = normalizeTeams(live.teams);
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
    // Team categories are source-specific. Never fill a missing Game8 F2P section
    // with a Premium/curated team, and preserve reaction/role groups when available.
    teams: { premium: lt.premium, f2p: lt.f2p },
    teamGroups: nonEmpty(live.teamGroups) ? live.teamGroups : [],
  };
}

function validateSlotTeam(slots) {
  if (!Array.isArray(slots) || slots.length !== 4) return null;
  const clean = slots.map((slot) => Array.isArray(slot) ? [...new Set(slot.filter(Boolean))].slice(0, 6) : []);
  return clean.every((slot) => slot.length) ? clean : null;
}

function validateGroups(groups) {
  return (groups || []).map((group) => ({
    kind: group?.kind === 'f2p' ? 'f2p' : 'premium',
    category: String(group?.category || 'Team').slice(0, 120),
    role: group?.role ? String(group.role).slice(0, 120) : '',
    slotTeams: (group?.slotTeams || []).map(validateSlotTeam).filter(Boolean).slice(0, 8),
    teams: dedupeTeams((group?.teams || []).filter((team) => Array.isArray(team) && team.length === 4)).slice(0, 24),
  })).filter((group) => group.slotTeams.length || group.teams.length).slice(0, 16);
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
      premium: dedupeTeams(teams.premium.filter((team) => Array.isArray(team) && team.length === 4)).slice(0, 40),
      f2p: dedupeTeams(teams.f2p.filter((team) => Array.isArray(team) && team.length === 4)).slice(0, 20),
    },
    teamGroups: validateGroups(guide.teamGroups),
  };
}

async function getGuide(name) {
  const key = String(name || '').toLowerCase();
  const cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;

  const curated = getGuideByText(name);
  let live = null;
  let groups = [];

  try {
    [live, groups] = await Promise.all([
      fetchGame8Guide(name).catch((error) => {
        console.warn(`[genshin] Game8 guide unavailable for ${name}: ${error.message}`);
        return null;
      }),
      fetchGame8TeamGroups(name).catch((error) => {
        console.warn(`[genshin] Game8 team groups unavailable for ${name}: ${error.message}`);
        return [];
      }),
    ]);
  } catch (error) {
    console.warn(`[genshin] Game8 lookup unavailable for ${name}: ${error.message}`);
  }

  if (groups.length) {
    const groupedTeams = teamsFromGroups(groups);
    live = {
      ...(live || { name, source: 'Game8' }),
      teams: groupedTeams,
      teamGroups: groups,
    };
  }

  const value = validateGuide(mergeGuide(live, curated));
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

module.exports = { getGuide, mergeGuide, normalizeTeams, teamsFromGroups, validateGroups };
