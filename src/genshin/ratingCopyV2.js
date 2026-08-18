'use strict';

const { reviewArtifacts } = require('./artifactEvaluator');
const { formatStat, formatTarget } = require('./statProfile');
const { recommendedRv, setNeedsChange, rankArtifactPieces, ltr } = require('./artifactDoctor');

function formatArtifactReview(snapshot, guide, lang = 'ar') {
  const ar = lang === 'ar';
  const report = reviewArtifacts(snapshot, guide);
  const lines = [`**${snapshot.name} — ${ar ? 'تقييم الارتيفاكتات' : 'Artifact Review'}**`];

  for (const row of report.pieces) {
    const target = recommendedRv(row);
    lines.push(`\n**${ltr(`${row.slotLabel} +${row.level}`)}**`);
    lines.push(ar
      ? `RV الحالي: **${ltr(`${row.usefulRv}%`)}** • CV: **${ltr(row.cv)}**`
      : `Current RV: **${row.usefulRv}%** • CV: **${row.cv}**`);
    lines.push(ar
      ? `RV المقترح: **${ltr(`${target}%+`)}**${row.usefulRv >= target ? ' ✓' : ''}`
      : `Suggested RV: **${target}%+**${row.usefulRv >= target ? ' ✓' : ''}`);
    if (!row.mainMatch && row.mainOptions.length) {
      lines.push(ar
        ? `Main Stat: ${ltr(row.mainStat)} → ${ltr(row.mainOptions.join(' / '))}`
        : `Main Stat: ${row.mainStat} → ${row.mainOptions.join(' / ')}`);
    }
  }

  const weakest = rankArtifactPieces(snapshot, guide)[0] || null;
  if (weakest) {
    const row = weakest.row;
    const target = recommendedRv(row);
    if (ar) {
      const reason = !row.mainMatch && row.mainOptions.length
        ? `غيّر الـMain Stat إلى ${ltr(row.mainOptions.join(' / '))}`
        : `هي أضعف حلقة بعد موازنة الستات المطلوبة وRV وCV؛ حاول ترفع RV من ${ltr(`${row.usefulRv}%`)} إلى ${ltr(`${target}%+`)}`;
      lines.push(`\n**الخلاصة:** ابدأ بـ ${ltr(row.slotLabel)}؛ ${reason}.`);
    } else {
      const reason = !row.mainMatch && row.mainOptions.length
        ? `change the main stat to ${row.mainOptions.join(' / ')}`
        : `it is the weakest link after build-stat, RV and CV weighting; raise RV from ${row.usefulRv}% toward ${target}%+`;
      lines.push(`\n**Summary:** start with ${row.slotLabel}; ${reason}.`);
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
  return ar ? `• ${ltr(`${row.label} ${current} → ${target}`)}` : `• ${row.label} ${current} → ${target}`;
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
  const weakest = rankArtifactPieces(snapshot, guide, evaluation)[0] || null;
  const setIssue = setNeedsChange(snapshot, guide);

  const lines = [`**${ar ? 'لرفع ترتيب Akasha' : 'Improve Akasha rank'}**`];
  lines.push(ar
    ? `• الحالي: **${ltr(`Top ${formatTopPercent(topPercent)}%`)}**`
    : `• Current: **Top ${formatTopPercent(topPercent)}%**`);

  if (targetProblems.length) targetProblems.slice(0, 2).forEach((row) => lines.push(targetAdviceLine(snapshot, row, lang)));

  if (mainProblems.length) {
    const row = mainProblems[0];
    lines.push(ar
      ? `• ${ltr(row.slotLabel)}: غيّر الـMain Stat إلى ${ltr(row.mainOptions.join(' / '))}.`
      : `• ${row.slotLabel}: change the main stat to ${row.mainOptions.join(' / ')}.`);
  } else if (weakest) {
    const row = weakest.row;
    const target = recommendedRv(row);
    lines.push(ar
      ? `• بعدها: ${ltr(`${row.slotLabel} — RV ${row.usefulRv}% → ${target}%+ • CV ${row.cv}`)}`
      : `• Next: ${row.slotLabel} — RV ${row.usefulRv}% → ${target}%+ • CV ${row.cv}`);
  }

  if (setIssue?.recommended) {
    lines.push(ar
      ? `• الـSet: جرّب ${ltr(setIssue.recommended)} بدل ${ltr(setIssue.current)}.`
      : `• Set: consider ${setIssue.recommended} instead of ${setIssue.current}.`);
  }

  if (!targetProblems.length && !mainProblems.length && weakest?.row?.usefulRv >= recommendedRv(weakest.row)) {
    lines.push(ar
      ? '• البيلد متوازن؛ التحسين من هنا Min-Max على أضعف قطعة بدون خسارة الستات اللي حافظت على التارقت.'
      : '• The build is balanced; further gains are min-max upgrades on the weakest piece without losing target stats.');
  }
  return lines.join('\n');
}

module.exports = { formatArtifactReview, akashaImprovementAdvice };
