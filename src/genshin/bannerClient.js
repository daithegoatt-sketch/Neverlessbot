'use strict';

const cheerio = require('cheerio');

const NEWS_API = 'https://bbs-api-os.hoyolab.com/community/post/wapi/getNewsList';
const POST_API = 'https://bbs-api-os.hoyolab.com/community/post/wapi/getPostFull';
const OFFICIAL_FEED = 'https://www.hoyolab.com/accountCenter/postList?id=1015537';
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 NeverlessBot/23.0 (Discord Genshin helper)',
      accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
      referer: 'https://www.hoyolab.com/',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`HoYoLAB HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  const json = JSON.parse(text);
  if (json?.retcode != null && json.retcode !== 0) throw new Error(`HoYoLAB retcode ${json.retcode}`);
  return json;
}

function listPost(entry) {
  return entry?.post?.post || entry?.post || entry || null;
}

function normalizeListEntry(entry) {
  const post = listPost(entry);
  if (!post) return null;
  const subject = String(post.subject || post.title || '').trim();
  const postId = String(post.post_id || post.postId || entry?.post_id || '').trim();
  if (!subject || !/^\d+$/.test(postId)) return null;
  return { postId, subject, createdAt: Number(post.created_at || post.createdAt || 0) || 0 };
}

async function fetchNoticeListFromApi() {
  const collected = [];
  for (const type of [1, 2, 3]) {
    try {
      const json = await fetchJson(`${NEWS_API}?gids=2&page_size=50&type=${type}`);
      for (const item of json?.data?.list || []) {
        const row = normalizeListEntry(item);
        if (row && /Event Wishes Notice/i.test(row.subject)) collected.push(row);
      }
    } catch (error) {
      console.warn(`[banner] HoYoLAB news type ${type} unavailable: ${error.message}`);
    }
  }
  const seen = new Set();
  return collected
    .filter((row) => !seen.has(row.postId) && seen.add(row.postId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function fetchNoticeListFromPage() {
  const html = await fetchText(OFFICIAL_FEED);
  const $ = cheerio.load(html);
  const rows = [];
  $('a[href*="/article/"]').each((_, node) => {
    const subject = $(node).text().replace(/\s+/g, ' ').trim();
    if (!/Event Wishes Notice/i.test(subject)) return;
    const href = String($(node).attr('href') || '');
    const postId = href.match(/\/article(?:_pre)?\/(\d+)/)?.[1];
    if (postId) rows.push({ postId, subject, createdAt: 0 });
  });
  return rows;
}

async function fetchNoticeList() {
  const api = await fetchNoticeListFromApi();
  if (api.length) return api;
  return fetchNoticeListFromPage().catch(() => []);
}

function structuredText(value) {
  if (!value) return '';
  try {
    const rows = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(rows)) return '';
    const out = [];
    for (const row of rows) {
      const insert = row?.insert;
      if (typeof insert === 'string') out.push(insert);
      else if (insert && typeof insert === 'object') {
        if (typeof insert.text === 'string') out.push(insert.text);
        if (typeof insert.link === 'string') out.push(insert.link);
      }
    }
    return out.join('\n');
  } catch {
    return '';
  }
}

function postText(post) {
  const inner = post?.post || post || {};
  const fromStructured = structuredText(inner.structured_content);
  if (fromStructured.trim()) return fromStructured;
  const raw = inner.content;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.describe === 'string') return parsed.describe;
      if (typeof parsed?.content === 'string') return parsed.content;
    } catch {}
    return raw;
  }
  return String(inner.desc || '');
}

async function fetchFullPost(postId) {
  const json = await fetchJson(`${POST_API}?post_id=${encodeURIComponent(postId)}`);
  const full = json?.data?.post || null;
  if (!full) throw new Error('HoYoLAB post body missing');
  return full;
}

const ELEMENTS = 'Anemo|Geo|Electro|Dendro|Hydro|Pyro|Cryo';
const WEAPON_TYPES = 'Sword|Claymore|Polearm|Catalyst|Bow';

function extractCharacterNames(segment) {
  const out = [];
  const regex = new RegExp(`(?:"[^"]+"\\s+)?([A-Z][A-Za-zÀ-ÖØ-öø-ÿ0-9’' .-]{1,48}?)\\s*\\((${ELEMENTS})\\)`, 'g');
  let match;
  while ((match = regex.exec(String(segment || '')))) {
    const name = match[1].replace(/^[,;:\s]+|[,;:\s]+$/g, '').trim();
    if (name && !out.some((row) => row.name === name)) out.push({ name, element: match[2] });
  }
  return out;
}

function extractWeaponNames(segment) {
  const out = [];
  const regex = new RegExp(`"?([A-Z][A-Za-zÀ-ÖØ-öø-ÿ0-9’' -]{2,60}?)"?\\s*\\((${WEAPON_TYPES})\\)`, 'g');
  let match;
  while ((match = regex.exec(String(segment || '')))) {
    const name = match[1].replace(/^[,;:\s]+|[,;:\s]+$/g, '').trim();
    if (name && !out.some((row) => row.name === name)) out.push({ name, type: match[2] });
  }
  return out;
}

function segments(text, label) {
  const out = [];
  const regex = new RegExp(`${label}([\\s\\S]{0,900}?)(?:will receive|receive a huge|receive huge)`, 'gi');
  let match;
  while ((match = regex.exec(String(text || '')))) out.push(match[1]);
  return out;
}

