'use strict';

const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ffmpegPath = require('ffmpeg-static');
const { getCharacter, getWeapon } = require('./dataClient');

// Pinned public WishSimulator.App revision. Result visuals intentionally reuse its
// Genshin result assets, offsets and timing model instead of Neverless-made cards.
const WISH_SIM_REV = 'd7d1870df7f2b168e37affdfadb43ba9da75857a';
const WISH_SIM_BASE = `https://cdn.jsdelivr.net/gh/Mantan21/Genshin-Impact-Wish-Simulator@${WISH_SIM_REV}`;
const SPLASH_BG = `${WISH_SIM_BASE}/src/images/background/splash-background.webp`;
const RESULT_BG = `${WISH_SIM_BASE}/src/images/utility/resultcard-bg.webp`;
const CHAR_DATA = `${WISH_SIM_BASE}/src/lib/data/characters.json`;
const WEAPON_DATA = `${WISH_SIM_BASE}/src/lib/data/weapons.json`;
const MAX_GIF_BYTES = 9 * 1024 * 1024;

const imageCache = new Map();
const jsonCache = new Map();
const metaCache = new Map();
const revealCache = new Map();
const maskCache = new Map();

const FRAME_PATH = 'M734 6419 c-25 -29 -100 -76 -199 -127 -125 -64 -165 -117 -165 -217 0 -22 -3 -50 -6 -63 -9 -33 -83 -72 -155 -82 -68 -10 -79 -19 -79 -67 0 -24 -7 -37 -32 -54 -18 -12 -43 -34 -55 -48 l-22 -26 -1 -2502 c0 -1542 4 -2503 9 -2503 5 0 13 -9 16 -20 4 -11 23 -28 43 -38 32 -15 37 -22 40 -57 4 -49 23 -65 76 -65 47 0 113 -28 140 -58 12 -14 21 -45 26 -90 13 -117 54 -164 215 -250 55 -28 114 -66 132 -82 18 -17 35 -30 39 -30 4 0 23 15 44 34 21 19 80 56 131 82 153 79 197 131 210 252 4 39 13 70 25 84 27 30 93 58 140 58 53 0 72 16 76 65 3 35 8 42 40 57 20 10 39 27 43 38 3 11 11 20 16 20 5 0 9 961 9 2503 l-1 2502 -22 26 c-12 14 -37 36 -54 48 -26 17 -33 30 -33 54 0 48 -11 57 -79 67 -72 10 -146 49 -155 82 -3 13 -6 41 -6 63 0 100 -40 153 -165 217 -106 54 -153 84 -191 119 l-30 29 -20 -21z';

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function easeOut(v) { const t = clamp01(v); return 1 - Math.pow(1 - t, 3); }
function rarityStyle(rarity) {
  if (+rarity >= 5) return { rgb: [251, 193, 60], embed: 0xf4c65a, top: '#f9aa02', bottom: '#f97902', glow: 'rgba(249,170,2,.95)' };
  if (+rarity === 4) return { rgb: [156, 71, 218], embed: 0x9e68e8, top: '#c44dda', bottom: '#8a03a1', glow: 'rgba(217,0,255,.90)' };
  return { rgb: [99, 124, 205], embed: 0x6aa9ff, top: '#aac8f1', bottom: '#65bbf6', glow: 'rgba(101,187,246,.72)' };
}
function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[’']/g, '_s').replace(/&/g, 'and').replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
}

