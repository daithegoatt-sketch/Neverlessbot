'use strict';

const cheerio = require('cheerio');
const { getCharacterNames, getWeaponNames, getArtifactNames } = require('./dataClient');

const BASE = 'https://game8.co';
const ALL_BUILDS_URL = `${BASE}/games/Genshin-Impact/archives/530535`;
const SEARCH_URL = (name) => `${BASE}/games/Genshin-Impact/search?q=${encodeURIComponent(name)}`;
const CACHE_TTL = 12 * 60 * 60 * 1000;
const pageCache = new Map();
const urlCache = new Map();

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function fetchHtml(url) {
  const cached = pageCache.get(url);
  if (cached?.expiresAt > Date.now()) return cached.html;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/3.0 (+Discord Genshin helper)',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Game8 HTTP ${response.status}`);
  const html = await response.text();
  pageCache.set(url, { html, expiresAt: Date.now() + CACHE_TTL });
  return html;
}

function absoluteUrl(href) {
  if (!href) return null;
  try { return new URL(href, BASE).toString(); } catch { return null; }
}

async function discoverCharacterUrl(name) {
  const key = normalize(name);
  const cached = urlCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.url;

  const html = await fetchHtml(ALL_BUILDS_URL);
  const $ = cheerio.load(html);
  let best = null;
  $('a[href*="/games/Genshin-Impact/archives/"]').each((_, node) => {
    const text = normalize($(node).text());
    if (!text) return;
    const href = absoluteUrl($(node).attr('href'));
    if (!href) return;
    const exact = text === key || text === `${key} builds` || text.includes(`${key} best builds`);
    const contains = text.includes(key);
    if (!exact && !contains) return;
    const score = (exact ? 100 : 0) + (text.startsWith(key) ? 20 : 0) - Math.abs(text.length - key.length);
    if (!best || score > best.score) best = { href, score };
  });

  if (!best) {
    const searchHtml = await fetchHtml(SEARCH_URL(name));
    const $$ = cheerio.load(searchHtml);
    $$('a[href*="/games/Genshin-Impact/archives/"]').each((_, node) => {
      const text = normalize($$(node).text());
      if (!text || !text.includes(key)) return;
      const href = absoluteUrl($$(node).attr('href'));
      if (!href) return;
      const score = (text.startsWith(key) ? 50 : 0) - Math.abs(text.length - key.length);
      if (!best || score > best.score) best = { href, score };
    });
  }

  if (!best) throw new Error(`Game8 character page not found for ${name}`);
  urlCache.set(key, { url: best.href, expiresAt: Date.now() + CACHE_TTL });
  return best.href;
}

function headingText(node, $) { return normalize($(node).text()); }
function elementStream($) { return $('h2,h3,h4,table').toArray(); }

function precedingHeadings(elements, index, $, limit = 4) {
  const result = [];
  for (let i = index - 1; i >= 0 && result.length < limit; i -= 1) {
    const tag = elements[i].tagName?.toLowerCase();
    if (!/^h[234]$/.test(tag || '')) continue;
    result.push({ level: Number(tag[1]), text: headingText(elements[i], $) });
  }
  return result;
}

function tableRows(table, $) {
  const rows = [];
  $(table).find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length) rows.push(cells);
  });
  return rows;
}

function orderedMatches(text, names, limit = 10) {
  const lower = String(text || '').toLowerCase();
  const found = [];
  for (const name of names) {
    const index = lower.indexOf(String(name).toLowerCase());
    if (index >= 0) found.push({ name, index });
  }
  found.sort((a, b) => a.index - b.index || b.name.length - a.name.length);
  const seen = new Set();
  const out = [];
  for (const item of found) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.name);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanMainStat(value) {
  const text = String(value || '').replace(/Image:\s*Genshin[^:]*:?/gi, ' ').replace(/\s+/g, ' ').trim();
  const allowed = /(ATK|HP|DEF|CRIT|DMG|Elemental Mastery|Energy Recharge|Healing Bonus|Physical)/i;
  if (!allowed.test(text) || text.length > 120) return null;
  return text;
}

function parseMainStats(text) {
  const out = [];
  const patterns = [
    ['Sands', /Sands\s*:\s*([^\n|]{1,90})/i],
    ['Goblet', /Goblet\s*:\s*([^\n|]{1,90})/i],
    ['Circlet', /Circlet\s*:\s*([^\n|]{1,90})/i],
  ];
  for (const [label, regex] of patterns) {
    const match = String(text || '').match(regex);
    const value = cleanMainStat(match?.[1]);
    if (value) out.push(`${label}: ${value}`);
  }
  return out;
}

function parseSubstats(text) {
  const match = String(text || '').match(/Artifact Sub Stats?\s*:?\s*([^\n|]{1,220})/i);
  if (!match) return null;
  const cleaned = match[1].replace(/Image:[^,]+/gi, '').replace(/\s+/g, ' ').trim();
  return cleaned.length <= 220 ? cleaned : null;
}

function saneTarget(label, raw) {
  const text = String(raw || '').replace(/,/g, '').trim();
  const nums = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (!nums.length) return null;
  const key = normalize(label);
  const max = Math.max(...nums);
  if (key.includes('hp') && (max < 1000 || max > 100000)) return null;
  if ((key === 'atk' || key.includes('attack')) && (max < 100 || max > 10000)) return null;
  if (key.includes('crit rate') && max > 100) return null;
  if (key.includes('crit dmg') && max > 500) return null;
  if ((key.includes('energy recharge') || key === 'er') && (max < 100 || max > 500)) return null;
  if ((key.includes('elemental mastery') || key === 'em') && max > 2000) return null;
  return `${label}: ${raw.trim()}`;
}

