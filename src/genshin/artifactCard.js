'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { buildAccountCard } = require('./buildCard');
const { rankArtifactPieces, effectiveRv } = require('./artifactDoctor');

const SLOT_ORDER = ['flower', 'plume', 'sands', 'goblet', 'circlet'];

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function borderFor(rv, cv) {
  if (rv >= 650 || cv >= 45) return '#d7a72d';
  if (rv >= 550 || cv >= 35) return '#b96f26';
  if (rv >= 450 || cv >= 25) return '#7653b8';
  if (rv >= 330 || cv >= 15) return '#3c78a8';
  return '#506173';
}

async function buildArtifactCard(character, snapshot, guide, evaluation = null) {
  const full = await buildAccountCard(character);
  const source = await loadImage(full);
  const sourceW = Number(source.width) || 0;
  const sourceH = Number(source.height) || 0;
  if (!sourceW || !sourceH) throw new Error('ARTIFACT_CARD_IMAGE_INVALID');

  const ranked = rankArtifactPieces(snapshot, guide, evaluation);
  const bySlot = new Map(ranked.map((item) => [item.row.slot, item]));
  const equipped = new Set((snapshot?.artifacts || []).map((row) => row.slot));

  // Five large compact panels, deliberately matching the visual reading order used
  // by Akasha: Flower / Plume / Sands / Goblet / Circlet. The source panels come from
  // the same Kirara/Enka renderer used by the proven character build card, so the
  // artifact art and substats remain the real equipped data rather than placeholders.
  const width = 1500;
  const height = 390;
  const margin = 12;
  const gap = 8;
  const cardW = Math.floor((width - margin * 2 - gap * 4) / 5);
  const cardH = height - margin * 2;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d141c';
  ctx.fillRect(0, 0, width, height);

  // Kirara stacks its five artifact panels on the right side. These coordinates are
  // intentionally based on ratios so upstream render-size changes do not break them.
  const cropX = Math.floor(sourceW * 0.625);
  const cropW = Math.max(1, Math.floor(sourceW * 0.365));
  const firstY = Math.floor(sourceH * 0.018);
  const cropH = Math.max(1, Math.floor(sourceH * 0.174));
  const stepY = Math.floor(sourceH * 0.18);

  for (let i = 0; i < SLOT_ORDER.length; i += 1) {
    const slot = SLOT_ORDER[i];
    const item = bySlot.get(slot);
    const x = margin + i * (cardW + gap);
    const y = margin;
    const rv = item ? effectiveRv(item.row) : 0;
    const cv = Number(item?.row?.cv) || 0;

    ctx.save();
    roundedRect(ctx, x, y, cardW, cardH, 10);
    ctx.clip();
    ctx.fillStyle = '#162333';
    ctx.fillRect(x, y, cardW, cardH);

    if (equipped.has(slot)) {
      const sy = Math.min(Math.max(0, firstY + i * stepY), Math.max(0, sourceH - cropH));
      ctx.drawImage(source, cropX, sy, cropW, cropH, x, y, cardW, cardH);
    } else {
      ctx.fillStyle = '#0a1119';
      ctx.fillRect(x, y, cardW, cardH);
      ctx.fillStyle = '#65788c';
      ctx.textAlign = 'center';
      ctx.font = '700 58px sans-serif';
      ctx.fillText('×', x + cardW / 2, y + cardH / 2 + 20);
    }
    ctx.restore();

    ctx.strokeStyle = borderFor(rv, cv);
    ctx.lineWidth = 4;
    roundedRect(ctx, x + 1, y + 1, cardW - 2, cardH - 2, 10);
    ctx.stroke();

    if (item) {
      const badge = `RV ${rv}%  •  CV ${cv}`;
      ctx.font = '700 19px sans-serif';
      const badgeW = Math.min(cardW - 16, ctx.measureText(badge).width + 22);
      ctx.fillStyle = 'rgba(7, 12, 18, 0.9)';
      roundedRect(ctx, x + 8, y + 8, badgeW, 34, 8);
      ctx.fill();
      ctx.fillStyle = '#f3f6f9';
      ctx.textAlign = 'left';
      ctx.fillText(badge, x + 18, y + 31);
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { buildArtifactCard };
