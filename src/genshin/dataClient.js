'use strict';

const { KNOWN_CHARACTER_NAMES } = require('./characterAliases');

const API = 'https://genshin-db-api.vercel.app/api/v5';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const nameCaches = new Map();
const responseCache = new Map();

async function fetchJson(url, ttl = 10 * 60 * 1000) {
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(url, {
    headers: { 'user-agent': 'Neverlessbot-Genshin/2.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Genshin data source returned HTTP ${response.status}`);
  const value = await response.json();
  responseCache.set(url, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function getNames(folder) {
  const cached = nameCaches.get(folder);
  if (cached?.expiresAt > Date.now() && cached.value.length) return cached.value;
  const url = `${API}/${folder}?query=names&matchCategories=true&resultLanguage=english`;
  const value = await fetchJson(url, CACHE_TTL);
  const names = Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  nameCaches.set(folder, { value: names, expiresAt: Date.now() + CACHE_TTL });
  return names;
}

async function getCatalog(folder) {
  const url = `${API}/${folder}?query=names&matchCategories=true&verboseCategories=true&resultLanguage=english`;
  const value = await fetchJson(url, CACHE_TTL);
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

async function getCharacterNames() {
  const live = await getNames('characters');
  return [...new Set([...live, ...KNOWN_CHARACTER_NAMES])];
}

async function getWeaponNames() {
  return getNames('weapons');
}

async function getArtifactNames() {
  return getNames('artifacts');
}

async function getCharacterCatalog() {
  return getCatalog('characters');
}

async function getTalentCatalog() {
  return getCatalog('talents');
}

async function getCharacter(name) {
  const url = `${API}/characters?query=${encodeURIComponent(name)}&resultLanguage=english`;
  const value = await fetchJson(url);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function getTalent(name) {
  const url = `${API}/talents?query=${encodeURIComponent(name)}&resultLanguage=english`;
  const value = await fetchJson(url);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function getCharacterStats(name, level = '90') {
  const url = `${API}/stats?folder=characters&query=${encodeURIComponent(name)}&level=${encodeURIComponent(level)}&resultLanguage=english`;
  const value = await fetchJson(url);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

module.exports = {
  getCharacterNames,
  getWeaponNames,
  getArtifactNames,
  getCharacterCatalog,
  getTalentCatalog,
  getCharacter,
  getTalent,
  getCharacterStats,
};