function objectUnique(rows) {
  const seen = new Set();
  return (rows || []).filter((row) => {
    const value = String(row?.name || '').toLowerCase();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractByRarity(text) {
  const fiveCharacters = objectUnique(segments(text, '(?:event-exclusive\\s+)?5-star character(?:s)?\\s+').flatMap(extractCharacterNames));
  const fourCharacters = objectUnique(segments(text, '4-star character(?:s)?\\s+').flatMap(extractCharacterNames));
  const fiveWeapons = objectUnique(segments(text, '(?:event-exclusive\\s+)?5-star weapon(?:s)?\\s+').flatMap(extractWeaponNames));
  const fourWeapons = objectUnique(segments(text, '4-star weapon(?:s)?\\s+').flatMap(extractWeaponNames));
  return { fiveCharacters, fourCharacters, fiveWeapons, fourWeapons };
}

function dateFromParts(year, month, day, hour, minute) {
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
}

function extractTextDates(text) {
  const out = [];
  const regex = /(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})/g;
  let match;
  while ((match = regex.exec(String(text || '')))) {
    const value = dateFromParts(match[1], match[2], match[3], match[4], match[5]);
    if (Number.isFinite(value)) out.push(value);
  }
  return unique(out).sort((a, b) => a - b);
}

function eventTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function imageUrls(full) {
  const rows = full?.image_list || full?.post?.image_list || [];
  return unique(rows.map((row) => row?.url || row?.image_url || row).filter((value) => typeof value === 'string' && /^https?:\/\//i.test(value)));
}

function phaseFromSubject(subject) {
  const match = String(subject || '').match(/Phase\s*([IVX]+)/i);
  return match?.[1]?.toUpperCase() || null;
}

function parseNotice(full, fallback = {}) {
  const inner = full?.post || full || {};
  const text = postText(full).replace(/\r/g, '');
  const rated = extractByRarity(text);
  const dates = extractTextDates(text);
  const createdRaw = Number(inner.created_at || fallback.createdAt || 0) || 0;
  const createdAt = createdRaw ? createdRaw * (createdRaw < 10_000_000_000 ? 1000 : 1) : 0;
  const explicitStart = eventTimestamp(inner.event_start_date || full?.event_start_date);
  const explicitEnd = eventTimestamp(inner.event_end_date || full?.event_end_date);
  const startKnown = Boolean(explicitStart || dates.length >= 2);
  const startAt = explicitStart || (dates.length >= 2 ? dates[0] : null);
  const endAt = explicitEnd || (dates.length ? dates[dates.length - 1] : null);
  const subject = String(inner.subject || fallback.subject || 'Event Wishes Notice');
  return {
    postId: String(inner.post_id || fallback.postId || ''),
    subject,
    phase: phaseFromSubject(subject),
    sourceUrl: `https://www.hoyolab.com/article/${inner.post_id || fallback.postId || ''}`,
    text,
    images: imageUrls(full),
    createdAt,
    startKnown,
    startAt,
    endAt,
    ...rated,
  };
}

function activeNotice(rows, now) {
  const exact = rows.filter((row) => row.startKnown && Number.isFinite(row.startAt) && row.startAt <= now && (!Number.isFinite(row.endAt) || row.endAt >= now));
  if (exact.length) return exact.sort((a, b) => (b.startAt || 0) - (a.startAt || 0) || (b.createdAt || 0) - (a.createdAt || 0))[0];

  // Phase-I notices often say "After the Version update" instead of printing a start
  // timestamp. Only use such a notice as current when there is no exact active phase.
  const phaseOne = rows.filter((row) => !row.startKnown && (!Number.isFinite(row.endAt) || row.endAt >= now) && (row.createdAt || 0) <= now);
  return phaseOne.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

function selectNotice(notices, mode = 'current', now = Date.now()) {
  const rows = (notices || []).filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!rows.length) return null;
  const current = activeNotice(rows, now);

  if (mode === 'upcoming') {
    const future = rows
      .filter((row) => row.startKnown && Number.isFinite(row.startAt) && row.startAt > now)
      .sort((a, b) => a.startAt - b.startAt || (b.createdAt || 0) - (a.createdAt || 0));
    if (future.length) return future[0];

    // A newly announced Phase-I post may have only an end timestamp. Treat it as
    // upcoming while an older, explicitly-timed banner is still active.
    if (current) {
      const announced = rows
        .filter((row) => row.postId !== current.postId && !row.startKnown && (row.createdAt || 0) > (current.createdAt || 0) && (!Number.isFinite(row.endAt) || row.endAt > now))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (announced.length) return announced[0];
    }
    return null;
  }

  if (current) return current;
  const notExpired = rows.filter((row) => !Number.isFinite(row.endAt) || row.endAt >= now);
  return notExpired[0] || rows[0];
}

async function loadNotices() {
  const cached = cache.get('notices');
  if (cached?.expiresAt > Date.now()) return cached.value;
  const list = await fetchNoticeList();
  const notices = [];
  for (const row of list.slice(0, 12)) {
    try {
      const full = await fetchFullPost(row.postId);
      notices.push(parseNotice(full, row));
    } catch (error) {
      console.warn(`[banner] Cannot fetch post ${row.postId}: ${error.message}`);
    }
  }
  cache.set('notices', { value: notices, expiresAt: Date.now() + CACHE_TTL });
  return notices;
}

async function getBannerNotice(mode = 'current') {
  const notices = await loadNotices();
  return selectNotice(notices, mode);
}

module.exports = {
  getBannerNotice,
  parseNotice,
  selectNotice,
  extractByRarity,
  extractTextDates,
  postText,
  phaseFromSubject,
};
