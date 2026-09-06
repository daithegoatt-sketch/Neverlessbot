'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../store');

const FILE = path.join(DATA_DIR, 'neverless-ai-memory.json');
const DATA_CHANNEL_NAME = 'neverless-data';
const RECORD_PREFIX = 'NLAIM1|';
const MAX_SCAN_MESSAGES = 5000;
const MAX_TURNS = 12;
const MAX_MEANINGS = 8;
const MAX_RULES = 6;

let state = { users: {} };
let dataChannel = null;
let botUserId = null;
let writeTimer = null;
let writeQueue = Promise.resolve();
const recordMessageIds = new Map();

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeQuestion(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/\u0640/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function normalizeRule(input = {}) {
  return {
    key: normalizeQuestion(input.key || input.trigger || input.rule),
    trigger: cleanText(input.trigger || '', 180),
    meaning: cleanText(input.meaning || input.rule || '', 220),
    hits: Math.max(0, Math.min(99, Number(input.hits) || 0)),
    active: Boolean(input.active),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function normalizeMeaning(input = {}) {
  return {
    question: cleanText(input.question || '', 240),
    meaning: cleanText(input.meaning || '', 260),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function normalizeUser(input = {}) {
  const turns = Array.isArray(input.turns)
    ? input.turns
      .filter((row) => row && ['user', 'assistant'].includes(row.role) && row.content)
      .slice(-MAX_TURNS)
      .map((row) => ({ role: row.role, content: cleanText(row.content, 1800), at: row.at || null }))
    : [];
  const meanings = input.meanings && typeof input.meanings === 'object' ? input.meanings : {};
  const normalizedMeanings = {};
  for (const [key, row] of Object.entries(meanings)) {
    const normalizedKey = normalizeQuestion(key);
    if (!normalizedKey) continue;
    normalizedMeanings[normalizedKey] = normalizeMeaning(row);
  }
  const orderedMeanings = Object.entries(normalizedMeanings)
    .sort((a, b) => Date.parse(b[1].updatedAt || '') - Date.parse(a[1].updatedAt || ''))
    .slice(0, MAX_MEANINGS);
  const rules = Array.isArray(input.rules)
    ? input.rules.map(normalizeRule).filter((row) => row.key && row.meaning)
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
      .slice(0, MAX_RULES)
    : [];
  return { turns, meanings: Object.fromEntries(orderedMeanings), rules };
}

function userState(userId) {
  const id = String(userId);
  state.users[id] = normalizeUser(state.users[id] || {});
  return state.users[id];
}

function loadLocal() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed?.users && typeof parsed.users === 'object') {
      state.users = parsed.users;
      for (const id of Object.keys(state.users)) state.users[id] = normalizeUser(state.users[id]);
    }
  } catch (error) {
    console.warn('[neverless-ai] Memory load failed:', error.message);
  }
}
loadLocal();

function scheduleLocalWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const snapshot = JSON.stringify(state, null, 2);
    writeQueue = writeQueue.then(() => fs.promises.writeFile(FILE, snapshot)).catch((error) => {
      console.warn('[neverless-ai] Memory write failed:', error.message);
    });
  }, 800);
  writeTimer.unref?.();
}

function getTurns(userId) {
  return userState(userId).turns.map((row) => ({ role: row.role, content: row.content }));
}

function appendTurn(userId, role, content) {
  if (!['user', 'assistant'].includes(role)) return;
  const user = userState(userId);
  user.turns.push({ role, content: cleanText(content, 1800), at: new Date().toISOString() });
  user.turns = user.turns.slice(-MAX_TURNS);
  scheduleLocalWrite();
}

function lastExchange(userId) {
  const turns = userState(userId).turns;
  let assistant = null;
  let question = null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (!assistant && turns[i].role === 'assistant') {
      assistant = turns[i].content;
      continue;
    }
    if (assistant && turns[i].role === 'user') {
      question = turns[i].content;
      break;
    }
  }
  return question && assistant ? { question, answer: assistant } : null;
}

function getLearningContext(userId, question) {
  const user = userState(userId);
  const key = normalizeQuestion(question);
  const exact = user.meanings[key] || null;
  const rules = user.rules.filter((row) => row.active).map((row) => ({ trigger: row.trigger, meaning: row.meaning }));
  return { exact, rules };
}

function compactLongTerm(userId) {
  const user = userState(userId);
  const meanings = Object.entries(user.meanings)
    .sort((a, b) => Date.parse(b[1].updatedAt || '') - Date.parse(a[1].updatedAt || ''))
    .slice(0, MAX_MEANINGS)
    .map(([key, row]) => [key, cleanText(row.question, 160), cleanText(row.meaning, 190), row.updatedAt]);
  const rules = user.rules.slice(0, MAX_RULES).map((row) => [
    row.key,
    cleanText(row.trigger, 130),
    cleanText(row.meaning, 180),
    row.hits,
    row.active ? 1 : 0,
    row.updatedAt,
  ]);
  return { m: meanings, r: rules };
}

