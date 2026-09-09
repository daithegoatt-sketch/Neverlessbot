'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { getCharacter, getWeapon } = require('./dataClient');

const dataCache = new Map();
const imageCache = new Map();
const animationCache = new Map();

function rarityColors(rarity, capturingRadiance = false) {
  if (capturingRadiance) return { primary: '#ff89f8', secondary: '#7f5dff', dark: '#271642' };
  if (rarity >= 5) return { primary: '#ffd76a', secondary: '#f08a32', dark: '#39200f' };
  if (rarity === 4) return { primary: '#bd77ff', secondary: '#6e55df', dark: '#211643' };
  return { primary: '#6cdcff', secondary: '#4c7fff', dark: '#101f47' };
}

function drawCover(ctx, image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const sw = width / scale;
  const sh = height / scale;
  const sx = (image.width - sw) / 2;
  const sy = (image.height - sh) / 2;
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function drawContain(ctx, image, x, y, width, height) {
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

async function itemData(item) {
  const key = `${item.type}:${item.name}`;
  if (dataCache.has(key)) return dataCache.get(key);
  const promise = (item.type === 'character' ? getCharacter(item.name) : getWeapon(item.name))
    .catch(() => null);
  dataCache.set(key, promise);
  return promise;
}

function imageUrl(item, data) {
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
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Neverless-Wish/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      return loadImage(Buffer.from(await response.arrayBuffer()));
    } catch {
      return null;
    }
  })();
  imageCache.set(url, promise);
  return promise;
}

