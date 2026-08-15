'use strict';

let client = null;
const accountCache = new Map();

function getClient() {
  if (client) return client;
  const { EnkaClient } = require('enka-network-api');
  client = new EnkaClient({
    defaultLanguage: 'en',
    userAgent: 'NeverlessBot/3.0 (Discord Genshin helper)',
    requestTimeout: 10000,
    showFetchCacheLog: false,
  });
  return client;
}

async function fetchAccount(uid) {
  const value = String(uid || '').trim();
  if (!/^\d{9,10}$/.test(value)) throw new Error('INVALID_UID');
  const cached = accountCache.get(value);
  if (cached?.expiresAt > Date.now()) return cached.account;
  const account = await getClient().fetchUser(value);
  const ttl = Number.isFinite(account?.ttl) && account.ttl > 0 ? account.ttl : 60;
  accountCache.set(value, { account, expiresAt: Date.now() + Math.min(ttl, 300) * 1000 });
  return account;
}

function clearAccountCache(uid) {
  accountCache.delete(String(uid || '').trim());
}

function characterName(character) {
  return character?.characterData?.name?.get?.('en') || character?.characterData?.name?.get?.() || null;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findCharacter(account, name) {
  const key = normalize(name);
  return account?.characters?.find((character) => normalize(characterName(character)) === key) || null;
}

function statValue(property) {
  if (!property) return null;
  if (typeof property.getMultipliedValue === 'function') return property.getMultipliedValue();
  if (typeof property.value === 'number') return property.isPercent ? property.value * 100 : property.value;
  return null;
}

function rounded(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function textAsset(asset) {
  return asset?.get?.('en') || asset?.get?.() || null;
}

function getBuildSnapshot(character) {
  if (!character) return null;
  const stats = character.stats || {};
  const weapon = character.weapon || null;
  const artifacts = Array.isArray(character.artifacts) ? character.artifacts : [];
  const slotMap = {
    EQUIP_BRACER: 'flower', EQUIP_NECKLACE: 'plume', EQUIP_SHOES: 'sands', EQUIP_RING: 'goblet', EQUIP_DRESS: 'circlet',
  };
  const artifactRows = artifacts.map((artifact) => ({
    slot: slotMap[artifact?.artifactData?.equipType] || artifact?.artifactData?.equipType || 'unknown',
    set: textAsset(artifact?.artifactData?.set?.name) || textAsset(artifact?.artifactData?.setName) || 'Unknown Set',
    mainStat: textAsset(artifact?.mainstat?.fightPropName) || artifact?.mainstat?.fightProp || 'Unknown',
    mainValue: artifact?.mainstat?.valueText || '',
    level: Number.isInteger(artifact?.level) ? Math.max(0, artifact.level - 1) : null,
  }));
  const setCounts = {};
  for (const artifact of artifactRows) setCounts[artifact.set] = (setCounts[artifact.set] || 0) + 1;
  return {
    name: characterName(character),
    level: character.level ?? null,
    constellation: character.unlockedConstellations?.length ?? 0,
    weapon: {
      name: textAsset(weapon?.weaponData?.name),
      level: weapon?.level ?? null,
      refinement: weapon?.refinementRank ?? null,
    },
    artifacts: artifactRows,
    setCounts,
    stats: {
      hp: rounded(statValue(stats.maxHealth), 0),
      atk: rounded(statValue(stats.attack), 0),
      def: rounded(statValue(stats.defense), 0),
      critRate: rounded(statValue(stats.critRate)),
      critDmg: rounded(statValue(stats.critDamage)),
      er: rounded(statValue(stats.chargeEfficiency)),
      em: rounded(statValue(stats.elementMastery), 0),
      elementalDmg: rounded(statValue(stats.matchedElementDamage)),
    },
  };
}

function listCharacters(account) {
  return (account?.characters || []).map((character) => ({
    name: characterName(character),
    level: character.level ?? null,
    constellation: character.unlockedConstellations?.length ?? 0,
  })).filter((item) => item.name);
}

function accountSummary(account) {
  return {
    uid: Number.isFinite(account?.uid) ? String(account.uid) : null,
    nickname: account?.nickname || null,
    adventureRank: account?.level ?? null,
    worldLevel: account?.worldLevel ?? null,
    showCharacterDetails: Boolean(account?.showCharacterDetails),
    ttl: account?.ttl ?? null,
    characters: listCharacters(account),
  };
}

module.exports = {
  fetchAccount,
  clearAccountCache,
  findCharacter,
  getBuildSnapshot,
  listCharacters,
  accountSummary,
};
