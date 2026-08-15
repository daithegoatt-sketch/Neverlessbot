'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../store');

const FILE = path.join(DATA_DIR, 'genshin-build-history.json');
let state = { users: {} };
let writeQueue = Promise.resolve();

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.users) state = parsed;
  } catch (error) {
    console.error('[genshin-history] Could not read history:', error.message);
  }
}
load();

function key(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getEntries(discordUserId, uid, characterName) {
  const user = state.users[String(discordUserId)] || {};
  return user[String(uid)]?.[key(characterName)] || [];
}

function getPrevious(discordUserId, uid, characterName) {
  const entries = getEntries(discordUserId, uid, characterName);
  return entries.length ? entries[entries.length - 1] : null;
}

async function record(discordUserId, uid, characterName, entry) {
  const userId = String(discordUserId);
  const uidKey = String(uid);
  const charKey = key(characterName);
  state.users[userId] ||= {};
  state.users[userId][uidKey] ||= {};
  state.users[userId][uidKey][charKey] ||= [];
  state.users[userId][uidKey][charKey].push({ ...entry, savedAt: new Date().toISOString() });
  state.users[userId][uidKey][charKey] = state.users[userId][uidKey][charKey].slice(-10);
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(FILE, snapshot));
  await writeQueue;
  return state.users[userId][uidKey][charKey].at(-1);
}

module.exports = { getEntries, getPrevious, record };
