'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { reviewArtifacts } = require('./artifactEvaluator');

const SLOT_ORDER = ['flower', 'plume', 'sands', 'goblet', 'circlet'];

async function fetchImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

function fitText(ctx, text, maxWidth, start = 22, min = 13) {
  let size = start;
  while (size > min) {
    ctx.font = `700 ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 1;
  }
  return min;
}

function recommendedRv(row) {
  if (!row?.mainMatch) return 550;
  if ((row?.usefulRv || 0) < 400) return 500;
  if ((row?.usefulRv || 0) < 500) return 550;
  if ((row?.usefulRv || 0) < 600) return 600;
  return 650;
}

async function buildArtifactCard(snapshot, guide) {
  const report = reviewArtifacts(snapshot, guide);
  const bySlot = new Map(report.pieces.map((row) => [row.slot, row]));
  const rawBySlot = new Map((snapshot.artifacts || []).map((row) => [row.slot, row]));

  const width = 1180;
  const height = 410;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#101722';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#182333';
  ctx.fillRect(24, 24, width - 48, height - 48);

  ctx.fillStyle = '#f3f6fb';
  ctx.font = '700 30px sans-serif';
  ctx.fillText(`${snapshot.name} — Artifacts`, 48, 66);
  ctx.fillStyle = '#9fb0c5';
  ctx.font = '500 16px sans-serif';
  ctx.fillText('RV = useful roll value for this build', 48, 92);

  const startX = 42;
  const gap = 14;
  const cardW = 208;
  const cardH = 270;
  const y = 112;

  for (let i = 0; i < SLOT_ORDER.length; i += 1) {
    const slot = SLOT_ORDER[i];
    const row = bySlot.get(slot);
    const raw = rawBySlot.get(slot);
    const x = startX + i * (cardW + gap);

    ctx.fillStyle = '#0c131d';
    ctx.fillRect(x, y, cardW, cardH);
    ctx.strokeStyle = row?.mainMatch === false ? '#d86a6a' : '#3d5168';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cardW, cardH);

    const icon = await fetchImage(raw?.iconUrl);
    if (icon) {
      const size = 88;
      ctx.drawImage(icon, x + (cardW - size) / 2, y + 18, size, size);
    }

    ctx.fillStyle = '#f4f7fb';
    ctx.font = '700 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${row?.slotLabel || slot} +${row?.level ?? '?'}`, x + cardW / 2, y + 132);

    const main = `${raw?.mainStat || row?.mainStat || ''}${raw?.mainValue ? ` ${raw.mainValue}` : ''}`.trim();
    const mainSize = fitText(ctx, main || '—', cardW - 22, 18, 12);
    ctx.font = `600 ${mainSize}px sans-serif`;
    ctx.fillStyle = row?.mainMatch === false ? '#ff9a9a' : '#cbd7e6';
    ctx.fillText(main || '—', x + cardW / 2, y + 160);

    ctx.fillStyle = '#75baff';
    ctx.font = '800 24px sans-serif';
    ctx.fillText(`RV ${row?.usefulRv ?? 0}%`, x + cardW / 2, y + 205);

    ctx.fillStyle = '#95a7bc';
    ctx.font = '600 15px sans-serif';
    const target = recommendedRv(row);
    ctx.fillText(`Target ${target}%+`, x + cardW / 2, y + 231);

    if (row?.mainMatch === false) {
      ctx.fillStyle = '#ffb0b0';
      ctx.font = '700 13px sans-serif';
      ctx.fillText('Main Stat mismatch', x + cardW / 2, y + 255);
    }
  }

  ctx.textAlign = 'left';
  return canvas.toBuffer('image/png');
}

module.exports = { buildArtifactCard, recommendedRv };
