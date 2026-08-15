'use strict';

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

async function fetchAkashaPercentile(uid, characterName) {
  const key = `${uid}:${String(characterName).toLowerCase()}`;
  const cached = cache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;
  let value = null;
  try {
    const response = await fetch(`https://akasha.cv/profile/${encodeURIComponent(uid)}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 NeverlessBot/3.0',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (response.ok) {
      const html = await response.text();
      const plain = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const escaped = String(characterName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const around = plain.match(new RegExp(`${escaped}.{0,900}`, 'i'))?.[0] || '';
      const match = around.match(/top\s*<?\s*(\d+(?:\.\d+)?)%/i);
      if (match) value = Number(match[1]);
    }
  } catch {}
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

module.exports = { fetchAkashaPercentile };
