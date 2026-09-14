'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');

const THEME = Object.freeze({
  bg0: '#040913',
  bg1: '#07111f',
  panel: '#0c1827',
  panel2: '#101f31',
  stroke: '#29415e',
  strokeSoft: '#182a40',
  text: '#f3f7fb',
  muted: '#8398af',
  blue: '#5aa8ff',
  cyan: '#6bd8ff',
  green: '#39e39f',
  red: '#ff6378',
  gold: '#e4c36d',
  silver: '#c8d5e3',
});

const avatarCache = new Map();
const AVATAR_CACHE_TTL = 10 * 60 * 1000;
const AVATAR_CACHE_MAX = 300;

function roundRect(ctx, x, y, w, h, r = 20) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r, fill, stroke = null, lineWidth = 1) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function wave(ctx, width, height, color, alpha, offset, amplitude, thickness) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-80, height * 0.35 + offset);
  ctx.bezierCurveTo(
    width * 0.20, height * 0.15 + amplitude + offset,
    width * 0.46, height * 0.62 - amplitude + offset,
    width * 0.72, height * 0.35 + offset,
  );
  ctx.bezierCurveTo(
    width * 0.88, height * 0.18 + amplitude + offset,
    width * 1.05, height * 0.50 - amplitude + offset,
    width + 100, height * 0.30 + offset,
  );
  ctx.stroke();
  ctx.restore();
}

function baseCard(title, subtitle, width = 1000, height = 520, accent = THEME.blue) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, THEME.bg0);
  gradient.addColorStop(0.55, THEME.bg1);
  gradient.addColorStop(1, '#061526');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  wave(ctx, width, height, '#0f3c70', 0.28, -85, 70, 72);
  wave(ctx, width, height, '#2c78b7', 0.12, 45, 40, 44);
  wave(ctx, width, height, '#cbd8e6', 0.045, 170, 45, 30);

  fillRoundRect(ctx, 18, 18, width - 36, height - 36, 26, 'rgba(4, 10, 19, 0.76)', THEME.stroke, 2);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = THEME.text;
  ctx.font = '800 31px sans-serif';
  ctx.fillText(title, 54, 64);
  ctx.fillStyle = THEME.muted;
  ctx.font = '500 16px sans-serif';
  ctx.fillText(subtitle, 55, 91);

  fillRoundRect(ctx, width - 188, 40, 130, 36, 18, 'rgba(90,168,255,.10)', 'rgba(90,168,255,.38)');
  ctx.textAlign = 'center';
  ctx.fillStyle = THEME.silver;
  ctx.font = '700 13px sans-serif';
  ctx.fillText('NEVERLESS', width - 123, 63);
  ctx.textAlign = 'left';

  ctx.fillStyle = accent;
  ctx.fillRect(54, 109, width - 108, 2);
  ctx.globalAlpha = 0.18;
  ctx.fillRect(54, 113, width - 108, 1);
  ctx.globalAlpha = 1;

  return { canvas, ctx };
}

function fitText(ctx, text, maxWidth, startSize, minSize = 14, weight = 700) {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px sans-serif`;
    if (ctx.measureText(String(text)).width <= maxWidth) return size;
    size -= 1;
  }
  return minSize;
}

function rtlText(ctx, text, x, y, font = '700 20px sans-serif', color = THEME.text) {
  ctx.save();
  ctx.textAlign = 'right';
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

function centerText(ctx, text, x, y, font = '700 20px sans-serif', color = THEME.text) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

function metric(ctx, x, y, w, h, label, value, color = THEME.text) {
  fillRoundRect(ctx, x, y, w, h, 16, 'rgba(12,24,39,.90)', THEME.strokeSoft, 1.5);
  rtlText(ctx, label, x + w - 18, y + 26, '600 14px sans-serif', THEME.muted);
  rtlText(ctx, value, x + w - 18, y + 60, '800 25px sans-serif', color);
}

async function loadAvatarImage(user) {
  try {
    const url = user?.displayAvatarURL?.({ extension: 'png', size: 256 });
    if (!url) return null;
    const parsed = new URL(url);
    if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)) return null;

    const cached = avatarCache.get(url);
    if (cached && cached.expiresAt > Date.now()) return await cached.value;
    if (cached) avatarCache.delete(url);

    const value = loadImage(url).catch(() => null);
    avatarCache.set(url, { value, expiresAt: Date.now() + AVATAR_CACHE_TTL });
    if (avatarCache.size > AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value);
    return await value;
  } catch {
    return null;
  }
}

function drawAvatarImage(ctx, image, x, y, size, ring = THEME.blue) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (image) {
    const side = Math.min(image.width, image.height);
    ctx.drawImage(
      image,
      (image.width - side) / 2,
      (image.height - side) / 2,
      side,
      side,
      x,
      y,
      size,
      size,
    );
  } else {
    const gradient = ctx.createLinearGradient(x, y, x + size, y + size);
    gradient.addColorStop(0, '#173252');
    gradient.addColorStop(1, '#0a1727');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, size, size);
    ctx.textAlign = 'center';
    ctx.fillStyle = THEME.silver;
    ctx.font = `800 ${Math.round(size * 0.36)}px sans-serif`;
    ctx.fillText('N', x + size / 2, y + size * 0.64);
  }
  ctx.restore();
  ctx.strokeStyle = ring;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.stroke();
}

function playerName(user) {
  return user?.globalName || user?.username || 'Member';
}

function drawStatusPill(ctx, x, y, text, good) {
  const fill = good ? 'rgba(57,227,159,.12)' : 'rgba(255,99,120,.12)';
  const stroke = good ? 'rgba(57,227,159,.55)' : 'rgba(255,99,120,.55)';
  fillRoundRect(ctx, x, y, 154, 36, 18, fill, stroke, 1.5);
  ctx.fillStyle = good ? THEME.green : THEME.red;
  ctx.beginPath();
  ctx.arc(x + 22, y + 18, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.font = '700 14px sans-serif';
  ctx.fillText(text, x + 87, y + 23);
  ctx.textAlign = 'left';
}

function drawLineChart(ctx, values, x, y, w, h, color, options = {}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(3, (max - min) * 0.16);
  const lo = min - pad;
  const hi = max + pad;

  ctx.save();
  ctx.strokeStyle = 'rgba(115,150,184,.13)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const yy = y + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  }

  const points = values.map((value, index) => ({
    x: x + (w * index) / Math.max(1, values.length - 1),
    y: y + h - ((value - lo) / Math.max(1, hi - lo)) * h,
  }));

  const fill = ctx.createLinearGradient(0, y, 0, y + h);
  fill.addColorStop(0, `${color}38`);
  fill.addColorStop(1, `${color}00`);
  ctx.beginPath();
  ctx.moveTo(points[0].x, y + h);
  points.forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.lineTo(points.at(-1).x, y + h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = options.lineWidth || 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  points.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
  ctx.stroke();

  const last = points.at(-1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

module.exports = {
  THEME,
  baseCard,
  fillRoundRect,
  fitText,
  rtlText,
  centerText,
  metric,
  loadAvatarImage,
  drawAvatarImage,
  playerName,
  drawStatusPill,
  drawLineChart,
};
