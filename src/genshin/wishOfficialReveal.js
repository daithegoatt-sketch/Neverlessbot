'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { getCharacter, getWeapon } = require('./dataClient');

// This renderer ports the public WishSimulator.App reveal timing/style:
// SplashArt: 0% scale(5)+brightness(0), 20-75% silhouette, 95-100% full color.
// SplashLight: expanding rarity-colored radial light; name/stars appear after the art settles.
// Summary cards use the same 3/4/5-star vertical gradients as ResultList.
// It is deliberately isolated from Neverless' other Genshin renderers.

const metaCache = new Map();
const imageCache = new Map();
const revealCache = new Map();
const MAX_GIF_BYTES = 9 * 1024 * 1024;

function rarityColor(rarity) {
  if (rarity >= 5) return { rgb: [251, 193, 60], edge: '#f9aa02', embed: 0xf4c65a };
  if (rarity === 4) return { rgb: [156, 71, 218], edge: '#c44dda', embed: 0x9e68e8 };
  return { rgb: [99, 124, 205], edge: '#aac8f1', embed: 0x6aa9ff };
}

async function itemMeta(item) {
  const key = `${item.type}:${item.name}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const promise = (item.type === 'character' ? getCharacter(item.name) : getWeapon(item.name))
    .catch(() => null);
  metaCache.set(key, promise);
  return promise;
}

function itemImageUrl(item, data) {
  const images = data?.images || {};
  if (item.type === 'character') {
    return images.card || images.portrait || images.icon || images['hoyolab-avatar'] || null;
  }
  return images.image || images.icon || images.awakenicon || null;
}

async function remoteImage(url) {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url);
  const promise = (async () => {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Neverless-Wish/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return loadImage(Buffer.from(await response.arrayBuffer())).catch(() => null);
  })().catch(() => null);
  imageCache.set(url, promise);
  return promise;
}

function descriptionFor(item, data) {
  return String(data?.description || data?.descriptionRaw || data?.story || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 650);
}

function drawContain(ctx, image, x, y, width, height, scaleMultiplier = 1) {
  if (!image) return;
  const scale = Math.min(width / image.width, height / image.height) * scaleMultiplier;
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

function easeOutCubic(t) {
  const p = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - p, 3);
}

function drawSplashLight(ctx, width, height, rarity, t) {
  const { rgb } = rarityColor(rarity);
  const [r, g, b] = rgb;
  const cx = width * 0.53;
  const cy = height * 0.50;
  const inT = Math.min(1, t / 0.55);
  const pulse = Math.sin(inT * Math.PI);
  const maxR = Math.min(width, height) * (0.34 + inT * 0.55);

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
  glow.addColorStop(0, `rgba(255,255,255,${0.75 * pulse})`);
  glow.addColorStop(0.18, `rgba(${r},${g},${b},${0.65 * pulse})`);
  glow.addColorStop(0.52, `rgba(${r},${g},${b},${0.20 * pulse})`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // WishSimulator SplashLight uses four expanding circular layers with different durations.
  for (let i = 0; i < 4; i += 1) {
    const lag = i * 0.035;
    const p = easeOutCubic(Math.max(0, Math.min(1, (t - lag) / (0.48 + i * 0.04))));
    if (p <= 0) continue;
    ctx.globalAlpha = (1 - p) * 0.42;
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = 5 - i * 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, 30 + p * (160 + i * 75), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBackground(ctx, width, height, rarity) {
  const { rgb } = rarityColor(rarity);
  const [r, g, b] = rgb;
  const bg = ctx.createRadialGradient(width * 0.54, height * 0.52, 10, width * 0.54, height * 0.52, width * 0.72);
  bg.addColorStop(0, `rgb(${Math.round(r * 0.32)},${Math.round(g * 0.32)},${Math.round(b * 0.32)})`);
  bg.addColorStop(0.45, '#172039');
  bg.addColorStop(1, '#080b15');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Thin rays match the in-game/WishSimulator reveal field, with no Neverless branding.
  ctx.save();
  ctx.translate(width * 0.53, height * 0.5);
  ctx.strokeStyle = `rgba(${r},${g},${b},0.24)`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 28; i += 1) {
    ctx.rotate(Math.PI / 14);
    ctx.beginPath();
    ctx.moveTo(35, 0);
    ctx.lineTo(width * 0.78, 0);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStars(ctx, count, x, y, alpha, scale = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f7cf33';
  ctx.font = `700 ${36 * scale}px sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 5;
  ctx.fillText('★'.repeat(count), x, y);
  ctx.restore();
}

