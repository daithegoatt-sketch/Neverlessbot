'use strict';

const { guideProfile } = require('./statProfile');

const MAX_ROLLS = {
  5: {
    flatHp: 298.75,
    hpPercent: 5.83,
    flatAtk: 19.45,
    atkPercent: 5.83,
    flatDef: 23.15,
    defPercent: 7.29,
    em: 23.31,
    er: 6.48,
    critRate: 3.89,
    critDmg: 7.77,
  },
  4: {
    flatHp: 239.0,
    hpPercent: 4.66,
    flatAtk: 15.56,
    atkPercent: 4.66,
    flatDef: 18.52,
    defPercent: 5.83,
    em: 18.65,
    er: 5.18,
    critRate: 3.11,
    critDmg: 6.22,
  },
};

const SLOT_LABELS = {
  flower: 'Flower',
  plume: 'Plume',
  sands: 'Sands',
  goblet: 'Goblet',
  circlet: 'Circlet',
};

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9%]+/g, '');
}

function rollKeyFromFightProp(fightProp) {
  const prop = String(fightProp || '').toUpperCase();
  const map = {
    FIGHT_PROP_HP: 'flatHp',
    FIGHT_PROP_HP_PERCENT: 'hpPercent',
    FIGHT_PROP_ATTACK: 'flatAtk',
    FIGHT_PROP_ATTACK_PERCENT: 'atkPercent',
    FIGHT_PROP_DEFENSE: 'flatDef',
    FIGHT_PROP_DEFENSE_PERCENT: 'defPercent',
    FIGHT_PROP_ELEMENT_MASTERY: 'em',
    FIGHT_PROP_CHARGE_EFFICIENCY: 'er',
    FIGHT_PROP_CRITICAL: 'critRate',
    FIGHT_PROP_CRITICAL_HURT: 'critDmg',
  };
  return map[prop] || null;
}

function rollKeyFromName(name, isPercent = false) {
  const text = String(name || '');
  if (/crit\s*rate/i.test(text)) return 'critRate';
  if (/crit\s*(?:dmg|damage)/i.test(text)) return 'critDmg';
  if (/energy\s*recharge|\ber\b/i.test(text)) return 'er';
  if (/elemental\s*mastery|\bem\b/i.test(text)) return 'em';
  if (/\bhp\b/i.test(text)) return isPercent ? 'hpPercent' : 'flatHp';
  if (/\batk\b|attack/i.test(text)) return isPercent ? 'atkPercent' : 'flatAtk';
  if (/\bdef\b|defense/i.test(text)) return isPercent ? 'defPercent' : 'flatDef';
  return null;
}

function rollKey(roll) {
  return rollKeyFromFightProp(roll?.fightProp) || rollKeyFromName(roll?.name, Boolean(roll?.isPercent));
}

function maxRollFor(roll, rarity = 5) {
  const table = MAX_ROLLS[Number(rarity)] || MAX_ROLLS[5];
  return table[rollKey(roll)] || null;
}

function rollValue(roll, rarity = 5) {
  const value = Number(roll?.numericValue);
  const max = maxRollFor(roll, rarity);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(110, (value / max) * 100));
}

function usefulRollKeys(guide) {
  const profile = guideProfile(guide);
  const useful = new Set(['critRate', 'critDmg']);
  for (const key of [...profile.priority, ...profile.ordered]) {
    if (key === 'atk') { useful.add('atkPercent'); useful.add('flatAtk'); }
    else if (key === 'hp') { useful.add('hpPercent'); useful.add('flatHp'); }
    else if (key === 'def') { useful.add('defPercent'); useful.add('flatDef'); }
    else if (key === 'er') useful.add('er');
    else if (key === 'em') useful.add('em');
    else if (key === 'critRate') useful.add('critRate');
    else if (key === 'critDmg') useful.add('critDmg');
  }
  return useful;
}

