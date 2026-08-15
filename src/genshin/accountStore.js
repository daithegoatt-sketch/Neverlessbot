'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../store');

const FILE = path.join(DATA_DIR, 'genshin-users.json');
let state = { users: {} };
let writeQueue = Promise.resolve();

function ensureLoaded() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.users) state = parsed;
  } catch (error) {
    console.error('[genshin-store] Failed to read user links:', error);
  }
}

ensureLoaded();

function getLinkedUid(discordUserId) {
  return state.users[String(discordUserId)]?.uid || null;
}

async function linkUid(discordUserId, uid) {
  state.users[String(discordUserId)] = {
    uid: String(uid),
    updatedAt: new Date().toISOString(),
  };
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(FILE, snapshot));
  await writeQueue;
  return state.users[String(discordUserId)];
}

async function unlinkUid(discordUserId) {
  delete state.users[String(discordUserId)];
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(FILE, snapshot));
  await writeQueue;
}

module.exports = { getLinkedUid, linkUid, unlinkUid };
