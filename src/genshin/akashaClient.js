'use strict';

const CACHE_TTL = 75 * 1000;
const API_BASE = 'https://akasha.cv/api';
const userCache = new Map();
const htmlCache = new Map();

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function calculationsOf(row) {
  if (Array.isArray(row?.calculations)) return row.calculations;
  if (row?.calculations && typeof row.calculations === 'object') return Object.values(row.calculations);
  return [];
}

function rankingFromCalculation(calc) {
  const ranking = Number(calc?.ranking);
  const outOf = Number(calc?.outOf ?? calc?.out_of);
  const derived = Number.isFinite(ranking) && Number.isFinite(outOf) && ranking > 0 && outOf > 0
    ? (ranking / outOf) * 100
    : null;
  const explicit = Number(calc?.topPercent ?? calc?.top_percent);
  const topPercent = Number.isFinite(explicit) && explicit > 0 ? explicit : derived;
  if (!Number.isFinite(topPercent) || topPercent <= 0 || topPercent > 100) return null;
  const calculationId = Number(calc?.calculationId ?? calc?.id);
  const category = calc?.variant?.displayName || calc?.variant?.name || calc?.name || calc?.short || null;
  return {
    topPercent: round(topPercent),
    ranking: Number.isFinite(ranking) && ranking > 0 ? ranking : null,
    outOf: Number.isFinite(outOf) && outOf > 0 ? outOf : null,
    category: category ? String(category) : null,
    calculationId: Number.isFinite(calculationId) ? calculationId : null,
    leaderboardUrl: Number.isFinite(calculationId) ? `https://akasha.cv/leaderboards/${calculationId}` : null,
  };
}

function bestRanking(row) {
  if (!row) return null;
  const rankings = calculationsOf(row).map(rankingFromCalculation).filter(Boolean);
  rankings.sort((a, b) => a.topPercent - b.topPercent || (a.ranking ?? Infinity) - (b.ranking ?? Infinity));
  return rankings[0] || null;
}

async function fetchUserRows(uid, options = {}) {
  const key = String(uid);
  if (options.forceRefresh) userCache.delete(key);
  const cached = userCache.get(key);
  if (!options.forceRefresh && cached?.expiresAt > Date.now()) return cached.rows;

  const response = await fetch(`${API_BASE}/getCalculationsForUser/${encodeURIComponent(uid)}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/11.0',
      accept: 'application/json,text/plain,*/*',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Akasha API HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  userCache.set(key, { rows, expiresAt: Date.now() + CACHE_TTL });
  return rows;
}

async function fetchFromHtml(uid, characterName, options = {}) {
  const key = `${uid}:${String(characterName).toLowerCase()}`;
  if (options.forceRefresh) htmlCache.delete(key);
  const cached = htmlCache.get(key);
  if (!options.forceRefresh && cached?.expiresAt > Date.now()) return cached.value;

  const response = await fetch(`https://akasha.cv/profile/${encodeURIComponent(uid)}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/11.0',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) return null;
  const html = await response.text();
  const plain = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const escaped = escapeRegex(characterName);
  const windows = [...plain.matchAll(new RegExp(`${escaped}.{0,1800}`, 'ig'))].map((match) => match[0]);
  const percentages = [];
  for (const window of windows) {
    for (const match of window.matchAll(/top\s*<?\s*(\d+(?:\.\d+)?)%/ig)) {
      const number = Number(match[1]);
      if (Number.isFinite(number) && number > 0 && number <= 100) percentages.push(number);
    }
  }
  const value = percentages.length
    ? { topPercent: round(Math.min(...percentages)), ranking: null, outOf: null, category: null, calculationId: null, leaderboardUrl: null }
    : null;
  htmlCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

async function fetchAkashaPercentiles(uid, characterNames, options = {}) {
  const names = [...new Set((characterNames || []).filter(Boolean))];
  const out = new Map();
  let rows = null;
  try { rows = await fetchUserRows(uid, { forceRefresh: Boolean(options.forceRefresh) }); } catch {}

  if (rows) {
    const byName = new Map(rows.map((row) => [normalize(row?.name), row]));
    for (const name of names) out.set(name, bestRanking(byName.get(normalize(name))));
    return out;
  }

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    let value = null;
    try { value = await fetchFromHtml(uid, name, { forceRefresh: Boolean(options.forceRefresh) && index === 0 }); } catch {}
    out.set(name, value);
  }
  return out;
}

async function fetchAkashaPercentile(uid, characterName, options = {}) {
  const values = await fetchAkashaPercentiles(uid, [characterName], options);
  return values.get(characterName) || null;
}

function clearAkashaCache(uid, characterName = null) {
  userCache.delete(String(uid));
  const prefix = `${uid}:`;
  if (characterName) htmlCache.delete(`${uid}:${String(characterName).toLowerCase()}`);
  else for (const key of htmlCache.keys()) if (key.startsWith(prefix)) htmlCache.delete(key);
}

module.exports = {
  fetchAkashaPercentile,
  fetchAkashaPercentiles,
  rankingFromCalculation,
  clearAkashaCache,
};