function actualMainTokens(artifact) {
  const prop = String(artifact?.mainStatKey || '').toUpperCase();
  const tokens = [normalize(artifact?.mainStat)];
  const map = {
    FIGHT_PROP_HP: ['hp'],
    FIGHT_PROP_HP_PERCENT: ['hp%', 'hppercent'],
    FIGHT_PROP_ATTACK: ['atk', 'attack'],
    FIGHT_PROP_ATTACK_PERCENT: ['atk%', 'atkpercent', 'attack%'],
    FIGHT_PROP_DEFENSE: ['def', 'defense'],
    FIGHT_PROP_DEFENSE_PERCENT: ['def%', 'defpercent', 'defense%'],
    FIGHT_PROP_ELEMENT_MASTERY: ['elementalmastery', 'em'],
    FIGHT_PROP_CHARGE_EFFICIENCY: ['energyrecharge', 'er'],
    FIGHT_PROP_CRITICAL: ['critrate'],
    FIGHT_PROP_CRITICAL_HURT: ['critdmg', 'critdamage'],
    FIGHT_PROP_FIRE_ADD_HURT: ['pyrodmgbonus', 'pyrodmg'],
    FIGHT_PROP_ICE_ADD_HURT: ['cryodmgbonus', 'cryodmg'],
    FIGHT_PROP_WATER_ADD_HURT: ['hydrodmgbonus', 'hydrodmg'],
    FIGHT_PROP_ELEC_ADD_HURT: ['electrodmgbonus', 'electrodmg'],
    FIGHT_PROP_WIND_ADD_HURT: ['anemodmgbonus', 'anemodmg'],
    FIGHT_PROP_ROCK_ADD_HURT: ['geodmgbonus', 'geodmg'],
    FIGHT_PROP_GRASS_ADD_HURT: ['dendrodmgbonus', 'dendrodmg'],
    FIGHT_PROP_PHYSICAL_ADD_HURT: ['physicaldmgbonus', 'physicaldmg'],
    FIGHT_PROP_HEAL_ADD: ['healingbonus', 'healing'],
  };
  for (const value of map[prop] || []) tokens.push(normalize(value));
  return [...new Set(tokens.filter(Boolean))];
}

function mainStatOptions(guide, slot) {
  const line = (guide?.stats?.main || []).find((item) => String(item).toLowerCase().trim().startsWith(`${String(slot).toLowerCase()}:`));
  if (!line) return [];
  const body = String(line).split(':').slice(1).join(':').trim();
  return body.split(/\/|>|\bor\b/gi).map((item) => item.trim()).filter(Boolean);
}

function mainStatMatches(artifact, guide) {
  if (!artifact || !['sands', 'goblet', 'circlet'].includes(artifact.slot)) return true;
  const options = mainStatOptions(guide, artifact.slot);
  if (!options.length) return true;
  const actual = actualMainTokens(artifact);
  return options.some((option) => {
    const expected = normalize(option);
    return expected && actual.some((token) => token === expected || token.includes(expected) || expected.includes(token));
  });
}

function rvGrade(usefulRv, mainMatch = true, level = 20, lang = 'en') {
  const ar = lang === 'ar';
  if (!mainMatch) return ar ? 'Main Stat غير مناسب' : 'Wrong main stat';
  if (Number(level) < 20) return ar ? 'غير مكتمل' : 'Not +20';
  if (usefulRv >= 650) return ar ? 'ممتاز جدًا' : 'Excellent';
  if (usefulRv >= 550) return ar ? 'ممتاز' : 'Very Good';
  if (usefulRv >= 450) return ar ? 'جيد' : 'Good';
  if (usefulRv >= 330) return ar ? 'متوسط' : 'Average';
  return ar ? 'يحتاج تبديل' : 'Replaceable';
}