function starPath(ctx, x, y, outer, inner, rotation = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (Math.PI * i) / 5;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawCloud(ctx, x, y, scale, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  const circles = [
    [0, 20, 48], [45, 4, 58], [95, 17, 50], [140, 30, 42], [65, 38, 70],
  ];
  for (const [cx, cy, r] of circles) {
    ctx.beginPath();
    ctx.arc(x + cx * scale, y + cy * scale, r * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function renderAnimationFrame(frame, total, rarity, capturingRadiance) {
  const width = 960;
  const height = 540;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const colors = rarityColors(rarity, capturingRadiance);
  const t = frame / Math.max(1, total - 1);

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#08183c');
  sky.addColorStop(0.55, '#174aa0');
  sky.addColorStop(1, '#83caff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  drawCloud(ctx, -60, 355, 1.8, 0.72);
  drawCloud(ctx, 610, 390, 1.65, 0.78);
  drawCloud(ctx, 230, 430, 1.4, 0.55);

  // Opening vortex mirrors the in-game sequence: portal -> falling star -> rarity trail -> flash.
  if (t < 0.40) {
    const p = t / 0.40;
    const radius = 45 + p * 120;
    const glow = ctx.createRadialGradient(480, 120, 5, 480, 120, radius * 1.5);
    glow.addColorStop(0, '#ffffff');
    glow.addColorStop(0.18, '#bceaff');
    glow.addColorStop(0.55, 'rgba(91,159,255,0.58)');
    glow.addColorStop(1, 'rgba(20,70,160,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(480, 120, radius * 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(480, 120);
    ctx.rotate(p * Math.PI * 1.6);
    ctx.strokeStyle = 'rgba(220,244,255,0.8)';
    ctx.lineWidth = 4;
    for (let i = 0; i < 7; i += 1) {
      ctx.beginPath();
      ctx.arc(0, 0, radius - i * 11, i * 0.45, Math.PI * 1.15 + i * 0.45);
      ctx.stroke();
    }
    ctx.restore();
  }

  const flight = Math.max(0, Math.min(1, (t - 0.22) / 0.63));
  if (flight > 0) {
    const ease = 1 - Math.pow(1 - flight, 2.2);
    const x = 500 - ease * 500;
    const y = 135 + ease * 300;
    const trailColor = flight < 0.48 ? '#aeefff' : colors.primary;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const trail = ctx.createLinearGradient(x, y, x + 430, y - 235);
    trail.addColorStop(0, trailColor);
    trail.addColorStop(0.18, `${trailColor}cc`);
    trail.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.strokeStyle = trail;
    ctx.lineWidth = 18 + Math.sin(flight * Math.PI) * 16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 430, y - 235);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 320, y - 176);
    ctx.stroke();

    const glow = ctx.createRadialGradient(x, y, 2, x, y, 64);
    glow.addColorStop(0, '#ffffff');
    glow.addColorStop(0.18, trailColor);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 64, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    starPath(ctx, x, y, 17, 7);
    ctx.fill();
    ctx.restore();
  }

  if (t > 0.80) {
    const flash = (t - 0.80) / 0.20;
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, flash * 1.15)})`;
    ctx.fillRect(0, 0, width, height);
  }

  return canvas.toBuffer('image/png');
}

async function renderWishAnimation(rarity, capturingRadiance = false) {
  const key = `${rarity}:${capturingRadiance ? 1 : 0}`;
  if (animationCache.has(key)) return animationCache.get(key);

  const promise = (async () => {
    if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE');
    const fps = 20;
    const frames = 42;
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));

    for (let i = 0; i < frames; i += 1) {
      const frame = renderAnimationFrame(i, frames, rarity, capturingRadiance);
      if (!child.stdin.write(frame)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    const [code] = await once(child, 'close');
    if (code !== 0) throw new Error(`FFMPEG_WISH_${code}: ${Buffer.concat(errors).toString('utf8').slice(0, 300)}`);
    return Buffer.concat(chunks);
  })();

  animationCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    animationCache.delete(key);
    throw error;
  }
}

async function renderResultCard(item) {
  const canvas = createCanvas(960, 540);
  const ctx = canvas.getContext('2d');
  const colors = rarityColors(item.rarity, item.capturingRadiance);
  const bg = ctx.createLinearGradient(0, 0, 960, 540);
  bg.addColorStop(0, '#10111c');
  bg.addColorStop(0.55, colors.dark);
  bg.addColorStop(1, '#11111a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 960, 540);

  ctx.save();
  ctx.translate(590, 270);
  ctx.strokeStyle = `${colors.primary}45`;
  ctx.lineWidth = 3;
  for (let i = 0; i < 28; i += 1) {
    ctx.rotate(Math.PI / 14);
    ctx.beginPath();
    ctx.moveTo(45, 0);
    ctx.lineTo(420, 0);
    ctx.stroke();
  }
  ctx.restore();

  const data = await itemData(item);
  const image = await remoteImage(imageUrl(item, data));
  if (image) {
    ctx.save();
    ctx.globalAlpha = 0.98;
    if (item.type === 'character') drawContain(ctx, image, 390, 25, 535, 500);
    else drawContain(ctx, image, 465, 55, 430, 430);
    ctx.restore();
  }

  const shade = ctx.createLinearGradient(0, 0, 510, 0);
  shade.addColorStop(0, 'rgba(8,9,16,0.98)');
  shade.addColorStop(0.75, 'rgba(8,9,16,0.72)');
  shade.addColorStop(1, 'rgba(8,9,16,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 570, 540);

  ctx.fillStyle = colors.primary;
  ctx.font = '700 38px sans-serif';
  ctx.fillText('★'.repeat(item.rarity), 55, 95);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 44px sans-serif';
  const name = String(item.name || 'Unknown');
  ctx.fillText(name.length > 24 ? `${name.slice(0, 22)}…` : name, 55, 160);
  ctx.fillStyle = '#cfd5e7';
  ctx.font = '500 24px sans-serif';
  ctx.fillText(item.type === 'character' ? 'Character' : 'Weapon', 58, 205);
  ctx.fillText(`Owned: x${item.ownedCount || 1}`, 58, 245);
  if (item.featured) {
    ctx.fillStyle = colors.primary;
    ctx.font = '700 22px sans-serif';
    ctx.fillText(item.capturingRadiance ? 'Capturing Radiance • Featured' : 'Featured', 58, 295);
  }
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.8;
  ctx.font = '500 19px sans-serif';
  ctx.fillText(`5★ pity after pull: ${item.fivePityAfter ?? 0}`, 58, 450);
  ctx.fillText(`Neverless Wish Simulator`, 58, 487);
  ctx.globalAlpha = 1;
  return canvas.toBuffer('image/png');
}

async function renderSummary(results, fivePityAfter) {
  const width = 1200;
  const height = 620;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0e0f17';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 34px sans-serif';
  ctx.fillText('Wish x10 • Summary', 45, 52);
  ctx.fillStyle = '#c8cbd8';
  ctx.font = '500 20px sans-serif';
  ctx.fillText(`${fivePityAfter} pity`, 980, 52);

  const prepared = await Promise.all(results.map(async (item) => {
    const data = await itemData(item);
    return { item, image: await remoteImage(imageUrl(item, data)) };
  }));

  for (let i = 0; i < prepared.length; i += 1) {
    const { item, image } = prepared[i];
    const col = i % 5;
    const row = Math.floor(i / 5);
    const x = 40 + col * 232;
    const y = 82 + row * 255;
    const colors = rarityColors(item.rarity, item.capturingRadiance);
    const grad = ctx.createLinearGradient(x, y, x, y + 225);
    grad.addColorStop(0, colors.dark);
    grad.addColorStop(1, '#171822');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, 210, 225);
    ctx.fillStyle = colors.primary;
    ctx.fillRect(x, y, 5, 225);
    if (image) drawContain(ctx, image, x + 14, y + 15, 182, 142);
    ctx.fillStyle = colors.primary;
    ctx.font = '700 18px sans-serif';
    ctx.fillText('★'.repeat(item.rarity), x + 14, y + 178);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 16px sans-serif';
    const label = item.name.length > 20 ? `${item.name.slice(0, 18)}…` : item.name;
    ctx.fillText(label, x + 14, y + 205);
  }
  return canvas.toBuffer('image/png');
}

async function renderInventory(title, inventory, type) {
  const entries = Object.entries(inventory || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const cols = 7;
  const tileW = 150;
  const tileH = 170;
  const rows = Math.max(1, Math.ceil(entries.length / cols));
  const width = 40 + cols * tileW;
  const height = 105 + rows * tileH + 30;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101117';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 30px sans-serif';
  ctx.fillText(title, 35, 48);
  ctx.fillStyle = '#aeb3c5';
  ctx.font = '500 18px sans-serif';
  ctx.fillText(`${entries.length} unique • ${entries.reduce((sum, [, count]) => sum + Number(count), 0)} total`, 35, 78);

  if (!entries.length) {
    ctx.fillStyle = '#d7d9e1';
    ctx.font = '500 24px sans-serif';
    ctx.fillText('No items yet. Use Wish or Wish10.', 35, 145);
    return canvas.toBuffer('image/png');
  }

  const prepared = await Promise.all(entries.map(async ([name, count]) => {
    const item = { name, type, rarity: type === 'character' ? 4 : 3 };
    const data = await itemData(item);
    const rarity = Math.max(3, Number(data?.rarity) || item.rarity);
    return { name, count, rarity, image: await remoteImage(imageUrl(item, data)) };
  }));

  for (let i = 0; i < prepared.length; i += 1) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = 30 + col * tileW;
    const y = 100 + row * tileH;
    const item = prepared[i];
    const colors = rarityColors(item.rarity);
    ctx.fillStyle = colors.dark;
    ctx.fillRect(x, y, 132, 150);
    ctx.fillStyle = colors.primary;
    ctx.fillRect(x, y, 4, 150);
    if (item.image) drawContain(ctx, item.image, x + 8, y + 8, 116, 100);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 13px sans-serif';
    const label = item.name.length > 16 ? `${item.name.slice(0, 14)}…` : item.name;
    ctx.fillText(label, x + 8, y + 123);
    ctx.fillStyle = '#f1f2f6';
    ctx.font = '700 14px sans-serif';
    ctx.fillText(`x${item.count}`, x + 8, y + 143);
  }
  return canvas.toBuffer('image/png');
}

module.exports = {
  renderWishAnimation,
  renderResultCard,
  renderSummary,
  renderInventory,
  itemData,
};
