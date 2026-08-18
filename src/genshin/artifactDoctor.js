'use strict';

const { reviewArtifacts, reviewArtifact, maxRollFor, rollKey } = require('./artifactEvaluator');
const { guideProfile, formatStat } = require('./statProfile');

const LRI = '\u2066';
const PDI = '\u2069';
const SLOT_ORDER = ['flower', 'plume', 'sands', 'goblet', 'circlet'];

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

function effectiveRv(row) {
  const value = Number(row?.effectiveRv ?? row?.usefulRv);
  return Number.isFinite(value) ? value : 0;
}

function recommendedRv(row) {
  if (!row?.mainMatch) return 550;
  const value = effectiveRv(row);
  if (value < 350) return 500;
  if (value < 450) return 550;
  if (value < 550) return 600;
  return 650;
}

function recommendedSet(guide) {
  return (guide?.artifacts || []).map((item) => String(item || '').trim()).filter(Boolean)[0] || null;
}

function cleanSetName(value) {
  return String(value || '')
    .replace(/\([^)]*(?:pc|piece)[^)]*\)/ig, '')
    .replace(/\b[24]\s*(?:pc|piece)(?:\s*set)?\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function setNeedsChange(snapshot, guide) {
  const candidates = (guide?.artifacts || []).map(cleanSetName).map(normalize).filter(Boolean);
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
    let weight = Math.max(0.8, 1.34 - index * 0.11);
    const target = profile.targetMap[accountKey];
    const current = Number(snapshot?.stats?.[accountKey]);
    const evalRow = (evaluation?.relevantStats || []).find((row) => row.key === accountKey);

    if (evalRow?.status === 'down' || (target && Number.isFinite(current) && current < target.min)) weight *= 1.5;
    else if (target && Number.isFinite(current) && target.max > target.min && current < target.max) weight *= 1.12;
    else if (target && Number.isFinite(current) && target.max > target.min && current >= target.max) weight *= 0.92;

    const sub = ACCOUNT_TO_SUB[accountKey];
    if (sub) weights.set(sub, Math.max(weights.get(sub) || 0, weight));

    // Flat stats can still help, but Akasha-style RV normally values the percentage
    // form for ordinary scaling characters. Keep flat stats as a small fit tiebreaker
    // instead of letting Flat ATK make a weak Skirk circlet look stronger than it is.
    if (accountKey === 'atk') weights.set('flatAtk', Math.max(weights.get('flatAtk') || 0, weight * 0.2));
    if (accountKey === 'hp') weights.set('flatHp', Math.max(weights.get('flatHp') || 0, weight * 0.2));
    if (accountKey === 'def') weights.set('flatDef', Math.max(weights.get('flatDef') || 0, weight * 0.2));
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
  let displayRv = 0;
  const parts = [];

  for (const sub of artifact?.substats || []) {
    const key = statKey(sub);
    const weight = weights.get(key) || 0;
    const max = maxRollFor(key, artifact?.rarity || 5);
    const value = numericSubstat(sub);
    if (!key || !weight || !Number.isFinite(max) || max <= 0) continue;
    const rv = Math.max(0, (value / max) * 100);
    weightedRv += rv * weight;
    if (!key.startsWith('flat')) displayRv += rv;
    parts.push({ key, value, rv: Math.round(rv), weight });
  }

  const critRelevant = (weights.get('critRate') || 0) >= 0.5 || (weights.get('critDmg') || 0) >= 0.5;
  const critWeight = Math.max(weights.get('critRate') || 0, weights.get('critDmg') || 0, 1);
  const cvEquivalentRv = critRelevant ? ((Number(row.cv) || 0) / 7.77) * 100 : 0;
  let score = weightedRv * 0.88 + cvEquivalentRv * critWeight * 0.12;
  if (!row.mainMatch) score -= 1200;
  if (row.level < 20) score -= (20 - row.level) * 35;

  return {
    score: Math.round(score * 10) / 10,
    weightedRv: Math.round(weightedRv),
    displayRv: Math.round(displayRv),
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
    const quality = pieceQuality(artifact, row, snapshot, guide, evaluation);
    return { row: { ...row, effectiveRv: quality.displayRv }, artifact, quality };
  }).sort((a, b) => a.quality.score - b.quality.score || effectiveRv(a.row) - effectiveRv(b.row));
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
  const preferred = new RegExp(`${group}.{0,32}?(?:إلى|الى|لـ|ل|to|target|هدف)\\s*(\\d+(?:\\.\\d+)?)`, 'iu');
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
  for (const key of unique([...profile.priority, ...profile.ordered])) {
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
    .filter(([key, weight]) => SUB_TO_ACCOUNT[key] !== targetKey && !key.startsWith('flat') && weight >= 0.5)
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

  return report.pieces.map((sourceRow) => {
    const raw = rawBySlot.get(sourceRow.slot);
    if (!raw || !sourceRow.mainMatch || sourceRow.level < 20 || mainBlocksSubstat(raw, subKey)) return null;
    const quality = pieceQuality(raw, sourceRow, snapshot, guide, evaluation);
    const row = { ...sourceRow, effectiveRv: quality.displayRv };
    const currentOnPiece = substatValue(raw, subKey);
    const maxOneRoll = maxRollFor(subKey, 5) || 0;
    const ceiling = maxOneRoll * 5;
    let wanted;
    if (direct && Number.isFinite(currentTotal)) wanted = Math.max(0, goal.target - (currentTotal - currentOnPiece));
    else {
      const gapPct = Number.isFinite(currentTotal) && currentTotal > 0
        ? Math.max(0, ((goal.target - currentTotal) / currentTotal) * 100)
        : 0;
      wanted = currentOnPiece + Math.max(maxOneRoll, Math.min(maxOneRoll * 2, gapPct));
    }
    wanted = Math.round(wanted * 10) / 10;
    const preserve = preserveKeys.map((key) => ({ key, value: substatValue(raw, key) })).filter((item) => item.value > 0);
    return {
      row, raw, subKey, currentOnPiece, wanted, ceiling,
      headroom: Math.max(0, ceiling - currentOnPiece),
      fitsOnePiece: wanted <= ceiling + 0.15,
      preserve, quality,
    };
  }).filter(Boolean).sort((a, b) => {
    if (a.fitsOnePiece !== b.fitsOnePiece) return a.fitsOnePiece ? -1 : 1;
    return a.quality.score - b.quality.score || effectiveRv(a.row) - effectiveRv(b.row);
  });
}

function buildSplitPlan(snapshot, goal, candidates) {
  if (!goal || !['critRate', 'critDmg', 'er', 'em'].includes(goal.key)) return [];
  const current = Number(snapshot?.stats?.[goal.key]);
  if (!Number.isFinite(current) || current >= goal.target) return [];
  const gap = goal.target - current;
  const subKey = ACCOUNT_TO_SUB[goal.key];
  const maxRoll = maxRollFor(subKey, 5) || 0;
  const viable = candidates.filter((item) => item.headroom > 0.05).slice(0, 4);
  if (!viable.length) return [];

  // A small gap stays on the weakest suitable piece. Larger gaps are deliberately
  // spread across 2–3 weak links so the Doctor does not demand a near-perfect single
  // artifact when two realistic upgrades can reach the same account target.
  let useCount = 1;
  if (viable.length >= 2 && gap > maxRoll * 1.35) useCount = 2;
  if (viable.length >= 3 && gap > maxRoll * 2.7) useCount = 3;
  const chosen = viable.slice(0, useCount);
  let remaining = gap;
  const plan = [];

  for (let i = 0; i < chosen.length; i += 1) {
    const item = chosen[i];
    const remainingPieces = chosen.length - i;
    let gain;
    if (remainingPieces === 1) gain = remaining;
    else {
      const bias = i === 0 ? 1.18 : 1;
      gain = (remaining / remainingPieces) * bias;
    }
    gain = Math.max(0, Math.min(item.headroom, gain));
    remaining -= gain;
    plan.push({ ...item, gain, targetOnPiece: item.currentOnPiece + gain });
  }

  // If the first allocation hit a headroom cap, distribute the leftover across any
  // selected piece that still has legal room before considering a fourth piece.
  if (remaining > 0.05) {
    for (const item of plan) {
      const extraRoom = Math.max(0, item.ceiling - item.targetOnPiece);
      if (!extraRoom) continue;
      const extra = Math.min(extraRoom, remaining);
      item.gain += extra;
      item.targetOnPiece += extra;
      remaining -= extra;
      if (remaining <= 0.05) break;
    }
  }

  if (remaining > 0.05) {
    for (const candidate of viable.slice(useCount)) {
      if (remaining <= 0.05) break;
      const gain = Math.min(candidate.headroom, remaining);
      plan.push({ ...candidate, gain, targetOnPiece: candidate.currentOnPiece + gain });
      remaining -= gain;
    }
  }

  return plan.filter((item) => item.gain > 0.05).map((item) => ({
    ...item,
    gain: Math.round(item.gain * 10) / 10,
    targetOnPiece: Math.round(item.targetOnPiece * 10) / 10,
  }));
}

function formatPreserveLines(item, lang) {
  const ar = lang === 'ar';
  const preserved = item.preserve.slice(0, 2);
  if (!preserved.length) return [];
  return preserved.map((row) => ar
    ? `  حافظ قدر الإمكان على ${ltr(`${LABELS[row.key] || row.key} ${fmtSub(row.key, row.value)}`)}`
    : `  Preserve about ${LABELS[row.key] || row.key} ${fmtSub(row.key, row.value)}`);
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
      ? `**ابدأ بـ ${ltr(wrongMain.row.slotLabel)}:** الـMain Stat غير مناسب. المطلوب ${ltr(wrongMain.row.mainOptions.join(' / '))}. بعد تصحيحه نقارن جودة السب ستات بالـRV والـCV.`
      : `**Start with ${wrongMain.row.slotLabel}:** its main stat is wrong. Use ${wrongMain.row.mainOptions.join(' / ')} first, then compare substat quality by RV/CV.`;
  }

  if (!goal) {
    const weakest = ranked[0];
    if (!weakest) return ar ? 'ما لقيت قطعة واضحة تحتاج تغيير.' : 'No obvious artifact replacement was found.';
    return ar
      ? `**الخطة:** التارقت الأساسي محقق. أضعف حلقة حاليًا ${ltr(weakest.row.slotLabel)} — ${ltr(`RV ${effectiveRv(weakest.row)}% • CV ${weakest.row.cv}`)}. ابدأ منها إذا تبي Min-Max بدون النزول عن الستات المطلوبة.`
      : `**Plan:** core targets are met. Your weakest link is ${weakest.row.slotLabel} — RV ${effectiveRv(weakest.row)}% • CV ${weakest.row.cv}. Min-max it without dropping required stats.`;
  }

  const current = Number(snapshot?.stats?.[goal.key]);
  const candidates = improvementCandidates(snapshot, guide, report, goal, evaluation);
  if (!candidates.length) return ar ? 'ما لقيت قطعة مناسبة أغيّرها بدون تخريب الـMain Stat.' : 'No suitable piece can be changed without breaking its main stat.';

  const lines = [];
  if (Number.isFinite(current)) {
    lines.push(ar
      ? `**الهدف:** ${ltr(`${LABELS[goal.key] || goal.key} ${formatStat(goal.key, current)} → ${formatStat(goal.key, goal.target)}`)}`
      : `**Goal:** ${LABELS[goal.key] || goal.key} ${formatStat(goal.key, current)} → ${formatStat(goal.key, goal.target)}`);
  }

  if (['critRate', 'critDmg', 'er', 'em'].includes(goal.key)) {
    const plan = buildSplitPlan(snapshot, goal, candidates);
    if (!plan.length) return lines.concat(ar ? 'التارقت محقق أو ما في مساحة رول منطقية إضافية.' : 'Target is already met or there is no realistic roll room left.').join('\n');

    lines.push(ar
      ? `**أفضل مسار:** ${plan.length > 1 ? 'وزّع التحسين على أكثر من قطعة بدل مطاردة رول شبه مثالي بقطعة واحدة.' : `ابدأ بـ ${ltr(plan[0].row.slotLabel)} لأنها أضعف قطعة مناسبة.`}`
      : `**Best path:** ${plan.length > 1 ? 'split the gain across weak pieces instead of chasing one near-perfect artifact.' : `start with ${plan[0].row.slotLabel}.`}`);

    for (const item of plan) {
      lines.push(ar
        ? `• ${ltr(item.row.slotLabel)}: ${ltr(`${LABELS[item.subKey]} ${fmtSub(item.subKey, item.currentOnPiece)} → ~${fmtSub(item.subKey, item.targetOnPiece)}`)} — ${ltr(`RV ${effectiveRv(item.row)}% • CV ${item.row.cv}`)}`
        : `• ${item.row.slotLabel}: ${LABELS[item.subKey]} ${fmtSub(item.subKey, item.currentOnPiece)} → ~${fmtSub(item.subKey, item.targetOnPiece)} — RV ${effectiveRv(item.row)}% • CV ${item.row.cv}`);
      lines.push(...formatPreserveLines(item, lang));
    }

    const projected = Number.isFinite(current) ? current + plan.reduce((sum, item) => sum + item.gain, 0) : null;
    if (Number.isFinite(projected)) {
      lines.push(ar
        ? `**النتيجة المتوقعة:** حوالي ${ltr(formatStat(goal.key, projected))}. كل رقم داخل حدود رول 5★ منطقي، ولا يطلب 6–7 رولات على سب ستات واحد.`
        : `**Projected result:** about ${formatStat(goal.key, projected)}. Every requested value stays within a realistic 5★ substat ceiling.`);
    }
    return lines.join('\n');
  }

  const best = candidates[0];
  const maxRoll = maxRollFor(best.subKey, 5) || 0;
  const suggested = Math.min(best.ceiling, best.currentOnPiece + maxRoll * 1.5);
  lines.push(ar
    ? `**ابدأ بـ ${ltr(best.row.slotLabel)}:** هي أضعف حلقة مناسبة. استهدف تقريبًا ${ltr(`${LABELS[best.subKey]} ${fmtSub(best.subKey, suggested)}`)} مع المحافظة على الستات المهمة الموجودة فيها.`
    : `**Start with ${best.row.slotLabel}:** target roughly ${LABELS[best.subKey]} ${fmtSub(best.subKey, suggested)} while preserving its important existing stats.`);
  lines.push(ar
    ? 'ATK/HP/DEF النهائي يعتمد على الـBase Stat، لذلك الهدف هنا تحسين منطقي للسب ستات وليس وعدًا برقم نهائي دقيق.'
    : 'Final ATK/HP/DEF depends on base stats, so this is a realistic substat upgrade target rather than a guaranteed final total.');
  return lines.join('\n');
}

function formatArtifactDoctor(snapshot, guide, evaluation, lang = 'ar', requestText = '') {
  const ar = lang === 'ar';
  const ranked = rankArtifactPieces(snapshot, guide, evaluation);
  const rawBySlot = new Map((snapshot?.artifacts || []).map((row) => [row.slot, row]));
  const bySlot = new Map(ranked.map((item) => [item.row.slot, item]));
  const lines = [`**${snapshot.name} — Artifact Doctor**`];

  for (const slot of SLOT_ORDER) {
    const item = bySlot.get(slot);
    if (!item) continue;
    const raw = rawBySlot.get(slot);
    lines.push(`\n**${ltr(`${item.row.slotLabel} +${item.row.level}`)} — ${ltr(`RV ${effectiveRv(item.row)}% • CV ${item.row.cv}`)}**`);
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
  buildSplitPlan,
  formatPlan,
  mainBlocksSubstat,
  substatValue,
  directStatDelta,
  applyArtifactReplacement,
  effectiveRv,
  ltr,
};
