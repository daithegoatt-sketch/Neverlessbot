'use strict';

const { reviewArtifacts, reviewArtifact, maxRollFor, rollKey } = require('./artifactEvaluator');
const { guideProfile, formatStat } = require('./statProfile');

const LRI = '\u2066';
const PDI = '\u2069';

function ltr(value) {
  return `${LRI}${String(value)}${PDI}`;
}

const ACCOUNT_TO_SUB = {
  critRate: 'critRate', critDmg: 'critDmg', er: 'er', em: 'em',
  atk: 'atkPercent', hp: 'hpPercent', def: 'defPercent',
};
const SUB_TO_ACCOUNT = {
  critRate: 'critRate', critDmg: 'critDmg', er: 'er', em: 'em',
  atkPercent: 'atk', hpPercent: 'hp', defPercent: 'def',
  flatAtk: 'atk', flatHp: 'hp', flatDef: 'def',
};
const MAX_FIVE_ROLL = {
  critRate: 19.5, critDmg: 38.9, er: 32.4, em: 116.6,
  atkPercent: 29.2, hpPercent: 29.2, defPercent: 36.5,
};
const LABELS = {
  critRate: 'CRIT Rate', critDmg: 'CRIT DMG', er: 'ER', em: 'EM',
  atk: 'ATK', hp: 'HP', def: 'DEF', atkPercent: 'ATK%', hpPercent: 'HP%', defPercent: 'DEF%',
  flatAtk: 'ATK', flatHp: 'HP', flatDef: 'DEF',
};

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function numericSubstat(row) {
  const direct = Number(row?.numericValue);
  if (Number.isFinite(direct)) return direct;
  const parsed = Number.parseFloat(String(row?.value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function statKey(row) {
  const direct = rollKey(row);
  if (direct) return direct;
  const name = String(row?.name || row?.fightProp || '');
  if (/crit\s*rate/i.test(name)) return 'critRate';
  if (/crit\s*(?:dmg|damage)/i.test(name)) return 'critDmg';
  if (/energy\s*recharge|\ber\b/i.test(name)) return 'er';
  if (/elemental\s*mastery|\bem\b/i.test(name)) return 'em';
  if (/attack|atk/i.test(name)) return row?.isPercent || /%/.test(row?.value || '') ? 'atkPercent' : 'flatAtk';
  if (/health|hp/i.test(name)) return row?.isPercent || /%/.test(row?.value || '') ? 'hpPercent' : 'flatHp';
  if (/defense|def/i.test(name)) return row?.isPercent || /%/.test(row?.value || '') ? 'defPercent' : 'flatDef';
  return null;
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

function recommendedRv(row) {
  if (!row?.mainMatch) return 550;
  const value = Number(row?.usefulRv) || 0;
  if (value < 400) return 500;
  if (value < 500) return 550;
  if (value < 600) return 600;
  return 650;
}

function recommendedSet(guide) {
  return (guide?.artifacts || []).map((item) => String(item || '').trim()).filter(Boolean)[0] || null;
}

function cleanSetName(value) {
  return String(value || '').replace(/\([^)]*piece[^)]*\)/ig, '').replace(/\b[24][- ]?piece\b/ig, '').replace(/\s+/g, ' ').trim();
}

function setNeedsChange(snapshot, guide) {
  const candidates = (guide?.artifacts || []).map((row) => cleanSetName(row)).map(normalize).filter(Boolean);
  if (!candidates.length) return null;
  const current = Object.entries(snapshot?.setCounts || {}).sort((a, b) => b[1] - a[1])[0];
  if (!current || current[1] < 2) return null;
  const currentKey = normalize(current[0]);
  const matched = candidates.some((candidate) => candidate.includes(currentKey) || currentKey.includes(candidate));
  if (matched) return null;
  return { current: current[0], recommended: recommendedSet(guide) };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildStatWeights(snapshot, guide, evaluation = null) {
  const profile = guideProfile(guide);
  const ordered = unique([...profile.priority, ...profile.ordered]);
  const weights = new Map();

  ordered.forEach((accountKey, index) => {
    let weight = Math.max(0.82, 1.32 - index * 0.11);
    const target = profile.targetMap[accountKey];
    const current = Number(snapshot?.stats?.[accountKey]);
    const evalRow = (evaluation?.relevantStats || []).find((row) => row.key === accountKey);

    if (evalRow?.status === 'down' || (target && Number.isFinite(current) && current < target.min)) weight *= 1.45;
    else if (target && Number.isFinite(current) && target.max > target.min && current < target.max) weight *= 1.12;
    else if (target && Number.isFinite(current) && target.max > target.min && current >= target.max) weight *= 0.92;

    const sub = ACCOUNT_TO_SUB[accountKey];
    if (sub) weights.set(sub, Math.max(weights.get(sub) || 0, weight));
    if (accountKey === 'atk') weights.set('flatAtk', Math.max(weights.get('flatAtk') || 0, weight * 0.32));
    if (accountKey === 'hp') weights.set('flatHp', Math.max(weights.get('flatHp') || 0, weight * 0.32));
    if (accountKey === 'def') weights.set('flatDef', Math.max(weights.get('flatDef') || 0, weight * 0.32));
  });

  if (!weights.size) {
    weights.set('critRate', 1);
    weights.set('critDmg', 1);
  }
  return weights;
}

function pieceQuality(artifact, reviewed, snapshot, guide, evaluation = null) {
  const row = reviewed || reviewArtifact(artifact, guide);
  const weights = buildStatWeights(snapshot, guide, evaluation);
  let weightedRv = 0;
  const parts = [];

  for (const sub of artifact?.substats || []) {
    const key = statKey(sub);
    const weight = weights.get(key) || 0;
    const max = maxRollFor(key, artifact?.rarity || 5);
    const value = numericSubstat(sub);
    if (!key || !weight || !Number.isFinite(max) || max <= 0) continue;
    const rv = Math.max(0, (value / max) * 100);
    weightedRv += rv * weight;
    parts.push({ key, value, rv: Math.round(rv), weight });
  }

  const critRelevant = (weights.get('critRate') || 0) > 0 || (weights.get('critDmg') || 0) > 0;
  const critWeight = Math.max(weights.get('critRate') || 0, weights.get('critDmg') || 0, 1);
  const cvEquivalentRv = critRelevant ? ((Number(row.cv) || 0) / 7.77) * 100 : 0;
  let score = weightedRv * 0.84 + cvEquivalentRv * critWeight * 0.16;
  if (!row.mainMatch) score -= 1200;
  if (row.level < 20) score -= (20 - row.level) * 35;

  return {
    score: Math.round(score * 10) / 10,
    weightedRv: Math.round(weightedRv),
    cv: Number(row.cv) || 0,
    critRelevant,
    parts,
  };
}

function rankArtifactPieces(snapshot, guide, evaluation = null) {
  const report = reviewArtifacts(snapshot, guide);
  const rawBySlot = new Map((snapshot?.artifacts || []).map((row) => [row.slot, row]));
  return report.pieces.map((row) => {
    const artifact = rawBySlot.get(row.slot);
    return { row, artifact, quality: pieceQuality(artifact, row, snapshot, guide, evaluation) };
  }).sort((a, b) => a.quality.score - b.quality.score || a.row.usefulRv - b.row.usefulRv);
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
    if (target.max > target.min && current < target.max) soft.push({ key, target: Number(target.max), explicit: false, hard: false });
  }
  return soft;
}

function preservationKeys(snapshot, guide, evaluation, targetKey) {
  const weights = buildStatWeights(snapshot, guide, evaluation);
  return [...weights.entries()]
    .filter(([key]) => SUB_TO_ACCOUNT[key] !== targetKey && !key.startsWith('flat'))
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key)
    .slice(0, 4);
}

function fmtSub(key, value) {
  if (!Number.isFinite(value)) return '?';
  if (['critRate', 'critDmg', 'er', 'atkPercent', 'hpPercent', 'defPercent'].includes(key)) return `${Math.round(value * 10) / 10}%`;
  return `${Math.round(value)}`;
}

function improvementCandidates(snapshot, guide, report, goal, evaluation = null) {
  const accountKey = goal.key;
  const subKey = ACCOUNT_TO_SUB[accountKey];
  if (!subKey) return [];
  const currentTotal = Number(snapshot?.stats?.[accountKey]);
  const direct = ['critRate', 'critDmg', 'er', 'em'].includes(accountKey);
  const rawBySlot = new Map((snapshot?.artifacts || []).map((row) => [row.slot, row]));
  const preserveKeys = preservationKeys(snapshot, guide, evaluation, accountKey);

  return report.pieces.map((row) => {
    const raw = rawBySlot.get(row.slot);
    if (!raw || !row.mainMatch || row.level < 20 || mainBlocksSubstat(raw, subKey)) return null;
    const currentOnPiece = substatValue(raw, subKey);
    let wanted;
    if (direct && Number.isFinite(currentTotal)) {
      wanted = Math.max(0, goal.target - (currentTotal - currentOnPiece));
    } else {
      const gapPct = Number.isFinite(currentTotal) && currentTotal > 0
        ? Math.max(0, ((goal.target - currentTotal) / currentTotal) * 100)
        : 0;
      wanted = currentOnPiece + Math.max(maxRollFor(subKey, 5) || 0, gapPct);
    }
    wanted = Math.round(wanted * 10) / 10;
    const ceiling = MAX_FIVE_ROLL[subKey] || Infinity;
    const preserve = preserveKeys.map((key) => ({ key, value: substatValue(raw, key) })).filter((item) => item.value > 0);
    const quality = pieceQuality(raw, row, snapshot, guide, evaluation);
    return { row, raw, subKey, currentOnPiece, wanted, ceiling, fitsOnePiece: wanted <= ceiling + 0.15, preserve, quality };
  }).filter(Boolean).sort((a, b) => {
    if (a.fitsOnePiece !== b.fitsOnePiece) return a.fitsOnePiece ? -1 : 1;
    return a.quality.score - b.quality.score || a.row.usefulRv - b.row.usefulRv;
  });
}

function formatPlan(snapshot, guide, evaluation, requestText, lang) {
  const ar = lang === 'ar';
  const explicit = parseRequestedTargets(requestText);
  const goals = explicit.length ? explicit : defaultGoals(snapshot, guide, evaluation);
  const ranked = rankArtifactPieces(snapshot, guide, evaluation);
  const report = reviewArtifacts(snapshot, guide);
  const goal = goals[0] || null;

  const wrongMain = ranked.find((item) => !item.row.mainMatch);
  if (wrongMain) {
    return ar
      ? `**ابدأ بـ ${ltr(wrongMain.row.slotLabel)}:** الـMain Stat غير مناسب. المطلوب ${ltr(wrongMain.row.mainOptions.join(' / '))}. بعدها نرجع نقارن جودة السب ستات بالـRV والـCV.`
      : `**Start with ${wrongMain.row.slotLabel}:** its main stat is wrong. Use ${wrongMain.row.mainOptions.join(' / ')} first, then compare substat quality by RV/CV.`;
  }

  if (!goal) {
    const weakest = ranked[0];
    if (!weakest) return ar ? 'ما لقيت قطعة واضحة تحتاج تغيير.' : 'No obvious artifact replacement was found.';
    return ar
      ? `**الخطة:** بيلدك محقق التارقت الأساسي. أضعف حلقة حاليًا ${ltr(weakest.row.slotLabel)} — ${ltr(`RV ${weakest.row.usefulRv}% • CV ${weakest.row.cv}`)}. إذا تبي Min-Max ابدأ منها، مع المحافظة على الستات المهمة للشخصية.`
      : `**Plan:** your main targets are met. The weakest link is ${weakest.row.slotLabel} — RV ${weakest.row.usefulRv}% • CV ${weakest.row.cv}. Min-max this piece while preserving the character's important stats.`;
  }

  const current = Number(snapshot?.stats?.[goal.key]);
  const candidates = improvementCandidates(snapshot, guide, report, goal, evaluation);
  const best = candidates[0] || ranked[0] || null;
  if (!best) return ar ? 'ما لقيت قطعة مناسبة أغيّرها بدون تخريب البيلد.' : 'No suitable replacement was found without damaging the build.';

  const row = best.row;
  const lines = [];
  if (Number.isFinite(current)) {
    lines.push(ar
      ? `**الهدف:** ${ltr(LABELS[goal.key] || goal.key)} من ${ltr(formatStat(goal.key, current))} إلى ${ltr(formatStat(goal.key, goal.target))}.`
      : `**Goal:** ${LABELS[goal.key] || goal.key} from ${formatStat(goal.key, current)} to ${formatStat(goal.key, goal.target)}.`);
  }
  lines.push(ar
    ? `**أضعف حلقة مناسبة للتحسين: ${ltr(row.slotLabel)} +${row.level}** — ${ltr(`RV ${row.usefulRv}% • CV ${row.cv}`)}.`
    : `**Best weak link to improve: ${row.slotLabel} +${row.level}** — RV ${row.usefulRv}% • CV ${row.cv}.`);

  if (best.subKey) {
    if (!best.fitsOnePiece) {
      const second = candidates.find((item) => item !== best) || null;
      lines.push(ar
        ? `الفرق المطلوب أكبر من 4–5 رولات واقعية على سب ستات واحد. وزّع الزيادة${second ? ` بين ${ltr(row.slotLabel)} و${ltr(second.row.slotLabel)}` : ' على أكثر من قطعة'} بدل طلب رول مستحيل.`
        : 'The gap is larger than a realistic 4–5 rolls on one substat. Split the gain across pieces instead of chasing an impossible roll.');
    } else {
      lines.push(ar ? 'ابحث عن نفس الـMain Stat، وحاول توصل تقريبًا إلى:' : 'Keep the same main stat and look for roughly:');
      lines.push(`• ${ltr(`${LABELS[best.subKey] || best.subKey}: ${fmtSub(best.subKey, best.wanted)}+`)}`);
      best.preserve.slice(0, 3).forEach((item) => {
        lines.push(ar
          ? `• حافظ قدر الإمكان على ${ltr(`${LABELS[item.key] || item.key}: ${fmtSub(item.key, item.value)}`)}`
          : `• Preserve ${LABELS[item.key] || item.key}: about ${fmtSub(item.key, item.value)}`);
      });
      if (Number.isFinite(current) && ['critRate', 'critDmg', 'er', 'em'].includes(goal.key)) {
        const projected = current - best.currentOnPiece + best.wanted;
        lines.push(ar
          ? `**النتيجة المتوقعة:** حوالي ${ltr(formatStat(goal.key, projected))} بدون التضحية بالستات المهمة الموجودة بالقطعة.`
          : `**Projected result:** about ${formatStat(goal.key, projected)} without sacrificing the important stats on the piece.`);
      } else if (['atk', 'hp', 'def'].includes(goal.key)) {
        lines.push(ar
          ? 'الرقم المقترح هنا تقريبي لأن ATK/HP/DEF النهائي يعتمد على الـBase Stat؛ البوت يستخدمه كهدف تحسين للقطعة، مو كضمان للرقم النهائي.'
          : 'This substat number is approximate because final ATK/HP/DEF depends on the base stat; it is an upgrade target, not a guaranteed final total.');
      }
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
    lines.push(`\n**${ltr(`${row.slotLabel} +${row.level}`)} — ${ltr(`RV ${row.usefulRv}% • CV ${row.cv}`)}**`);
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

function directStatDelta(oldArtifact, newArtifact) {
  const keys = ['critRate', 'critDmg', 'er', 'em'];
  const out = {};
  for (const key of keys) out[key] = substatValue(newArtifact, key) - substatValue(oldArtifact, key);
  return out;
}

function applyArtifactReplacement(snapshot, slot, artifact) {
  const current = (snapshot?.artifacts || []).find((row) => row.slot === slot) || null;
  const artifacts = (snapshot?.artifacts || []).filter((row) => row.slot !== slot).concat([{ ...artifact, slot }]);
  const stats = { ...(snapshot?.stats || {}) };
  const delta = directStatDelta(current, artifact);
  for (const [key, value] of Object.entries(delta)) {
    if (Number.isFinite(stats[key]) && Number.isFinite(value)) stats[key] = Math.round((stats[key] + value) * 10) / 10;
  }
  const setCounts = {};
  artifacts.forEach((row) => { if (row.set) setCounts[row.set] = (setCounts[row.set] || 0) + 1; });
  return { ...snapshot, artifacts, stats, setCounts };
}

module.exports = {
  formatArtifactDoctor,
  setNeedsChange,
  cleanSetName,
  recommendedRv,
  parseRequestedTargets,
  buildStatWeights,
  pieceQuality,
  rankArtifactPieces,
  improvementCandidates,
  formatPlan,
  mainBlocksSubstat,
  substatValue,
  directStatDelta,
  applyArtifactReplacement,
  ltr,
};
