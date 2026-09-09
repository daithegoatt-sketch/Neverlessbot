'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { getCharacter, getWeapon } = require('./dataClient');

// Isolated port of the public WishSimulator.App result reveal:
// SplashArt keyframes: scale 5 -> 1, black silhouette until 75%, color reveal 75-95%.
// SplashLight colors/timing and ResultList rarity gradients follow the upstream components.
const metaCache = new Map();
const imageCache = new Map();
const revealCache = new Map();
const MAX_GIF_BYTES = 9 * 1024 * 1024;

function rarityStyle(rarity) {
  if (rarity >= 5) return { rgb: [251, 193, 60], embed: 0xf4c65a };
  if (rarity === 4) return { rgb: [156, 71, 218], embed: 0x9e68e8 };
  return { rgb: [99, 124, 205], embed: 0x6aa9ff };
}

async function itemMeta(item) {
  const key = `${item.type}:${item.name}`;
  if (!metaCache.has(key)) metaCache.set(key, (item.type === 'character' ? getCharacter(item.name) : getWeapon(item.name)).catch(() => null));
  return metaCache.get(key);
}

function imageUrl(item, data) {
  const images = data?.images || {};
  return item.type === 'character'
    ? images.card || images.portrait || images.icon || images['hoyolab-avatar'] || null
    : images.image || images.icon || images.awakenicon || null;
}

