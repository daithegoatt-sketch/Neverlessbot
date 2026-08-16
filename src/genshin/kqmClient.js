'use strict';

const cheerio = require('cheerio');
const { getCharacterNames } = require('./dataClient');

const BASE = 'https://keqingmains.com';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const pageCache = new Map();
const urlCache = new Map();

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchHtml(url) {
  const cached = pageCache.get(url);
  if (cached?.expiresAt > Date.now()) return cached.html;
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 NeverlessBot/10.0', accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`KQM HTTP ${response.status}`);
  const html = await response.text();
  pageCache.set(url, { html, expiresAt: Date.now() + CACHE_TTL });
  return html;
}

async function discoverUrl(name) {
  const cacheKey = normalize(name);
  const cached = urlCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.url;
  const slug = cacheKey.replace(/\s+/g, '-');
  const direct = `${BASE}/q/${slug}-quickguide/`;
  try {
    const html = await fetchHtml(direct);
    if (normalize(cheerio.load(html)('body').text()).includes(cacheKey)) {
      urlCache.set(cacheKey, { url: direct, expiresAt: Date.now() + CACHE_TTL });
      return direct;
    }
  } catch {}

  const searchUrl = `${BASE}/?s=${encodeURIComponent(`${name} quick guide`)}`;
  const html = await fetchHtml(searchUrl);
  const $ = cheerio.load(html);
  let best = null;
  $('a[href]').each((_, node) => {
    const href = $(node).attr('href');
    if (!href || !href.includes('/q/')) return;
    const text = normalize($(node).text());
    const hrefText = normalize(href);
    if (!text.includes(cacheKey) && !hrefText.includes(slug)) return;
    const score = (text.includes('quick guide') ? 20 : 0) + (text.startsWith(cacheKey) ? 10 : 0);
    if (!best || score > best.score) best = { url: href, score };
  });
  if (!best) return null;
  urlCache.set(cacheKey, { url: best.url, expiresAt: Date.now() + CACHE_TTL });
  return best.url;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function rotationCandidates($) {
  const out = [];
  $('*').filter((_, node) => /^sample rotation/i.test(cleanText($(node).text())) && $(node).children().length < 4).each((_, node) => {
    const label = cleanText($(node).text());
    let cursor = $(node).next();
    const parts = [];
    for (let i = 0; i < 6 && cursor.length; i += 1, cursor = cursor.next()) {
      if (/^h[1-6]$/i.test(cursor[0]?.tagName || '')) break;
      const text = cleanText(cursor.text());
      if (text) parts.push(text);
      if (parts.join(' ').length > 360) break;
    }
    const rotation = parts.join(' ').replace(/^Sample Rotation[^A-Za-z0-9]*/i, '').slice(0, 360).trim();
    const context = cleanText($(node).parent().text()).slice(0, 1400);
    if (rotation) out.push({ label, rotation, context });
  });

  if (!out.length) {
    const text = $('body').text().replace(/\r/g, '\n').replace(/[ \t]+/g, ' ');
    for (const match of text.matchAll(/Sample Rotation(?:\s*\([^)]*\))?\s*\n?([^\n]{8,300})/gi)) {
      out.push({ label: 'Sample Rotation', rotation: cleanText(match[1]), context: cleanText(text.slice(Math.max(0, match.index - 900), match.index + 500)) });
    }
  }
  return out;
}

async function findTeamRotation(mainName, teamNames = []) {
  const url = await discoverUrl(mainName);
  if (!url) return null;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const candidates = rotationCandidates($);
  if (!candidates.length) return null;
  const names = teamNames.map(normalize).filter(Boolean);
  let best = null;
  for (const candidate of candidates) {
    const context = normalize(`${candidate.context} ${candidate.rotation}`);
    const score = names.reduce((sum, name) => sum + (context.includes(name) ? 1 : 0), 0);
    if (!best || score > best.score) best = { ...candidate, score };
  }
  if (!best) return null;
  return { rotation: best.rotation, matchedMembers: best.score, url };
}

function sectionText($, headingPattern, max = 1200) {
  const heading = $('h2,h3,h4').filter((_, node) => headingPattern.test(cleanText($(node).text()))).first();
  if (!heading.length) return null;
  const parts = [];
  let cursor = heading.next();
  while (cursor.length && parts.join(' ').length < max) {
    if (/^h[1-4]$/i.test(cursor[0]?.tagName || '')) break;
    const text = cleanText(cursor.text());
    if (text) parts.push(text);
    cursor = cursor.next();
  }
  return cleanText(parts.join(' ')).slice(0, max) || null;
}

async function getCharacterTheoryNotes(name) {
  const url = await discoverUrl(name);
  if (!url) return null;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  return {
    url,
    overview: sectionText($, /character overview|overview/i, 900),
    constellations: sectionText($, /constellations?/i, 1000),
    combos: sectionText($, /combos?/i, 800),
  };
}

module.exports = { discoverUrl, findTeamRotation, getCharacterTheoryNotes };
