'use strict';

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchAkashaPercentile(uid, characterName) {
  const key = `${uid}:${String(characterName).toLowerCase()}`;
  const cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;
  let value = null;
  try {
    const response = await fetch(`https://akasha.cv/profile/${encodeURIComponent(uid)}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 NeverlessBot/4.0',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (response.ok) {
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
      if (percentages.length) value = Math.min(...percentages);
    }
  } catch {}
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

module.exports = { fetchAkashaPercentile };
