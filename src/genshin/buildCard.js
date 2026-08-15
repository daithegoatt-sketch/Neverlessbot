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

function characterArtUrl(character, characterData = null, snapshot = null) {
  if (snapshot?.artUrl) return snapshot.artUrl;
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
      headers: { 'user-agent': 'NeverlessBot/5.0 build-card' },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    return loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

function fit(ctx, text, maxWidth, start, min = 16, weight = 700) {
  let size = start;
  while (size > min) {
    ctx.font = `${weight} ${size}px serif`;
    if (ctx.measureText(String(text)).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function roundedRect(ctx, x, y, w, h, r = 20) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
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
  const rows = evaluation?.relevantStats?.slice(0, 6) || [];
  if (rows.length < 3) return false;
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
  polygon(ctx, radarPoints(x, y, radius, Array(n).fill(1)), 'rgba(205,211,224,0.14)', 'rgba(205,211,224,0.58)');
  const current = rows.map((row) => {
    const ideal = row.target.max > row.target.min ? (row.target.min + row.target.max) / 2 : row.target.min;
    return ideal > 0 ? row.value / ideal : 0;
  });
  polygon(ctx, radarPoints(x, y, radius, current), 'rgba(93,156,236,0.30)', 'rgba(121,178,248,0.98)');
  ctx.font = '600 15px serif';
  ctx.fillStyle = '#cbd2e2';
  rows.forEach((row, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / n;
    const tx = x + Math.cos(angle) * (radius + 24);
    const ty = y + Math.sin(angle) * (radius + 24);
    ctx.textAlign = tx < x - 10 ? 'right' : tx > x + 10 ? 'left' : 'center';
    ctx.textBaseline = ty < y ? 'bottom' : 'top';
    ctx.fillText(row.label.replace('CRIT ', 'C.'), tx, ty);
  });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return true;
}

const ALL_STAT_ROWS = [
  ['hp', 'HP'], ['atk', 'ATK'], ['def', 'DEF'], ['em', 'Elemental Mastery'],
  ['critRate', 'CRIT Rate'], ['critDmg', 'CRIT DMG'], ['er', 'Energy Recharge'], ['elementalDmg', 'Element DMG'],
];

function allStats(snapshot) {
  return ALL_STAT_ROWS.filter(([key]) => Number.isFinite(snapshot?.stats?.[key])).map(([key, label]) => ({ key, label, value: snapshot.stats[key] }));
}

function drawStatList(ctx, rows, x, y, options = {}) {
  const targetMap = new Map((options.evaluation?.relevantStats || []).map((row) => [row.key, row]));
  let cy = y;
  for (const row of rows.slice(0, 8)) {
    ctx.font = '600 20px serif';
    ctx.fillStyle = '#aeb8cb';
    ctx.fillText(row.label, x, cy);
    ctx.fillStyle = '#f4f7fc';
    ctx.font = '700 21px serif';
    const value = row.key === 'elementalDmg'
      ? `${Math.round(row.value * 10) / 10}%`
      : formatStat(row.key, row.value);
    ctx.fillText(value, x + 195, cy);
    const target = targetMap.get(row.key);
    if (target && options.showTargets) {
      ctx.font = '500 16px serif';
      ctx.fillStyle = target.status === 'down' ? '#ef9bad' : '#8290a8';
      ctx.fillText(`target ${formatTarget(target.target)}`, x + 315, cy);
    }
    cy += 36;
  }
  return cy;
}

function shortStatName(value) {
  return String(value || '')
    .replace(/CRIT Rate/gi, 'CR')
    .replace(/CRIT DMG/gi, 'CD')
    .replace(/Energy Recharge/gi, 'ER')
    .replace(/Elemental Mastery/gi, 'EM')
    .replace(/Bonus/gi, '')
    .trim();
}

async function drawArtifactCard(ctx, artifact, image, x, y, w, h) {
  roundedRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = 'rgba(20,25,36,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(151,166,194,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const imageH = 95;
  if (image) {
    const scale = Math.min((w - 12) / image.width, imageH / image.height);
    const dw = image.width * scale;
    const dh = image.height * scale;
    ctx.drawImage(image, x + (w - dw) / 2, y + 8 + (imageH - dh) / 2, dw, dh);
  }

  ctx.font = '700 15px serif';
  ctx.fillStyle = '#f2f5fb';
  ctx.fillText(`+${artifact?.level ?? '?'}`, x + 10, y + 116);
  const main = shortStatName(artifact?.mainStat || '?');
  const mainSize = fit(ctx, main, w - 20, 15, 11, 700);
  ctx.font = `700 ${mainSize}px serif`;
  ctx.fillText(main, x + 10, y + 140);
  if (artifact?.mainValue) {
    ctx.font = '600 14px serif';
    ctx.fillStyle = '#cbd4e6';
    ctx.fillText(String(artifact.mainValue), x + 10, y + 159);
  }

  ctx.font = '500 12px serif';
  let sy = y + 182;
  for (const sub of (artifact?.substats || []).slice(0, 4)) {
    ctx.fillStyle = '#aeb8cb';
    const name = shortStatName(sub.name).slice(0, 13);
    ctx.fillText(`${name} ${sub.value}`, x + 10, sy);
    sy += 17;
  }
}

function setSummary(snapshot) {
  return Object.entries(snapshot?.setCounts || {})
    .sort((a, b) => b[1] - a[1])
    .filter(([, count]) => count >= 2)
    .map(([name, count]) => `${count}pc ${name}`)
    .join(' • ');
}

async function buildAccountCard(character, snapshot, evaluation = null, comparison = null, options = {}) {
  const mode = options.mode === 'stats' ? 'stats' : 'rating';
  const width = 1400;
  const height = 920;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#10131b');
  gradient.addColorStop(0.58, '#171d29');
  gradient.addColorStop(1, '#202a3d');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const artUrl = characterArtUrl(character, options.characterData, snapshot);
  const [art, weaponImage, ...artifactImages] = await Promise.all([
    loadRemoteImage(artUrl),
    loadRemoteImage(snapshot?.weapon?.iconUrl || snapshot?.weapon?.splashUrl),
    ...(snapshot?.artifacts || []).slice(0, 5).map((artifact) => loadRemoteImage(artifact.iconUrl)),
  ]);

  const artPanel = 500;
  if (art) {
    const scale = Math.max(artPanel / art.width, 600 / art.height);
    const dw = art.width * scale;
    const dh = art.height * scale;
    ctx.save();
    ctx.globalAlpha = 0.98;
    ctx.drawImage(art, (artPanel - dw) / 2, (600 - dh) / 2, dw, dh);
    const fade = ctx.createLinearGradient(220, 0, 520, 0);
    fade.addColorStop(0, 'rgba(16,19,27,0.02)');
    fade.addColorStop(1, 'rgba(16,19,27,0.97)');
    ctx.fillStyle = fade;
    ctx.fillRect(200, 0, 340, 600);
    ctx.restore();
  }

  // Header / identity.
  const left = 520;
  ctx.fillStyle = '#f4f6fb';
  const titleSize = fit(ctx, snapshot?.name || 'Build', 420, 42, 26);
  ctx.font = `700 ${titleSize}px serif`;
  ctx.fillText(snapshot?.name || 'Build', left, 58);
  ctx.font = '500 19px serif';
  ctx.fillStyle = '#aeb7c9';
  ctx.fillText(`Lv.${snapshot?.level ?? '?'} • C${snapshot?.constellation ?? 0}`, left, 90);

  if (mode === 'rating' && evaluation) {
    roundedRect(ctx, 1130, 30, 225, 90, 18);
    ctx.fillStyle = 'rgba(35,44,62,0.86)';
    ctx.fill();
    ctx.font = '800 45px serif';
    ctx.fillStyle = '#f4f7fc';
    ctx.fillText(`${evaluation.score}%`, 1150, 82);
    ctx.font = '600 16px serif';
    ctx.fillStyle = '#aeb8cb';
    ctx.fillText(scoreLabel(evaluation.score), 1255, 78);
    if (Number.isFinite(options.akashaPercentile)) {
      ctx.font = '500 13px serif';
      ctx.fillStyle = '#91a5c8';
      ctx.fillText(`Akasha Top ${options.akashaPercentile}%`, 1255, 99);
    }
  }

  // Weapon block.
  roundedRect(ctx, left, 120, 505, 128, 18);
  ctx.fillStyle = 'rgba(22,28,40,0.82)';
  ctx.fill();
  if (weaponImage) {
    const max = 105;
    const scale = Math.min(max / weaponImage.width, max / weaponImage.height);
    const dw = weaponImage.width * scale;
    const dh = weaponImage.height * scale;
    ctx.drawImage(weaponImage, left + 10 + (108 - dw) / 2, 130 + (108 - dh) / 2, dw, dh);
  }
  ctx.font = '700 20px serif';
  ctx.fillStyle = '#eef2fa';
  const weaponName = snapshot?.weapon?.name || 'No weapon data';
  const ws = fit(ctx, weaponName, 345, 20, 14);
  ctx.font = `700 ${ws}px serif`;
  ctx.fillText(weaponName, left + 125, 165);
  ctx.font = '500 17px serif';
  ctx.fillStyle = '#aeb8cb';
  ctx.fillText(`Lv.${snapshot?.weapon?.level ?? '?'} • R${snapshot?.weapon?.refinement ?? '?'}`, left + 125, 196);
  if (snapshot?.weapon?.rarity) {
    ctx.fillStyle = '#e3c66a';
    ctx.font = '600 15px serif';
    ctx.fillText('★'.repeat(Math.min(5, Number(snapshot.weapon.rarity) || 0)), left + 125, 220);
  }

  // Stats: vertical, Enka-like. Rating mode highlights only the useful targets; stats mode shows the full panel.
  ctx.font = '700 20px serif';
  ctx.fillStyle = '#f1f4fa';
  ctx.fillText(mode === 'rating' ? 'Build Stats' : 'Account Stats', left, 286);
  const rows = mode === 'rating' && evaluation?.relevantStats?.length
    ? evaluation.relevantStats.map((row) => ({ key: row.key, label: row.label, value: row.value }))
    : allStats(snapshot);
  drawStatList(ctx, rows, left, 320, { evaluation, showTargets: mode === 'rating' });

  // Radar only belongs to rating/analysis. Stats-only requests contain no evaluation graphic.
  if (mode === 'rating' && evaluation) {
    const drew = drawRadar(ctx, evaluation, 1160, 360, 118);
    if (drew) {
      ctx.font = '500 14px serif';
      ctx.fillStyle = '#8491a7';
      ctx.textAlign = 'center';
      ctx.fillText('gray target • blue current', 1160, 535);
      ctx.textAlign = 'left';
    }
  }

  const sets = setSummary(snapshot);
  ctx.font = '600 17px serif';
  ctx.fillStyle = '#9da9bd';
  ctx.fillText(sets || 'Artifact sets: no active 2pc/4pc set detected', left, 574);

  // Artifact row closely mirrors Enka/Akasha build cards.
  const artifacts = (snapshot?.artifacts || []).slice(0, 5);
  const cardY = 615;
  const gap = 12;
  const cardW = 166;
  const cardH = 270;
  const rowWidth = cardW * 5 + gap * 4;
  const startX = Math.max(25, width - rowWidth - 24);
  for (let i = 0; i < 5; i += 1) {
    const artifact = artifacts[i] || { slot: ['flower','plume','sands','goblet','circlet'][i], level: null, mainStat: 'Empty', substats: [] };
    await drawArtifactCard(ctx, artifact, artifactImages[i] || null, startX + i * (cardW + gap), cardY, cardW, cardH);
  }

  // Left-bottom metadata keeps the art visible but gives the card context.
  roundedRect(ctx, 28, 625, 455, 255, 20);
  ctx.fillStyle = 'rgba(13,17,25,0.76)';
  ctx.fill();
  ctx.font = '700 19px serif';
  ctx.fillStyle = '#f1f4fa';
  ctx.fillText(mode === 'rating' ? 'Neverless Build Analysis' : 'Enka Showcase Build', 52, 665);
  ctx.font = '500 16px serif';
  ctx.fillStyle = '#aab4c6';
  ctx.fillText(`Artifacts ${artifacts.length}/5`, 52, 700);
  ctx.fillText(`Weapon: ${weaponName}`, 52, 730);
  if (mode === 'rating' && evaluation) {
    ctx.fillText(`Main Stats ${evaluation.mainStatScore}% • Set ${evaluation.artifactSetScore}%`, 52, 760);
    const improvement = evaluation.notes?.find((note) => note.type === 'down' || note.type === 'warn');
    if (improvement) {
      ctx.font = '600 16px serif';
      ctx.fillStyle = '#e6c795';
      const line = String(improvement.text).slice(0, 48);
      ctx.fillText(`Next: ${line}`, 52, 798);
    }
    if (comparison) {
      const sign = comparison.scoreDelta > 0 ? '+' : '';
      ctx.font = '700 17px serif';
      ctx.fillStyle = comparison.scoreDelta > 0 ? '#a6e3a1' : comparison.scoreDelta < 0 ? '#f0a6b6' : '#c2cada';
      ctx.fillText(`Previous ${comparison.previousScore}% → ${comparison.currentScore}% (${sign}${comparison.scoreDelta}%)`, 52, 835);
    }
  } else {
    ctx.fillText('No rating or improvement analysis in stats mode.', 52, 765);
  }

  ctx.font = '500 13px serif';
  ctx.fillStyle = '#69758a';
  ctx.fillText('Live showcase data: Enka.Network', 52, 861);

  return canvas.toBuffer('image/png');
}

async function buildRatingCard(character, snapshot, evaluation, comparison = null, options = {}) {
  return buildAccountCard(character, snapshot, evaluation, comparison, { ...options, mode: 'rating' });
}

async function buildStatsCard(character, snapshot, options = {}) {
  return buildAccountCard(character, snapshot, null, null, { ...options, mode: 'stats' });
}

module.exports = { buildRatingCard, buildStatsCard, buildAccountCard, characterArtUrl, dbArtUrl };