async function remoteImage(url) {
  if (!url) return null;
  if (!imageCache.has(url)) imageCache.set(url, (async () => {
    const response = await fetch(url, { headers: { 'user-agent': 'Neverless-Wish/1.0' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    return loadImage(Buffer.from(await response.arrayBuffer())).catch(() => null);
  })().catch(() => null));
  return imageCache.get(url);
}

function description(data) {
  return String(data?.description || data?.descriptionRaw || data?.story || '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 650);
}

function contain(ctx, image, x, y, w, h, mult = 1) {
  const s = Math.min(w / image.width, h / image.height) * mult;
  const dw = image.width * s;
  const dh = image.height * s;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function ease(t) {
  const p = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - p, 3);
}

function background(ctx, w, h, rarity) {
  const [r, g, b] = rarityStyle(rarity).rgb;
  const grad = ctx.createRadialGradient(w * 0.53, h * 0.5, 0, w * 0.53, h * 0.5, w * 0.72);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.42)`);
  grad.addColorStop(0.42, '#172039'); grad.addColorStop(1, '#080b15');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  ctx.save(); ctx.translate(w * 0.53, h * 0.5); ctx.strokeStyle = `rgba(${r},${g},${b},0.24)`; ctx.lineWidth = 2;
  for (let i = 0; i < 28; i += 1) { ctx.rotate(Math.PI / 14); ctx.beginPath(); ctx.moveTo(35, 0); ctx.lineTo(w * 0.78, 0); ctx.stroke(); }
  ctx.restore();
}

function splashLight(ctx, w, h, rarity, t) {
  const [r, g, b] = rarityStyle(rarity).rgb;
  const cx = w * 0.53, cy = h * 0.5;
  const p = Math.min(1, t / 0.55), alpha = Math.max(0, Math.sin(p * Math.PI));
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * (0.3 + p * 0.58));
  glow.addColorStop(0, `rgba(255,255,255,${0.72 * alpha})`); glow.addColorStop(0.2, `rgba(${r},${g},${b},${0.58 * alpha})`); glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i += 1) {
    const q = ease((t - i * 0.035) / (0.48 + i * 0.04));
    if (q <= 0) continue;
    ctx.globalAlpha = (1 - q) * 0.42; ctx.strokeStyle = `rgb(${r},${g},${b})`; ctx.lineWidth = 5 - i * 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, 30 + q * (160 + i * 75), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function artLayer(item, image, brightness, scale, shift) {
  const w = 960, h = 540;
  const layer = createCanvas(w, h), ctx = layer.getContext('2d');
  const box = item.type === 'character' ? { x: 175 + shift, y: 5, w: 720, h: 525, mult: 1.03 } : { x: 260 + shift, y: 35, w: 570, h: 460, mult: 0.96 };
  ctx.save(); ctx.translate(box.x + box.w / 2, box.y + box.h / 2); ctx.scale(scale, scale); ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
  contain(ctx, image, box.x, box.y, box.w, box.h, box.mult); ctx.restore();
  if (brightness < 0.995) {
    ctx.globalCompositeOperation = 'source-in';
    const v = Math.round(255 * Math.max(0, brightness)); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(0, 0, w, h);
  }
  return layer;
}

function revealFrame(item, image, frame, frames) {
  const w = 960, h = 540, t = frame / Math.max(1, frames - 1);
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  background(ctx, w, h, item.rarity); splashLight(ctx, w, h, item.rarity, t);
  let scale = 1, brightness = 0, shift = 0;
  if (t <= 0.20) scale = 5 - 4 * ease(t / 0.20);
  else if (t > 0.75 && t <= 0.95) { const p = (t - 0.75) / 0.20; brightness = p; shift = 18 * p; }
  else if (t > 0.95) { brightness = 1; shift = 18; }
  ctx.drawImage(artLayer(item, image, brightness, scale, shift), 0, 0);
  const nameA = Math.max(0, Math.min(1, (t - 0.68) / 0.18));
  if (nameA > 0) {
    ctx.save(); ctx.globalAlpha = nameA; ctx.fillStyle = '#fff'; ctx.font = '700 40px sans-serif'; ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 8;
    const name = String(item.name || 'Unknown'); ctx.fillText(name.length > 28 ? `${name.slice(0, 27)}…` : name, 48 + (1 - nameA) * 22, 415); ctx.restore();
  }
  const starA = Math.max(0, Math.min(1, (t - 0.82) / 0.14));
  if (starA > 0) { ctx.save(); ctx.globalAlpha = starA; ctx.fillStyle = '#f7cf33'; ctx.font = '700 32px sans-serif'; ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 5; ctx.fillText('★'.repeat(item.rarity), 48, 463); ctx.restore(); }
  return canvas.toBuffer('image/png');
}

async function encodeReveal(item, image) {
  if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE');
  const fps = 12, frames = 27;
  const filter = '[0:v]split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]';
  const child = spawn(ffmpegPath, ['-hide_banner','-loglevel','error','-f','image2pipe','-vcodec','png','-framerate',String(fps),'-i','pipe:0','-filter_complex',filter,'-map','[v]','-loop','0','-f','gif','pipe:1'], { stdio: ['pipe','pipe','pipe'] });
  const out = [], err = []; let size = 0, tooLarge = false;
  child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_GIF_BYTES) { tooLarge = true; child.kill('SIGKILL'); } else out.push(chunk); }); child.stderr.on('data', chunk => err.push(chunk));
  for (let i = 0; i < frames; i += 1) { const png = revealFrame(item, image, i, frames); if (!child.stdin.write(png)) await once(child.stdin, 'drain'); }
  child.stdin.end(); const [code] = await once(child, 'close');
  if (tooLarge) throw new Error('WISH_REVEAL_GIF_TOO_LARGE'); if (code !== 0) throw new Error(`WISH_REVEAL_FFMPEG_${code}:${Buffer.concat(err).toString('utf8').slice(0,300)}`);
  const gif = Buffer.concat(out); if (!gif.length) throw new Error('WISH_REVEAL_GIF_EMPTY'); return gif;
}

async function renderOfficialRevealGif(item) {
  const key = `${item.type}:${item.name}:${item.rarity}`;
  if (!revealCache.has(key)) revealCache.set(key, (async () => { const data = await itemMeta(item); const image = await remoteImage(imageUrl(item, data)); if (!image) throw new Error(`WISH_REVEAL_IMAGE_MISSING:${item.name}`); return encodeReveal(item, image); })());
  try { return await revealCache.get(key); } catch (error) { revealCache.delete(key); throw error; }
}

async function getOfficialRevealInfo(item) {
  const data = await itemMeta(item); return { description: description(data), embedColor: rarityStyle(item.rarity).embed };
}

async function renderOfficialSummary(results) {
  const w = 1600, h = 620, canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#e9eef5'); bg.addColorStop(0.5, '#bcc8d9'); bg.addColorStop(1, '#edf1f5'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  const prepared = await Promise.all(results.map(async item => { const data = await itemMeta(item); return { item, image: await remoteImage(imageUrl(item, data)) }; }));
  const cw = 142, ch = 500, gap = 10, start = (w - (prepared.length * cw + (prepared.length - 1) * gap)) / 2, y = 58;
  for (let i = 0; i < prepared.length; i += 1) {
    const { item, image } = prepared[i], x = start + i * (cw + gap), grad = ctx.createLinearGradient(x, y, x, y + ch);
    if (item.rarity >= 5) { grad.addColorStop(0,'#f9aa02'); grad.addColorStop(.48,'#fff'); grad.addColorStop(1,'#f9aa02'); }
    else if (item.rarity === 4) { grad.addColorStop(0,'#c44dda'); grad.addColorStop(.48,'#fff'); grad.addColorStop(1,'#c44dda'); }
    else { grad.addColorStop(0,'#aac8f1'); grad.addColorStop(.48,'#fff'); grad.addColorStop(1,'#aac8f1'); }
    ctx.fillStyle = grad; ctx.beginPath(); ctx.roundRect(x,y,cw,ch,12); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.roundRect(x+4,y+4,cw-8,ch-8,10); ctx.clip(); const inner = ctx.createLinearGradient(x,y,x,y+ch); inner.addColorStop(0,'#596476'); inner.addColorStop(.62,'#293747'); inner.addColorStop(1,'#182230'); ctx.fillStyle = inner; ctx.fillRect(x+4,y+4,cw-8,ch-8);
    if (image) contain(ctx,image,x+7,y+12,cw-14,ch-90,item.type === 'character' ? 1.7 : 1.05); const shade = ctx.createLinearGradient(0,y+ch-165,0,y+ch); shade.addColorStop(0,'rgba(0,0,0,0)'); shade.addColorStop(1,'rgba(0,0,0,.75)'); ctx.fillStyle = shade; ctx.fillRect(x+4,y+ch-170,cw-8,166); ctx.restore();
    ctx.fillStyle = '#f7cf33'; ctx.font = '700 18px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('★'.repeat(item.rarity),x+cw/2,y+ch-28);
  }
  ctx.textAlign = 'start'; return canvas.toBuffer('image/png');
}

module.exports = { getOfficialRevealInfo, renderOfficialRevealGif, renderOfficialSummary, rarityStyle };
