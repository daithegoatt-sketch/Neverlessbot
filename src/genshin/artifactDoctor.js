'use strict';

const { reviewArtifacts } = require('./artifactEvaluator');
const { guideProfile } = require('./statProfile');

const LRI = '\u2066';
const PDI = '\u2069';

function ltr(value) {
  return `${LRI}${String(value)}${PDI}`;
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

function recommendedRv(row) {
  if (!row?.mainMatch) return 550;
  const value = Number(row?.usefulRv) || 0;
  if (value < 400) return 500;
  if (value < 500) return 550;
  if (value < 600) return 600;
  return 650;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function recommendedSet(guide) {
  const rows = (guide?.artifacts || []).map((item) => String(item || '').trim()).filter(Boolean);
  return rows[0] || null;
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

const RANGE = {
  critRate: '7–12%',
  critDmg: '14–24%',
  er: '5–13%',
  em: '20–47',
  atk: '5–12% ATK',
  hp: '5–12% HP',
  def: '6–15% DEF',
};

function doctorPriorityKeys(guide, evaluation) {
  const profile = guideProfile(guide);
  const missing = (evaluation?.relevantStats || []).filter((row) => row.status === 'down').map((row) => row.key);
  const ordered = [...missing, ...profile.priority, 'critRate', 'critDmg'];
  const result = [];
  for (const key of ordered) {
    if (!RANGE[key] || result.includes(key)) continue;
    result.push(key);
    if (result.length >= 4) break;
  }
  return result;
}

function formatSubstats(artifact, lang) {
  const ar = lang === 'ar';
  const rows = artifact?.substats || [];
  if (!rows.length) return ar ? 'ما قدرت أقرأ السب ستات.' : 'Substats unavailable.';
  return rows.map((row) => {
    const label = cleanStatName(row.name);
    const value = row.value || row.numericValue || '?';
    return ar ? `• ${ltr(`${label}: ${value}`)}` : `• ${label}: ${value}`;
  }).join('\n');
}

function formatArtifactDoctor(snapshot, guide, evaluation, lang = 'ar') {
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const rawBySlot = new Map((snapshot?.artifacts || []).map((row) => [row.slot, row]));
  const lines = [`**${snapshot.name} — ${ar ? 'Artifact Doctor' : 'Artifact Doctor'}**`];

  for (const row of report.pieces) {
    const raw = rawBySlot.get(row.slot);
    lines.push(`\n**${ltr(`${row.slotLabel} +${row.level}`)}**`);
    lines.push(formatSubstats(raw, lang));
  }

  const weakest = report.prioritized[0] || null;
  const rawWeak = weakest ? rawBySlot.get(weakest.slot) : null;
  const keys = doctorPriorityKeys(guide, evaluation);
  const setIssue = setNeedsChange(snapshot, guide);

  lines.push('\n────────────');
  if (weakest) {
    const targetRv = recommendedRv(weakest);
    if (ar) {
      lines.push(`**الخطة:** ابدأ بـ ${ltr(weakest.slotLabel)}.`);
      if (!weakest.mainMatch && weakest.mainOptions.length) {
        lines.push(`غيّر الـMain Stat إلى ${ltr(weakest.mainOptions.join(' / '))}.`);
      } else {
        lines.push(`حاليًا ${ltr(`RV ${weakest.usefulRv}%`)}؛ هدف منطقي للقطعة التالية ${ltr(`RV ${targetRv}%+`)}.`);
      }
      if (rawWeak?.substats?.length) lines.push('ابحث عن قطعة بنفس الـMain Stat لكن برولات أنظف في الستات المطلوبة.');
      if (keys.length) lines.push(`مثال واقعي: ${keys.map((key) => ltr(`${key === 'critRate' ? 'CRIT Rate' : key === 'critDmg' ? 'CRIT DMG' : key.toUpperCase()} ${RANGE[key]}`)).join(' • ')}`);
      lines.push('مو لازم تجمع كل الأرقام مع بعض؛ الهدف تقريبًا 5–7 رولات مفيدة بالمجموع، مو رول مستحيل.');
    } else {
      lines.push(`**Plan:** start with ${weakest.slotLabel}.`);
      if (!weakest.mainMatch && weakest.mainOptions.length) lines.push(`Change the main stat to ${weakest.mainOptions.join(' / ')}.`);
      else lines.push(`Current useful RV is ${weakest.usefulRv}%; a realistic next target is ${targetRv}%+.`);
      if (keys.length) lines.push(`Reasonable example: ${keys.map((key) => `${key}: ${RANGE[key]}`).join(' • ')}`);
      lines.push('You do not need every range at once; aim for roughly 5–7 useful rolls total, not an impossible perfect artifact.');
    }
  }

  if (setIssue?.recommended) {
    lines.push(ar
      ? `\n**الـSet:** أنت تستخدم ${ltr(setIssue.current)}؛ إذا هدفك البيلد القياسي، جرّب الانتقال إلى ${ltr(setIssue.recommended)}.`
      : `\n**Set:** you are using ${setIssue.current}; for the standard build, consider ${setIssue.recommended}.`);
  }

  return lines.join('\n');
}

module.exports = { formatArtifactDoctor, setNeedsChange, recommendedRv, doctorPriorityKeys, ltr };
