'use strict';

const crypto = require('node:crypto');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const BANK_CHANNEL_ID = '1548665575247581184';
const BANK_TEST_CHANNEL_ID = '1548665662556217384';
const BANK_EXTRA_CHANNEL_ID = '1548983198120419418';
const BANK_CHANNELS = new Set([BANK_CHANNEL_ID, BANK_TEST_CHANNEL_ID, BANK_EXTRA_CHANNEL_ID]);
const DATA_CHANNEL_NAME = 'neverless-data';
const USER_PREFIX = 'NLBANK1|U|';
const MARKET_PREFIX = 'NLBANK1|M|';
const START_BALANCE = 1000;
const COMMAND_CD = 5 * 60 * 1000;
const SALARY_CD = COMMAND_CD;
const TIP_CD = COMMAND_CD;
const MARKET_STEP = 5 * 60 * 1000;
const MAX_BET = 100000;

const users = new Map();
const userMessageIds = new Map();
const markets = new Map();
const marketMessageIds = new Map();
const loadPromises = new Map();
const guildLocks = new Map();
const shortCooldowns = new Map();

const key = (g, u) => `${g}:${u}`;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function newUser() {
  return { balance: START_BALANCE, vault: 0, shares: 0, salaryAt: 0, tipAt: 0, earned: 0, lost: 0, games: 0, wins: 0, cooldowns: {} };
}
function packUser(s) {
  return { b: s.balance, v: s.vault, sh: s.shares, sa: s.salaryAt, ta: s.tipAt, e: s.earned, l: s.lost, g: s.games, w: s.wins, c: s.cooldowns || {} };
}
function unpackUser(x = {}) {
  return {
    balance: Math.max(0, Math.floor(Number(x.b ?? START_BALANCE) || 0)),
    vault: Math.max(0, Math.floor(Number(x.v ?? 0) || 0)),
    shares: Math.max(0, Math.floor(Number(x.sh ?? 0) || 0)),
    salaryAt: Math.max(0, Number(x.sa ?? 0) || 0),
    tipAt: Math.max(0, Number(x.ta ?? 0) || 0),
    earned: Math.max(0, Math.floor(Number(x.e ?? 0) || 0)),
    lost: Math.max(0, Math.floor(Number(x.l ?? 0) || 0)),
    games: Math.max(0, Math.floor(Number(x.g ?? 0) || 0)),
    wins: Math.max(0, Math.floor(Number(x.w ?? 0) || 0)),
    cooldowns: x.c && typeof x.c === 'object' && !Array.isArray(x.c)
      ? Object.fromEntries(Object.entries(x.c).filter(([name, at]) => /^[a-z]+$/.test(name) && Number.isFinite(Number(at))).map(([name, at]) => [name, Math.max(0, Number(at))]))
      : {},
  };
}
function newMarket() { return { price: 100, history: [100], updatedAt: Date.now() }; }
function packMarket(m) { return { p: m.price, h: m.history.slice(-24), u: m.updatedAt }; }
function unpackMarket(x = {}) {
  const price = clamp(Math.round(Number(x.p) || 100), 25, 1200);
  const history = Array.isArray(x.h) && x.h.length ? x.h.map((n) => clamp(Math.round(Number(n) || price), 25, 1200)).slice(-24) : [price];
  return { price, history, updatedAt: Math.max(0, Number(x.u) || Date.now()) };
}
function enc(v) { return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url'); }
function dec(v) { try { return JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8')); } catch { return null; } }

function parseRecord(content) {
  const s = String(content || '');
  if (s.startsWith(USER_PREFIX)) {
    const parts = s.slice(USER_PREFIX.length).split('|');
    if (parts.length !== 3 || !/^\d{15,22}$/.test(parts[0]) || !/^\d{15,22}$/.test(parts[1])) return null;
    const payload = dec(parts[2]);
    return payload ? { type: 'user', guildId: parts[0], userId: parts[1], payload } : null;
  }
  if (s.startsWith(MARKET_PREFIX)) {
    const rest = s.slice(MARKET_PREFIX.length);
    const i = rest.indexOf('|');
    if (i < 0) return null;
    const guildId = rest.slice(0, i);
    const payload = dec(rest.slice(i + 1));
    return /^\d{15,22}$/.test(guildId) && payload ? { type: 'market', guildId, payload } : null;
  }
  return null;
}

function dataChannel(guild) {
  return guild.channels.cache.find((c) => c?.name === DATA_CHANNEL_NAME && c.isTextBased?.()) || null;
}
async function loadGuild(guild) {
  const channel = dataChannel(guild);
  if (!channel) { markets.set(guild.id, newMarket()); return; }
  const latestUsers = new Map();
  let latestMarket = null;
  let before;
  let scanned = 0;
  while (scanned < 5000) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    for (const msg of batch.values()) {
      if (msg.author?.id !== guild.client.user?.id) continue;
      const r = parseRecord(msg.content);
      if (!r || r.guildId !== guild.id) continue;
      if (r.type === 'user') {
        const old = latestUsers.get(r.userId);
        if (!old || msg.createdTimestamp > old.ts) latestUsers.set(r.userId, { ...r, id: msg.id, ts: msg.createdTimestamp });
      } else if (!latestMarket || msg.createdTimestamp > latestMarket.ts) latestMarket = { ...r, id: msg.id, ts: msg.createdTimestamp };
    }
    scanned += batch.size;
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  for (const r of latestUsers.values()) {
    users.set(key(guild.id, r.userId), unpackUser(r.payload));
    userMessageIds.set(key(guild.id, r.userId), r.id);
  }
  if (latestMarket) {
    markets.set(guild.id, unpackMarket(latestMarket.payload));
    marketMessageIds.set(guild.id, latestMarket.id);
  } else markets.set(guild.id, newMarket());
  console.log(`[bank] loaded ${latestUsers.size} bank accounts in ${guild.name}`);
}
function ensureLoaded(guild) {
  if (!loadPromises.has(guild.id)) loadPromises.set(guild.id, loadGuild(guild).catch((e) => console.error('[bank] load failed:', e)));
  return loadPromises.get(guild.id);
}
function getUser(guildId, userId) {
  const k = key(guildId, userId);
  if (!users.has(k)) users.set(k, newUser());
  return users.get(k);
}
async function persistUser(guild, userId) {
  const channel = dataChannel(guild); if (!channel) return;
  const k = key(guild.id, userId);
  const content = `${USER_PREFIX}${guild.id}|${userId}|${enc(packUser(getUser(guild.id, userId)))}`;
  const id = userMessageIds.get(k);
  let msg = id ? await channel.messages.fetch(id).catch(() => null) : null;
  if (msg) await msg.edit({ content, allowedMentions: { parse: [] } }).catch(() => {});
  else {
    msg = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
    if (msg) userMessageIds.set(k, msg.id);
  }
}
async function persistMarket(guild) {
  const channel = dataChannel(guild); if (!channel) return;
  const market = markets.get(guild.id) || newMarket();
  const content = `${MARKET_PREFIX}${guild.id}|${enc(packMarket(market))}`;
  const id = marketMessageIds.get(guild.id);
  let msg = id ? await channel.messages.fetch(id).catch(() => null) : null;
  if (msg) await msg.edit({ content, allowedMentions: { parse: [] } }).catch(() => {});
  else {
    msg = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
    if (msg) marketMessageIds.set(guild.id, msg.id);
  }
}
async function locked(guildId, fn) {
  const prev = guildLocks.get(guildId) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const next = prev.catch(() => {}).then(() => gate);
  guildLocks.set(guildId, next);
  await prev.catch(() => {});
  try { return await fn(); } finally { release(); if (guildLocks.get(guildId) === next) guildLocks.delete(guildId); }
}

function updateMarket(guildId) {
  const m = markets.get(guildId) || newMarket();
  const steps = Math.min(18, Math.floor(Math.max(0, Date.now() - m.updatedAt) / MARKET_STEP));
  for (let i = 0; i < steps; i += 1) {
    const momentum = m.history.length > 1 ? (m.history.at(-1) - m.history.at(-2)) / Math.max(1, m.history.at(-2)) : 0;
    const move = clamp((Math.random() * 0.15) - 0.065 + momentum * 0.12, -0.10, 0.11);
    m.price = clamp(Math.round(m.price * (1 + move)), 25, 1200);
    m.history.push(m.price); m.history = m.history.slice(-24); m.updatedAt += MARKET_STEP;
  }
  markets.set(guildId, m);
  return { market: m, changed: steps > 0 };
}

function digits(v) {
  const a = '٠١٢٣٤٥٦٧٨٩', p = '۰۱۲۳۴۵۶۷۸۹';
  return String(v || '').replace(/[٠-٩۰-۹]/g, (d) => String(a.includes(d) ? a.indexOf(d) : p.indexOf(d)));
}
function parseAmount(raw, max = Infinity) {
  let s = digits(raw).trim().toLowerCase().replace(/[$,]/g, '');
  const available = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : Infinity;
  if (available <= 0) return NaN;
  if (/^(كل|الكل|كامل|all|full)$/u.test(s)) return Number.isFinite(available) ? available : NaN;
  if (/^(نص|نصف|half)$/u.test(s)) return Number.isFinite(available) ? Math.max(1, Math.floor(available / 2)) : NaN;
  if (/^(ربع|quarter)$/u.test(s)) return Number.isFinite(available) ? Math.max(1, Math.floor(available / 4)) : NaN;
  let mult = 1;
  if (/(?:k|الف|ألف)$/u.test(s)) { mult = 1000; s = s.replace(/(?:k|الف|ألف)$/u, '').trim(); }
  if (/(?:m|مليون)$/u.test(s)) { mult = 1000000; s = s.replace(/(?:m|مليون)$/u, '').trim(); }
  const n = Math.floor(Number(s) * mult);
  return Number.isFinite(n) && n > 0 && n <= available ? n : NaN;
}
function parseShares(raw) { const n = Number(digits(raw).replace(/,/g, '').trim()); return Number.isInteger(n) && n > 0 && n <= 100000 ? n : NaN; }
function money(v) { return `$${Math.round(Number(v) || 0).toLocaleString('en-US')}`; }
function shortMoney(v) { const n = Math.round(Number(v) || 0); return Math.abs(n) >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${(n/1e3).toFixed(1)}K` : money(n); }
function cooldownLeft(at, cd) { const ms = Number(at) + cd - Date.now(); return ms <= 0 ? null : `${Math.floor(ms/3600000)}س ${Math.ceil((ms%3600000)/60000)}د`; }
function commandCooldownLeft(s, name, now = Date.now()) { return Math.max(0, Number(s.cooldowns?.[name] || 0) + COMMAND_CD - now); }
function setCommandCooldown(s, name, now = Date.now()) { if (!s.cooldowns || typeof s.cooldowns !== 'object') s.cooldowns = {}; s.cooldowns[name] = now; }
function cooldownStatus(ms) {
  if (ms <= 0) return '🟢 متاح';
  const minutes = Math.floor(ms / 60000), seconds = Math.ceil((ms % 60000) / 1000);
  return `🔴 الوقت الباقي ${minutes}:${String(seconds).padStart(2, '0')}`;
}
function shortCd(userId, name, ms) {
  const k = `${userId}:${name}`, until = shortCooldowns.get(k) || 0;
  if (until > Date.now()) return Math.ceil((until - Date.now()) / 1000);
  shortCooldowns.set(k, Date.now() + ms); return 0;
}

function roundRect(ctx, x, y, w, h, r = 20) {
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}
function panel(ctx, x, y, w, h, fill = '#101925', stroke = '#38506d') { roundRect(ctx,x,y,w,h,18); ctx.fillStyle=fill; ctx.fill(); ctx.strokeStyle=stroke; ctx.lineWidth=1.5; ctx.stroke(); }
function card(title, subtitle, w = 1000, h = 500) {
  const canvas = createCanvas(w,h), ctx=canvas.getContext('2d');
  const g=ctx.createLinearGradient(0,0,w,h); g.addColorStop(0,'#06101d'); g.addColorStop(1,'#0b1420'); ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
  panel(ctx,18,18,w-36,h-36,'rgba(7,14,24,.92)','#496480');
  ctx.fillStyle='#edf5ff'; ctx.font='700 34px sans-serif'; ctx.fillText(title,52,62);
  ctx.fillStyle='#7f95ad'; ctx.font='500 17px sans-serif'; ctx.fillText(subtitle,54,90);
  ctx.strokeStyle='rgba(120,150,185,.25)'; ctx.beginPath(); ctx.moveTo(52,110); ctx.lineTo(w-52,110); ctx.stroke();
  return {canvas,ctx};
}
async function avatar(ctx,user,x,y,size) {
  ctx.save(); ctx.beginPath(); ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2); ctx.clip();
  try {
    const url=user?.displayAvatarURL?.({extension:'png',size:256}); const u=new URL(url); if(!['cdn.discordapp.com','media.discordapp.net'].includes(u.hostname)) throw new Error();
    const img=await loadImage(url), side=Math.min(img.width,img.height); ctx.drawImage(img,(img.width-side)/2,(img.height-side)/2,side,side,x,y,size,size);
  } catch { ctx.fillStyle='#203149'; ctx.fillRect(x,y,size,size); }
  ctx.restore(); ctx.strokeStyle='#7f9cbf'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(x+size/2,y+size/2,size/2,0,Math.PI*2); ctx.stroke();
}
async function balanceCard(user,s,price) {
  const {canvas,ctx}=card('NEVERLESS BANK','Personal account',1000,430); await avatar(ctx,user,58,145,145);
  ctx.fillStyle='#f3f7fc'; ctx.font='700 30px sans-serif'; ctx.fillText(user.globalName||user.username,230,175);
  const portfolio=s.shares*price, net=s.balance+s.vault+portfolio;
  const rows=[['CASH',money(s.balance),'#00e6a3'],['VAULT',money(s.vault),'#8dc3ff'],['STOCK',`${s.shares} • ${money(portfolio)}`,'#d9b879'],['NET WORTH',money(net),'#f1f5fa']];
  rows.forEach((r,i)=>{const x=230+(i%2)*350,y=220+Math.floor(i/2)*86;panel(ctx,x,y,320,68);ctx.fillStyle='#7790aa';ctx.font='600 13px sans-serif';ctx.fillText(r[0],x+16,y+23);ctx.fillStyle=r[2];ctx.font='700 23px sans-serif';ctx.fillText(r[1],x+16,y+52);});
  return canvas.toBuffer('image/png');
}
async function receiptCard(user,label,delta,balance,note='') {
  const {canvas,ctx}=card('NEVERLESS BANK',label,1000,410); await avatar(ctx,user,445,130,100); ctx.textAlign='center';
  ctx.fillStyle=delta>=0?'#00e6a3':'#ff6276';ctx.font='800 55px sans-serif';ctx.fillText(`${delta>=0?'+':'-'}${shortMoney(Math.abs(delta))}`,495,285);
  ctx.fillStyle='#8da2ba';ctx.font='600 18px sans-serif';ctx.fillText(`Cash ${money(balance)}`,495,325); if(note){ctx.fillStyle='#cbd6e3';ctx.font='500 16px sans-serif';ctx.fillText(note,495,360);} ctx.textAlign='left';
  return canvas.toBuffer('image/png');
}
function rouletteCard(mult,wager,payout) {
  const {canvas,ctx}=card('ROULETTE',`Wager ${money(wager)}`,1000,540); const cx=500,cy=325,r=165,slots=[0,1.5,0,2,1,0,5,0,1.5,0,2,1];
  slots.forEach((m,i)=>{const a=-Math.PI/2+i*Math.PI*2/slots.length,b=-Math.PI/2+(i+1)*Math.PI*2/slots.length;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a,b);ctx.closePath();ctx.fillStyle=m>1?(i%2?'#174639':'#125b48'):(i%2?'#45232b':'#2f1e25');ctx.fill();ctx.strokeStyle='#647c97';ctx.stroke();});
  ctx.beginPath();ctx.arc(cx,cy,78,0,Math.PI*2);ctx.fillStyle='#eef3f8';ctx.fill();ctx.textAlign='center';ctx.fillStyle=mult>1?'#0a8c68':mult===1?'#38536e':'#b33d4e';ctx.font='800 38px sans-serif';ctx.fillText(`x${mult}`,cx,cy+12);ctx.fillStyle=payout>wager?'#00e6a3':payout===wager?'#e5edf5':'#ff6276';ctx.font='700 22px sans-serif';ctx.fillText(payout?`Return ${money(payout)}`:'Lost',cx,515);ctx.textAlign='left'; return canvas.toBuffer('image/png');
}
function hiloCard(current,next=null,won=null,wager=0) {
  const {canvas,ctx}=card('HIGH / LOW',`Wager ${money(wager)}`,1000,500); const draw=(x,n)=>{panel(ctx,x,155,220,260,'#f4f2ed','#c9d4df');ctx.textAlign='center';ctx.fillStyle='#162235';ctx.font='800 85px sans-serif';ctx.fillText(String(n),x+110,315);};draw(170,current);
  if(next!==null){draw(610,next);ctx.fillStyle=won?'#00e6a3':'#ff6276';ctx.font='800 27px sans-serif';ctx.fillText(won?'YOU WIN':'YOU LOSE',500,465);}else{ctx.fillStyle='#8da2ba';ctx.font='700 25px sans-serif';ctx.fillText('Higher or lower?',660,260);ctx.font='500 17px sans-serif';ctx.fillText('Choose below • ties are redrawn',660,300);}ctx.textAlign='left';return canvas.toBuffer('image/png');
}
function boxesCard(wager,boxes=null) {
  const {canvas,ctx}=card('MYSTERY BOXES',`Entry ${money(wager)}`,1000,470);for(let i=0;i<5;i++){const x=70+i*178,b=boxes?.[i];panel(ctx,x,175,150,190,b?(b.bomb?'#612a34':'#123f35'):'#111d2b','#536d88');ctx.textAlign='center';ctx.font='50px sans-serif';ctx.fillText(b?(b.bomb?'💥':'💰'):'🎁',x+75,260);ctx.fillStyle='#dbe6f2';ctx.font='700 18px sans-serif';ctx.fillText(b?(b.bomb?'BOMB':`x${b.mult}`):String(i+1),x+75,320);}ctx.fillStyle='#7f95ad';ctx.font='500 17px sans-serif';ctx.fillText(boxes?'All boxes revealed':'Pick one • one box is a bomb',500,420);ctx.textAlign='left';return canvas.toBuffer('image/png');
}
function stockCard(m) {
  const {canvas,ctx}=card('NEVERLESS MARKET','Server-wide virtual stock',1000,550),h=m.history.length>1?m.history:[m.price,m.price],min=Math.min(...h),max=Math.max(...h),pad=Math.max(5,(max-min)*.2),lo=Math.max(1,min-pad),hi=max+pad,left=80,top=165,w=840,hh=260,pos=h.at(-1)>=h[0];
  ctx.strokeStyle='rgba(120,150,185,.17)';for(let i=0;i<5;i++){const y=top+i*hh/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(left+w,y);ctx.stroke();}ctx.strokeStyle=pos?'#00e6a3':'#ff6276';ctx.lineWidth=5;ctx.beginPath();h.forEach((v,i)=>{const x=left+w*i/Math.max(1,h.length-1),y=top+hh-(v-lo)/Math.max(1,hi-lo)*hh;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();const ch=(m.price-h[0])/Math.max(1,h[0])*100;ctx.fillStyle=pos?'#00e6a3':'#ff6276';ctx.font='800 45px sans-serif';ctx.fillText(money(m.price),80,500);ctx.font='700 19px sans-serif';ctx.fillText(`${ch>=0?'+':''}${ch.toFixed(1)}%`,290,498);return canvas.toBuffer('image/png');
}
async function topCard(rows,price) {
  const {canvas,ctx}=card('RICHEST MEMBERS','Neverless Bank leaderboard',1000,750);let y=145;for(let i=0;i<Math.min(5,rows.length);i++){const r=rows[i];panel(ctx,55,y,890,100,i<3?'#111d2b':'#0d1723');ctx.fillStyle=i===0?'#e7c56f':i===1?'#cad5e0':i===2?'#b88965':'#7e93ab';ctx.font='800 27px sans-serif';ctx.fillText(`#${i+1}`,80,y+61);await avatar(ctx,r.user,145,y+16,68);ctx.fillStyle='#f0f5fa';ctx.font='700 22px sans-serif';ctx.fillText(r.user.globalName||r.user.username,235,y+41);ctx.fillStyle='#8096ad';ctx.font='500 15px sans-serif';ctx.fillText(`${r.state.shares} shares • ${money(r.state.vault)} vault`,235,y+69);ctx.textAlign='right';ctx.fillStyle='#00e6a3';ctx.font='800 24px sans-serif';ctx.fillText(money(r.net),910,y+58);ctx.textAlign='left';y+=110;}ctx.fillStyle='#657c95';ctx.font='500 14px sans-serif';ctx.fillText(`Stock price ${money(price)}`,58,715);return canvas.toBuffer('image/png');
}

function helpEmbed(client) {
  const e=new EmbedBuilder().setColor(0x17365d).setTitle('🏦 Neverless Bank — دليل الأوامر').setDescription('اقتصاد افتراضي خاص بالسيرفر. مدة أوامر الدخل واللعب **5 دقائق**.')
    .addFields(
      {name:'💳 الحساب',value:'`رصيد` • `ايداع 500` • `سحب 500` • `تحويل @member 500`'},
      {name:'⏱️ الوقت',value:'`وقت` يعرض 🟢 متاح أو 🔴 الوقت الباقي'},
      {name:'💰 الدخل',value:'`راتب` • `بخشيش`'},
      {name:'🎮 الألعاب والاستثمار',value:'`رهان كامل` • `استثمار نص` • `نرد ربع` • `قمار 1000` • `تداول 1000`'},
      {name:'🧮 خيارات المبلغ',value:'`كامل` كل المتاح • `نص` نصفه • `ربع` ربعه • أو رقم محدد'},
      {name:'📈 السوق',value:'`سهم` • `شراء سهم 5` • `بيع سهم 5`'},
      {name:'🏆 الترتيب',value:'`توب` يعرض أعلى 5 حسب صافي الثروة'},
      {name:'🤝 الصداقة',value:'`طلب صداقة @member` • `صداقة @member` • `قائمة الأصدقاء` • `حذف صديق @member`'}
    ).setFooter({text:'Neverless Bank • أموال افتراضية فقط'});
  const icon=client.user?.displayAvatarURL?.({extension:'png',size:256});if(icon)e.setThumbnail(icon);return e;
}
async function replyImage(message,buffer,name,content,components=[]) {
  return message.reply({content:content||undefined,files:[{attachment:buffer,name}],components,allowedMentions:{repliedUser:false,parse:[]}});
}

function baseEmbed(user,title,color=0x17365d) {
  return new EmbedBuilder().setColor(color).setAuthor({name:user.globalName||user.username,iconURL:user.displayAvatarURL({extension:'png',size:256})}).setTitle(title).setTimestamp().setFooter({text:'Neverless Bank • أموال افتراضية فقط'});
}
function bar(value,total,size=10){const n=total>0?clamp(Math.round(value/total*size),0,size):0;return `${'▰'.repeat(n)}${'▱'.repeat(size-n)}`;}
function resultEmbed(user,title,wager,net,balance,details='') {
  return baseEmbed(user,title,net>0?0x22c55e:net<0?0xef4444:0x17365d)
    .setDescription(`${net>0?'📈 +':net<0?'📉 ':'➖ '}${money(net)}\n${bar(balance,Math.max(balance,wager*5,1000))}`)
    .addFields(
      {name:'👤 اللاعب',value:`<@${user.id}>`,inline:true},
      {name:'💵 المبلغ',value:money(wager),inline:true},
      {name:'💳 الرصيد',value:money(balance),inline:true},
      ...(details?[{name:'🎮 النتيجة',value:details}]:[])
    );
}
async function replyEmbed(message,embed,components=[]){return message.reply({embeds:[embed],components,allowedMentions:{repliedUser:false,users:[]}});}

async function balance(message) {
  const target=message.mentions.users.first()||message.author,{market,changed}=updateMarket(message.guildId);if(changed)await persistMarket(message.guild);const s=getUser(message.guildId,target.id);await persistUser(message.guild,target.id);
  const portfolio=s.shares*market.price,net=s.balance+s.vault+portfolio,rate=s.games?Math.round(s.wins/s.games*100):0;
  const embed=baseEmbed(target,'💳 الحساب البنكي').setThumbnail(target.displayAvatarURL({extension:'png',size:256}))
    .setDescription(`صافي الثروة **${money(net)}**\n${bar(net,Math.max(net,10000))}`)
    .addFields(
      {name:'💵 الرصيد المتاح',value:money(s.balance),inline:true},{name:'🏦 الخزنة',value:money(s.vault),inline:true},
      {name:'📈 الأسهم',value:`${s.shares} • ${money(portfolio)}`,inline:true},{name:'🏆 الأرباح',value:money(s.earned),inline:true},
      {name:'📉 الخسائر',value:money(s.lost),inline:true},{name:'🎯 الفوز',value:`${rate}% • ${s.wins}/${s.games}`,inline:true}
    );
  await replyEmbed(message,embed);
}
async function income(message,type) {
  await locked(message.guildId,async()=>{const s=getUser(message.guildId,message.author.id),isSalary=type==='salary',left=cooldownLeft(isSalary?s.salaryAt:s.tipAt,isSalary?SALARY_CD:TIP_CD);if(left){await message.reply({content:`🔴 الوقت الباقي **${left}**`,allowedMentions:{repliedUser:false}});return;}const amount=isSalary?700+Math.floor(Math.random()*801):120+Math.floor(Math.random()*381);s.balance+=amount;s.earned+=amount;if(isSalary)s.salaryAt=Date.now();else s.tipAt=Date.now();await persistUser(message.guild,message.author.id);await replyEmbed(message,resultEmbed(message.author,isSalary?'💰 راتب':'🎁 بخشيش',0,amount,s.balance,`تم إيداع **${money(amount)}** • متاح مجددًا بعد 5 دقائق`));});
}
async function transfer(message,raw) {
  const target=message.mentions.users.first();if(!target||target.bot||target.id===message.author.id){await message.reply({content:'استخدم: `تحويل @member 500`',allowedMentions:{repliedUser:false}});return;}
  await locked(message.guildId,async()=>{const a=getUser(message.guildId,message.author.id),amount=parseAmount(raw,a.balance);if(!Number.isFinite(amount)){await message.reply({content:`الرصيد المتاح **${money(a.balance)}**. اكتب مبلغ صحيح.`,allowedMentions:{repliedUser:false}});return;}const b=getUser(message.guildId,target.id);a.balance-=amount;b.balance+=amount;await Promise.all([persistUser(message.guild,message.author.id),persistUser(message.guild,target.id)]);
    const embed=baseEmbed(message.author,'💸 تحويل ناجح',0x22c55e).addFields({name:'من',value:`<@${message.author.id}>`,inline:true},{name:'إلى',value:`<@${target.id}>`,inline:true},{name:'المبلغ',value:money(amount),inline:true},{name:'رصيدك الآن',value:money(a.balance),inline:true},{name:'رصيد المستلم',value:money(b.balance),inline:true});
    await message.reply({embeds:[embed],allowedMentions:{repliedUser:false,users:[target.id]}});
  });
}
async function vault(message,action,raw) {
  await locked(message.guildId,async()=>{const s=getUser(message.guildId,message.author.id),source=action==='deposit'?s.balance:s.vault,amount=parseAmount(raw,source);if(!Number.isFinite(amount)){await message.reply({content:`المتاح **${money(source)}**. اكتب مبلغ صحيح.`,allowedMentions:{repliedUser:false}});return;}if(action==='deposit'){s.balance-=amount;s.vault+=amount;}else{s.vault-=amount;s.balance+=amount;}await persistUser(message.guild,message.author.id);
    await replyEmbed(message,baseEmbed(message.author,action==='deposit'?'🏦 إيداع بالخزنة':'💵 سحب من الخزنة',0x22c55e).addFields({name:'👤 العضو',value:`<@${message.author.id}>`,inline:true},{name:'💰 المبلغ',value:money(amount),inline:true},{name:'💳 الرصيد',value:money(s.balance),inline:true},{name:'🏦 الخزنة',value:money(s.vault),inline:true}));
  });
}
async function roulette(message,raw) {
  const wait=shortCd(message.author.id,'roulette',15000);if(wait){await message.reply({content:`⏳ انتظر **${wait}** ثانية.`,allowedMentions:{repliedUser:false}});return;}
  await locked(message.guildId,async()=>{const s=getUser(message.guildId,message.author.id),w=parseAmount(raw,Math.min(s.balance,MAX_BET));if(!Number.isFinite(w)){await message.reply({content:`استخدم: \`روليت 500\` — رصيدك ${money(s.balance)}.`,allowedMentions:{repliedUser:false}});return;}const r=Math.random(),mult=r>=.95?5:r>=.85?2:r>=.65?1.5:r>=.45?1:0,payout=Math.floor(w*mult),net=payout-w;s.balance=s.balance-w+payout;s.games++;if(net>0){s.wins++;s.earned+=net;}else if(net<0)s.lost+=-net;await persistUser(message.guild,message.author.id);await replyImage(message,rouletteCard(mult,w,payout),`roulette-${message.author.id}.png`,net>0?`✅ ربحت **${money(net)}**.`:net===0?'➖ رجع لك نفس الرهان.':`❌ خسرت **${money(-net)}**.`);});
}
function hiloButtons(uid,nonce,disabled=false){return[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nlbank:hilo:${nonce}:up`).setLabel('أعلى').setEmoji('📈').setStyle(ButtonStyle.Success).setDisabled(disabled),new ButtonBuilder().setCustomId(`nlbank:hilo:${nonce}:down`).setLabel('أقل').setEmoji('📉').setStyle(ButtonStyle.Danger).setDisabled(disabled))];}
async function hilo(message,raw) {
  const s=getUser(message.guildId,message.author.id),w=parseAmount(raw,Math.min(s.balance,MAX_BET));if(!Number.isFinite(w)){await message.reply({content:`استخدم: \`هايلو 500\` — رصيدك ${money(s.balance)}.`,allowedMentions:{repliedUser:false}});return;}const wait=shortCd(message.author.id,'hilo',12000);if(wait){await message.reply({content:`⏳ انتظر **${wait}** ثانية.`,allowedMentions:{repliedUser:false}});return;}
  const current=2+Math.floor(Math.random()*13),nonce=crypto.randomBytes(4).toString('hex'),sent=await replyImage(message,hiloCard(current,null,null,w),`hilo-${nonce}.png`,null,hiloButtons(message.author.id,nonce));const collector=sent.createMessageComponentCollector({time:45000});
  collector.on('collect',async(i)=>{if(i.user.id!==message.author.id){await i.reply({content:'هذه اللعبة ليست لك.',ephemeral:true}).catch(()=>{});return;}collector.stop('done');await i.deferUpdate().catch(()=>{});const up=i.customId.endsWith(':up');let out;await locked(message.guildId,async()=>{const f=getUser(message.guildId,message.author.id);if(f.balance<w){out={error:`رصيدك صار أقل من ${money(w)}.`};return;}let next=current;while(next===current)next=2+Math.floor(Math.random()*13);const won=up?next>current:next<current,payout=won?Math.floor(w*1.85):0;f.balance=f.balance-w+payout;f.games++;if(won){f.wins++;f.earned+=payout-w;}else f.lost+=w;await persistUser(message.guild,message.author.id);out={next,won,payout};});if(out.error){await sent.edit({content:out.error,components:hiloButtons(message.author.id,nonce,true)}).catch(()=>{});return;}await sent.edit({content:out.won?`✅ ربحت **${money(out.payout-w)}**.`:`❌ خسرت **${money(w)}**.`,files:[{attachment:hiloCard(current,out.next,out.won,w),name:`hilo-result-${nonce}.png`}],attachments:[],components:hiloButtons(message.author.id,nonce,true),allowedMentions:{parse:[]}}).catch(()=>{});});
  collector.on('end',async(_,reason)=>{if(reason!=='done')await sent.edit({components:hiloButtons(message.author.id,nonce,true)}).catch(()=>{});});
}
function boxButtons(nonce,disabled=false){return[new ActionRowBuilder().addComponents(...Array.from({length:5},(_,i)=>new ButtonBuilder().setCustomId(`nlbank:box:${nonce}:${i}`).setLabel(String(i+1)).setEmoji('🎁').setStyle(ButtonStyle.Secondary).setDisabled(disabled)))];}
async function boxes(message,raw) {
  const s=getUser(message.guildId,message.author.id),w=parseAmount(raw||'500',Math.min(s.balance,MAX_BET));if(!Number.isFinite(w)){await message.reply({content:`استخدم: \`صناديق 500\` — رصيدك ${money(s.balance)}.`,allowedMentions:{repliedUser:false}});return;}const wait=shortCd(message.author.id,'boxes',12000);if(wait){await message.reply({content:`⏳ انتظر **${wait}** ثانية.`,allowedMentions:{repliedUser:false}});return;}
  const bomb=Math.floor(Math.random()*5),mults=[.5,.8,1.2,2].sort(()=>Math.random()-.5),list=[];let j=0;for(let i=0;i<5;i++)list.push(i===bomb?{bomb:true,mult:0}:{bomb:false,mult:mults[j++]});const nonce=crypto.randomBytes(4).toString('hex'),sent=await replyImage(message,boxesCard(w),`boxes-${nonce}.png`,null,boxButtons(nonce));const collector=sent.createMessageComponentCollector({time:45000});
  collector.on('collect',async(i)=>{if(i.user.id!==message.author.id){await i.reply({content:'هذه الصناديق ليست لك.',ephemeral:true}).catch(()=>{});return;}collector.stop('done');await i.deferUpdate().catch(()=>{});const idx=Number(i.customId.split(':')[3]),pick=list[idx];let out;await locked(message.guildId,async()=>{const f=getUser(message.guildId,message.author.id);if(f.balance<w){out={error:`رصيدك صار أقل من ${money(w)}.`};return;}const payout=pick.bomb?0:Math.floor(w*pick.mult),net=payout-w;f.balance=f.balance-w+payout;f.games++;if(net>0){f.wins++;f.earned+=net;}else if(net<0)f.lost+=-net;await persistUser(message.guild,message.author.id);out={payout,net};});if(out.error){await sent.edit({content:out.error,components:boxButtons(nonce,true)}).catch(()=>{});return;}await sent.edit({content:pick.bomb?`💥 انفجر الصندوق وخسرت **${money(w)}**.`:out.net>=0?`✅ x${pick.mult} — صافي **${money(out.net)}**.`:`📦 رجع لك **${money(out.payout)}**.`,files:[{attachment:boxesCard(w,list),name:`boxes-result-${nonce}.png`}],attachments:[],components:boxButtons(nonce,true),allowedMentions:{parse:[]}}).catch(()=>{});});collector.on('end',async(_,reason)=>{if(reason!=='done')await sent.edit({components:boxButtons(nonce,true)}).catch(()=>{});});
}
function marketGraph(history){const blocks='▁▂▃▄▅▆▇█',min=Math.min(...history),max=Math.max(...history);return history.map((value)=>blocks[Math.round((value-min)/Math.max(1,max-min)*(blocks.length-1))]).join('');}
async function stock(message) { await locked(message.guildId,async()=>{const {market,changed}=updateMarket(message.guildId);if(changed)await persistMarket(message.guild);const first=market.history[0]||market.price,pct=(market.price-first)/Math.max(1,first)*100;
  await replyEmbed(message,new EmbedBuilder().setColor(pct>=0?0x22c55e:0xef4444).setTitle('📈 سوق Neverless').setDescription(`\`${marketGraph(market.history)}\``).addFields({name:'السعر الحالي',value:money(market.price),inline:true},{name:'التغيّر',value:`${pct>=0?'+':''}${pct.toFixed(1)}%`,inline:true}).setFooter({text:'السوق الافتراضي يتحدث كل 5 دقائق'}));
}); }
async function tradeStock(message,action,raw) {
  await locked(message.guildId,async()=>{const {market,changed}=updateMarket(message.guildId),s=getUser(message.guildId,message.author.id),count=parseShares(raw);if(!Number.isFinite(count)){await message.reply({content:`استخدم: \`${action==='buy'?'شراء سهم 5':'بيع سهم 5'}\`.`,allowedMentions:{repliedUser:false}});return;}const total=count*market.price;if(action==='buy'){if(s.balance<total){await message.reply({content:`تحتاج **${money(total)}** ورصيدك **${money(s.balance)}**.`,allowedMentions:{repliedUser:false}});return;}s.balance-=total;s.shares+=count;}else{if(s.shares<count){await message.reply({content:`عندك **${s.shares}** سهم فقط.`,allowedMentions:{repliedUser:false}});return;}s.shares-=count;s.balance+=total;}await persistUser(message.guild,message.author.id);if(changed)await persistMarket(message.guild);
    await replyEmbed(message,baseEmbed(message.author,action==='buy'?'🟢 شراء أسهم':'🔴 بيع أسهم',action==='buy'?0x22c55e:0xef4444).addFields({name:'👤 العضو',value:`<@${message.author.id}>`,inline:true},{name:'عدد الأسهم',value:String(count),inline:true},{name:'قيمة الصفقة',value:money(total),inline:true},{name:'سعر السهم',value:money(market.price),inline:true},{name:'رصيدك',value:money(s.balance),inline:true},{name:'أسهمك',value:String(s.shares),inline:true}));
  });
}
async function top(message,client) {
  await locked(message.guildId,async()=>{const {market,changed}=updateMarket(message.guildId);if(changed)await persistMarket(message.guild);const rows=[];for(const [k,s] of users){if(!k.startsWith(`${message.guildId}:`))continue;rows.push({userId:k.split(':')[1],net:s.balance+s.vault+s.shares*market.price});}rows.sort((a,b)=>b.net-a.net);const medals=['🥇','🥈','🥉','4️⃣','5️⃣'],lines=rows.slice(0,5).map((r,i)=>`${medals[i]} <@${r.userId}> — **${money(r.net)}**`);
    await replyEmbed(message,new EmbedBuilder().setColor(0x17365d).setTitle('🏆 أغنى أعضاء Neverless').setDescription(lines.join('\n')||'لا توجد حسابات حتى الآن.').addFields({name:'سعر السهم',value:money(market.price),inline:true}).setFooter({text:'الترتيب حسب صافي الثروة'}));
  });
}

function statusEmbed(user,s) {
  const labels=[['salary','راتب'],['tip','بخشيش'],['bet','رهان'],['invest','استثمار'],['dice','نرد'],['gamble','قمار'],['trade','تداول']];
  return baseEmbed(user,'⏱️ أوقات الأوامر').setDescription('مدة كل أمر **5 دقائق** وتُحفظ بعد إعادة التشغيل.')
    .addFields(labels.map(([name,label])=>({name:label,value:name==='salary'
      ? (cooldownLeft(s.salaryAt,SALARY_CD)?`🔴 الوقت الباقي ${cooldownLeft(s.salaryAt,SALARY_CD)}`:'🟢 متاح')
      : name==='tip'
        ? (cooldownLeft(s.tipAt,TIP_CD)?`🔴 الوقت الباقي ${cooldownLeft(s.tipAt,TIP_CD)}`:'🟢 متاح')
        : cooldownStatus(commandCooldownLeft(s,name)),inline:true})));
}
function randomOutcome(type,wager) {
  if(type==='bet'){const won=Math.random()<.48;return{payout:won?Math.floor(wager*1.9):0,details:won?'🟢 فاز الرهان • x1.9':'🔴 خسر الرهان'};}
  if(type==='invest'){const pct=Math.floor(Math.random()*71)-30;return{payout:Math.max(0,Math.floor(wager*(1+pct/100))),details:`${pct>=0?'📈':'📉'} عائد الاستثمار ${pct>=0?'+':''}${pct}%`};}
  if(type==='dice'){const player=1+Math.floor(Math.random()*6),bank=1+Math.floor(Math.random()*6);return{payout:player>bank?wager*2:player===bank?wager:0,details:`🎲 أنت: **${player}** • البنك: **${bank}**`};}
  if(type==='gamble'){const roll=Math.random(),mult=roll<.52?0:roll<.78?1.5:roll<.94?2:5;return{payout:Math.floor(wager*mult),details:`🎰 المضاعف **x${mult}**`};}
  const pct=Math.floor(Math.random()*51)-22;return{payout:Math.max(0,Math.floor(wager*(1+pct/100))),details:`${pct>=0?'🟢 صفقة ناجحة':'🔴 صفقة خاسرة'} • ${pct>=0?'+':''}${pct}%`};
}
async function moneyGame(message,type,raw) {
  const names={bet:'رهان',invest:'استثمار',dice:'نرد',gamble:'قمار',trade:'تداول'};
  await locked(message.guildId,async()=>{
    const s=getUser(message.guildId,message.author.id),left=commandCooldownLeft(s,type);
    if(left){await message.reply({content:cooldownStatus(left),allowedMentions:{repliedUser:false}});return;}
    const wager=parseAmount(raw,s.balance);
    if(!Number.isFinite(wager)){await message.reply({content:`الاستخدام: \`${names[type]} كامل\` أو \`${names[type]} نص\` أو \`${names[type]} ربع\` أو \`${names[type]} 1000\`\nرصيدك: **${money(s.balance)}**`,allowedMentions:{repliedUser:false}});return;}
    const out=randomOutcome(type,wager),net=out.payout-wager;s.balance=s.balance-wager+out.payout;s.games+=1;
    if(net>0){s.wins+=1;s.earned+=net;}else if(net<0)s.lost+=-net;
    setCommandCooldown(s,type);await persistUser(message.guild,message.author.id);
    await replyEmbed(message,resultEmbed(message.author,`🎮 ${names[type]}`,wager,net,s.balance,`${out.details}\nالمبلغ العائد: **${money(out.payout)}**`));
  });
}

function normalized(content) { return digits(content).trim().replace(/^[-#]+\s*/u,'').replace(/^<@!?\d{15,22}>\s*/u,'').replace(/\s+/g,' ').toLowerCase(); }
async function handleBankMessage(message,client) {
  if(!message?.guildId||message.author?.bot||!BANK_CHANNELS.has(message.channelId))return false;const text=normalized(message.content);if(!text)return false;
  const known=/^(?:اوامر|أوامر|bank|bank help|رصيد|balance|bal|وقت|cooldowns?|راتب|salary|daily|بخشيش|tip|توب|top|سهم|اسهم|أسهم|stock|تحويل|transfer|ايداع|إيداع|deposit|سحب|withdraw|رهان|bet|استثمار|invest|نرد|dice|قمار|gamble|تداول|trade|روليت|roulette|هايلو|هاي لو|hilo|صناديق|boxes|شراء سهم|شراء اسهم|شراء أسهم|buy|بيع سهم|بيع اسهم|بيع أسهم|sell)(?:\s|$)/u.test(text);if(!known)return false;await ensureLoaded(message.guild);
  try {
    if(/^(?:اوامر|أوامر|bank|bank help)$/u.test(text)){await message.reply({embeds:[helpEmbed(client)],allowedMentions:{repliedUser:false}});return true;}
    if(/^(?:رصيد|balance|bal)(?:\s|$)/u.test(text)){await balance(message);return true;}
    if(/^(?:وقت|cooldowns?)$/u.test(text)){await replyEmbed(message,statusEmbed(message.author,getUser(message.guildId,message.author.id)));return true;}
    if(/^(?:راتب|salary|daily)$/u.test(text)){await income(message,'salary');return true;}
    if(/^(?:بخشيش|tip)$/u.test(text)){await income(message,'tip');return true;}
    if(/^(?:توب|top)$/u.test(text)){await top(message,client);return true;}
    if(/^(?:سهم|اسهم|أسهم|stock)$/u.test(text)){await stock(message);return true;}
    let m=text.match(/^(?:تحويل|transfer)\s+<@!?\d{15,22}>\s+(.+)$/u);if(m){await transfer(message,m[1]);return true;}
    m=text.match(/^(?:ايداع|إيداع|deposit)\s+(.+)$/u);if(m){await vault(message,'deposit',m[1]);return true;}
    m=text.match(/^(?:سحب|withdraw)\s+(.+)$/u);if(m){await vault(message,'withdraw',m[1]);return true;}
    const moneyGames=[
      [/^(?:رهان|bet)\s+(.+)$/u,'bet'],
      [/^(?:استثمار|invest)\s+(.+)$/u,'invest'],
      [/^(?:نرد|dice)\s+(.+)$/u,'dice'],
      [/^(?:قمار|gamble)\s+(.+)$/u,'gamble'],
      [/^(?:تداول|trade)\s+(.+)$/u,'trade'],
    ];
    for(const [pattern,type] of moneyGames){m=text.match(pattern);if(m){await moneyGame(message,type,m[1]);return true;}}
    m=text.match(/^(?:روليت|roulette)\s+(.+)$/u);if(m){await moneyGame(message,'gamble',m[1]);return true;}
    m=text.match(/^(?:هايلو|هاي لو|hilo)\s+(.+)$/u);if(m){await moneyGame(message,'bet',m[1]);return true;}
    m=text.match(/^(?:صناديق|boxes)(?:\s+(.+))?$/u);if(m){await moneyGame(message,'invest',m[1]||'500');return true;}
    m=text.match(/^(?:شراء سهم|شراء اسهم|شراء أسهم|buy)\s+(.+)$/u);if(m){await tradeStock(message,'buy',m[1]);return true;}
    m=text.match(/^(?:بيع سهم|بيع اسهم|بيع أسهم|sell)\s+(.+)$/u);if(m){await tradeStock(message,'sell',m[1]);return true;}
    await message.reply({content:'اكتب `اوامر` لعرض أوامر البنك.',allowedMentions:{repliedUser:false}});return true;
  } catch(e){console.error('[bank] command failed:',e);await message.reply({content:'صار خطأ مؤقت في البنك. جرّب مرة ثانية.',allowedMentions:{repliedUser:false}}).catch(()=>{});return true;}
}
function installBankSystem(client) {
  if(client.__neverlessBankInstalled)return;client.__neverlessBankInstalled=true;client.on('messageCreate',(m)=>handleBankMessage(m,client).catch((e)=>console.error('[bank] unhandled:',e)));console.log(`[bank] installed for ${[...BANK_CHANNELS].join(', ')}`);
}

module.exports={installBankSystem,handleBankMessage,parseAmount,parseShares,parseRecord,unpackUser,commandCooldownLeft,cooldownStatus,BANK_CHANNEL_ID,BANK_TEST_CHANNEL_ID,BANK_EXTRA_CHANNEL_ID,COMMAND_CD};
