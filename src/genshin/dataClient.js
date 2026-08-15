'use strict';

const API = 'https://genshin-db-api.vercel.app/api/v5';
const CACHE_TTL = 6 * 60 * 60 * 1000;
let namesCache = { expiresAt: 0, value: [] };
const responseCache = new Map();

async function fetchJson(url, ttl = 10 * 60 * 1000) {
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(url, {
    headers: { 'user-agent': 'Neverlessbot-Genshin/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Genshin data source returned HTTP ${response.status}`);
  const value = await response.json();
  responseCache.set(url, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function getCharacterNames() {
  if (namesCache.expiresAt > Date.now() && namesCache.value.length) return namesCache.value;
  const url = `${API}/characters?query=names&matchCategories=true&resultLanguage=english`;
  const value = await fetchJson(url, CACHE_TTL);
  const names = Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  namesCache = { value: names, expiresAt: Date.now() + CACHE_TTL };
  return names;
}

async function getCharacter(name) {
  const url = `${API}/characters?query=${encodeURIComponent(name)}&resultLanguage=english`;
  const value = await fetchJson(url);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function getCharacterStats(name, level = '90') {
  const url = `${API}/stats?folder=characters&query=${encodeURIComponent(name)}&level=${encodeURIComponent(level)}&resultLanguage=english`;
  const value = await fetchJson(url);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

module.exports = { getCharacterNames, getCharacter, getCharacterStats };
