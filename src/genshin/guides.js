'use strict';

/**
 * Curated, source-backed recommendations only.
 * Do not add guessed values. Every numeric recommendation must have a source.
 */
const GUIDES = {
  odette: {
    name: 'Odette',
    aliases: ['odette', 'اوديت', 'أوديت'],
    status: 'provisional',
    statusNote: 'Icy Veins lists this as Version 7.0 V3 data (updated 2026-07-14). Treat as provisional until a post-release theorycrafting update is published.',
    sources: [
      { name: 'Icy Veins — Odette Build Guide', url: 'https://www.icy-veins.com/genshin-impact/odette-guide-best-builds' },
      { name: 'Icy Veins — Odette Team Guide', url: 'https://www.icy-veins.com/genshin-impact/odette-team-guide' },
    ],
    role: 'Off-field Cryo support / Stellar-Conduct & Stellar-Swirl enabler',
    stats: {
      main: ['Sands: ATK% or EM', 'Goblet: ATK% or EM', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'CRIT Rate / CRIT DMG > ATK% > Elemental Mastery > Energy Recharge',
      targets: ['HP: 17,000–20,000', 'ATK: 2,400–2,600', 'CRIT Rate: 60–75%', 'CRIT DMG: 150–175%', 'ER: 100–130%'],
      note: 'Target ranges are pre-buff screen values from the cited guide and vary with weapon/team. ER is often optional if Burst is skipped.',
    },
    weapons: [
      'Whitelake Frostfeather — listed as her top weapon in the cited 7.0 guide.',
    ],
    artifacts: [
      'Use the source-backed main stats above. Artifact set ranking is intentionally not hard-coded here until a post-release source update is available.',
    ],
    teams: [
      'Odette — Sandrone — Yae Miko — Alyosha (Stellar-Conduct)',
      'Odette — Wriothesley — Nicole — Yae Miko (Stellar-Conduct)',
      'Odette — Cyno — Yae Miko — Alyosha (Stellar-Conduct)',
      'Odette — Sandrone — Cryo Traveler — Sucrose (Stellar-Swirl)',
      'Odette — Sandrone — Qiqi — Sucrose (Stellar-Swirl)',
    ],
    talentPriority: 'Elemental Skill > Elemental Burst >>> Normal Attack',
  },

  sandrone: {
    name: 'Sandrone',
    aliases: ['sandrone', 'ساندروني', 'ساندرون'],
    status: 'verified',
    statusNote: 'KQM Quick Guide updated for Version 6.7 / Luna VIII.',
    sources: [
      { name: 'KQM — Sandrone Quick Guide', url: 'https://keqingmains.com/q/sandrone-quickguide/' },
    ],
    role: 'On-field Stellar-Conduct DPS',
    stats: {
      main: ['Sands: ATK%', 'Goblet: ATK%', 'Circlet: CRIT'],
      priority: '(ER until requirement) > CRIT > ATK% > EM',
      targets: ['ER: 130–165% with +1 Cryo for Burst every rotation', 'ER: 120–140% with +2 Cryo or +2 Electro for Burst every rotation'],
      note: 'KQM notes that if ER needs exceed ~140%, forcing ER can be a DPS loss; Burst can instead be used when available.',
    },
    weapons: [
      'A Teaspoon of Transcendence — KQM BiS',
      'A Thousand Blazing Suns — KQM second-best listed option',
      'Other competitive 5★ options include Wolf’s Gravestone, Redhorn Stonethresher, Verdict, Beacon of the Reed Sea, and The Unforged.',
    ],
    artifacts: [
      '4pc Disenchantment in Deep Shadows — KQM best set for on-field Stellar-Conduct Sandrone',
      '4pc Gilded Dreams — strong backup',
      '2pc ATK% / EM mixes — fallback when 4pc sets are weak',
    ],
    teams: [
      'Sandrone — Yae Miko — Qiqi — Escoffier / Nicole / C6 Beidou / C6 Diona',
      'Sandrone — Yae Miko — Escoffier — Nicole',
      'Sandrone — C6 Beidou — C6 Diona — Sucrose / Xilonen',
      'Sandrone — Columbina — Ineffa — Yae Miko',
      'Limited roster: Sandrone — Kuki Shinobu — Charlotte / Diona — Sucrose',
    ],
    talentPriority: 'Normal Attack > Burst > Skill',
  },

  yaemiko: {
    name: 'Yae Miko',
    aliases: ['yae miko', 'yae', 'miko', 'ياي ميكو', 'ياي', 'ميكو'],
    status: 'verified',
    statusNote: 'KQM Quick Guide; Stellar-Conduct team context is also covered by current Icy Veins team data.',
    sources: [
      { name: 'KQM — Yae Miko Quick Guide', url: 'https://keqingmains.com/q/yae-quickguide/' },
      { name: 'Icy Veins — Yae Miko Team Guide', url: 'https://www.icy-veins.com/genshin-impact/yae-miko-team-guide' },
    ],
    role: 'Off-field Electro DPS / Stellar-Conduct support',
    stats: {
      main: ['Sands: ATK% / EM', 'Goblet: Electro DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'ER (until requirement) > CRIT > ATK% >= EM',
      targets: ['With Raiden: ~140–150% ER at C0', 'Off-field with Fischl: ~130% ER at C0', 'Aggravate: roughly 100–300 EM before prioritizing more ATK%'],
      note: 'EM is mainly valuable in Aggravate/Hyperbloom contexts. Stellar-Conduct usage may prioritize different team goals and often skips Burst.',
    },
    weapons: [
      'Weapon ranking depends on team. KQM lists The Widsith, Solar Pearl, Flowing Purity, Hakushin Ring, and Mappa Mare among viable 4★ options in appropriate teams.',
    ],
    artifacts: [
      '4pc Golden Troupe — especially strong for Skill-focused / Aggravate use',
      '4pc Emblem of Severed Fate — strong at C0 in non-Aggravate teams when Bursting consistently',
    ],
    teams: [
      'Sandrone — Yae Miko — Alyosha — Odette (Stellar-Conduct)',
      'Sandrone — Yae Miko — Escoffier — Qiqi (Stellar-Conduct)',
      'Yae Miko — Raiden — Kazuha — Bennett',
      'Yae Miko — Raiden — Yaoyao — Sucrose (Aggravate)',
    ],
    talentPriority: 'Skill >= Burst > Normal Attack',
  },

  furina: {
    name: 'Furina',
    aliases: ['furina', 'فورينا'],
    status: 'verified',
    statusNote: 'KQM Quick Guide updated for Luna II.',
    sources: [
      { name: 'KQM — Furina Quick Guide', url: 'https://keqingmains.com/q/furina-quickguide/' },
    ],
    role: 'Off-field Hydro DPS + teamwide buffer',
    stats: {
      main: ['Sands: HP% or ER%', 'Goblet: HP% (generally) / Hydro DMG Bonus', 'Circlet: CRIT Rate / CRIT DMG'],
      priority: 'ER (until requirement) > CRIT DMG = CRIT Rate > HP%',
      targets: ['Solo Hydro: 200%+ ER', 'Double Hydro: ~150–210% depending on teammate Skill usage', 'Double Hydro with Neuvillette: ~130–150% ER', 'Triple Hydro: ~130–140% ER'],
      note: 'Each Favonius proc can substantially reduce ER needs. Exact ER depends on rotation and particles.',
    },
    weapons: [
      'Weapon choice depends on ER and team; the bot avoids inventing a universal ranking when the cited excerpt does not establish one.',
    ],
    artifacts: [
      '4pc Golden Troupe — KQM’s clear recommendation for Furina personal damage.',
    ],
    teams: [
      'Furina — Healer — Flex — Flex (general shell)',
      'Furina — Xianyun — Xiao — Faruzan',
      'Furina — Hu Tao — Yelan — Xilonen / Xianyun / Jean',
    ],
    talentPriority: 'Burst >= Skill; Level 90 strongly recommended',
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
