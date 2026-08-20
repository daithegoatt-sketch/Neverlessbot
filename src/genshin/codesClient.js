'use strict';

const API = 'https://api.ennead.cc/mihoyo/genshin/codes';
const SOURCE = 'https://github.com/torikushiii/hoyoverse-api';
const CACHE_TTL = 5 * 60 * 1000;
let cache = null;

function parseTime(value) {
  if (value == null || value === '') return null;
  if (Number.isFinite(Number(value))) {
    const number = Number(value);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function rewardList(row) {
  const value = row?.reward ?? row?.rewards ?? row?.items ?? [];
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : item?.name || item?.reward || '').filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function parseCodesPayload(payload, now = Date.now()) {
  const active = Array.isArray(payload?.active) ? payload.active
    : Array.isArray(payload?.data?.active) ? payload.data.active
      : [];
  const seen = new Set();
  return active.map((row) => {
    const code = String(row?.code || row?.key || '').trim();
    const expiresAt = parseTime(row?.expiresAt ?? row?.expires_at ?? row?.expiry ?? row?.expiration);
    return { code, rewards: rewardList(row), expiresAt };
  }).filter((row) => {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(row.code) || seen.has(row.code.toUpperCase())) return false;
    if (Number.isFinite(row.expiresAt) && row.expiresAt <= now) return false;
    seen.add(row.code.toUpperCase());
    return true;
  });
}

async function fetchActiveCodes(options = {}) {
  if (!options.forceRefresh && cache?.expiresAt > Date.now()) return cache.value;
  const response = await fetch(API, {
    headers: { 'user-agent': 'NeverlessBot/27.0 (Discord Genshin helper)', accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Codes API HTTP ${response.status}`);
  const value = parseCodesPayload(await response.json());
  cache = { value, expiresAt: Date.now() + CACHE_TTL };
  return value;
}

module.exports = { fetchActiveCodes, parseCodesPayload, API, SOURCE };
