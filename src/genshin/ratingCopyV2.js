'use strict';

const { reviewArtifacts } = require('./artifactEvaluator');
const { formatStat, formatTarget } = require('./statProfile');
const { recommendedRv, setNeedsChange, ltr } = require('./artifactDoctor');

function formatArtifactReview(snapshot, guide, lang = 'ar') {
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const lines = [`**${snapshot.name} — ${ar ? 'تقييم الارتيفاكتات' : 'Artifact Review'}**`];

  for (const row of report.pieces) {
    const target = recommendedRv(row);
    lines.push(`\n**${ltr(`${row.slotLabel} +${row.level}`)}**`);
    lines.push(ar
      ? `RV الحالي: **${ltr(`${row.usefulRv}%`)}**`
      : `Current RV: **${row.usefulRv}%**`);
    lines.push(ar
      ? `RV المقترح: **${ltr(`${target}%+`)}**${row.usefulRv >= target ? ' ✓' : ''}`
      : `Suggested RV: **${target}%+**${row.usefulRv >= target ? ' ✓' : ''}`);
    if (!row.mainMatch && row.mainOptions.length) {
      lines.push(ar
        ? `Main Stat: ${ltr(row.mainStat)} → ${ltr(row.mainOptions.join(' / '))}`
        : `Main Stat: ${row.mainStat} → ${row.mainOptions.join(' / ')}`);
    }
  }

  const weakest = report.prioritized[0] || null;
  if (weakest) {
    const target = recommendedRv(weakest);
    if (ar) {
      const reason = !weakest.mainMatch && weakest.mainOptions.length
        ? `غيّر الـMain Stat إلى ${ltr(weakest.mainOptions.join(' / '))}`
        : `حاول ترفعها من ${ltr(`${weakest.usefulRv}%`)} إلى ${ltr(`${target}%+`)} مع نفس الـMain Stat`;
      lines.push(`\n**الخلاصة:** أضعف قطعة عندك ${ltr(weakest.slotLabel)}؛ ${reason}.`);
    } else {
      const reason = !weakest.mainMatch && weakest.mainOptions.length
        ? `change the main stat to ${weakest.mainOptions.join(' / ')}`
        : `raise it from ${weakest.usefulRv}% to ${target}%+ while keeping the same main stat`;
      lines.push(`\n**Summary:** your weakest piece is ${weakest.slotLabel}; ${reason}.`);
    }
  }

  const setIssue = setNeedsChange(snapshot, guide);
  if (setIssue?.recommended) {
    lines.push(ar
      ? `**الـSet:** ${ltr(setIssue.current)} خارج الخيارات المقترحة؛ جرّب ${ltr(setIssue.recommended)}.`
      : `**Set:** ${setIssue.current} is outside the recommended options; consider ${setIssue.recommended}.`);
  }

  return lines.join('\n');
}

function targetAdviceLine(snapshot, row, lang = 'ar') {
  const ar = lang === 'ar';
  const current = formatStat(row.key, row.value);
  const target = formatTarget(row.target);

  if (String(snapshot?.name || '').toLowerCase() === 'sandrone' && row.key === 'er') {
    return ar
      ? `• ${ltr(`ER ${current} → ${target}`)} إذا تبي الـBurst كل Rotation.`
      : `• ER ${current} → ${target} if you want Burst every rotation.`;
  }

  return ar
    ? `• ${ltr(`${row.label} ${current} → ${target}`)}`
    : `• ${row.label} ${current} → ${target}`;
}

function formatTopPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '?';
  if (number > 0 && number < 0.01) return '<0.01';
  if (number >= 10) return String(Math.round(number));
  return Number(number.toFixed(2)).toString();
}

function akashaImprovementAdvice(snapshot, guide, evaluation, akashaRanking, lang = 'ar') {
  const topPercent = Number(akashaRanking?.topPercent ?? akashaRanking);
  if (!Number.isFinite(topPercent)) return null;
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const targetProblems = (evaluation?.relevantStats || []).filter((row) => row.status === 'down');
  const mainProblems = report.pieces.filter((row) => !row.mainMatch);
  const weakest = report.prioritized[0] || null;
  const setIssue = setNeedsChange(snapshot, guide);

  const lines = [`**${ar ? 'لرفع ترتيب Akasha' : 'Improve Akasha rank'}**`];
  lines.push(ar
    ? `• الحالي: **${ltr(`Top ${formatTopPercent(topPercent)}%`)}**`
    : `• Current: **Top ${formatTopPercent(topPercent)}%**`);

  if (targetProblems.length) {
    targetProblems.slice(0, 2).forEach((row) => lines.push(targetAdviceLine(snapshot, row, lang)));
  }

  if (mainProblems.length) {
    const row = mainProblems[0];
    lines.push(ar
      ? `• ${ltr(row.slotLabel)}: غيّر الـMain Stat إلى ${ltr(row.mainOptions.join(' / '))}.`
      : `• ${row.slotLabel}: change the main stat to ${row.mainOptions.join(' / ')}.`);
  } else if (weakest) {
    const target = recommendedRv(weakest);
    lines.push(ar
      ? `• بعدها: ${ltr(`${weakest.slotLabel} RV ${weakest.usefulRv}% → ${target}%+`)}`
      : `• Next: ${weakest.slotLabel} RV ${weakest.usefulRv}% → ${target}%+`);
  }

  if (setIssue?.recommended) {
    lines.push(ar
      ? `• الـSet: جرّب ${ltr(setIssue.recommended)} بدل ${ltr(setIssue.current)}.`
      : `• Set: consider ${setIssue.recommended} instead of ${setIssue.current}.`);
  }

  if (!targetProblems.length && !mainProblems.length && weakest?.usefulRv >= recommendedRv(weakest)) {
    lines.push(ar
      ? '• البيلد متوازن؛ التحسين من هنا Min-Max بسيط على أضعف قطعة.'
      : '• The build is balanced; further gains are small min-max upgrades on the weakest piece.');
  }

  return lines.join('\n');
}

module.exports = { formatArtifactReview, akashaImprovementAdvice };