function renderRevealFrame(item, image, frame, frames) {
  const width = 960;
  const height = 540;
  const t = frame / Math.max(1, frames - 1);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, width, height, item.rarity);
  drawSplashLight(ctx, width, height, item.rarity, t);

  // Exact timing curve ported from WishSimulator.App SplashArt keyframes.
  let scale;
  let brightness;
  let translateX = 0;
  if (t <= 0.20) {
    const p = easeOutCubic(t / 0.20);
    scale = 5 - 4 * p;
    brightness = 0;
  } else if (t <= 0.75) {
    scale = 1;
    brightness = 0;
  } else if (t <= 0.95) {
    const p = (t - 0.75) / 0.20;
    scale = 1;
    brightness = p;
    translateX = 18 * p;
  } else {
    scale = 1;
    brightness = 1;
    translateX = 18;
  }

  if (image) {
    const box = item.type === 'character'
      ? { x: 175 + translateX, y: 5, w: 720, h: 525, mult: 1.03 }
      : { x: 260 + translateX, y: 35, w: 570, h: 460, mult: 0.96 };

    ctx.save();
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
    if (brightness < 0.985) {
      // Canvas has no CSS brightness filter parity; render the silhouette exactly as WishSimulator does.
      ctx.globalAlpha = 0.98;
      drawContain(ctx, image, box.x, box.y, box.w, box.h, box.mult);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = `rgb(${Math.round(255 * brightness)},${Math.round(255 * brightness)},${Math.round(255 * brightness)})`;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = item.type === 'weapon' ? 18 : 8;
      drawContain(ctx, image, box.x, box.y, box.w, box.h, box.mult);
    }
    ctx.restore();
  }

  // WishSimulator ItemInfo starts the name at ~1.3s and stars at 2.0s.
  const nameAlpha = Math.max(0, Math.min(1, (t - 0.68) / 0.18));
  const starAlpha = Math.max(0, Math.min(1, (t - 0.82) / 0.14));
  if (nameAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = nameAlpha;
    ctx.fillStyle = '#fff';
    ctx.font = '700 40px sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 8;
    const name = String(item.name || 'Unknown');
    ctx.fillText(name.length > 28 ? `${name.slice(0, 27)}…` : name, 48 + (1 - nameAlpha) * 22, 415);
    ctx.restore();
  }
  drawStars(ctx, item.rarity, 48, 463, starAlpha, 0.9);
  return canvas.toBuffer('image/png');
}

async function encodeGif(item, image) {
  if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE');
  const fps = 12;
  const frames = 27; // 2.25 seconds, enough to preserve the 1.5s SplashArt + star reveal.
  const filter = [
    '[0:v]split[a][b]',
    '[a]palettegen=max_colors=96:stats_mode=diff[p]',
    '[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]',
  ].join(';');
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', filter, '-map', '[v]', '-loop', '0', '-f', 'gif', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const chunks = [];
  const errors = [];
  let size = 0;
  let tooLarge = false;
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_GIF_BYTES) {
      tooLarge = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  child.stderr.on('data', (chunk) => errors.push(chunk));

  for (let i = 0; i < frames; i += 1) {
    const png = renderRevealFrame(item, image, i, frames);
    if (!child.stdin.write(png)) await once(child.stdin, 'drain');
  }
  child.stdin.end();
  const [code] = await once(child, 'close');
  if (tooLarge) throw new Error('WISH_REVEAL_GIF_TOO_LARGE');
  if (code !== 0) throw new Error(`WISH_REVEAL_FFMPEG_${code}: ${Buffer.concat(errors).toString('utf8').slice(0, 350)}`);
  const gif = Buffer.concat(chunks);
  if (!gif.length) throw new Error('WISH_REVEAL_GIF_EMPTY');
  return gif;
}

