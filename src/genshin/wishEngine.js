'use strict';

const { getCharacterCatalog } = require('./dataClient');

const BANNERS = Object.freeze({
  flins: {
    key: 'flins',
    name: 'The Lone Light Knocks at Night',
    featured5: 'Flins',
    featured4: ['Aino', 'Lan Yan', 'Iansan'],
  },
  ineffa: {
    key: 'ineffa',
    name: 'Astral Actuation',
    featured5: 'Ineffa',
    featured4: ['Aino', 'Lan Yan', 'Iansan'],
  },
});

// Standard 5-star character pool as used by the current character-event simulator.
const STANDARD_FIVE = ['Diluc', 'Jean', 'Mona', 'Qiqi', 'Keqing', 'Tighnari', 'Dehya', 'Mizuki'];

const FOUR_STAR_WEAPONS = [
  'Favonius Sword', 'Favonius Greatsword', 'Favonius Lance', 'Favonius Codex', 'Favonius Warbow',
  'Sacrificial Sword', 'Sacrificial Greatsword', 'Sacrificial Fragments', 'Sacrificial Bow',
  "Dragon's Bane", 'The Bell', 'Rainslasher', 'Rust', 'The Stringless', "Lion's Roar", 'The Flute',
  'Eye of Perception', 'The Widsith',
];

const THREE_STAR_WEAPONS = [
  'Slingshot', "Sharpshooter's Oath", 'Raven Bow', 'Emerald Orb', 'Magic Guide',
  'Thrilling Tales of Dragon Slayers', 'Bloodtainted Greatsword', 'Debate Club', 'Ferrous Shadow',
  'Black Tassel', 'Cool Steel', 'Harbinger of Dawn', 'Skyrider Sword',
];

let fourStarCharactersCache = null;
let fourStarCacheAt = 0;

function randomItem(items, random = Math.random) {
  return items[Math.floor(random() * items.length)] || items[0];
}

async function fourStarCharacters() {
  if (fourStarCharactersCache && Date.now() - fourStarCacheAt < 6 * 60 * 60 * 1000) return fourStarCharactersCache;
  try {
    const catalog = await getCharacterCatalog();
    const rows = catalog
      .filter((row) => Number(row?.rarity) === 4 && row?.name)
      .map((row) => String(row.name))
      .filter((name) => !['Traveler', 'Aether', 'Lumine', 'Aloy'].includes(name));
    if (rows.length) {
      fourStarCharactersCache = [...new Set(rows)];
      fourStarCacheAt = Date.now();
      return fourStarCharactersCache;
    }
  } catch (error) {
    console.warn(`[wish] 4-star catalog unavailable: ${error.message}`);
  }
  return [
    'Amber', 'Barbara', 'Beidou', 'Bennett', 'Candace', 'Charlotte', 'Chevreuse', 'Chongyun',
    'Collei', 'Diona', 'Dori', 'Faruzan', 'Fischl', 'Freminet', 'Gaming', 'Gorou', 'Iansan',
    'Kaeya', 'Kachina', 'Kirara', 'Kuki Shinobu', 'Lan Yan', 'Layla', 'Lisa', 'Lynette', 'Mika',
    'Ningguang', 'Noelle', 'Ororon', 'Razor', 'Rosaria', 'Sayu', 'Sethos', 'Sucrose', 'Thoma',
    'Xiangling', 'Xingqiu', 'Xinyan', 'Yanfei', 'Yaoyao', 'Yun Jin', 'Aino', 'Alyosha',
  ];
}

function fiveStarChance(nextPity) {
  if (nextPity >= 90) return 1;
  // Community-observed soft pity curve; published base/hard pity remain 0.6% / 90.
  if (nextPity >= 74) return Math.min(1, 0.006 + (nextPity - 73) * 0.06);
  return 0.006;
}

function fourStarChance(nextPity) {
  if (nextPity >= 10) return 1;
  if (nextPity === 9) return 0.561;
  return 0.051;
}

async function rollOne(state, random = Math.random) {
  const banner = BANNERS[state.banner] || BANNERS.flins;
  const nextFive = Number(state.fivePity || 0) + 1;
  const nextFour = Number(state.fourPity || 0) + 1;
  let result;

  if (random() < fiveStarChance(nextFive)) {
    state.fivePity = 0;
    state.fourPity = Math.min(9, nextFour);

    let featured = false;
    let capturingRadiance = false;
    if (state.guaranteed5) {
      featured = true;
      state.guaranteed5 = false;
    } else if (Number(state.captureLosses || 0) >= 3) {
      featured = true;
      capturingRadiance = true;
      state.captureLosses = 0;
    } else {
      const eventRoll = random();
      if (eventRoll < 0.50) {
        featured = true;
        state.captureLosses = 0;
      } else if (eventRoll < 0.55) {
        featured = true;
        capturingRadiance = true;
        state.captureLosses = 0;
      } else {
        state.guaranteed5 = true;
        state.captureLosses = Math.min(3, Number(state.captureLosses || 0) + 1);
      }
    }

    result = {
      rarity: 5,
      type: 'character',
      name: featured ? banner.featured5 : randomItem(STANDARD_FIVE, random),
      featured,
      capturingRadiance,
      pityAtPull: nextFive,
    };
  } else if (random() < fourStarChance(nextFour)) {
    state.fivePity = Math.min(89, nextFive);
    state.fourPity = 0;

    let featured = false;
    if (state.guaranteed4) {
      featured = true;
      state.guaranteed4 = false;
    } else if (random() < 0.50) {
      featured = true;
    } else {
      state.guaranteed4 = true;
    }

    if (featured) {
      result = {
        rarity: 4,
        type: 'character',
        name: randomItem(banner.featured4, random),
        featured: true,
        pityAtPull: nextFour,
      };
    } else if (random() < 0.50) {
      const pool = (await fourStarCharacters()).filter((name) => !banner.featured4.includes(name));
      result = {
        rarity: 4,
        type: 'character',
        name: randomItem(pool.length ? pool : await fourStarCharacters(), random),
        featured: false,
        pityAtPull: nextFour,
      };
    } else {
      result = {
        rarity: 4,
        type: 'weapon',
        name: randomItem(FOUR_STAR_WEAPONS, random),
        featured: false,
        pityAtPull: nextFour,
      };
    }
  } else {
    state.fivePity = Math.min(89, nextFive);
    state.fourPity = Math.min(9, nextFour);
    result = {
      rarity: 3,
      type: 'weapon',
      name: randomItem(THREE_STAR_WEAPONS, random),
      featured: false,
      pityAtPull: nextFour,
    };
  }

  state.totalWishes = Number(state.totalWishes || 0) + 1;
  const inventory = result.type === 'character' ? state.characters : state.weapons;
  inventory[result.name] = Number(inventory[result.name] || 0) + 1;
  result.ownedCount = inventory[result.name];
  result.fivePityAfter = state.fivePity;
  result.fourPityAfter = state.fourPity;
  result.banner = banner.key;
  return result;
}

async function rollWishes(state, count, random = Math.random) {
  const amount = count === 10 ? 10 : 1;
  const results = [];
  for (let index = 0; index < amount; index += 1) results.push(await rollOne(state, random));
  return results;
}

function bannerInfo(key) {
  return BANNERS[key] || BANNERS.flins;
}

module.exports = {
  BANNERS,
  STANDARD_FIVE,
  FOUR_STAR_WEAPONS,
  THREE_STAR_WEAPONS,
  fiveStarChance,
  fourStarChance,
  rollOne,
  rollWishes,
  bannerInfo,
};
