'use strict';

const cheerio = require('cheerio');

const BASE = 'https://gamewith.net';
const INDEX_URL = `${BASE}/genshin-impact/search/results`;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const pageCache = new Map();
const urlCache = new Map();

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url) {
  const cached = pageCache.get(url);
  if (cached?.expiresAt > Date.now()) return cached.html;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/11.0 (+Discord Genshin helper)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GameWith HTTP ${response.status}`);
  const html = await response.text();
  pageCache.set(url, { html, expiresAt: Date.now() + CACHE_TTL });
  return html;
}

function absoluteUrl(href) {
  if (!href) return null;
  try { return new URL(href, BASE).toString(); } catch { return null; }
}

async function discoverCharacterUrl(name) {
  const wanted = normalize(name);
  const cached = urlCache.get(wanted);
  if (cached?.expiresAt > Date.now()) return cached.url;
  const html = await fetchHtml(INDEX_URL);
  const $ = cheerio.load(html);
  let best = null;
  $('a[href*="/genshin-impact/article/show/"]').each((_, node) => {
    const text = normalize($(node).text());
    if (!text) return;
    const href = absoluteUrl($(node).attr('href'));
    if (!href) return;
    const exact = text === wanted;
    const contains = text.includes(wanted) || wanted.includes(text);
    if (!exact && !contains) return;
    const score = (exact ? 100 : 0) - Math.abs(text.length - wanted.length);
    if (!best || score > best.score) best = { url: href, score };
  });
  if (!best) return null;
  urlCache.set(wanted, { url: best.url, expiresAt: Date.now() + CACHE_TTL });
  return best.url;
}

function statLabel(value) {
  const text = normalize(value);
  if (/^hp\b|health/.test(text)) return 'HP';
  if (/^atk\b|attack/.test(text)) return 'ATK';
  if (/^def\b|defense/.test(text)) return 'DEF';
  if (/crit rate/.test(text)) return 'CRIT Rate';
  if (/crit dmg|crit damage/.test(text)) return 'CRIT DMG';
  if (/energy recharge|^er$/.test(text)) return 'ER';
  if (/elemental mastery|^em$/.test(text)) return 'EM';
  return null;
}

function numericGoal(label, raw) {
  const value = cleanText(raw);
  if (!label || !value || /^(?:none|not needed|n\/a|-|—)$/i.test(value)) return null;
  if (!/\d/.test(value)) return null;
  // ER varies heavily by team, weapon and rotation. A generic secondary-site ER
  // target is not safe enough to score a build against, so leave ER to Game8/KQM.
  if (label === 'ER') return null;
  const compact = value
    .replace(/\([^)]*(?:set|artifact|weapon)[^)]*\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${label}: ${compact || value}`;
}

function rowsOf(table, $) {
  const rows = [];
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((__, td) => cleanText($(td).text())).get().filter(Boolean);
    if (cells.length >= 2) rows.push(cells);
  });
  return rows;
}

function parsePriority($) {
  let value = null;
  $('tr').each((_, tr) => {
    if (value) return;
    const cells = $(tr).find('th,td').map((__, td) => cleanText($(td).text())).get();
    if (cells.length < 2 || !/priority\s+(?:sub-?stats?|stats?)/i.test(cells[0])) return;
    value = cells.slice(1).join(' ').slice(0, 220);
  });
  if (value) return value;
  const body = cleanText($('body').text());
  const match = body.match(/(?:Priority Sub-?Stats?|Stat Priority)\s*:?\s*([^.;]{8,220})/i);
  return match ? cleanText(match[1]) : null;
}

function parseStatGoals(name, html) {
  const $ = cheerio.load(html);
  const headings = $('h2,h3,h4,h5').toArray();
  const candidates = [];
  for (const heading of headings) {
    const title = cleanText($(heading).text());
    if (!/stat goals?|recommended stats?/i.test(title)) continue;
    let cursor = $(heading).next();
    const targets = [];
    for (let i = 0; i < 8 && cursor.length; i += 1, cursor = cursor.next()) {
      const tag = String(cursor[0]?.tagName || '').toLowerCase();
      if (/^h[1-5]$/.test(tag)) break;
      if (tag !== 'table') continue;
      for (const row of rowsOf(cursor, $)) {
        const label = statLabel(row[0]);
        const goal = numericGoal(label, row.slice(1).join(' '));
        if (goal && !targets.some((item) => item.startsWith(`${label}:`))) targets.push(goal);
      }
    }
    if (targets.length) {
      const titleScore = normalize(title).includes(normalize(name)) ? 10 : 0;
      candidates.push({ targets, title, score: titleScore + targets.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  return {
    targets: best?.targets || [],
    priority: parsePriority($),
    variant: best?.title || null,
  };
}

async function fetchGameWithStats(name) {
  const url = await discoverCharacterUrl(name);
  if (!url) return null;
  const parsed = parseStatGoals(name, await fetchHtml(url));
  if (!parsed.targets.length && !parsed.priority) return null;
  return { ...parsed, url };
}

module.exports = {
  fetchGameWithStats,
  discoverCharacterUrl,
  parseStatGoals,
  numericGoal,
};
