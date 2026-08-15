'use strict';

/**
 * Verified fallbacks. Runtime guide data is fetched from Game8 first.
 * Keep only values we can trace to a published guide; never invent missing numbers.
 */
const GUIDES = {
  skirk: {
    name: 'Skirk',
    aliases: ['skirk', 'سكيرك'],
    role: 'On-field Cryo Freeze DPS',
    stats: {
      main: ['Sands: ATK%', 'Goblet: Cryo DMG Bonus', 'Circlet: CRIT DMG or CRIT Rate'],
      priority: 'ATK% > CRIT Rate > CRIT DMG',
      targets: ['ATK: 2,100 or above', 'CRIT Rate: 70-80%', 'CRIT DMG: 200% or above'],
    },
    weapons: ['Azurelight', 'Haran Geppaku Futsu', 'Mistsplitter Reforged', 'Primordial Jade Cutter', 'Finale of the Deep', 'Calamity of Eshu'],
    f2pWeapons: ['Finale of the Deep', 'Calamity of Eshu', 'Harbinger of Dawn'],
    artifacts: ['4pc Finale of the Deep Galleries', '4pc Marechaussee Hunter', "4pc Gladiator's Finale"],
    teams: {
      premium: [
        ['Skirk', 'Furina', 'Yelan', 'Escoffier'],
        ['Skirk', 'Furina', 'Shenhe', 'Escoffier'],
        ['Skirk', 'Xingqiu', 'Yelan', 'Citlali'],
      ],
      f2p: [
        ['Skirk', 'Xingqiu', 'Rosaria', 'Dahlia'],
        ['Skirk', 'Xingqiu', 'Kaeya', 'Barbara'],
      ],
    },
  },

  durin: {
    name: 'Durin',
    aliases: ['durin', 'دورين', 'ديورين'],
    role: 'Off-field Pyro Sub-DPS / Hexerei support',
    stats: {
      main: ['Sands: ATK%', 'Goblet: Pyro DMG or ATK%', 'Circlet: CRIT DMG or CRIT Rate'],
      priority: 'ATK% > CRIT Rate / CRIT DMG; EM when reaction damage matters',
      targets: ['ATK: 2,000 or above', 'CRIT Rate: 60-70%', 'CRIT DMG: 200% or above'],
    },
    weapons: ['Athame Artis', 'Freedom-Sworn', 'Wolf-Fang', 'Absolution', 'Primordial Jade Cutter', 'Azurelight', "Lion's Roar", 'Amenoma Kageuchi', 'Harbinger of Dawn'],
    f2pWeapons: ['Amenoma Kageuchi', 'Harbinger of Dawn'],
    artifacts: ['4pc A Day Carved from Rising Winds', '4pc Noblesse Oblige', '4pc Emblem of Severed Fate'],
    teams: {
      premium: [
        ['Durin', 'Arlecchino', 'Fischl', 'Chevreuse'],
        ['Durin', 'Chasca', 'Fischl', 'Furina'],
        ['Durin', 'Venti', 'Bennett', 'Furina'],
        ['Durin', 'Hu Tao', 'Mona', 'Xingqiu'],
        ['Durin', 'Mavuika', 'Citlali', 'Xilonen'],
      ],
      f2p: [
        ['Durin', 'Xingqiu', 'Bennett', 'Sucrose'],
        ['Durin', 'Bennett', 'Xiangling', 'Xingqiu'],
      ],
    },
  },

  escoffier: {
    name: 'Escoffier',
    aliases: ['escoffier', 'اسكوفيه', 'اسكوفر', 'إسكوفيه', 'ايسكوفيه'],
    role: 'Off-field Cryo support, healer and Hydro/Cryo RES shred',
    stats: {
      main: ['Sands: ATK% / Energy Recharge', 'Goblet: Cryo DMG or ATK%', 'Circlet: CRIT Rate / CRIT DMG or ATK%'],
      priority: 'Energy Recharge > CRIT Rate / CRIT DMG > ATK%',
      targets: ['ATK: 1,650-1,800', 'CRIT Rate: 75-85%', 'CRIT DMG: 165-190%', 'ER: 180-200%'],
    },
    weapons: ['Symphonist of Scents', 'Favonius Lance'],
    f2pWeapons: ['Favonius Lance'],
    artifacts: ['4pc Blizzard Strayer', '4pc Golden Troupe'],
    teams: {
      premium: [
        ['Skirk', 'Escoffier', 'Furina', 'Yelan'],
        ['Skirk', 'Escoffier', 'Furina', 'Shenhe'],
      ],
      f2p: [],
    },
  },

  odette: {
    name: 'Odette',
    aliases: ['odette', 'اوديت', 'أوديت'],
    role: 'Off-field Cryo support / Stellar reaction enabler',
    stats: {
      main: ['Sands: ATK% or EM', 'Goblet: ATK% or EM', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'CRIT Rate / CRIT DMG > ATK% > Elemental Mastery > Energy Recharge',
      targets: ['HP: 17,000-20,000', 'ATK: 2,400-2,600', 'CRIT Rate: 60-75%', 'CRIT DMG: 150-175%', 'ER: 100-130%'],
    },
    weapons: ['Whitelake Frostfeather'],
    f2pWeapons: [],
    artifacts: ['4pc Disenchantment in Deep Shadow', '4pc Heart of the Furnace', '4pc Tenacity of the Millelith'],
    teams: {
      premium: [
        ['Odette', 'Sandrone', 'Yae Miko', 'Alyosha'],
        ['Odette', 'Wriothesley', 'Nicole', 'Yae Miko'],
      ],
      f2p: [['Odette', 'Sandrone', 'Qiqi', 'Sucrose']],
    },
  },

  sandrone: {
    name: 'Sandrone',
    aliases: ['sandrone', 'ساندروني', 'ساندرون'],
    role: 'On-field Stellar-Conduct DPS',
    stats: {
      main: ['Sands: ATK%', 'Goblet: ATK%', 'Circlet: CRIT'],
      priority: '(ER until requirement) > CRIT > ATK% > EM',
      targets: [],
    },
    weapons: ['A Teaspoon of Transcendence', 'A Thousand Blazing Suns', "Wolf's Gravestone", 'Redhorn Stonethresher', 'Verdict'],
    f2pWeapons: [],
    artifacts: ['4pc Disenchantment in Deep Shadows', '4pc Gilded Dreams'],
    teams: {
      premium: [
        ['Sandrone', 'Yae Miko', 'Escoffier', 'Nicole'],
        ['Sandrone', 'Columbina', 'Ineffa', 'Yae Miko'],
      ],
      f2p: [['Sandrone', 'Kuki Shinobu', 'Charlotte', 'Sucrose']],
    },
  },

  yaemiko: {
    name: 'Yae Miko',
    aliases: ['yae miko', 'yae', 'miko', 'ياي ميكو', 'ياي', 'ميكو'],
    role: 'Off-field Electro DPS',
    stats: {
      main: ['Sands: ATK% / EM', 'Goblet: Electro DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'ER (until requirement) > CRIT > ATK% >= EM',
      targets: [],
    },
    weapons: ["Kagura's Verity", 'The Widsith', 'Solar Pearl', 'Flowing Purity', 'Hakushin Ring'],
    f2pWeapons: ['Flowing Purity', 'Hakushin Ring', 'Mappa Mare'],
    artifacts: ['4pc Golden Troupe', '4pc Emblem of Severed Fate'],
    teams: {
      premium: [
        ['Raiden Shogun', 'Yae Miko', 'Bennett', 'Kaedehara Kazuha'],
        ['Sandrone', 'Yae Miko', 'Escoffier', 'Qiqi'],
      ],
      f2p: [['Yae Miko', 'Fischl', 'Yaoyao', 'Sucrose']],
    },
  },

  furina: {
    name: 'Furina',
    aliases: ['furina', 'فورينا'],
    role: 'Off-field Hydro DPS + teamwide buffer',
    stats: {
      main: ['Sands: HP% or ER%', 'Goblet: HP% / Hydro DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'ER (until requirement) > CRIT DMG = CRIT Rate > HP%',
      targets: ['Solo Hydro: 200%+ ER', 'Double Hydro: 150-210% ER', 'Double Hydro with Neuvillette: 130-150% ER', 'Triple Hydro: 130-140% ER'],
    },
    weapons: ['Splendor of Tranquil Waters', 'Favonius Sword', 'Fleuve Cendre Ferryman'],
    f2pWeapons: ['Fleuve Cendre Ferryman'],
    artifacts: ['4pc Golden Troupe'],
    teams: {
      premium: [
        ['Furina', 'Neuvillette', 'Kaedehara Kazuha', 'Xilonen'],
        ['Furina', 'Xianyun', 'Xiao', 'Faruzan'],
        ['Furina', 'Hu Tao', 'Yelan', 'Jean'],
      ],
      f2p: [],
    },
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
