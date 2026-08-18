'use strict';

const { applyKnownComputedStats } = require('./computedStats');

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

async function fetchAccount(uid, options = {}) {
  const value = String(uid || '').trim();
  if (!/^\d{9,10}$/.test(value)) throw new Error('INVALID_UID');
  const forceRefresh = Boolean(options?.forceRefresh);
  if (forceRefresh) accountCache.delete(value);
  const cached = accountCache.get(value);
  if (!forceRefresh && cached?.expiresAt > Date.now()) return cached.account;
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
  const character = account?.characters?.find((item) => normalize(characterName(item)) === key) || null;
  if (character && account?.uid != null) {
    try {
      Object.defineProperty(character, '__neverlessUid', {
        value: String(account.uid),
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch {
      character.__neverlessUid = String(account.uid);
    }
  }
  return character;
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

function assetUrl(asset) {
  if (!asset) return null;
  for (const key of ['url', 'imageUrl', 'mihoyoUrl']) {
    if (typeof asset[key] === 'string' && /^https?:\/\//.test(asset[key])) return asset[key];
  }
  for (const method of ['getUrl', 'getURL', 'toURL']) {
    try {
      const value = asset[method]?.();
      if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
    } catch {}
  }
  return null;
}

function statName(property) {
  if (!property) return null;
  const fromAssets = textAsset(property?.fightPropName)
    || textAsset(property?.name)
    || textAsset(property?.getFightPropTextAssets?.());
  return fromAssets || property?.fightProp || property?.type || null;
}

function statDisplay(property) {
  if (!property) return null;
  if (typeof property.valueText === 'string' && property.valueText.trim()) return property.valueText.trim();
  const value = statValue(property);
  if (!Number.isFinite(value)) return null;
  return property?.isPercent ? `${rounded(value)}%` : String(rounded(value));
}

function artifactStatRow(property) {
  if (!property) return null;
  const numericValue = statValue(property);
  const name = statName(property);
  if (!name || !Number.isFinite(numericValue)) return null;
  return {
    name,
    value: statDisplay(property),
    numericValue: rounded(numericValue, 3),
    rawValue: Number.isFinite(Number(property?.rawValue)) ? Number(property.rawValue) : null,
    isPercent: Boolean(property?.isPercent),
    fightProp: property?.fightProp || null,
  };
}

function getBuildSnapshot(character) {
  if (!character) return null;
  const stats = character.stats || {};
  const weapon = character.weapon || null;
  const artifacts = Array.isArray(character.artifacts) ? character.artifacts : [];
  const slotMap = {
    EQUIP_BRACER: 'flower', EQUIP_NECKLACE: 'plume', EQUIP_SHOES: 'sands', EQUIP_RING: 'goblet', EQUIP_DRESS: 'circlet',
  };
  const artifactRows = artifacts.map((artifact) => {
    const totalSubs = Array.isArray(artifact?.substats?.total)
      ? artifact.substats.total
      : Array.isArray(artifact?.substats)
        ? artifact.substats
        : [];
    const splitSubs = Array.isArray(artifact?.substats?.split) ? artifact.substats.split : [];
    return {
      slot: slotMap[artifact?.artifactData?.equipType] || artifact?.artifactData?.equipType || 'unknown',
      name: textAsset(artifact?.artifactData?.name) || null,
      set: textAsset(artifact?.artifactData?.set?.name)
        || textAsset(artifact?.artifactData?.setName)
        || 'Unknown Set',
      iconUrl: assetUrl(artifact?.artifactData?.icon),
      rarity: artifact?.artifactData?.stars ?? artifact?.artifactData?.rarity ?? null,
      mainStat: textAsset(artifact?.mainstat?.fightPropName)
        || textAsset(artifact?.mainstat?.getFightPropTextAssets?.())
        || artifact?.mainstat?.fightProp
        || 'Unknown',
      mainStatKey: artifact?.mainstat?.fightProp || null,
      mainValue: statDisplay(artifact?.mainstat) || '',
      substats: totalSubs.map(artifactStatRow).filter(Boolean),
      rolls: splitSubs.map(artifactStatRow).filter(Boolean),
      totalRolls: splitSubs.length,
      level: Number.isInteger(artifact?.level) ? Math.max(0, artifact.level - 1) : null,
    };
  });
  const setCounts = {};
  for (const artifact of artifactRows) setCounts[artifact.set] = (setCounts[artifact.set] || 0) + 1;

  const characterArtUrl = assetUrl(character?.costume?.art)
    || assetUrl(character?.characterData?.costume?.art)
    || assetUrl(character?.characterData?.art);
  const characterIconUrl = assetUrl(character?.costume?.icon)
    || assetUrl(character?.characterData?.costume?.icon)
    || assetUrl(character?.characterData?.icon);

  const name = characterName(character);
  const snapshotStats = applyKnownComputedStats(name, {
    hp: rounded(statValue(stats.maxHealth), 0),
    atk: rounded(statValue(stats.attack), 0),
    def: rounded(statValue(stats.defense), 0),
    critRate: rounded(statValue(stats.critRate)),
    critDmg: rounded(statValue(stats.critDamage)),
    er: rounded(statValue(stats.chargeEfficiency)),
    em: rounded(statValue(stats.elementMastery), 0),
    elementalDmg: rounded(statValue(stats.matchedElementDamage)),
  }, artifactRows);

  return {
    name,
    level: character.level ?? null,
    constellation: character.unlockedConstellations?.length ?? 0,
    artUrl: characterArtUrl,
    iconUrl: characterIconUrl,
    weapon: {
      name: textAsset(weapon?.weaponData?.name),
      level: weapon?.level ?? null,
      refinement: weapon?.refinementRank ?? null,
      rarity: weapon?.weaponData?.stars ?? weapon?.weaponData?.rarity ?? null,
      iconUrl: assetUrl(weapon?.weaponData?.icon),
      splashUrl: assetUrl(weapon?.weaponData?.splashImage),
    },
    artifacts: artifactRows,
    setCounts,
    stats: snapshotStats,
  };
}

function listCharacters(account) {
  return (account?.characters || []).map((character) => ({
    name: characterName(character),
    level: character.level ?? null,
    constellation: character.unlockedConstellations?.length ?? 0,
  })).filter((item) => item.name);
}

function bestShowcaseCharacter(account) {
  const rows = (account?.characters || []).map((character, index) => {
    const snapshot = getBuildSnapshot(character);
    if (!snapshot?.name) return null;
    const artifactLevels = snapshot.artifacts.map((item) => Number.isFinite(item.level) ? item.level : 0);
    const artifactAverage = artifactLevels.length ? artifactLevels.reduce((a, b) => a + b, 0) / artifactLevels.length : 0;
    const critValue = (Number(snapshot.stats?.critRate) || 0) * 2 + (Number(snapshot.stats?.critDmg) || 0);
    const score = (Number(snapshot.level) || 0) * 1.8
      + snapshot.artifacts.length * 22
      + artifactAverage * 2
      + Math.min(300, critValue) * 0.22
      + (Number(snapshot.weapon?.level) || 0) * 0.35
      + (Number(snapshot.constellation) || 0) * 3;
    return { name: snapshot.name, score, index };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index);
  return rows[0]?.name || listCharacters(account)[0]?.name || null;
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
    suggestedCharacter: bestShowcaseCharacter(account),
  };
}

module.exports = {
  fetchAccount,
  clearAccountCache,
  findCharacter,
  getBuildSnapshot,
  listCharacters,
  bestShowcaseCharacter,
  accountSummary,
};