async function renderOfficialRevealGif(item) {
  const key = `${item.type}:${item.name}:${item.rarity}`;
  if (revealCache.has(key)) return revealCache.get(key);
  const promise = (async () => {
    const data = await itemMeta(item);
    const image = await remoteImage(itemImageUrl(item, data));
    if (!image) throw new Error(`WISH_REVEAL_IMAGE_MISSING:${item.name}`);
    return encodeGif(item, image);
  })();
  revealCache.set(key, promise);
  try { return await promise; } catch (error) { revealCache.delete(key); throw error; }
}

async function getOfficialRevealInfo(item) {
  const data = await itemMeta(item);
  return {
    description: descriptionFor(item, data),
    embedColor: rarityColor(item.rarity).embed,
  };
}

async function renderOfficialSummary(results) {
  // Port of WishSimulator ResultList: 10 tall, narrow result cards in one row.
  const width = 1600;
  const height = 620;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#e9eef5');
  bg.addColorStop(0.5, '#bcc8d9');
  bg.addColorStop(1, '#edf1f5');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const prepared = await Promise.all(results.map(async (item) => {
    const data = await itemMeta(item);
    return { item, image: await remoteImage(itemImageUrl(item, data)) };
  }));

  const cardW = 142;
  const cardH = 500;
  const gap = 10;
  const totalW = prepared.length * cardW + (prepared.length - 1) * gap;
  const startX = (width - totalW) / 2;
  const y = 58;

  for (let i = 0; i < prepared.length; i += 1) {
    const { item, image } = prepared[i];
    const x = startX + i * (cardW + gap);
    const { edge } = rarityColor(item.rarity);
    const grad = ctx.createLinearGradient(x, y, x, y + cardH);
    if (item.rarity >= 5) {
      grad.addColorStop(0, '#f9aa02'); grad.addColorStop(0.48, '#fff'); grad.addColorStop(1, '#f9aa02');
    } else if (item.rarity === 4) {
      grad.addColorStop(0, '#c44dda'); grad.addColorStop(0.48, '#fff'); grad.addColorStop(1, '#c44dda');
    } else {
      grad.addColorStop(0, '#aac8f1'); grad.addColorStop(0.48, '#fff'); grad.addColorStop(1, '#aac8f1');
    }
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(x, y, cardW, cardH, 12); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.roundRect(x + 4, y + 4, cardW - 8, cardH - 8, 10); ctx.clip();
    const inner = ctx.createLinearGradient(x, y, x, y + cardH);
    inner.addColorStop(0, '#596476'); inner.addColorStop(0.62, '#293747'); inner.addColorStop(1, '#182230');
    ctx.fillStyle = inner; ctx.fillRect(x + 4, y + 4, cardW - 8, cardH - 8);
    if (image) {
      const mult = item.type === 'character' ? 1.7 : 1.05;
      drawContain(ctx, image, x + 7, y + 12, cardW - 14, cardH - 90, mult);
    }
    const shade = ctx.createLinearGradient(0, y + cardH - 165, 0, y + cardH);
    shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,0.75)');
    ctx.fillStyle = shade; ctx.fillRect(x + 4, y + cardH - 170, cardW - 8, 166);
    ctx.restore();

    ctx.fillStyle = edge;
    ctx.fillRect(x + 4, y + cardH - 8, cardW - 8, 4);
    ctx.fillStyle = '#f7cf33';
    ctx.font = '700 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('★'.repeat(item.rarity), x + cardW / 2, y + cardH - 28);
  }
  ctx.textAlign = 'start';
  return canvas.toBuffer('image/png');
}

module.exports = {
  getOfficialRevealInfo,
  renderOfficialRevealGif,
  renderOfficialSummary,
  rarityColor,
};