async function fetchJson(url) {
  if (!jsonCache.has(url)) jsonCache.set(url, fetch(url, { headers: { 'user-agent': 'Neverless-Wish/3.1' }, signal: AbortSignal.timeout(15000) }).then((r) => { if (!r.ok) throw new Error(`HTTP_${r.status}`); return r.json(); }));
  try { return await jsonCache.get(url); } catch (e) { jsonCache.delete(url); throw e; }
}
async function fetchImage(url) {
  if (!url) return null;
  if (!imageCache.has(url)) imageCache.set(url, (async () => {
    const r = await fetch(url, { headers: { 'user-agent': 'Neverless-Wish/3.1' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 255 ? loadImage(b).catch(() => null) : null;
  })().catch(() => null));
  return imageCache.get(url);
}
async function fallbackMeta(item) {
  const key = `${item.type}:${item.name}`;
  if (!metaCache.has(key)) metaCache.set(key, (item.type === 'character' ? getCharacter(item.name) : getWeapon(item.name)).catch(() => null));
  return metaCache.get(key);
}
async function simMeta(item) {
  const slug = slugify(item.name);
  try {
    const doc = await fetchJson(item.type === 'character' ? CHAR_DATA : WEAPON_DATA);
    const rows = Array.isArray(doc) ? doc : (doc?.data || []);
    const row = rows.find((v) => String(v?.name || '').toLowerCase() === slug || slugify(v?.name) === slug);
    if (row) return { ...row, slug };
  } catch (e) { console.warn(`[wish] simulator catalog: ${e.message}`); }
  return { slug };
}
async function resolveVisual(item) {
  const meta = await simMeta(item);
  let image = item.type === 'character'
    ? await fetchImage(`${WISH_SIM_BASE}/src/images/characters/splash-art/${item.rarity}star/${meta.slug}.webp`)
    : await fetchImage(meta.weaponType ? `${WISH_SIM_BASE}/src/images/weapons/${meta.weaponType}/${item.rarity}star/${meta.slug}.webp` : null);
  if (!image) {
    const fallback = await fallbackMeta(item);
    const images = fallback?.images || {};
    image = await fetchImage(item.type === 'character' ? (images.card || images.portrait || images.icon) : (images.image || images.icon || images.awakenicon));
  }
  return { meta, image };
}
function cleanDescription(meta) {
  return String(meta?.description || meta?.descriptionRaw || meta?.story || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 650);
}
function duplicateInfo(item) {
  const owned = Math.max(0, Number(item.ownedCount || 0));
  const isNew = owned <= 1;
  if (item.type === 'character') {
    if (isNew) return { isNew, qty: 0, type: null, stella: false };
    const maxed = owned > 7; const five = +item.rarity >= 5;
    return { isNew, qty: five ? (maxed ? 25 : 10) : (maxed ? 5 : 2), type: 'starglitter', stella: !maxed };
  }
  if (+item.rarity >= 4) return { isNew, qty: +item.rarity >= 5 ? 10 : 2, type: 'starglitter', stella: false };
  return { isNew, qty: 15, type: 'stardust', stella: false };
}

function drawCover(ctx, image, x, y, w, h) {
  if (!image) { ctx.fillStyle = '#353b48'; ctx.fillRect(x, y, w, h); return; }
  const s = Math.max(w / image.width, h / image.height), dw = image.width * s, dh = image.height * s;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
function drawContain(ctx, image, x, y, w, h, mul = 1) {
  if (!image) return;
  const s = Math.min(w / image.width, h / image.height) * mul, dw = image.width * s, dh = image.height * s;
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
function transformed(image, w, h, pos = {}, base = 1) {
  const c = createCanvas(w, h), ctx = c.getContext('2d');
  const scale = Number(pos.scale || base), tx = Number(pos.x || 0) / 100 * w, ty = Number(pos.y || 0) / 100 * h;
  ctx.translate(w / 2 + tx, h / 2 + ty); ctx.scale(scale, scale); ctx.translate(-w / 2, -h / 2);
  drawContain(ctx, image, 0, 0, w, h); return c;
}
function silhouette(layer) {
  const c = createCanvas(layer.width, layer.height), ctx = c.getContext('2d');
  ctx.drawImage(layer, 0, 0); ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); return c;
}
function drawStar(ctx, x, y, r) {
  ctx.save(); ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r; const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.closePath(); ctx.fillStyle = '#f7cf33'; ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 4; ctx.fill(); ctx.restore();
}
function drawLight(ctx, w, h, rarity, sec) {
  const [r,g,b] = rarityStyle(rarity).rgb, cx = w / 2, cy = h / 2;
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  const durations = [1, 1.2, 1.1, .75], radii = [.50,.40,.20,.35], alphas = [.20,.28,.52,.18];
  for (let i=0;i<4;i++) { if (sec > durations[i]) continue; const p=clamp01(sec/durations[i]), a=Math.sin(p*Math.PI)*alphas[i], rad=Math.max(5,Math.min(w,h)*radii[i]*easeOut(p)); if(a<=.001) continue; const g1=ctx.createRadialGradient(cx,cy,0,cx,cy,rad); g1.addColorStop(0,`rgba(255,255,255,${Math.min(.9,a*1.8)})`); g1.addColorStop(.45,`rgba(${r},${g},${b},${a})`); g1.addColorStop(1,`rgba(${r},${g},${b},0)`); ctx.fillStyle=g1; ctx.fillRect(0,0,w,h); }
  if (sec >= 1.1 && sec <= 2.5) { const p=clamp01((sec-1.1)/1.4), a=Math.sin(Math.min(1,p)*Math.PI)*.38, rad=Math.min(w,h)*(.25+p*.75); const g2=ctx.createRadialGradient(cx,cy,0,cx,cy,rad); g2.addColorStop(0,`rgba(255,255,255,${a*.7})`); g2.addColorStop(.5,`rgba(${r},${g},${b},${a})`); g2.addColorStop(1,`rgba(${r},${g},${b},0)`); ctx.fillStyle=g2; ctx.fillRect(0,0,w,h); }
  ctx.restore();
}
async function drawBonusTile(ctx, kind, qty, x, y, size, rarity=4) {
  const img = await fetchImage(`${WISH_SIM_BASE}/src/images/utility/masterless-${kind}.webp`);
  const grad = ctx.createLinearGradient(0,y,0,y+size); grad.addColorStop(0, kind==='starglitter' ? '#a47853' : '#754da5'); grad.addColorStop(1, kind==='starglitter' ? '#ca8937' : '#5b378b');
  ctx.save(); ctx.fillStyle=grad; ctx.shadowColor='rgba(255,255,255,.55)'; ctx.shadowBlur=12; ctx.fillRect(x,y,size,size); if(img) drawContain(ctx,img,x+5,y+3,size-10,size-15); ctx.shadowBlur=0; ctx.fillStyle='rgba(0,0,0,.52)'; ctx.fillRect(x,y+size-17,size,17); ctx.fillStyle='#fff'; ctx.font='700 13px sans-serif'; ctx.textAlign='center'; ctx.fillText(String(qty),x+size/2,y+size-4); ctx.restore();
}
async function drawStella(ctx, rarity, x, y, size) {
  const img = await fetchImage(`${WISH_SIM_BASE}/src/images/utility/stella-fortuna-${rarity}star.webp`); const grad=ctx.createLinearGradient(0,y,0,y+size); grad.addColorStop(0,+rarity>=5?'#a47853':'#7e78a9'); grad.addColorStop(1,+rarity>=5?'#ca8937':'#a47ab9'); ctx.save(); ctx.fillStyle=grad; ctx.shadowColor='rgba(255,255,255,.55)'; ctx.shadowBlur=12; ctx.fillRect(x,y,size,size); if(img) drawContain(ctx,img,x+5,y+3,size-10,size-14); ctx.shadowBlur=0; ctx.fillStyle='rgba(0,0,0,.52)'; ctx.fillRect(x,y+size-17,size,17); ctx.fillStyle='#fff'; ctx.font='700 13px sans-serif'; ctx.textAlign='center'; ctx.fillText('1',x+size/2,y+size-4); ctx.restore();
}

async function renderRevealFrame(item, visual, background, frame, fps) {
  const w=960,h=540,sec=frame/fps,c=createCanvas(w,h),ctx=c.getContext('2d'); drawCover(ctx,background,0,0,w,h); drawLight(ctx,w,h,item.rarity,sec);
  const sq=h, x0=(w-sq)/2, meta=visual.meta||{}, weaponType=String(meta.weaponType||'sword').toLowerCase();
  let art;
  if (item.type==='character') art=transformed(visual.image,sq,sq,meta.offset?.splashArt||{},1.5);
  else { art=createCanvas(sq,sq); const a=art.getContext('2d'); if(sec>=1.18){const bg=await fetchImage(`${WISH_SIM_BASE}/src/images/utility/bg-${weaponType}.webp`); if(bg){a.globalAlpha=clamp01((sec-1.18)/.12); drawContain(a,bg,0,sq*.06,sq,sq*.88,weaponType==='bow'?1.1:1); a.globalAlpha=1;}} const mul=weaponType==='catalyst'?.40:weaponType==='bow'?1.15:weaponType==='polearm'?1.20:1; drawContain(a,visual.image,0,0,sq,sq,mul); }
  const shadow=silhouette(art); let scale=1,shift=0; if(sec<.30) scale=5-4*easeOut(sec/.30); if(sec>1.12) shift=sq*.02*clamp01((sec-1.12)/.32);
  ctx.save(); ctx.translate(x0+sq/2+shift,sq/2); ctx.scale(scale,scale); ctx.translate(-(x0+sq/2),-sq/2); ctx.drawImage(shadow,x0,0); if(sec>=1.12){ctx.globalAlpha=clamp01((sec-1.12)/.33); ctx.drawImage(art,x0,0); ctx.globalAlpha=1;} ctx.restore();

  if(sec>=1.25){ const p=clamp01((sec-1.25)/.45), alpha=easeOut(p); ctx.save(); ctx.globalAlpha=alpha; ctx.shadowColor='rgba(0,0,0,.85)'; ctx.shadowBlur=8; ctx.fillStyle='#fff'; ctx.font='700 40px sans-serif'; const name=String(item.name||'Unknown'); ctx.fillText(name.length>28?`${name.slice(0,27)}…`:name,42,337); for(let i=0;i<+item.rarity;i++){ const sp=clamp01((sec-(1.95+i*.15))/.28); if(sp>0){ctx.globalAlpha=alpha*sp; drawStar(ctx,58+i*33,385,14*(.75+.25*easeOut(sp)));}} ctx.restore(); }
  const extra=duplicateInfo(item); if(sec>=1.35 && extra.qty>0){ const p=clamp01((sec-1.35)/.45); ctx.save(); ctx.globalAlpha=easeOut(p); if(item.type==='weapon'){ ctx.fillStyle='rgba(20,17,31,.58)'; ctx.fillRect(735,306,225,92); ctx.fillStyle='#ddd'; ctx.font='600 16px sans-serif'; ctx.fillText('Extra',759,329); ctx.fillStyle=extra.type==='starglitter'?'#fff94d':'#c682d6'; ctx.font='700 18px sans-serif'; ctx.fillText(`Masterless ${extra.type==='starglitter'?'Starglitter':'Stardust'}`,759,355); ctx.font='700 24px sans-serif'; ctx.fillText(`×${extra.qty}`,759,385); } else { const size=58, total=extra.stella?size*2+14:size, bx=w/2-total/2, by=443; if(extra.stella) await drawStella(ctx,item.rarity,bx,by,size); await drawBonusTile(ctx,extra.type,extra.qty,bx+(extra.stella?size+14:0),by,size,item.rarity); } ctx.restore(); }
  return c.toBuffer('image/png');
}
async function encodeReveal(item,visual,background){ if(!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE'); const fps=12,active=31,hold=6,total=active+hold,filter='[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]'; const child=spawn(ffmpegPath,['-hide_banner','-loglevel','error','-f','image2pipe','-vcodec','png','-framerate',String(fps),'-i','pipe:0','-filter_complex',filter,'-map','[v]','-loop','-1','-f','gif','pipe:1'],{stdio:['pipe','pipe','pipe']}); const out=[],err=[]; let size=0,big=false; child.stdout.on('data',(ch)=>{size+=ch.length;if(size>MAX_GIF_BYTES){big=true;child.kill('SIGKILL');}else out.push(ch);}); child.stderr.on('data',(ch)=>err.push(ch)); let final=null; for(let i=0;i<total;i++){const sf=Math.min(i,active-1);const png=sf===active-1&&final?final:await renderRevealFrame(item,visual,background,sf,fps);if(sf===active-1)final=png;if(!child.stdin.write(png))await once(child.stdin,'drain');} child.stdin.end(); const [code]=await once(child,'close'); if(big)throw new Error('WISH_REVEAL_GIF_TOO_LARGE'); if(code!==0)throw new Error(`WISH_REVEAL_FFMPEG_${code}:${Buffer.concat(err).toString('utf8').slice(0,300)}`); const gif=Buffer.concat(out); if(!gif.length)throw new Error('WISH_REVEAL_GIF_EMPTY'); return gif; }
async function renderOfficialRevealGif(item){ const d=duplicateInfo(item),key=`${item.type}:${item.name}:${item.rarity}:${d.isNew}:${d.qty}:${d.stella}`; if(!revealCache.has(key)) revealCache.set(key,(async()=>{const [v,bg]=await Promise.all([resolveVisual(item),fetchImage(SPLASH_BG)]);if(!v.image)throw new Error(`WISH_REVEAL_IMAGE_MISSING:${item.name}`);return encodeReveal(item,v,bg);})()); try{return await revealCache.get(key);}catch(e){revealCache.delete(key);throw e;} }
async function getOfficialRevealInfo(item){ const meta=await fallbackMeta(item); return {description:cleanDescription(meta),embedColor:rarityStyle(item.rarity).embed}; }

function sortLikeGame(results){ const type=(a,b)=>String(a.type).localeCompare(String(b.type)),name=(a,b)=>String(a.name).localeCompare(String(b.name)); const pick=(r)=>results.filter(x=>+x.rarity===r).slice().sort(name).sort((a,b)=>Number((b.ownedCount||0)===1)-Number((a.ownedCount||0)===1)).sort(type); return [...pick(5),...pick(4),...results.filter(x=>+x.rarity===3)]; }
async function frameMask(w,h){const key=`${w}x${h}`;if(!maskCache.has(key)){maskCache.set(key,loadImage(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1510 6470"><path d="${FRAME_PATH}" fill="white"/></svg>`)).catch(()=>null));}return maskCache.get(key);}
async function applyMask(canvas){const ctx=canvas.getContext('2d'),mask=await frameMask(canvas.width,canvas.height);if(!mask)return;ctx.globalCompositeOperation='destination-in';ctx.drawImage(mask,0,0,canvas.width,canvas.height);ctx.globalCompositeOperation='source-over';}
async function resultCard(item,visual,bg,w,h){ const outer=createCanvas(w,h),o=outer.getContext('2d'),style=rarityStyle(item.rarity),grad=o.createLinearGradient(0,0,0,h);grad.addColorStop(0,style.top);grad.addColorStop(.5,'#fff');grad.addColorStop(1,style.bottom);o.fillStyle=grad;o.fillRect(0,0,w,h);await applyMask(outer); const inner=createCanvas(w-8,h-8),ctx=inner.getContext('2d');drawCover(ctx,bg,0,0,inner.width,inner.height); if(visual.image){ const art=createCanvas(inner.width,inner.height),a=art.getContext('2d'); if(item.type==='character'){const pos=visual.meta?.offset?.wishCard||{},scale=Number(pos.scale||5),tx=Number(pos.x||0)/100*inner.width,ty=Number(pos.y||0)/100*inner.height;a.translate(inner.width/2+tx,inner.height/2+ty);a.scale(scale,scale);a.translate(-inner.width/2,-inner.height/2);drawContain(a,visual.image,0,0,inner.width,inner.height);}else{const wt=String(visual.meta?.weaponType||'sword').toLowerCase(),scale=wt==='catalyst'?1.3:2.05;a.translate(inner.width/2,inner.height/2);a.scale(scale,scale);a.translate(-inner.width/2,-inner.height/2);a.shadowColor='rgba(0,0,0,.8)';a.shadowBlur=5;drawContain(a,visual.image,0,0,inner.width,inner.height);}ctx.drawImage(art,0,0); } const shade=ctx.createLinearGradient(0,h*.48,0,h);shade.addColorStop(0,'rgba(0,0,0,0)');shade.addColorStop(1,'rgba(0,0,0,.42)');ctx.fillStyle=shade;ctx.fillRect(0,h*.48,w,h*.52); const d=duplicateInfo(item); if((d.isNew&&item.type==='character')||item.type==='weapon'){for(let i=0;i<+item.rarity;i++)drawStar(ctx,inner.width/2-(+item.rarity-1)*7+i*14,inner.height-45,6.5);} if(item.type==='character'&&!d.isNew){const s=Math.min(44,inner.width*.38),x=(inner.width-s)/2,y=inner.height-108;if(d.stella)await drawStella(ctx,item.rarity,x,y,s);else await drawBonusTile(ctx,d.type,d.qty,x,y,s,item.rarity);} if(d.isNew){ctx.fillStyle='#c3882a';ctx.strokeStyle='#fffa66';ctx.lineWidth=1;const tw=46,th=21,tx=inner.width-tw-7,ty=16;ctx.fillRect(tx,ty,tw,th);ctx.strokeRect(tx,ty,tw,th);ctx.fillStyle='#fffa66';ctx.font='700 11px sans-serif';ctx.textAlign='center';ctx.fillText('NEW',tx+tw/2,ty+15);ctx.textAlign='left';} await applyMask(inner);o.drawImage(inner,4,4);return outer; }
async function renderOfficialSummary(results){const w=1800,h=960,c=createCanvas(w,h),ctx=c.getContext('2d'),[bg,cardBg]=await Promise.all([fetchImage(SPLASH_BG),fetchImage(RESULT_BG)]);drawCover(ctx,bg,0,0,w,h);const sorted=sortLikeGame(results),prepared=await Promise.all(sorted.map(async item=>({item,visual:await resolveVisual(item)})));const cardH=720,cardW=Math.round(cardH*7/30),gap=4,total=prepared.length*cardW+(prepared.length-1)*gap,start=(w-total)/2,y=(h-cardH)/2;for(let i=0;i<prepared.length;i++){const {item,visual}=prepared[i],x=Math.round(start+i*(cardW+gap)),style=rarityStyle(item.rarity);ctx.save();ctx.shadowColor=style.glow;ctx.shadowBlur=+item.rarity>=5?42:+item.rarity===4?31:9;const card=await resultCard(item,visual,cardBg,cardW,cardH);ctx.drawImage(card,x,y);ctx.restore();}return c.toBuffer('image/png');}

module.exports={WISH_SIM_REV,getOfficialRevealInfo,renderOfficialRevealGif,renderOfficialSummary,rarityStyle};
