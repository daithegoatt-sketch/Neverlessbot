'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');

function assetUrl(asset) {
  if (!asset) return null;
  for (const key of ['url', 'imageUrl', 'mihoyoUrl']) {
    if (typeof asset[key] === 'string' && /^https?:\/\//.test(asset[key])) return asset[key];
  }
  for (const method of ['getUrl', 'getURL', 'toURL']) {
    try {
      const value = asset[method]?.();
      if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
    } catch {}
  }
  return null;
}

function characterArtUrl(character) {
  const candidates = [
    character?.costume?.art,
    character?.costume?.icon,
    character?.characterData?.costume?.art,
    character?.characterData?.costume?.icon,
    character?.characterData?.art,
    character?.characterData?.icon,
    character?.characterData?.sideIcon,
  ];
  for (const candidate of candidates) {
    const url = assetUrl(candidate);
    if (url) return url;
  }
  return null;
}

function fit(ctx, text, maxWidth, start, min = 22) {
  let size = start;
  while (size > min) {
    ctx.font = `700 ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

async function buildRatingCard(character, snapshot, evaluation, comparison = null) {
  const width = 1100;
  const height = 620;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#11131a');
  gradient.addColorStop(1, '#202636');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const artUrl = characterArtUrl(character);
  if (artUrl) {
    try {
      const art = await loadImage(artUrl);
      ctx.save();
      ctx.globalAlpha = 0.32;
      const scale = Math.max(430 / art.width, height / art.height);
      const dw = art.width * scale;
      const dh = art.height * scale;
      ctx.drawImage(art, 0, 0, art.width, art.height, width - dw, (height - dh) / 2, dw, dh);
      ctx.restore();
    } catch {}
  }

  ctx.fillStyle = '#f3f4f7';
  const titleSize = fit(ctx, snapshot.name || 'Build', 650, 48);
  ctx.font = `700 ${titleSize}px sans-serif`;
  ctx.fillText(snapshot.name || 'Build', 55, 82);
  ctx.font = '500 25px sans-serif';
  ctx.fillStyle = '#aeb5c4';
  ctx.fillText(`Lv.${snapshot.level ?? '?'}  •  C${snapshot.constellation ?? 0}  •  ${snapshot.weapon?.name || 'No weapon data'}`, 55, 124);

  ctx.fillStyle = '#f3f4f7';
  ctx.font = '800 88px sans-serif';
  ctx.fillText(`${evaluation.score}%`, 55, 244);
  ctx.font = '600 24px sans-serif';
  ctx.fillStyle = '#aeb5c4';
  ctx.fillText('Neverless Build Score', 58, 282);

  if (comparison) {
    const sign = comparison.scoreDelta > 0 ? '+' : '';
    ctx.font = '700 28px sans-serif';
    ctx.fillStyle = comparison.scoreDelta >= 0 ? '#a6e3a1' : '#f38ba8';
    ctx.fillText(`${sign}${comparison.scoreDelta}% from previous check`, 58, 330);
  }

  const stats = [
    ['ATK', snapshot.stats?.atk],
    ['CRIT Rate', snapshot.stats?.critRate != null ? `${snapshot.stats.critRate}%` : null],
    ['CRIT DMG', snapshot.stats?.critDmg != null ? `${snapshot.stats.critDmg}%` : null],
    ['ER', snapshot.stats?.er != null ? `${snapshot.stats.er}%` : null],
    ['EM', snapshot.stats?.em],
  ];
  let y = 395;
  ctx.font = '600 25px sans-serif';
  for (const [label, value] of stats) {
    if (value == null) continue;
    ctx.fillStyle = '#aeb5c4';
    ctx.fillText(label, 58, y);
    ctx.fillStyle = '#f3f4f7';
    ctx.fillText(String(value), 245, y);
    y += 42;
  }

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(520, 92, 2, 445);
  ctx.font = '700 25px sans-serif';
  ctx.fillStyle = '#f3f4f7';
  ctx.fillText('Build checks', 560, 138);
  ctx.font = '500 22px sans-serif';
  let ny = 182;
  for (const note of evaluation.notes.slice(0, 6)) {
    ctx.fillStyle = note.type === 'down' ? '#f38ba8' : note.type === 'warn' ? '#f9e2af' : '#a6e3a1';
    ctx.fillText(note.type === 'down' ? '↓' : note.type === 'warn' ? '!' : '✓', 560, ny);
    ctx.fillStyle = '#d8dbe4';
    ctx.fillText(note.text.slice(0, 42), 596, ny);
    ny += 44;
  }

  ctx.font = '500 18px sans-serif';
  ctx.fillStyle = '#7f8798';
  ctx.fillText('Stats from Enka.Network • Score uses published build targets', 560, 555);

  return canvas.toBuffer('image/png');
}

module.exports = { buildRatingCard, characterArtUrl };
