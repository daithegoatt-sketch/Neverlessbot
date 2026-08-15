'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { formatStat, formatTarget } = require('./statProfile');

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

function enkaAsset(filename) {
  if (typeof filename !== 'string' || !filename.trim()) return null;
  if (/^https?:\/\//.test(filename)) return filename;
  if (!/^UI_/i.test(filename)) return null;
  return `https://enka.network/ui/${filename.replace(/\.png$/i, '')}.png`;
}

function dbArtUrl(characterData) {
  const images = characterData?.images || {};
  const prioritizedKeys = [
    'filename_gachaSplash', 'filename_gachasplash', 'filename_gachaSlice', 'filename_gachaslice',
    'filename_icon', 'filename_sideIcon', 'filename_sideicon',
  ];
  for (const key of prioritizedKeys) {
    const url = enkaAsset(images[key] || characterData?.[key]);
    if (url) return url;
  }
  const entries = Object.entries(images);
  entries.sort(([a], [b]) => {
    const rank = (key) => /gacha.*splash/i.test(key) ? 0 : /gacha/i.test(key) ? 1 : /icon/i.test(key) ? 2 : 3;
    return rank(a) - rank(b);
  });
  for (const [, value] of entries) {
    const url = enkaAsset(value);
    if (url) return url;
  }
  return null;
}

function characterArtUrl(character, characterData = null) {
  const db = dbArtUrl(characterData);
  if (db) return db;
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

async function loadRemoteImage(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'NeverlessBot/4.0 build-card' },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    return loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

function fit(ctx, text, maxWidth, start, min = 20) {
  let size = start;
  while (size > min) {
    ctx.font = `700 ${size}px serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function scoreLabel(score) {
  if (score >= 95) return 'Elite';
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Strong';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Average';
  if (score >= 45) return 'Needs Work';
  return 'Incomplete';
}

function polygon(ctx, points, fill, stroke) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}

function radarPoints(cx, cy, radius, values) {
  const n = values.length;
  return values.map((value, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / n;
    const r = radius * Math.max(0, Math.min(1.08, value));
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  });
}

function drawRadar(ctx, evaluation, x, y, radius) {
  const rows = evaluation.relevantStats.slice(0, 6);
  if (rows.length < 3) return;
  const n = rows.length;

  for (const scale of [0.33, 0.66, 1]) {
    polygon(ctx, radarPoints(x, y, radius, Array(n).fill(scale)), null, 'rgba(210,216,230,0.22)');
  }
  for (let i = 0; i < n; i += 1) {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / n;
    ctx.strokeStyle = 'rgba(210,216,230,0.18)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    ctx.stroke();
  }

  // Gray polygon = published target baseline. Current build = blue polygon.
  polygon(ctx, radarPoints(x, y, radius, Array(n).fill(1)), 'rgba(205,211,224,0.15)', 'rgba(205,211,224,0.55)');
  const current = rows.map((row) => {
    const target = row.target;
    const ideal = target.max > target.min ? (target.min + target.max) / 2 : target.min;
    return ideal > 0 ? row.value / ideal : 0;
  });
  polygon(ctx, radarPoints(x, y, radius, current), 'rgba(93,156,236,0.28)', 'rgba(121,178,248,0.95)');

  ctx.font = '600 17px serif';
  ctx.fillStyle = '#cbd2e2';
  rows.forEach((row, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / n;
    const tx = x + Math.cos(angle) * (radius + 30);
    const ty = y + Math.sin(angle) * (radius + 30);
    ctx.textAlign = tx < x - 10 ? 'right' : tx > x + 10 ? 'left' : 'center';
    ctx.textBaseline = ty < y ? 'bottom' : 'top';
    ctx.fillText(row.label.replace('CRIT ', 'C.'), tx, ty);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

async function buildRatingCard(character, snapshot, evaluation, comparison = null, options = {}) {
  const width = 1200;
  const height = 700;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#10131b');
  gradient.addColorStop(1, '#222a3a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const artUrl = characterArtUrl(character, options.characterData);
  const art = await loadRemoteImage(artUrl);
  if (art) {
    const panelWidth = 410;
    const scale = Math.max(panelWidth / art.width, height / art.height);
    const dw = art.width * scale;
    const dh = art.height * scale;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(art, (panelWidth - dw) / 2, (height - dh) / 2, dw, dh);
    const fade = ctx.createLinearGradient(180, 0, 430, 0);
    fade.addColorStop(0, 'rgba(16,19,27,0.05)');
    fade.addColorStop(1, 'rgba(16,19,27,1)');
    ctx.fillStyle = fade;
    ctx.fillRect(170, 0, 280, height);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fillRect(0, 0, 390, height);
  }

  const left = 410;
  ctx.fillStyle = '#f4f6fb';
  const titleSize = fit(ctx, snapshot.name || 'Build', 440, 46);
  ctx.font = `700 ${titleSize}px serif`;
  ctx.fillText(snapshot.name || 'Build', left, 72);
  ctx.font = '500 22px serif';
  ctx.fillStyle = '#aeb7c9';
  ctx.fillText(`Lv.${snapshot.level ?? '?'} • C${snapshot.constellation ?? 0} • ${snapshot.weapon?.name || 'No weapon'}`, left, 108);

  ctx.fillStyle = '#f4f6fb';
  ctx.font = '800 72px serif';
  ctx.fillText(`${evaluation.score}%`, left, 190);
  ctx.font = '600 23px serif';
  ctx.fillStyle = '#aeb7c9';
  ctx.fillText(`Neverless Rating • ${scoreLabel(evaluation.score)}`, left + 155, 181);
  if (Number.isFinite(options.akashaPercentile)) {
    ctx.font = '600 20px serif';
    ctx.fillStyle = '#bac8e8';
    ctx.fillText(`Akasha artifacts: Top ${options.akashaPercentile}%`, left + 155, 210);
  }

  const rows = evaluation.relevantStats.slice(0, 6);
  let sy = 270;
  ctx.font = '700 21px serif';
  ctx.fillStyle = '#dce2ee';
  ctx.fillText('Relevant stats', left, sy);
  sy += 38;
  for (const row of rows) {
    ctx.font = '600 20px serif';
    ctx.fillStyle = '#aeb7c9';
    ctx.fillText(row.label, left, sy);
    ctx.fillStyle = row.status === 'down' ? '#f0a6b6' : row.status === 'warn' ? '#ead49b' : '#e9edf5';
    ctx.fillText(formatStat(row.key, row.value), left + 150, sy);
    ctx.fillStyle = '#8f9aae';
    ctx.font = '500 18px serif';
    ctx.fillText(`target ${formatTarget(row.target)}`, left + 285, sy);
    sy += 42;
  }

  if (!rows.length) {
    ctx.font = '500 20px serif';
    ctx.fillStyle = '#aeb7c9';
    ctx.fillText('No reliable numeric target profile was published.', left, sy);
  }

  const radarX = 970;
  const radarY = 360;
  drawRadar(ctx, evaluation, radarX, radarY, 135);
  ctx.font = '500 17px serif';
  ctx.fillStyle = '#8f9aae';
  ctx.textAlign = 'center';
  ctx.fillText('gray = published target • blue = your build', radarX, 555);
  ctx.textAlign = 'left';

  if (comparison) {
    const sign = comparison.scoreDelta > 0 ? '+' : '';
    ctx.font = '700 22px serif';
    ctx.fillStyle = comparison.scoreDelta > 0 ? '#a6e3a1' : comparison.scoreDelta < 0 ? '#f0a6b6' : '#c2cada';
    ctx.fillText(`Previous ${comparison.previousScore}% → ${comparison.currentScore}% (${sign}${comparison.scoreDelta}%)`, left, 625);
  } else {
    ctx.font = '500 18px serif';
    ctx.fillStyle = '#7f899d';
    ctx.fillText(`Artifacts ${evaluation.artifactCount}/5 • Avg +${evaluation.artifactAvgLevel} • Main Stats ${evaluation.mainStatScore}% • Set ${evaluation.artifactSetScore}%`, left, 625);
  }

  ctx.font = '500 16px serif';
  ctx.fillStyle = '#6f788b';
  ctx.fillText('Enka build data • published target ranges • Akasha percentile is artifact-leaderboard context only', left, 664);

  return canvas.toBuffer('image/png');
}

module.exports = { buildRatingCard, characterArtUrl, dbArtUrl };
