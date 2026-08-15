'use strict';

/**
 * Curated, source-backed recommendations only.
 * These are fallbacks when a live guide cannot be parsed. Do not add guessed values.
 */
const GUIDES = {
  odette: {
    name: 'Odette',
    aliases: ['odette', 'اوديت', 'أوديت'],
    status: 'provisional',
    sources: [
      { name: 'Icy Veins — Odette Build Guide', url: 'https://www.icy-veins.com/genshin-impact/odette-guide-best-builds' },
      { name: 'Icy Veins — Odette Team Guide', url: 'https://www.icy-veins.com/genshin-impact/odette-team-guide' },
    ],
    role: 'Off-field Cryo support / Stellar-Conduct & Stellar-Swirl enabler',
    stats: {
      main: ['Sands: ATK% or EM', 'Goblet: ATK% or EM', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'CRIT Rate / CRIT DMG > ATK% > Elemental Mastery > Energy Recharge',
      targets: ['HP: 17,000–20,000', 'ATK: 2,400–2,600', 'CRIT Rate: 60–75%', 'CRIT DMG: 150–175%', 'ER: 100–130%'],
    },
    weapons: ['Whitelake Frostfeather'],
    artifacts: ['4pc Disenchantment in Deep Shadow', '4pc Heart of the Furnace', '4pc Tenacity of the Millelith'],
    teams: [
      ['Odette', 'Sandrone', 'Yae Miko', 'Alyosha'],
      ['Odette', 'Wriothesley', 'Nicole', 'Yae Miko'],
      ['Odette', 'Cyno', 'Yae Miko', 'Alyosha'],
      ['Odette', 'Sandrone', 'Cryo Traveler', 'Sucrose'],
      ['Odette', 'Sandrone', 'Qiqi', 'Sucrose'],
    ],
  },

  skirk: {
    name: 'Skirk',
    aliases: ['skirk', 'سكيرك', 'سكيرك'],
    status: 'verified',
    sources: [
      { name: 'Icy Veins — Skirk Build Guide', url: 'https://www.icy-veins.com/genshin-impact/skirk-guide-best-builds' },
      { name: 'Icy Veins — Skirk Team Guide', url: 'https://www.icy-veins.com/genshin-impact/skirk-team-guide' },
    ],
    role: 'On-field Cryo Freeze DPS',
    stats: {
      main: ['Sands: ATK%', 'Goblet: Cryo DMG > ATK%', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'CRIT Rate / CRIT DMG > ATK%',
      targets: ['HP: 18,000–20,000', 'ATK: 2,200', 'CRIT Rate: 70–75%', 'CRIT DMG: 170–200%'],
    },
    weapons: ['Azurelight'],
    artifacts: ['4pc Finale of the Deep Galleries', '4pc Marechaussee Hunter'],
    teams: [
      ['Skirk', 'Escoffier', 'Furina', 'Yelan'],
      ['Skirk', 'Escoffier', 'Furina', 'Citlali'],
      ['Skirk', 'Escoffier', 'Furina', 'Charlotte'],
      ['Skirk', 'Escoffier', 'Yelan', 'Xingqiu'],
      ['Skirk', 'Escoffier', 'Yelan', 'Dahlia'],
      ['Skirk', 'Escoffier', 'Yelan', 'Charlotte'],
    ],
  },

  escoffier: {
    name: 'Escoffier',
    aliases: ['escoffier', 'اسكوفيه', 'اسكوفر', 'إسكوفيه', 'ايسكوفيه'],
    status: 'verified',
    sources: [
      { name: 'Icy Veins — Escoffier Build Guide', url: 'https://www.icy-veins.com/genshin-impact/escoffier-guide-best-builds' },
      { name: 'Icy Veins — Escoffier Team Guide', url: 'https://www.icy-veins.com/genshin-impact/escoffier-team-guide' },
    ],
    role: 'Off-field Cryo support, healer and Hydro/Cryo RES shred',
    stats: {
      main: ['Sands: ATK% / Energy Recharge', 'Goblet: Cryo DMG or ATK%', 'Circlet: CRIT Rate / CRIT DMG > ATK%'],
      priority: 'Energy Recharge > CRIT Rate / CRIT DMG > ATK%',
      targets: ['HP: 19,000–21,000', 'ATK: 1,650–1,800', 'CRIT Rate: 75–85%', 'CRIT DMG: 165–190%', 'ER: 180–200%'],
    },
    weapons: ['Symphonist of Scents'],
    artifacts: ['4pc Blizzard Strayer', '4pc Golden Troupe'],
    teams: [
      ['Skirk', 'Escoffier', 'Furina', 'Yelan'],
      ['Skirk', 'Escoffier', 'Furina', 'Citlali'],
      ['Skirk', 'Escoffier', 'Furina', 'Charlotte'],
    ],
  },

  sandrone: {
    name: 'Sandrone',
    aliases: ['sandrone', 'ساندروني', 'ساندرون'],
    status: 'verified',
    sources: [{ name: 'KQM — Sandrone Quick Guide', url: 'https://keqingmains.com/q/sandrone-quickguide/' }],
    role: 'On-field Stellar-Conduct DPS',
    stats: {
      main: ['Sands: ATK%', 'Goblet: ATK%', 'Circlet: CRIT'],
      priority: '(ER until requirement) > CRIT > ATK% > EM',
      targets: ['ER: 130–165% with +1 Cryo for Burst every rotation', 'ER: 120–140% with +2 Cryo or +2 Electro for Burst every rotation'],
    },
    weapons: ['A Teaspoon of Transcendence', 'A Thousand Blazing Suns', 'Wolf’s Gravestone', 'Redhorn Stonethresher', 'Verdict'],
    artifacts: ['4pc Disenchantment in Deep Shadows', '4pc Gilded Dreams'],
    teams: [
      ['Sandrone', 'Yae Miko', 'Escoffier', 'Nicole'],
      ['Sandrone', 'Columbina', 'Ineffa', 'Yae Miko'],
      ['Sandrone', 'Kuki Shinobu', 'Charlotte', 'Sucrose'],
      ['Sandrone', 'Yae Miko', 'Qiqi', 'Escoffier'],
    ],
  },

  yaemiko: {
    name: 'Yae Miko',
    aliases: ['yae miko', 'yae', 'miko', 'ياي ميكو', 'ياي', 'ميكو'],
    status: 'verified',
    sources: [
      { name: 'KQM — Yae Miko Quick Guide', url: 'https://keqingmains.com/q/yae-quickguide/' },
      { name: 'Icy Veins — Yae Miko Team Guide', url: 'https://www.icy-veins.com/genshin-impact/yae-miko-team-guide' },
    ],
    role: 'Off-field Electro DPS',
    stats: {
      main: ['Sands: ATK% / EM', 'Goblet: Electro DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'ER (until requirement) > CRIT > ATK% >= EM',
      targets: ['With Raiden: 140–150% ER at C0', 'Off-field with Fischl: 130% ER at C0', 'Aggravate: roughly 100–300 EM before prioritizing more ATK%'],
    },
    weapons: ['Kagura’s Verity', 'The Widsith', 'Solar Pearl', 'Flowing Purity', 'Hakushin Ring'],
    artifacts: ['4pc Golden Troupe', '4pc Emblem of Severed Fate'],
    teams: [
      ['Sandrone', 'Yae Miko', 'Alyosha', 'Odette'],
      ['Sandrone', 'Yae Miko', 'Escoffier', 'Qiqi'],
      ['Raiden Shogun', 'Yae Miko', 'Bennett', 'Kaedehara Kazuha'],
      ['Yae Miko', 'Raiden Shogun', 'Yaoyao', 'Sucrose'],
    ],
  },

  furina: {
    name: 'Furina',
    aliases: ['furina', 'فورينا'],
    status: 'verified',
    sources: [{ name: 'KQM — Furina Quick Guide', url: 'https://keqingmains.com/q/furina-quickguide/' }],
    role: 'Off-field Hydro DPS + teamwide buffer',
    stats: {
      main: ['Sands: HP% or ER%', 'Goblet: HP% / Hydro DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'ER (until requirement) > CRIT DMG = CRIT Rate > HP%',
      targets: ['Solo Hydro: 200%+ ER', 'Double Hydro: 150–210% ER', 'Double Hydro with Neuvillette: 130–150% ER', 'Triple Hydro: 130–140% ER'],
    },
    weapons: ['Splendor of Tranquil Waters', 'Favonius Sword', 'Fleuve Cendre Ferryman'],
    artifacts: ['4pc Golden Troupe'],
    teams: [
      ['Furina', 'Neuvillette', 'Kaedehara Kazuha', 'Xilonen'],
      ['Furina', 'Xianyun', 'Xiao', 'Faruzan'],
      ['Furina', 'Hu Tao', 'Yelan', 'Jean'],
    ],
  },
};

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function getGuideByText(text) {
  const normalized = normalize(text);
  let best = null;
  for (const guide of Object.values(GUIDES)) {
    for (const alias of guide.aliases) {
      const n = normalize(alias);
      if (!n) continue;
      if (normalized === n || normalized.includes(n)) {
        if (!best || n.length > best.aliasLength) best = { guide, aliasLength: n.length };
      }
    }
  }
  return best?.guide || null;
}

module.exports = { GUIDES, getGuideByText, normalize };
