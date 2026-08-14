const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'guilds.json');
let state = { guilds: {} };
let writeQueue = Promise.resolve();

function ensureLoaded() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.guilds) state = parsed;
  } catch (error) {
    console.error('[store] Failed to read config; starting with empty state:', error);
  }
}

ensureLoaded();

function getGuild(guildId) {
  return state.guilds[guildId] || {};
}

async function patchGuild(guildId, patch) {
  state.guilds[guildId] = {
    ...(state.guilds[guildId] || {}),
    ...patch,
  };
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(FILE, snapshot));
  await writeQueue;
  return state.guilds[guildId];
}

module.exports = { getGuild, patchGuild, DATA_DIR };
