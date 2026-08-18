'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { buildAccountCard } = require('./buildCard');
const { reviewArtifacts } = require('./artifactEvaluator');

const SLOT_ORDER = ['flower', 'plume', 'sands', 'goblet', 'circlet'];
const SLOT_LABELS = { flower: 'Flower', plume: 'Plume', sands: 'Sands', goblet: 'Goblet', circlet: 'Circlet' };

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

async function buildArtifactCard(character, snapshot, guide) {
  const full = await buildAccountCard(character);
  const source = await loadImage(full);
  const sourceW = Number(source.width) || 0;
  const sourceH = Number(source.height) || 0;
  if (!sourceW || !sourceH) throw new Error('ARTIFACT_CARD_IMAGE_INVALID');

  const report = reviewArtifacts(snapshot, guide);
  const bySlot = new Map(report.pieces.map((row) => [row.slot, row]));
  const equipped = new Set((snapshot?.artifacts || []).map((row) => row.slot));

  // The Kirara renderer is the same proven source used by the character card.
  // Its five artifact panels are stacked on the right. We extract those real panels
  // and rearrange them into the five-card horizontal layout used by Akasha.
  const width = 1500;
  const height = 330;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#11171f';
  ctx.fillRect(0, 0, width, height);

  const margin = 18;
  const gap = 10;
  const cardW = Math.floor((width - margin * 2 - gap * 4) / 5);
  const cardH = 292;
  const y = 18;

  const cropX = Math.floor(sourceW * 0.665);
  const cropW = Math.max(1, Math.floor(sourceW * 0.325));
  const firstY = Math.floor(sourceH * 0.025);
  const cropH = Math.max(1, Math.floor(sourceH * 0.165));
  const stepY = Math.floor(sourceH * 0.18);

  for (let i = 0; i < SLOT_ORDER.length; i += 1) {
    const slot = SLOT_ORDER[i];
    const row = bySlot.get(slot);
    const x = margin + i * (cardW + gap);

    ctx.fillStyle = '#182434';
    roundedRect(ctx, x, y, cardW, cardH, 14);
    ctx.fill();
    ctx.strokeStyle = '#3d5269';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (equipped.has(slot)) {
      const sy = Math.min(Math.max(0, firstY + i * stepY), Math.max(0, sourceH - cropH));
      ctx.save();
      roundedRect(ctx, x + 5, y + 5, cardW - 10, 222, 10);
      ctx.clip();
      ctx.drawImage(source, cropX, sy, cropW, cropH, x + 5, y + 5, cardW - 10, 222);
      ctx.restore();
    } else {
      ctx.fillStyle = '#0b1119';
      roundedRect(ctx, x + 5, y + 5, cardW - 10, 222, 10);
      ctx.fill();
      ctx.fillStyle = '#718096';
      ctx.textAlign = 'center';
      ctx.font = '700 42px sans-serif';
      ctx.fillText('×', x + cardW / 2, y + 120);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = '#eef4fb';
    ctx.font = '700 17px sans-serif';
    ctx.fillText(`${SLOT_LABELS[slot]}${row ? ` +${row.level}` : ''}`, x + 12, y + 248);

    ctx.fillStyle = '#9dd2ff';
    ctx.font = '700 17px sans-serif';
    const metric = row ? `RV ${row.usefulRv}%  •  CV ${row.cv}` : 'Empty slot';
    ctx.fillText(metric, x + 12, y + 274);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { buildArtifactCard };
