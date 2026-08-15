const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'guilds.json');

// NeverLess production defaults. These values intentionally live in code so a
// Railway restart/redeploy does not require running the setup commands again.
const DEFAULT_GUILD_CONFIG = Object.freeze({
  welcomeChannelId: '1537605375229173844',
  ticketCategoryId: '1537951071811534930',
  ticketPanelChannelId: '1537951109488971856',
  ticketPanelImageUrl: 'https://cdn.discordapp.com/attachments/1537606811551670332/1538086506856448000/C8A3D0E7-0D73-44DF-A3E7-4CD2D566FE60.png?ex=6a81662f&is=6a8014af&hm=4695c7bc796ddafa158584faaa0c8a028dfa30364ad7648d38f163e2c59fcfc1&',
});

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
    console.error('[store] Failed to read config; starting with defaults:', error);
  }
}

ensureLoaded();

function getGuild(guildId) {
  return {
    ...DEFAULT_GUILD_CONFIG,
    ...(state.guilds[guildId] || {}),
  };
}

async function patchGuild(guildId, patch) {
  state.guilds[guildId] = {
    ...DEFAULT_GUILD_CONFIG,
    ...(state.guilds[guildId] || {}),
    ...patch,
  };
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(FILE, snapshot));
  await writeQueue;
  return getGuild(guildId);
}

module.exports = { getGuild, patchGuild, DATA_DIR, DEFAULT_GUILD_CONFIG };