function expandLongTerm(value = {}) {
  const meanings = {};
  for (const row of Array.isArray(value.m) ? value.m : []) {
    if (!Array.isArray(row) || !row[0]) continue;
    meanings[normalizeQuestion(row[0])] = normalizeMeaning({ question: row[1], meaning: row[2], updatedAt: row[3] });
  }
  const rules = (Array.isArray(value.r) ? value.r : []).map((row) => normalizeRule({
    key: row?.[0], trigger: row?.[1], meaning: row?.[2], hits: row?.[3], active: Boolean(row?.[4]), updatedAt: row?.[5],
  })).filter((row) => row.key && row.meaning);
  return { meanings, rules };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseRemote(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(RECORD_PREFIX)) return null;
  const parts = value.split('|');
  if (parts.length !== 4) return null;
  const [, guildId, userId, payload] = parts;
  if (!/^\d{15,22}$/.test(guildId || '') || !/^\d{15,22}$/.test(userId || '')) return null;
  const decoded = decode(payload);
  return decoded ? { guildId, userId, longTerm: expandLongTerm(decoded) } : null;
}

async function fetchAllMessages(channel) {
  const out = [];
  let before;
  while (out.length < MAX_SCAN_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return out;
}

async function initLongTermMemory(guild, clientUserId) {
  botUserId = String(clientUserId || '');
  dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
  if (!dataChannel) {
    await guild.channels.fetch().catch(() => null);
    dataChannel = guild.channels.cache.find((channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased?.()) || null;
  }
  if (!dataChannel) return;
  const messages = await fetchAllMessages(dataChannel);
  const newest = new Map();
  for (const message of messages) {
    if (botUserId && message.author?.id !== botUserId) continue;
    const parsed = parseRemote(message.content);
    if (!parsed || parsed.guildId !== guild.id) continue;
    const previous = newest.get(parsed.userId);
    if (!previous || message.createdTimestamp > previous.createdTimestamp) {
      newest.set(parsed.userId, { ...parsed, messageId: message.id, createdTimestamp: message.createdTimestamp });
    }
  }
  for (const [userId, row] of newest) {
    const local = userState(userId);
    state.users[userId] = normalizeUser({ ...local, meanings: row.longTerm.meanings, rules: row.longTerm.rules });
    recordMessageIds.set(userId, row.messageId);
  }
  scheduleLocalWrite();
}

function persistLongTerm(guild, userId) {
  const id = String(userId);
  scheduleLocalWrite();
  if (!dataChannel || dataChannel.guildId !== guild.id) return Promise.resolve();
  const content = `${RECORD_PREFIX}${guild.id}|${id}|${encode(compactLongTerm(id))}`;
  if (content.length > 1900) {
    console.warn(`[neverless-ai] Long-term memory for ${id} exceeded Discord record limit.`);
    return Promise.resolve();
  }
  writeQueue = writeQueue.then(async () => {
    const known = recordMessageIds.get(id);
    let message = known ? await dataChannel.messages.fetch(known).catch(() => null) : null;
    if (message) await message.edit(content);
    else {
      message = await dataChannel.send(content);
      recordMessageIds.set(id, message.id);
    }
  }).catch((error) => console.warn('[neverless-ai] Remote memory write failed:', error.message));
  return writeQueue;
}

function applyCorrection(guild, userId, correction) {
  if (!correction?.valid) return { learned: false, promoted: false };
  const user = userState(userId);
  const previousQuestion = cleanText(correction.previousQuestion || '', 240);
  const intendedMeaning = cleanText(correction.meaning || '', 260);
  let learned = false;
  let promoted = false;

  if (previousQuestion && intendedMeaning) {
    const key = normalizeQuestion(previousQuestion);
    user.meanings[key] = { question: previousQuestion, meaning: intendedMeaning, updatedAt: new Date().toISOString() };
    const entries = Object.entries(user.meanings)
      .sort((a, b) => Date.parse(b[1].updatedAt || '') - Date.parse(a[1].updatedAt || ''))
      .slice(0, MAX_MEANINGS);
    user.meanings = Object.fromEntries(entries);
    learned = true;
  }

  if (correction.scope === 'general_pattern' && correction.trigger && intendedMeaning) {
    const key = normalizeQuestion(correction.trigger);
    if (key) {
      let rule = user.rules.find((row) => row.key === key);
      if (!rule) {
        rule = normalizeRule({ key, trigger: correction.trigger, meaning: intendedMeaning, hits: 0, active: false });
        user.rules.unshift(rule);
      }
      rule.hits += 1;
      rule.meaning = intendedMeaning;
      rule.trigger = cleanText(correction.trigger, 180);
      rule.updatedAt = new Date().toISOString();
      const explicit = Boolean(correction.explicit) && Number(correction.confidence || 0) >= 0.9;
      if (explicit || (rule.hits >= 2 && Number(correction.confidence || 0) >= 0.75)) {
        rule.active = true;
        promoted = true;
      }
      user.rules = user.rules.slice(0, MAX_RULES);
      learned = true;
    }
  }

  if (learned) persistLongTerm(guild, userId).catch(() => {});
  return { learned, promoted };
}

module.exports = {
  initLongTermMemory,
  getTurns,
  appendTurn,
  lastExchange,
  getLearningContext,
  applyCorrection,
  normalizeQuestion,
  parseRemote,
  compactLongTerm,
};