function parseTargetRows(rows) {
  const out = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    const label = row[0].replace(/Stat/i, '').trim();
    const value = row.slice(1).join(' ').trim();
    if (!/(HP|ATK|CRIT Rate|CRIT DMG|Energy Recharge|Elemental Mastery|\bER\b|\bEM\b)/i.test(label)) continue;
    const target = saneTarget(label, value);
    if (target) out.push(target);
  }
  return out.slice(0, 8);
}

function tableContext(elements, index, $) {
  return precedingHeadings(elements, index, $, 5).map((h) => h.text).join(' | ');
}

function extractTeamsFromRows(rows, characterNames, mainName) {
  const teams = [];
  for (const row of rows) {
    const text = row.join(' | ');
    const names = orderedMatches(text, characterNames, 8);
    if (!names.some((x) => normalize(x) === normalize(mainName))) continue;
    const unique = [];
    for (const n of names) if (!unique.some((x) => normalize(x) === normalize(n))) unique.push(n);
    if (unique.length < 4) continue;
    const team = unique.slice(0, 4);
    if (!teams.some((t) => t.map(normalize).join('|') === team.map(normalize).join('|'))) teams.push(team);
  }
  return teams;
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = Array.isArray(value) ? value.map(normalize).join('|') : normalize(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function parseGame8Guide(name, url, html) {
  const $ = cheerio.load(html);
  const title = normalize($('h1').first().text());
  if (title && !title.includes(normalize(name))) throw new Error(`Game8 page mismatch for ${name}`);
  const [characterNames, weaponNames, artifactNames] = await Promise.all([
    getCharacterNames(), getWeaponNames(), getArtifactNames(),
  ]);

  const elements = elementStream($);
  const guide = {
    name, source: 'Game8', url, role: null,
    stats: { main: [], priority: null, targets: [] },
    weapons: [], f2pWeapons: [], artifacts: [],
    teams: { premium: [], f2p: [] }, combos: [],
  };

  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const roleMatch = bodyText.match(new RegExp(`${escapedName}[^.]{0,120}(Main DPS|Sub-DPS|Support|DPS)[^.]{0,100}`, 'i'));
  if (roleMatch) guide.role = roleMatch[0].replace(/\s+/g, ' ').slice(0, 180);

  for (let i = 0; i < elements.length; i += 1) {
    const node = elements[i];
    if (node.tagName?.toLowerCase() !== 'table') continue;
    const rows = tableRows(node, $);
    if (!rows.length) continue;
    const context = tableContext(elements, i, $);
    const tableText = rows.flat().join(' | ');
    const combined = `${context} | ${tableText}`;

    if (/best builds|builds|best weapon|artifact main stats/i.test(combined)) {
      if (!guide.stats.main.length) guide.stats.main = parseMainStats(tableText);
      if (!guide.stats.priority) guide.stats.priority = parseSubstats(tableText);
      if (!guide.weapons.length && /best weapon|replacement weapons/i.test(tableText)) guide.weapons = orderedMatches(tableText, weaponNames, 8);
      if (!guide.artifacts.length && /best artifacts/i.test(tableText)) guide.artifacts = orderedMatches(tableText, artifactNames, 5);
    }

    if (/goal stat values|goal value|recommended stats/i.test(combined)) {
      const targets = parseTargetRows(rows);
      if (targets.length > guide.stats.targets.length) guide.stats.targets = targets;
    }
    if (/best artifacts|artifacts ranked|artifact bonuses/i.test(context)) guide.artifacts.push(...orderedMatches(tableText, artifactNames, 6));
    if (/best weapons|recommended weapons|weapon information|free.to.play weapon/i.test(context)) {
      const weapons = orderedMatches(tableText, weaponNames, 10);
      if (/free.to.play|f2p|free weapon/i.test(context)) guide.f2pWeapons.push(...weapons);
      else guide.weapons.push(...weapons);
    }
    if (/team comps|teams|team compositions/i.test(context)) {
      const teams = extractTeamsFromRows(rows, characterNames, name);
      if (/f2p|free.to.play|free team/i.test(context)) guide.teams.f2p.push(...teams);
      else guide.teams.premium.push(...teams);
    }
    if (/combo|rotation|how to play/i.test(context)) {
      for (const row of rows) {
        const step = row.join(' → ').replace(/\s+/g, ' ').trim();
        if (step.length >= 12 && step.length <= 240) guide.combos.push(step);
      }
    }
  }

  const allText = $('body').text().replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');
  if (!guide.stats.main.length) guide.stats.main = parseMainStats(allText);
  if (!guide.stats.priority) guide.stats.priority = parseSubstats(allText);

  guide.weapons = dedupe(guide.weapons).slice(0, 8);
  guide.f2pWeapons = dedupe(guide.f2pWeapons).slice(0, 5);
  guide.artifacts = dedupe(guide.artifacts).slice(0, 5);
  guide.teams.premium = dedupe(guide.teams.premium).slice(0, 10);
  guide.teams.f2p = dedupe(guide.teams.f2p).slice(0, 8);
  guide.combos = dedupe(guide.combos).slice(0, 8);

  const useful = guide.weapons.length || guide.artifacts.length || guide.stats.main.length || guide.teams.premium.length || guide.teams.f2p.length;
  if (!useful) throw new Error(`Game8 parser found no usable data for ${name}`);
  return guide;
}

async function fetchGame8Guide(name) {
  const url = await discoverCharacterUrl(name);
  return parseGame8Guide(name, url, await fetchHtml(url));
}

module.exports = { fetchGame8Guide, discoverCharacterUrl, parseGame8Guide, saneTarget };