function reviewArtifact(artifact, guide) {
  const rolls = Array.isArray(artifact?.rolls) && artifact.rolls.length ? artifact.rolls : [];
  const useful = usefulRollKeys(guide);
  let totalRv = 0;
  let usefulRv = 0;
  const usefulParts = new Map();

  for (const roll of rolls) {
    const rv = rollValue(roll, artifact?.rarity || 5);
    const key = rollKey(roll);
    totalRv += rv;
    if (key && useful.has(key)) {
      usefulRv += rv;
      usefulParts.set(key, (usefulParts.get(key) || 0) + rv);
    }
  }

  // Older stored snapshots do not have split rolls. Estimate from total substats so
  // comparisons remain usable, but live Showcase reads use the exact split-roll path.
  if (!rolls.length) {
    for (const sub of artifact?.substats || []) {
      const key = rollKey(sub);
      const max = maxRollFor(sub, artifact?.rarity || 5);
      const value = Number(sub?.numericValue);
      if (!key || !Number.isFinite(max) || !Number.isFinite(value)) continue;
      const rv = Math.max(0, (value / max) * 100);
      totalRv += rv;
      if (useful.has(key)) {
        usefulRv += rv;
        usefulParts.set(key, (usefulParts.get(key) || 0) + rv);
      }
    }
  }

  const mainOptions = mainStatOptions(guide, artifact?.slot);
  const mainMatch = mainStatMatches(artifact, guide);
  const usefulKeys = [...usefulParts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const level = Number.isFinite(artifact?.level) ? artifact.level : 0;
  const priorityScore = (mainMatch ? 0 : 1000) + Math.max(0, 650 - usefulRv) + Math.max(0, 20 - level) * 18;

  return {
    slot: artifact?.slot || 'unknown',
    slotLabel: SLOT_LABELS[artifact?.slot] || artifact?.slot || 'Artifact',
    set: artifact?.set || null,
    level,
    rarity: artifact?.rarity || null,
    mainStat: artifact?.mainStat || 'Unknown',
    mainValue: artifact?.mainValue || '',
    mainMatch,
    mainOptions,
    totalRolls: Number.isFinite(artifact?.totalRolls) ? artifact.totalRolls : rolls.length,
    totalRv: Math.round(totalRv),
    usefulRv: Math.round(usefulRv),
    usefulKeys,
    priorityScore,
  };
}

function reviewArtifacts(snapshot, guide) {
  const pieces = (snapshot?.artifacts || []).map((artifact) => reviewArtifact(artifact, guide));
  const prioritized = [...pieces].sort((a, b) => b.priorityScore - a.priorityScore || a.usefulRv - b.usefulRv);
  const averageUsefulRv = pieces.length ? Math.round(pieces.reduce((sum, row) => sum + row.usefulRv, 0) / pieces.length) : 0;
  const averageRv = pieces.length ? Math.round(pieces.reduce((sum, row) => sum + row.totalRv, 0) / pieces.length) : 0;
  return { pieces, prioritized, averageUsefulRv, averageRv };
}

function formatKey(key) {
  const labels = {
    critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM',
    atkPercent: 'ATK%', flatAtk: 'ATK', hpPercent: 'HP%', flatHp: 'HP', defPercent: 'DEF%', flatDef: 'DEF',
  };
  return labels[key] || key;
}

function mainStatAdvice(row, lang) {
  if (row.mainMatch || !row.mainOptions.length) return null;
  const ar = lang === 'ar';
  const wanted = row.mainOptions.join(' / ');
  return ar
    ? `${row.slotLabel}: الـMain Stat الحالي **${row.mainStat}${row.mainValue ? ` ${row.mainValue}` : ''}**؛ الأفضل حسب البيلد **${wanted}**.`
    : `${row.slotLabel}: current main stat is **${row.mainStat}${row.mainValue ? ` ${row.mainValue}` : ''}**; recommended: **${wanted}**.`;
}

function formatArtifactReview(snapshot, guide, lang = 'ar') {
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const lines = [`**${snapshot.name} — ${ar ? 'تقييم الآرتيفاكتات' : 'Artifact Review'}**`];

  for (const row of report.pieces) {
    const grade = rvGrade(row.usefulRv, row.mainMatch, row.level, lang);
    const useful = row.usefulKeys.slice(0, 3).map(formatKey).join(' / ');
    lines.push(`• **${row.slotLabel} +${row.level}** — RV **${row.totalRv}%** • Useful RV **${row.usefulRv}%** • ${grade}`);
    if (useful) lines.push(`  ${ar ? 'أفضل الرولات' : 'Useful rolls'}: ${useful}`);
    const mainAdvice = mainStatAdvice(row, lang);
    if (mainAdvice) lines.push(`  ⚠ ${mainAdvice}`);
  }

  const priorities = report.prioritized.filter((row) => !row.mainMatch || row.level < 20 || row.usefulRv < 550).slice(0, 3);
  if (priorities.length) {
    lines.push(`\n**${ar ? 'أولوية التطوير' : 'Upgrade priority'}:**`);
    priorities.forEach((row, index) => {
      const reason = !row.mainMatch
        ? (ar ? `بدّل الـMain Stat إلى ${row.mainOptions.join(' / ')}` : `change main stat to ${row.mainOptions.join(' / ')}`)
        : row.level < 20
          ? (ar ? `ارفعها إلى +20 أولًا` : 'level it to +20 first')
          : (ar ? `Useful RV منخفض (${row.usefulRv}%)؛ ابحث عن رولات أفضل في الستات المهمة` : `low Useful RV (${row.usefulRv}%); look for better relevant rolls`);
      lines.push(`${index + 1}. **${row.slotLabel}** — ${reason}`);
    });
  } else {
    lines.push(`\n${ar ? 'القطع الحالية قوية من ناحية Main Stats وRV؛ التحسين القادم بيكون Min-Max على القطع الأقل Useful RV.' : 'Your current pieces are strong on main stats and RV; further gains are mostly min-maxing the lowest Useful RV pieces.'}`);
  }

  lines.push(ar
    ? '\n*RV محسوب من الرولات الفعلية اللي Enka يعرضها، وUseful RV يحسب الرولات المفيدة لبيلد الشخصية حسب الـGuide.*'
    : '\n*RV uses the individual rolls exposed by Enka; Useful RV counts rolls relevant to this character guide.*');
  return lines.join('\n');
}

function akashaImprovementAdvice(snapshot, guide, evaluation, akashaRanking, lang = 'ar') {
  const topPercent = Number(akashaRanking?.topPercent ?? akashaRanking);
  if (!Number.isFinite(topPercent)) return null;
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const targetProblems = (evaluation?.relevantStats || []).filter((row) => row.status === 'down');
  const mainProblems = report.pieces.filter((row) => !row.mainMatch);
  const weakest = report.prioritized.filter((row) => row.level >= 20).slice(0, 2);
  const category = akashaRanking?.category ? ` (${akashaRanking.category})` : '';
  const lines = [];

  if (targetProblems.length || mainProblems.length) {
    const missing = targetProblems.slice(0, 3).map((row) => row.label);
    if (mainProblems.length) missing.push(...mainProblems.slice(0, 2).map((row) => `${row.slotLabel} Main Stat`));
    lines.push(ar
      ? `**لرفع Akasha${category}:** قبل الـmin-max ركز على ${missing.join(' / ')}؛ هذي أكبر مساحة تحسين واضحة حاليًا.`
      : `**To improve Akasha${category}:** before min-maxing, fix ${missing.join(' / ')}; these are the clearest current gaps.`);
  } else if (topPercent > 1) {
    const weakText = weakest.map((row) => `${row.slotLabel} Useful RV ${row.usefulRv}%`).join(' • ');
    lines.push(ar
      ? `**لرفع Akasha${category}:** أنت محقق التارقت الأساسي. التحسين الآن يكون برفع جودة الرولات بدون ما تنزل عن التارقت؛ ${weakText || 'ركز على أضعف قطعتين بالـUseful RV'}.`
      : `**To improve Akasha${category}:** your core targets are met. The next gains come from stronger rolls without dropping below targets; ${weakText || 'focus on the two lowest Useful RV pieces'}.`);
  } else {
    lines.push(ar
      ? `**Akasha:** أنت داخل Top ${topPercent}%؛ أي تقدم إضافي غالبًا يحتاج Min-Max قوي جدًا في RV والـcrit/الستات الأساسية مع الحفاظ على التارقت.`
      : `**Akasha:** you are already Top ${topPercent}%; further gains usually require heavy RV/stat min-maxing while preserving target thresholds.`);
  }

  return lines.join('\n');
}

module.exports = {
  rollKey,
  rollValue,
  mainStatOptions,
  mainStatMatches,
  reviewArtifact,
  reviewArtifacts,
  formatArtifactReview,
  akashaImprovementAdvice,
};
