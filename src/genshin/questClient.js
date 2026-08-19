'use strict';

const CACHE_TTL = 30 * 60 * 1000;
const cache = new Map();

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function decodeTitle(value) {
  const raw = String(value || '');
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch {
    return raw.replace(/\\u0026/g, '&').replace(/\\n/g, ' ').replace(/\\"/g, '"');
  }
}

function parseYoutubeResults(html, questName = '') {
  const rows = [];
  const regex = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,3500}?"title":\{"runs":\[\{"text":"((?:\\.|[^"\\]){1,180})"/g;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const id = match[1];
    const title = decodeTitle(match[2]);
    if (!rows.some((row) => row.id === id)) rows.push({ id, title });
    if (rows.length >= 20) break;
  }
  const tokens = normalize(questName).split(' ').filter((token) => token.length >= 3);
  rows.forEach((row) => {
    const title = normalize(row.title);
    row.score = tokens.reduce((sum, token) => sum + (title.includes(token) ? 1 : 0), 0)
      + (title.includes('genshin') ? 1 : 0)
      + (/quest|walkthrough|guide/.test(title) ? 0.5 : 0);
  });
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

async function fetchYoutube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/23.0',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`YouTube HTTP ${response.status}`);
  return response.text();
}

async function findQuestVideo(questName) {
  const clean = String(questName || '').trim().slice(0, 160);
  if (!clean) return null;
  const cacheKey = normalize(clean);
  const cached = cache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;

  let result = null;
  try {
    const html = await fetchYoutube(`Genshin Impact ${clean} quest guide walkthrough`);
    const rows = parseYoutubeResults(html, clean);
    if (rows.length) {
      result = {
        title: rows[0].title,
        url: `https://www.youtube.com/watch?v=${rows[0].id}`,
        direct: true,
      };
    }
  } catch (error) {
    console.warn(`[quest] YouTube search unavailable: ${error.message}`);
  }

  if (!result) {
    result = {
      title: `Genshin Impact — ${clean}`,
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`Genshin Impact ${clean} quest guide walkthrough`)}`,
      direct: false,
    };
  }
  cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

module.exports = { findQuestVideo, parseYoutubeResults, normalize };
