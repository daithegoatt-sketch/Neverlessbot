'use strict';

const USER_PREFIX = 'NLBANK1|U|';
const MARKET_PREFIX = 'NLBANK1|M|';
const START_BALANCE = 1000;
const COMMAND_CD = 5 * 60 * 1000;
const SALARY_CD = COMMAND_CD;
const TIP_CD = COMMAND_CD;
const MARKET_STEP = 5 * 60 * 1000;
const MAX_BET = 100000;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function newUser() {
  return {
    balance: START_BALANCE,
    vault: 0,
    shares: 0,
    salaryAt: 0,
    tipAt: 0,
    earned: 0,
    lost: 0,
    games: 0,
    wins: 0,
    cooldowns: {},
  };
}

function packUser(s) {
  return {
    b: s.balance,
    v: s.vault,
    sh: s.shares,
    sa: s.salaryAt,
    ta: s.tipAt,
    e: s.earned,
    l: s.lost,
    g: s.games,
    w: s.wins,
    c: s.cooldowns || {},
  };
}

function unpackUser(x = {}) {
  return {
    balance: Math.max(0, Math.floor(Number(x.b ?? START_BALANCE) || 0)),
    vault: Math.max(0, Math.floor(Number(x.v ?? 0) || 0)),
    shares: Math.max(0, Math.floor(Number(x.sh ?? 0) || 0)),
    salaryAt: Math.max(0, Number(x.sa ?? 0) || 0),
    tipAt: Math.max(0, Number(x.ta ?? 0) || 0),
    earned: Math.max(0, Math.floor(Number(x.e ?? 0) || 0)),
    lost: Math.max(0, Math.floor(Number(x.l ?? 0) || 0)),
    games: Math.max(0, Math.floor(Number(x.g ?? 0) || 0)),
    wins: Math.max(0, Math.floor(Number(x.w ?? 0) || 0)),
    cooldowns: x.c && typeof x.c === 'object' && !Array.isArray(x.c)
      ? Object.fromEntries(
        Object.entries(x.c)
          .filter(([name, at]) => /^[a-z]+$/.test(name) && Number.isFinite(Number(at)))
          .map(([name, at]) => [name, Math.max(0, Number(at))]),
      )
      : {},
  };
}

function newMarket() {
  return { price: 100, history: [100], updatedAt: Date.now() };
}

function packMarket(m) {
  return { p: m.price, h: m.history.slice(-24), u: m.updatedAt };
}

function unpackMarket(x = {}) {
  const price = clamp(Math.round(Number(x.p) || 100), 25, 1200);
  const history = Array.isArray(x.h) && x.h.length
    ? x.h.map((n) => clamp(Math.round(Number(n) || price), 25, 1200)).slice(-24)
    : [price];
  return { price, history, updatedAt: Math.max(0, Number(x.u) || Date.now()) };
}

function enc(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function dec(value) {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseRecord(content) {
  const value = String(content || '');
  if (value.startsWith(USER_PREFIX)) {
    const parts = value.slice(USER_PREFIX.length).split('|');
    if (parts.length !== 3 || !/^\d{15,22}$/.test(parts[0]) || !/^\d{15,22}$/.test(parts[1])) return null;
    const payload = dec(parts[2]);
    return payload ? { type: 'user', guildId: parts[0], userId: parts[1], payload } : null;
  }
  if (value.startsWith(MARKET_PREFIX)) {
    const rest = value.slice(MARKET_PREFIX.length);
    const index = rest.indexOf('|');
    if (index < 0) return null;
    const guildId = rest.slice(0, index);
    const payload = dec(rest.slice(index + 1));
    return /^\d{15,22}$/.test(guildId) && payload ? { type: 'market', guildId, payload } : null;
  }
  return null;
}

function digits(value) {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  return String(value || '').replace(/[٠-٩۰-۹]/g, (d) => String(arabic.includes(d) ? arabic.indexOf(d) : persian.indexOf(d)));
}

function parseAmount(raw, max = Infinity) {
  let text = digits(raw).trim().toLowerCase().replace(/[$,]/g, '');
  const available = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : Infinity;
  if (available <= 0) return NaN;

  if (/^(كل|الكل|كامل|all|full)$/u.test(text)) return Number.isFinite(available) ? available : NaN;
  if (/^(نص|نصف|half)$/u.test(text)) return Number.isFinite(available) ? Math.max(1, Math.floor(available / 2)) : NaN;
  if (/^(ربع|quarter)$/u.test(text)) return Number.isFinite(available) ? Math.max(1, Math.floor(available / 4)) : NaN;

  let multiplier = 1;
  if (/(?:k|الف|ألف)$/u.test(text)) {
    multiplier = 1000;
    text = text.replace(/(?:k|الف|ألف)$/u, '').trim();
  }
  if (/(?:m|مليون)$/u.test(text)) {
    multiplier = 1000000;
    text = text.replace(/(?:m|مليون)$/u, '').trim();
  }

  const amount = Math.floor(Number(text) * multiplier);
  return Number.isFinite(amount) && amount > 0 && amount <= available ? amount : NaN;
}

function parseShares(raw) {
  const count = Number(digits(raw).replace(/,/g, '').trim());
  return Number.isInteger(count) && count > 0 && count <= 100000 ? count : NaN;
}

function parseShareAmount(raw, max) {
  if (/^(?:كل|الكل|كامل|all|full|نص|نصف|half|ربع|quarter)$/u.test(digits(raw).trim().toLowerCase())) {
    return parseAmount(raw, max);
  }
  const count = parseShares(raw);
  return Number.isFinite(count) && count <= max ? count : NaN;
}

function money(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function shortMoney(value) {
  const number = Math.round(Number(value) || 0);
  if (Math.abs(number) >= 1e9) return `$${(number / 1e9).toFixed(1)}B`;
  if (Math.abs(number) >= 1e6) return `$${(number / 1e6).toFixed(1)}M`;
  if (Math.abs(number) >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
  return money(number);
}

function commandCooldownLeft(state, name, now = Date.now()) {
  return Math.max(0, Number(state.cooldowns?.[name] || 0) + COMMAND_CD - now);
}

function setCommandCooldown(state, name, now = Date.now()) {
  if (!state.cooldowns || typeof state.cooldowns !== 'object') state.cooldowns = {};
  state.cooldowns[name] = now;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}ث`;
}

function cooldownStatus(ms) {
  return ms <= 0 ? '🟢 متاح' : `🔴 الوقت الباقي ${formatDuration(ms)}`;
}

module.exports = {
  USER_PREFIX,
  MARKET_PREFIX,
  START_BALANCE,
  COMMAND_CD,
  SALARY_CD,
  TIP_CD,
  MARKET_STEP,
  MAX_BET,
  clamp,
  newUser,
  packUser,
  unpackUser,
  newMarket,
  packMarket,
  unpackMarket,
  enc,
  parseRecord,
  digits,
  parseAmount,
  parseShares,
  parseShareAmount,
  money,
  shortMoney,
  commandCooldownLeft,
  setCommandCooldown,
  formatDuration,
  cooldownStatus,
};
