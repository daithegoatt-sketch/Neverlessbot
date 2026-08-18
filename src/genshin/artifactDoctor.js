'use strict';

const { reviewArtifacts } = require('./artifactEvaluator');
const { guideProfile, formatStat } = require('./statProfile');

const LRI = '\u2066';
const PDI = '\u2069';

function ltr(value) {
  return `${LRI}${String(value)}${PDI}`;
}

const PROP_KEYS = {
  FIGHT_PROP_CRITICAL: 'critRate',
  FIGHT_PROP_CRITICAL_HURT: 'critDmg',
  FIGHT_PROP_CHARGE_EFFICIENCY: 'er',
  FIGHT_PROP_ELEMENT_MASTERY: 'em',
  FIGHT_PROP_ATTACK_PERCENT: 'atkPercent',
  FIGHT_PROP_ATTACK: 'flatAtk',
  FIGHT_PROP_HP_PERCENT: 'hpPercent',
  FIGHT_PROP_HP: 'flatHp',
  FIGHT_PROP_DEFENSE_PERCENT: 'defPercent',
  FIGHT_PROP_DEFENSE: 'flatDef',
};

const ACCOUNT_TO_SUB = {
  critRate: 'critRate', critDmg: 'critDmg', er: 'er', em: 'em',
  atk: 'atkPercent', hp: 'hpPercent', def: 'defPercent',
};

const MAX_FIVE_ROLL = {
  critRate: 19.5,
  critDmg: 38.9,
  er: 32.4,
  em: 116.6,
  atkPercent: 29.2,
  hpPercent: 29.2,
  defPercent: 36.5,
};

const LABELS = {
  critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM',
  atk: 'ATK', hp: 'HP', def: 'DEF', atkPercent: 'ATK%', hpPercent: 'HP%', defPercent: 'DEF%',
  flatAtk: 'ATK', flatHp: 'HP', flatDef: 'DEF',
};

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function cleanStatName(name) {
  const text = String(name || '');
  if (/crit\s*rate/i.test(text)) return 'CRIT Rate';
  if (/crit\s*(?:dmg|damage)/i.test(text)) return 'CRIT DMG';
  if (/energy\s*recharge/i.test(text)) return 'ER';
  if (/elemental\s*mastery/i.test(text)) return 'EM';
  if (/attack|atk/i.test(text)) return /%/.test(text) ? 'ATK%' : 'ATK';
  if (/health|hp/i.test(text)) return /%/.test(text) ? 'HP%' : 'HP';
  if (/defense|def/i.test(text)) return /%/.test(text) ? 'DEF%' : 'DEF';
  return text.replace(/^FIGHT_PROP_/i, '').replace(/_/g, ' ');
}

function statKey(row) {
  const prop = String(row?.fightProp || '').toUpperCase();
  if (PROP_KEYS[prop]) return PROP_KEYS[prop];
  const name = String(row?.name || '');
  if (/crit\s*rate/i.test(name)) return 'critRate';
  if (/crit\s*(?:dmg|damage)/i.test(name)) return 'critDmg';
  if (/energy\s*recharge|\ber\b/i.test(name)) return 'er';
  if (/elemental\s*mastery|\bem\b/i.test(name)) return 'em';
  if (/attack|atk/i.test(name)) return row?.isPercent || /%/.test(row?.value || '') ? 'atkPercent' : 'flatAtk';
  if (/health|hp/i.test(name)) return row?.isPercent || /%/.test(row?.value || '') ? 'hpPercent' : 'flatHp';
  if (/defense|def/i.test(name)) return row?.isPercent || /%/.test(row?.value || '') ? 'defPercent' : 'flatDef';
  return null;
}

