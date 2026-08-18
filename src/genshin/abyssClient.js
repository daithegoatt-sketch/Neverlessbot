'use strict';

const cheerio = require('cheerio');

const FLOOR12_URL = 'https://game8.co/games/Genshin-Impact/archives/326326';
const CACHE_TTL = 30 * 60 * 1000;
let cache = null;

const TEAM_TAGS = [
  'Stellar-Conduct', 'Lunar-Crystallize', 'Lunar-Bloom', 'Swirl-Pyro', 'Swirl-Electro',
  'Vaporize', 'Melt', 'Overload', 'Burning', 'Mono-Pyro', 'Freeze', 'Electro-Charged',
  'Aggravate', 'Spread', 'Hyperbloom', 'Burgeon', 'Bloom', 'Superconduct', 'Double-Geo',
  'Hypercarry', 'Swirl', 'Cryo', 'Pyro', 'Electro', 'Hydro', 'Dendro', 'Geo', 'Anemo',
];

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function headingLevel(node) {
  const match = String(node?.tagName || node?.name || '').match(/^h([1-6])$/i);
  return match ? Number(match[1]) : 99;
}

function collectSectionText($, heading) {
  const level = headingLevel(heading);
  const parts = [];
  let node = $(heading).next();
  while (node.length) {
    const raw = node.get(0);
    if (/^h[1-6]$/i.test(String(raw?.tagName || raw?.name || '')) && headingLevel(raw) <= level) break;
    parts.push(clean(node.text()));
    node = node.next();
  }
  return clean(parts.join(' '));
}

function tagsFrom(text) {
  const value = clean(text).toLowerCase();
  const out = [];
  for (const tag of TEAM_TAGS) {
    const needle = tag.toLowerCase();
    if (value.includes(needle) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function tableValueByLabel($, labelRegex) {
  let found = null;
  $('tr').each((_, tr) => {
    if (found) return;
    const cells = $(tr).children('th,td').map((__, cell) => clean($(cell).text())).get();
    if (cells.length >= 2 && labelRegex.test(cells[0])) found = clean(cells.slice(1).join(' '));
  });
  return found;
}

function parseAbyssHtml(html) {
  const $ = cheerio.load(html || '');
  const title = clean($('h1').first().text()) || 'Spiral Abyss Floor 12';
  const leyLine = tableValueByLabel($, /Ley Line Disorder/i);
  const blessingHeading = $('h2,h3,h4').toArray().find((node) => /Blessing of the Abyssal Moon/i.test(clean($(node).text())));
  const blessing = blessingHeading ? clean($(blessingHeading).text()) : null;

  const halfTexts = { first: '', second: '' };
  const headings = $('h2,h3,h4,h5').toArray();
  for (const node of headings) {
    const text = clean($(node).text());
    if (/^First Half$/i.test(text) && !halfTexts.first) halfTexts.first = collectSectionText($, node);
    if (/^Second Half$/i.test(text) && !halfTexts.second) halfTexts.second = collectSectionText($, node);
    if (halfTexts.first && halfTexts.second) break;
  }

  return {
    title,
    leyLine,
    blessing,
    firstHalfTags: tagsFrom(halfTexts.first),
    secondHalfTags: tagsFrom(halfTexts.second),
    firstHalfText: halfTexts.first,
    secondHalfText: halfTexts.second,
    source: 'Game8 Floor 12',
    url: FLOOR12_URL,
  };
}

async function fetchCurrentAbyss(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  if (!forceRefresh && cache?.expiresAt > Date.now()) return cache.value;
  const response = await fetch(FLOOR12_URL, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/22.0 (+Discord Genshin account advisor)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Game8 HTTP ${response.status}`);
  const value = parseAbyssHtml(await response.text());
  cache = { value, expiresAt: Date.now() + CACHE_TTL };
  return value;
}

module.exports = { FLOOR12_URL, fetchCurrentAbyss, parseAbyssHtml, tagsFrom };
