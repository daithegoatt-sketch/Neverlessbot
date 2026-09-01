'use strict';

const { load } = require('cheerio');

const TIMELINE_URL = 'https://genshin-builds.com/en/timeline';
const CACHE_MS = 20 * 60 * 1000;
let cache = null;

const DIFFICULTIES = Object.freeze({
  easy: { key: 'easy', ar: 'سهل', en: 'Easy', acts: 3, minCharacters: 8, maxCharacters: 10, level: 60 },
  normal: { key: 'normal', ar: 'عادي', en: 'Normal', acts: 6, minCharacters: 12, maxCharacters: 14, level: 60 },
  hard: { key: 'hard', ar: 'صعب', en: 'Hard', acts: 8, minCharacters: 16, maxCharacters: 20, level: 70 },
  visionary: { key: 'visionary', ar: 'Visionary', en: 'Visionary', acts: 10, minCharacters: 22, maxCharacters: 26, level: 70 },
  lunar: { key: 'lunar', ar: 'Lunar', en: 'Lunar', acts: 12, minCharacters: 28, maxCharacters: 32, level: 70 },
});

const VERIFIED_SEASONS = Object.freeze({
  '2026-09': {
    key: '2026-09',
    label: 'September 2026',
    elements: ['Hydro', 'Electro', 'Dendro'],
    opening: ['Columbina', 'Xingqiu', 'Cyno', 'Kuki Shinobu', 'Lauma', 'Kaveh'],
    guests: ['Odette', 'Sandrone', 'Sucrose', 'Nicole'],
    source: 'HoYoLAB/Genshin 7.0 update details + current season references',
    routeVerified: true,
    acts: {
      1: { type: 'normal', title: 'بداية خفيفة', reaction: 'Quicken / Hyperbloom', note: 'استخدم شخصيات أقل أولوية وابنِ Blessings. لا تحرق أقوى Hydro/Electro من البداية.' },
      2: { type: 'normal', title: 'تجهيز لأول Boss', reaction: 'Quicken / Electro-Charged', note: 'حاول إنهاءها بفريق اقتصادي واحتفظ بتطبيق Electro جيد للمرحلة 3.' },
      3: { type: 'boss', boss: 'Jadeplume Terrorshroom', reaction: 'Electro / Quicken', note: 'Electro يسرّع حالة الـActivated ثم تحصل نافذة ضعف. لا تحتاج تصرف أقوى فريق بالحساب هنا.' },
      4: { type: 'normal', title: 'AoE / Defense', reaction: 'AoE + Control', note: 'الأولوية للـAoE أو التحكم. إذا ظهر Monolith Defense لا تطارد عدو واحد واترك الباقي.' },
      5: { type: 'normal', title: 'مرحلة حفظ الموارد', reaction: 'حسب الأعداء', note: 'استعمل DPS ثانوي وSupports لا تحتاجهم للبوس 6 أو 8.' },
      6: { type: 'boss', boss: 'Emperor of Fire and Iron', reaction: 'Hydro application', note: 'أهم شيء كسر درع الـPyro بسرعة. Hydro سريع/مستمر أهم من رقم Damage نظري عالي.' },
      7: { type: 'normal', title: 'قبل البوس الثاني', reaction: 'Quicken / Electro', note: 'استعمل التشكيلة الاحتياطية واحفظ Hydro+Electro القوي للمرحلة 8.' },
      8: { type: 'boss', boss: 'Battle-Hardened Pipilpan Idol', reaction: 'Electro-Charged / Lunar-Charged', note: 'احتفظ بزوج Hydro + Electro لهذه المرحلة. التفاعل المطلوب أهم من حشر أربعة DPS.' },
      9: { type: 'normal', title: 'المرحلة قبل الأخيرة', reaction: 'Flexible Hydro/Dendro', note: 'اختر التفاعل حسب الأعداء الظاهرين. لا تستخدم Healer الأخير إذا عندك بديل.' },
      10: { type: 'boss', boss: 'Radiant Moonfly', reaction: 'Strong DPS + Healing', note: 'الشفاء مهم لأن ميكانيكية البوس تعطل الـCRIT بشكل عملي إلى أن ترجع الشخصية Full HP. فضّل Teamwide healer.' },
      11: { type: 'arcana', boss: 'Shadowy Husks', reaction: 'Sustain + AoE', note: 'Lunar فقط: يوجد ضغط HP مستمر. Healer مريح جدًا، وتجنب الاعتماد على Shield كخطة أساسية ضد الـHusks.' },
      12: { type: 'arcana', boss: 'Battle-Hardened Primordial Bathysmal Vishap', reaction: 'Dendro / Electro', note: 'Lunar فقط: Energy drain وHydro defenses؛ Dendro/Electro يساعدان أكثر من Burst-heavy team يعتمد على طاقة مستمرة.' },
    },
  },
});

function monthKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function splitNames(value) {
  return String(value || '')
    .replace(/\band\b/gi, ',')
    .split(',')
    .map((name) => name.trim().replace(/[.。]+$/g, ''))
    .filter(Boolean);
}

function parseTimelineText(raw, now = new Date()) {
  const text = String(raw || '').replace(/\s+/g, ' ');
  const marker = text.toLowerCase().indexOf('imaginarium theater');
  if (marker < 0) return null;
  const segment = text.slice(marker, marker + 1800);
  const elementsMatch = segment.match(/Required Elemental Types:\s*([^.]*)\./i);
  const openingMatch = segment.match(/Opening Characters:\s*([^.]*)\./i);
  const guestsMatch = segment.match(/Special Guest Stars:\s*([^.]*)\./i);
  if (!elementsMatch || !openingMatch || !guestsMatch) return null;
  return {
    key: monthKey(now),
    label: now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    elements: splitNames(elementsMatch[1]),
    opening: splitNames(openingMatch[1]),
    guests: splitNames(guestsMatch[1]),
    source: 'Genshin Builds timeline (season data)',
    routeVerified: false,
    acts: {},
  };
}

async function fetchTimelineSeason(now = new Date()) {
  const response = await fetch(TIMELINE_URL, {
    headers: { 'user-agent': 'NeverlessBot/4.0 (Imaginarium Theater planner)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`THEATER_TIMELINE_HTTP_${response.status}`);
  const html = await response.text();
  const $ = load(html);
  const parsed = parseTimelineText($.text(), now);
  if (!parsed) throw new Error('THEATER_TIMELINE_PARSE');
  return parsed;
}

function mergeVerified(live, verified) {
  if (!verified) return live;
  if (!live) return { ...verified, acts: { ...verified.acts } };
  return {
    ...verified,
    ...live,
    // Verified act/boss route wins only for the matching month; live roster remains fresh.
    elements: live.elements?.length ? live.elements : verified.elements,
    opening: live.opening?.length ? live.opening : verified.opening,
    guests: live.guests?.length ? live.guests : verified.guests,
    routeVerified: true,
    acts: { ...verified.acts },
    source: `${live.source} + verified boss route`,
  };
}

function genericAct(act) {
  if (act === 3 || act === 6 || act === 8 || act === 10) {
    return {
      type: 'boss',
      title: `Boss Act ${act}`,
      reaction: 'حسب ميكانيكية البوس الحالي',
      note: 'مسار البوس لهذا الشهر غير موثق داخل Neverless بعد؛ لا راح أخترع Counter. استخدم الأمر بعد تحديث المصدر أو أعطني الأعداء الظاهرين ليبني بديلًا من الموجود.',
    };
  }
  if (act > 10) {
    return {
      type: 'arcana',
      title: `Arcana ${act - 10}`,
      reaction: 'حسب التحدي',
      note: 'تحدي Lunar إضافي. أعطني الأعداء/الميكانيكية الظاهرة إذا مسار الشهر ما توفر تلقائيًا.',
    };
  }
  return {
    type: 'normal',
    title: `Act ${act}`,
    reaction: 'Flexible reaction',
    note: 'استخدم فريق اقتصادي واحفظ أقوى Carry/Support للبوسات القادمة. كل شخصية عندها استعمالان فقط.',
  };
}

async function getCurrentTheaterSeason(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const key = monthKey(now);
  if (!options.force && cache?.expiresAt > Date.now() && cache.key === key) return cache.value;

  const verified = VERIFIED_SEASONS[key] || null;
  let live = null;
  try {
    live = await fetchTimelineSeason(now);
  } catch (error) {
    if (!verified) console.warn('[theater] current season lookup failed:', error.message);
  }

  let value = mergeVerified(live, verified);
  if (!value) {
    value = {
      key,
      label: now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      elements: [],
      opening: [],
      guests: [],
      source: 'Unavailable',
      routeVerified: false,
      acts: {},
    };
  }
  value.act = (act) => value.acts?.[act] || genericAct(act);
  cache = { key, value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

function resolveDifficulty(value) {
  const text = String(value || '').toLowerCase().replace(/[–—_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || /^(?:current|الحالي|حالي|الان|الآن)$/.test(text)) return null;
  if (/\beasy\b|سهل/.test(text)) return DIFFICULTIES.easy;
  if (/\bnormal\b|عادي|متوسط/.test(text)) return DIFFICULTIES.normal;
  if (/\bhard\b|صعب/.test(text)) return DIFFICULTIES.hard;
  if (/\bvisionary\b|فيجنري|خيالي/.test(text)) return DIFFICULTIES.visionary;
  if (/\blunar\b|قمري|لونار/.test(text)) return DIFFICULTIES.lunar;
  return undefined;
}

module.exports = {
  TIMELINE_URL,
  DIFFICULTIES,
  VERIFIED_SEASONS,
  monthKey,
  splitNames,
  parseTimelineText,
  getCurrentTheaterSeason,
  resolveDifficulty,
  genericAct,
};