function numericSubstat(row) {
  const value = Number(row?.numericValue);
  if (Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(String(row?.value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function substatValue(artifact, key) {
  return (artifact?.substats || []).reduce((sum, row) => statKey(row) === key ? sum + numericSubstat(row) : sum, 0);
}

function mainBlocksSubstat(artifact, key) {
  const main = String(artifact?.mainStatKey || '').toUpperCase();
  const map = {
    critRate: 'FIGHT_PROP_CRITICAL', critDmg: 'FIGHT_PROP_CRITICAL_HURT', er: 'FIGHT_PROP_CHARGE_EFFICIENCY',
    em: 'FIGHT_PROP_ELEMENT_MASTERY', atkPercent: 'FIGHT_PROP_ATTACK_PERCENT', hpPercent: 'FIGHT_PROP_HP_PERCENT',
    defPercent: 'FIGHT_PROP_DEFENSE_PERCENT',
  };
  return Boolean(map[key] && main === map[key]);
}

function recommendedSet(guide) {
  return (guide?.artifacts || []).map((item) => String(item || '').trim()).filter(Boolean)[0] || null;
}

function setNeedsChange(snapshot, guide) {
  const candidates = (guide?.artifacts || []).map(normalize).filter(Boolean);
  if (!candidates.length) return null;
  const current = Object.entries(snapshot?.setCounts || {}).sort((a, b) => b[1] - a[1])[0];
  if (!current || current[1] < 2) return null;
  const currentKey = normalize(current[0]);
  const matched = candidates.some((candidate) => candidate.includes(currentKey) || currentKey.includes(candidate));
  if (matched) return null;
  return { current: current[0], recommended: recommendedSet(guide) };
}

function formatSubstats(artifact, lang) {
  const ar = lang === 'ar';
  const rows = artifact?.substats || [];
  if (!rows.length) return ar ? 'ما قدرت أقرأ السب ستات.' : 'Substats unavailable.';
  return rows.map((row) => {
    const label = cleanStatName(row.name || row.fightProp);
    const value = row.value || row.numericValue || '?';
    return ar ? `• ${ltr(`${label}: ${value}`)}` : `• ${label}: ${value}`;
  }).join('\n');
}

function explicitTarget(text, aliases) {
  const body = String(text || '');
  const group = `(?:${aliases.join('|')})`;
  const preferred = new RegExp(`${group}.{0,28}?(?:إلى|الى|لـ|ل|to|target|هدف)\\s*(\\d+(?:\\.\\d+)?)`, 'iu');
  const match = body.match(preferred);
  return match ? Number(match[1]) : null;
}

function parseRequestedTargets(text) {
  const rows = [
    ['critRate', ['كريت\\s*(?:ريت|rate)', 'crit(?:ical)?\\s*rate']],
    ['critDmg', ['كريت\\s*(?:دمج|دmg)', 'crit(?:ical)?\\s*(?:dmg|damage)']],
    ['er', ['\\bER\\b', 'energy\\s*recharge', 'انرجي\\s*ريشارج']],
    ['em', ['\\bEM\\b', 'elemental\\s*mastery', 'المنتل\\s*ماستري']],
    ['atk', ['اتاك', '\\bATK\\b', 'attack']],
    ['hp', ['\\bHP\\b', 'health']],
    ['def', ['\\bDEF\\b', 'defense']],
  ];
  const out = [];
  for (const [key, aliases] of rows) {
    const value = explicitTarget(text, aliases);
    if (Number.isFinite(value) && value > 0) out.push({ key, target: value, explicit: true });
  }
  return out;
}

function defaultGoals(snapshot, guide, evaluation) {
  const profile = guideProfile(guide);
  const rows = evaluation?.relevantStats || [];
  const hard = rows.filter((row) => row.status === 'down' && Number.isFinite(row.value) && row.target)
    .map((row) => ({ key: row.key, target: Number(row.target.min), explicit: false, hard: true }));
  if (hard.length) return hard;

  const soft = [];
  for (const key of [...profile.priority, ...profile.ordered]) {
    const target = profile.targetMap[key];
    const current = Number(snapshot?.stats?.[key]);
    if (!target || !Number.isFinite(current)) continue;
    if (Number(target.max) > Number(target.min) && current < Number(target.max)) {
      soft.push({ key, target: Number(target.max), explicit: false, hard: false });
    }
  }
  return soft;
}

function preservationKeys(guide, targetKey) {
  const profile = guideProfile(guide);
  const keys = [...profile.priority, ...profile.ordered, 'critRate', 'critDmg'];
  const mapped = [];
  for (const key of keys) {
    if (key === targetKey) continue;
    const sub = ACCOUNT_TO_SUB[key];
    if (sub && !mapped.includes(sub)) mapped.push(sub);
  }
  return mapped.slice(0, 4);
}

function fmtSub(key, value) {
  if (!Number.isFinite(value)) return '?';
  if (['critRate', 'critDmg', 'er', 'atkPercent', 'hpPercent', 'defPercent'].includes(key)) return `${Math.round(value * 10) / 10}%`;
  return `${Math.round(value)}`;
}

function improvementCandidates(snapshot, guide, report, goal) {
  const accountKey = goal.key;
  const subKey = ACCOUNT_TO_SUB[accountKey];
  if (!subKey) return [];
  const currentTotal = Number(snapshot?.stats?.[accountKey]);
  const direct = ['critRate', 'critDmg', 'er', 'em'].includes(accountKey);
  const gap = direct && Number.isFinite(currentTotal) ? Math.max(0, goal.target - currentTotal) : null;
  const rawBySlot = new Map((snapshot?.artifacts || []).map((row) => [row.slot, row]));
  const preserveKeys = preservationKeys(guide, accountKey);

  return report.pieces
    .filter((row) => row.mainMatch && row.level >= 20)
    .map((row) => {
      const raw = rawBySlot.get(row.slot);
      if (!raw || mainBlocksSubstat(raw, subKey)) return null;
      const currentOnPiece = substatValue(raw, subKey);
      let wanted = currentOnPiece;
      if (direct && Number.isFinite(gap)) wanted = currentOnPiece + gap;
      else wanted = currentOnPiece + (MAX_FIVE_ROLL[subKey] || 0) * 0.22;
      wanted = Math.round(wanted * 10) / 10;
      const ceiling = MAX_FIVE_ROLL[subKey] || Infinity;
      const fitsOnePiece = wanted <= ceiling + 0.15;
      const preserve = preserveKeys.map((key) => ({ key, value: substatValue(raw, key) })).filter((row) => row.value > 0);
      return { row, raw, subKey, currentOnPiece, wanted, ceiling, fitsOnePiece, preserve };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.fitsOnePiece !== b.fitsOnePiece) return a.fitsOnePiece ? -1 : 1;
      return a.row.usefulRv - b.row.usefulRv || a.preserve.length - b.preserve.length;
    });
}

function formatPlan(snapshot, guide, evaluation, requestText, lang) {
  const ar = lang === 'ar';
  const explicit = parseRequestedTargets(requestText);
  const goals = explicit.length ? explicit : defaultGoals(snapshot, guide, evaluation);
  const goal = goals[0] || null;
  const report = reviewArtifacts(snapshot, guide);
  if (!goal) {
    const weakest = report.prioritized.find((row) => row.mainMatch && row.level >= 20) || report.prioritized[0];
    if (!weakest) return ar ? 'ما لقيت قطعة واضحة تحتاج تغيير.' : 'No obvious artifact replacement was found.';
    return ar
      ? `**الخطة:** بيلدك محقق الأهداف الأساسية. إذا تبي Min-Max، ابدأ بـ ${ltr(weakest.slotLabel)} لأنها أضعف قطعة عندك حاليًا.`
      : `**Plan:** your main build targets are already met. For min-maxing, start with ${weakest.slotLabel}, your weakest current piece.`;
  }

  const current = Number(snapshot?.stats?.[goal.key]);
  const candidates = improvementCandidates(snapshot, guide, report, goal);
  const best = candidates.find((row) => row.fitsOnePiece) || candidates[0] || null;
  if (!best) return ar ? 'ما لقيت قطعة مناسبة أغيّرها بدون تعارض مع الـMain Stat.' : 'No suitable piece can be changed without conflicting with its main stat.';

  const lines = [];
  if (Number.isFinite(current)) {
    lines.push(ar
      ? `**الهدف:** ${ltr(LABELS[goal.key] || goal.key)} من ${ltr(formatStat(goal.key, current))} إلى ${ltr(formatStat(goal.key, goal.target))}.`
      : `**Goal:** ${LABELS[goal.key] || goal.key} from ${formatStat(goal.key, current)} to ${formatStat(goal.key, goal.target)}.`);
  }
  lines.push(ar
    ? `**ابدأ بـ ${ltr(best.row.slotLabel)} +${best.row.level}:** هي أفضل حلقة للتعديل بدون التضحية بقطعة أقوى.`
    : `**Start with ${best.row.slotLabel} +${best.row.level}:** it is the best weak link to replace without sacrificing a stronger piece.`);

  if (!best.fitsOnePiece) {
    const second = candidates.find((row) => row !== best) || null;
    lines.push(ar
      ? `الفرق المطلوب أكبر من رول منطقي على قطعة واحدة. لا تتجاوز تقريبًا 4–5 رولات لنفس السب ستات؛ وزّع التحسين${second ? ` بين ${ltr(best.row.slotLabel)} و${ltr(second.row.slotLabel)}` : ' على أكثر من قطعة'}.`
      : `The gap is larger than a realistic single-piece roll. Keep one substat to roughly 4–5 rolls and split the gain across multiple pieces.`);
  } else {
    lines.push(ar ? `ابحث عن نفس الـMain Stat وبالسب ستات التالية:` : 'Look for the same main stat with:');
    lines.push(ar
      ? `• ${ltr(`${LABELS[best.subKey] || best.subKey}: ${fmtSub(best.subKey, best.wanted)}+`)}${best.currentOnPiece > 0 ? ` بدل ${ltr(fmtSub(best.subKey, best.currentOnPiece))}` : ''}`
      : `• ${LABELS[best.subKey] || best.subKey}: ${fmtSub(best.subKey, best.wanted)}+${best.currentOnPiece > 0 ? ` (currently ${fmtSub(best.subKey, best.currentOnPiece)})` : ''}`);
    best.preserve.slice(0, 3).forEach((row) => {
      lines.push(ar
        ? `• حافظ على ${ltr(`${LABELS[row.key] || row.key}: ${fmtSub(row.key, row.value)}+`)}`
        : `• Keep ${LABELS[row.key] || row.key}: ${fmtSub(row.key, row.value)}+`);
    });
    if (Number.isFinite(current) && ['critRate', 'critDmg', 'er', 'em'].includes(goal.key)) {
      const projected = current - best.currentOnPiece + best.wanted;
      lines.push(ar
        ? `بهالشكل توصل تقريبًا إلى ${ltr(formatStat(goal.key, projected))} مع المحافظة على الستات المهمة الموجودة بالقطعة.`
        : `That projects to about ${formatStat(goal.key, projected)} while preserving the important stats already on the piece.`);
    }
  }
  return lines.join('\n');
}

function formatArtifactDoctor(snapshot, guide, evaluation, lang = 'ar', requestText = '') {
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const rawBySlot = new Map((snapshot?.artifacts || []).map((row) => [row.slot, row]));
  const lines = [`**${snapshot.name} — Artifact Doctor**`];

  for (const row of report.pieces) {
    const raw = rawBySlot.get(row.slot);
    lines.push(`\n**${ltr(`${row.slotLabel} +${row.level}`)}**`);
    lines.push(formatSubstats(raw, lang));
  }

  lines.push('\n────────────');
  lines.push(formatPlan(snapshot, guide, evaluation, requestText, lang));

  const setIssue = setNeedsChange(snapshot, guide);
  if (setIssue?.recommended) {
    lines.push(ar
      ? `\n**الـSet:** إذا هدفك البيلد القياسي، بدّل ${ltr(setIssue.current)} إلى ${ltr(setIssue.recommended)}.`
      : `\n**Set:** for the standard build, replace ${setIssue.current} with ${setIssue.recommended}.`);
  }

  return lines.join('\n');
}

module.exports = {
  formatArtifactDoctor,
  setNeedsChange,
  parseRequestedTargets,
  improvementCandidates,
  formatPlan,
  mainBlocksSubstat,
  substatValue,
  ltr,
};
