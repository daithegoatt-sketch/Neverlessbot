'use strict';

const {
  THEME,
  baseCard,
  fillRoundRect,
  fitText,
  centerText,
  metric,
  loadAvatarImage,
  drawAvatarImage,
  playerName,
  drawLineChart,
} = require('./bankVisualBase');
const { money } = require('./bankUtils');

function seriesForOutcome(percent, count = 22) {
  const start = 100;
  const target = Math.max(8, start * (1 + percent / 100));
  const values = [];
  let previous = start;
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const baseline = start + (target - start) * t;
    const remaining = 1 - Math.abs(0.5 - t) * 1.65;
    const noise = (Math.random() - 0.5) * 11 * Math.max(0.15, remaining);
    previous = i === 0 ? start : previous * 0.28 + (baseline + noise) * 0.72;
    values.push(previous);
  }
  values[0] = start;
  values[values.length - 1] = target;
  return values;
}

async function investmentCard(user, wager, out, net, balance) {
  const color = net > 0 ? THEME.green : net < 0 ? THEME.red : THEME.blue;
  const { canvas, ctx } = baseCard('NEVERLESS INVEST', 'محفظة استثمار افتراضية', 1100, 640, color);
  drawAvatarImage(ctx, await loadAvatarImage(user), 68, 152, 92, color);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 260, 23, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 182, 187);
  ctx.fillStyle = THEME.muted;
  ctx.font = '500 14px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(net >= 0 ? 'POSITION CLOSED • PROFIT' : 'POSITION CLOSED • LOSS', 182, 215);

  fillRoundRect(ctx, 55, 260, 990, 265, 22, 'rgba(7,17,30,.92)', THEME.strokeSoft, 1.5);
  drawLineChart(ctx, seriesForOutcome(out.percent, 24), 90, 300, 920, 180, color);

  ctx.textAlign = 'right';
  ctx.fillStyle = color;
  ctx.font = '900 42px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(`${out.percent >= 0 ? '+' : ''}${out.percent}%`, 1010, 243);
  ctx.textAlign = 'left';

  metric(ctx, 55, 545, 230, 70, 'المبلغ المستثمر', money(wager), THEME.silver);
  metric(ctx, 305, 545, 230, 70, 'العائد', money(out.payout), color);
  metric(ctx, 555, 545, 230, 70, net >= 0 ? 'الربح' : 'الخسارة', `${net >= 0 ? '+' : '-'}${money(Math.abs(net))}`, color);
  metric(ctx, 805, 545, 240, 70, 'الرصيد', money(balance), THEME.text);
  return canvas.toBuffer('image/png');
}

async function betCard(user, wager, out, net, balance) {
  const won = net > 0;
  const color = won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS BET', 'تذكرة الرهان', 1000, 500, color);
  drawAvatarImage(ctx, await loadAvatarImage(user), 72, 155, 108, color);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 270, 25, 16, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 205, 194);

  fillRoundRect(ctx, 515, 150, 390, 210, 24, won ? 'rgba(21,70,53,.34)' : 'rgba(79,29,42,.34)', color, 2);
  centerText(ctx, won ? 'رهان ناجح' : 'الرهان خسر', 710, 205, '800 26px "Noto Sans Arabic", "Neverless Latin"', color);
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.font = '900 54px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(won ? `+${money(net)}` : `-${money(Math.abs(net))}`, 710, 282);
  ctx.textAlign = 'left';
  centerText(ctx, `x${out.multiplier.toFixed(1)}`, 710, 326, '700 18px "Noto Sans Arabic", "Neverless Latin"', THEME.silver);

  metric(ctx, 72, 385, 260, 72, 'الرهان', money(wager), THEME.silver);
  metric(ctx, 370, 385, 260, 72, 'العائد', money(out.payout), color);
  metric(ctx, 668, 385, 260, 72, 'الرصيد', money(balance), THEME.text);
  return canvas.toBuffer('image/png');
}

function drawDie(ctx, x, y, size, value, color) {
  fillRoundRect(ctx, x, y, size, size, 22, '#eaf0f5', color, 3);
  const positions = {
    1: [[0.5, 0.5]],
    2: [[0.28, 0.28], [0.72, 0.72]],
    3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
    4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
    5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
    6: [[0.28, 0.24], [0.72, 0.24], [0.28, 0.5], [0.72, 0.5], [0.28, 0.76], [0.72, 0.76]],
  };
  ctx.fillStyle = '#0b1726';
  for (const [px, py] of positions[value] || []) {
    ctx.beginPath();
    ctx.arc(x + size * px, y + size * py, size * 0.055, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function diceCard(user, opponent, wager, playerRoll, opponentRoll, result, balance = null) {
  const color = result === 'win' ? THEME.green : result === 'loss' ? THEME.red : THEME.blue;
  const { canvas, ctx } = baseCard('NEVERLESS DICE', 'مواجهة النرد', 1050, 560, color);
  const [leftAvatar, rightAvatar] = await Promise.all([loadAvatarImage(user), loadAvatarImage(opponent)]);

  drawAvatarImage(ctx, leftAvatar, 70, 155, 82, THEME.blue);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 230, 22, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 170, 190);

  drawAvatarImage(ctx, rightAvatar, 898, 155, 82, THEME.silver);
  ctx.textAlign = 'right';
  ctx.font = `800 ${fitText(ctx, playerName(opponent), 230, 22, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(opponent), 878, 190);
  ctx.textAlign = 'left';

  drawDie(ctx, 235, 220, 190, playerRoll, THEME.blue);
  drawDie(ctx, 625, 220, 190, opponentRoll, THEME.silver);

  ctx.strokeStyle = THEME.stroke;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(525, 205);
  ctx.lineTo(525, 430);
  ctx.stroke();

  centerText(ctx, String(playerRoll), 330, 455, '900 28px "Noto Sans Arabic", "Neverless Latin"', THEME.blue);
  centerText(ctx, String(opponentRoll), 720, 455, '900 28px "Noto Sans Arabic", "Neverless Latin"', THEME.silver);
  centerText(ctx, result === 'win' ? 'فوز' : result === 'loss' ? 'خسارة' : 'تعادل', 525, 470, '900 30px "Noto Sans Arabic", "Neverless Latin"', color);

  metric(ctx, 70, 485, 260, 58, 'المبلغ', money(wager), THEME.silver);
  metric(ctx, 395, 485, 260, 58, 'النتيجة', result === 'win' ? `+${money(wager)}` : result === 'loss' ? `-${money(wager)}` : money(0), color);
  metric(ctx, 720, 485, 260, 58, 'الرصيد', balance === null ? '—' : money(balance), THEME.text);
  return canvas.toBuffer('image/png');
}

function drawCherry(ctx, cx, cy, scale = 1) {
  ctx.save();
  ctx.lineWidth = 6 * scale;
  ctx.strokeStyle = '#4eb06a';
  ctx.beginPath();
  ctx.moveTo(cx - 4 * scale, cy - 18 * scale);
  ctx.quadraticCurveTo(cx + 18 * scale, cy - 50 * scale, cx + 31 * scale, cy - 42 * scale);
  ctx.stroke();

  ctx.fillStyle = '#dc334f';
  ctx.beginPath();
  ctx.arc(cx - 14 * scale, cy, 23 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 20 * scale, cy + 7 * scale, 23 * scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#5fc879';
  ctx.beginPath();
  ctx.ellipse(cx + 28 * scale, cy - 42 * scale, 18 * scale, 9 * scale, -0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSlotSymbol(ctx, kind, x, y) {
  if (kind === 'cherry') {
    drawCherry(ctx, x, y, 1.05);
    return;
  }
  if (kind === 'diamond') {
    ctx.fillStyle = '#63c7ff';
    ctx.beginPath();
    ctx.moveTo(x, y - 38);
    ctx.lineTo(x + 38, y);
    ctx.lineTo(x, y + 38);
    ctx.lineTo(x - 38, y);
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = kind === 'seven' ? '#d8344f' : '#163654';
  ctx.font = kind === 'seven'
    ? '900 74px "Noto Sans Arabic", "Neverless Latin"'
    : '900 32px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(kind === 'seven' ? '7' : 'BAR', x, y + 20);
  ctx.textAlign = 'left';
}

async function gambleCard(user, wager, out, net, balance) {
  const won = net > 0;
  const color = won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS JACKPOT', 'آلة الحظ', 1000, 560, color);
  drawAvatarImage(ctx, await loadAvatarImage(user), 62, 150, 88, color);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 260, 22, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 172, 185);

  const symbols = won ? ['cherry', 'cherry', 'cherry'] : ['bar', 'seven', 'diamond'];
  symbols.forEach((symbol, index) => {
    const x = 350 + index * 170;
    fillRoundRect(ctx, x, 155, 145, 165, 18, 'rgba(238,244,249,.97)', THEME.stroke, 2);
    drawSlotSymbol(ctx, symbol, x + 72, 235);
  });

  centerText(ctx, won ? 'JACKPOT' : 'حاول مرة أخرى', 600, 365, '900 30px "Noto Sans Arabic", "Neverless Latin"', color);
  centerText(ctx, `x${out.multiplier}`, 600, 400, '800 20px "Noto Sans Arabic", "Neverless Latin"', THEME.silver);

  metric(ctx, 65, 445, 265, 72, 'الرهان', money(wager), THEME.silver);
  metric(ctx, 365, 445, 265, 72, won ? 'صافي الربح' : 'الخسارة', `${won ? '+' : '-'}${money(Math.abs(net))}`, color);
  metric(ctx, 665, 445, 265, 72, 'الرصيد', money(balance), THEME.text);
  return canvas.toBuffer('image/png');
}

async function tradeGameCard(user, wager, out, net, balance) {
  const color = net >= 0 ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS TRADE', 'صفقة قصيرة', 1050, 600, color);
  drawAvatarImage(ctx, await loadAvatarImage(user), 65, 150, 86, color);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 255, 22, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 172, 184);
  ctx.fillStyle = color;
  ctx.font = '900 38px "Noto Sans Arabic", "Neverless Latin"';
  ctx.textAlign = 'right';
  ctx.fillText(`${out.percent >= 0 ? '+' : ''}${out.percent}%`, 982, 191);
  ctx.textAlign = 'left';

  fillRoundRect(ctx, 55, 245, 940, 230, 22, 'rgba(7,17,30,.93)', THEME.strokeSoft, 1.5);
  drawLineChart(ctx, seriesForOutcome(out.percent, 18), 90, 280, 870, 155, color);

  metric(ctx, 55, 500, 290, 70, 'حجم الصفقة', money(wager), THEME.silver);
  metric(ctx, 380, 500, 290, 70, net >= 0 ? 'ربح الصفقة' : 'خسارة الصفقة', `${net >= 0 ? '+' : '-'}${money(Math.abs(net))}`, color);
  metric(ctx, 705, 500, 290, 70, 'الرصيد', money(balance), THEME.text);
  return canvas.toBuffer('image/png');
}

function rouletteCard(mult, wager, payout, balance) {
  const net = payout - wager;
  const color = net > 0 ? THEME.green : net < 0 ? THEME.red : THEME.blue;
  const { canvas, ctx } = baseCard('NEVERLESS ROULETTE', 'دولاب الروليت', 1050, 650, color);
  const cx = 330, cy = 345, radius = 205;
  const slots = [
    {m:0,c:'#1b1f2a'},{m:1.5,c:'#9f2639'},{m:0,c:'#151922'},{m:2,c:'#a92d3f'},
    {m:1,c:'#151922'},{m:0,c:'#9f2639'},{m:5,c:'#12714f'},{m:0,c:'#151922'},
    {m:1.5,c:'#a92d3f'},{m:0,c:'#151922'},{m:2,c:'#9f2639'},{m:1,c:'#151922'}
  ];
  const winningIndex = slots.findIndex((slot) => slot.m === mult);
  slots.forEach((slot, index) => {
    const start = -Math.PI / 2 + index * Math.PI * 2 / slots.length;
    const end = -Math.PI / 2 + (index + 1) * Math.PI * 2 / slots.length;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,radius,start,end); ctx.closePath();
    ctx.fillStyle = slot.c; ctx.fill();
    ctx.strokeStyle = index === winningIndex ? color : '#52667d';
    ctx.lineWidth = index === winningIndex ? 5 : 1.5; ctx.stroke();
    const mid=(start+end)/2, tx=cx+Math.cos(mid)*radius*.72, ty=cy+Math.sin(mid)*radius*.72;
    ctx.save(); ctx.translate(tx,ty); ctx.rotate(mid+Math.PI/2); ctx.textAlign='center';
    ctx.fillStyle='#f2f5f8'; ctx.font='800 16px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`x${slot.m}`,0,5); ctx.restore();
  });
  ctx.beginPath(); ctx.arc(cx,cy,88,0,Math.PI*2); ctx.fillStyle='#e9eef4'; ctx.fill();
  ctx.strokeStyle=color; ctx.lineWidth=5; ctx.stroke();
  centerText(ctx,`x${mult}`,cx,cy+14,'900 40px "Noto Sans Arabic", "Neverless Latin"','#101c2a');
  ctx.fillStyle=color; ctx.beginPath(); ctx.moveTo(cx,112); ctx.lineTo(cx-20,150); ctx.lineTo(cx+20,150); ctx.closePath(); ctx.fill();

  fillRoundRect(ctx,610,165,370,310,24,'rgba(8,20,34,.95)',THEME.stroke,1.5);
  centerText(ctx,net>0?'فوز':net<0?'خسارة':'تعادل',795,220,'900 30px "Noto Sans Arabic", "Neverless Latin"',color);
  centerText(ctx,`المضاعف x${mult}`,795,265,'700 19px "Noto Sans Arabic", "Neverless Latin"',THEME.silver);
  centerText(ctx,net>0?`+${money(net)}`:net<0?`-${money(-net)}`:money(0),795,335,'900 46px "Noto Sans Arabic", "Neverless Latin"',color);
  metric(ctx,620,390,165,70,'الرهان',money(wager),THEME.silver);
  metric(ctx,805,390,165,70,'الرصيد',money(balance),THEME.text);
  centerText(ctx,'القطاع المحدد هو نتيجة الجولة',525,590,'600 15px "Noto Sans Arabic", "Neverless Latin"',THEME.muted);
  return canvas.toBuffer('image/png');
}

function hiloCard(current, next = null, won = null, wager = 0, balance = null) {
  const accent = won === null ? THEME.blue : won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS HIGH / LOW', 'أعلى أم أقل؟', 1000, 560, accent);
  const label = (n) => n === 14 ? 'A' : n === 13 ? 'K' : n === 12 ? 'Q' : n === 11 ? 'J' : String(n);

  const drawSuit = (kind, cx, cy, size, color) => {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (kind === 0) { // spade
      ctx.beginPath();
      ctx.moveTo(cx, cy - size * 0.55);
      ctx.bezierCurveTo(cx - size * 0.55, cy - size * 0.10, cx - size * 0.42, cy + size * 0.30, cx, cy + size * 0.08);
      ctx.bezierCurveTo(cx + size * 0.42, cy + size * 0.30, cx + size * 0.55, cy - size * 0.10, cx, cy - size * 0.55);
      ctx.fill();
      ctx.fillRect(cx - size * 0.08, cy + size * 0.02, size * 0.16, size * 0.42);
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.22, cy + size * 0.44);
      ctx.lineTo(cx + size * 0.22, cy + size * 0.44);
      ctx.lineTo(cx + size * 0.08, cy + size * 0.23);
      ctx.lineTo(cx - size * 0.08, cy + size * 0.23);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 1) { // heart
      ctx.beginPath();
      ctx.moveTo(cx, cy + size * 0.50);
      ctx.bezierCurveTo(cx - size * 0.65, cy + size * 0.08, cx - size * 0.55, cy - size * 0.48, cx - size * 0.18, cy - size * 0.38);
      ctx.bezierCurveTo(cx, cy - size * 0.32, cx, cy - size * 0.16, cx, cy - size * 0.08);
      ctx.bezierCurveTo(cx, cy - size * 0.16, cx, cy - size * 0.32, cx + size * 0.18, cy - size * 0.38);
      ctx.bezierCurveTo(cx + size * 0.55, cy - size * 0.48, cx + size * 0.65, cy + size * 0.08, cx, cy + size * 0.50);
      ctx.fill();
    } else if (kind === 2) { // diamond
      ctx.beginPath();
      ctx.moveTo(cx, cy - size * 0.58);
      ctx.lineTo(cx + size * 0.38, cy);
      ctx.lineTo(cx, cy + size * 0.58);
      ctx.lineTo(cx - size * 0.38, cy);
      ctx.closePath();
      ctx.fill();
    } else { // club
      ctx.beginPath(); ctx.arc(cx, cy - size * 0.22, size * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx - size * 0.22, cy + size * 0.05, size * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + size * 0.22, cy + size * 0.05, size * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(cx - size * 0.07, cy + size * 0.05, size * 0.14, size * 0.38);
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.22, cy + size * 0.43);
      ctx.lineTo(cx + size * 0.22, cy + size * 0.43);
      ctx.lineTo(cx + size * 0.07, cy + size * 0.24);
      ctx.lineTo(cx - size * 0.07, cy + size * 0.24);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };

  const drawCard = (x, n, activeColor) => {
    fillRoundRect(ctx,x,160,245,300,26,'#f4f6f8',activeColor,4);
    const suitKind = n % 4;
    const red = suitKind === 1 || suitKind === 2;
    const suitColor = red ? '#c63145' : '#101820';
    ctx.fillStyle=suitColor; ctx.textAlign='left';
    ctx.font='900 42px "Noto Sans Arabic", "Neverless Latin"'; ctx.fillText(label(n),x+24,215);
    drawSuit(suitKind, x + 42, 255, 34, suitColor);
    drawSuit(suitKind, x + 122, 330, 78, suitColor);
    ctx.textAlign='right'; ctx.font='900 42px "Noto Sans Arabic", "Neverless Latin"'; ctx.fillText(label(n),x+220,425);
    ctx.textAlign='left';
  };
  drawCard(110,current,THEME.blue);
  if(next!==null) {
    drawCard(645,next,accent);
    centerText(ctx, won ? 'اختيار صحيح' : 'اختيار خاطئ', 500, 505, '900 28px "Noto Sans Arabic", "Neverless Latin"', accent);
    centerText(ctx, `الرهان ${money(wager)} • الرصيد ${money(balance)}`, 500, 535, '600 15px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  } else {
    centerText(ctx,'VS',500,305,'900 34px "Noto Sans Arabic", "Neverless Latin"',THEME.silver);
    centerText(ctx,'اختر أعلى أو أقل من الأزرار',700,500,'700 18px "Noto Sans Arabic", "Neverless Latin"',THEME.text);
  }
  return canvas.toBuffer('image/png');
}

function boxesCard(wager, boxes = null, picked = null, balance = null) {
  const pickedBox = picked === null ? null : boxes?.[picked];
  const accent = !pickedBox ? THEME.blue : pickedBox.bomb ? THEME.red : pickedBox.mult > 1 ? THEME.green : THEME.gold;
  const { canvas, ctx } = baseCard('NEVERLESS VAULT BOXES', 'صناديق الخزنة', 1100, 560, accent);

  for (let index=0; index<5; index+=1) {
    const x=55+index*205, box=boxes?.[index], selected=picked===index;
    const stroke=selected?accent:THEME.stroke;
    // chest body
    fillRoundRect(ctx,x,215,170,150,18,'#7b4a24',stroke,selected?4:2);
    fillRoundRect(ctx,x+8,175,154,70,20,'#9c6534',stroke,selected?4:2);
    ctx.fillStyle='#d3a342'; ctx.fillRect(x+74,215,22,150);
    fillRoundRect(ctx,x+62,240,46,45,8,'#e0b64f','#6b4d1b',2);
    ctx.textAlign='center';
    ctx.fillStyle=THEME.silver; ctx.font='800 16px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`BOX ${index+1}`,x+85,400);
    if(box){
      ctx.fillStyle=box.bomb?THEME.red:THEME.green;
      if (box.bomb) {
        ctx.beginPath();
        ctx.arc(x + 85, 441, 19, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = THEME.red;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x + 98, 426);
        ctx.quadraticCurveTo(x + 116, 408, x + 126, 419);
        ctx.stroke();
        ctx.fillStyle = THEME.gold;
        ctx.beginPath();
        ctx.arc(x + 129, 417, 5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.font='900 42px "Noto Sans Arabic", "Neverless Latin"';
        ctx.fillText(`x${box.mult}`,x+85,455);
      }
    } else {
      ctx.font='900 42px "Noto Sans Arabic", "Neverless Latin"'; ctx.fillStyle=THEME.cyan; ctx.fillText('?',x+85,455);
    }
    ctx.textAlign='left';
  }
  if(!boxes) {
    centerText(ctx,`قيمة الدخول ${money(wager)} • اختر صندوقاً واحداً`,550,505,'700 18px "Noto Sans Arabic", "Neverless Latin"',THEME.muted);
  } else if(pickedBox) {
    const msg=pickedBox.bomb?'الصندوق مفخخ':pickedBox.mult>1?`ربحت x${pickedBox.mult}`:`عاد لك x${pickedBox.mult}`;
    centerText(ctx,msg,550,505,'900 24px "Noto Sans Arabic", "Neverless Latin"',accent);
    if(balance!==null) centerText(ctx,`الرصيد ${money(balance)}`,550,535,'600 15px "Noto Sans Arabic", "Neverless Latin"',THEME.muted);
  }
  return canvas.toBuffer('image/png');
}

function minesCard(wager, cells, revealed = [], result = null, balance = null) {
  const accent = result === 'loss' ? THEME.red : result === 'win' ? THEME.green : THEME.blue;
  const { canvas, ctx } = baseCard('NEVERLESS MINES', 'حقل الألغام', 900, 650, accent);
  const size = 120, gap = 18, startX = 125, startY = 170;
  for (let i = 0; i < 9; i += 1) {
    const row = Math.floor(i / 3), col = i % 3;
    const x = startX + col * (size + gap), y = startY + row * (size + gap);
    const isRevealed = revealed.includes(i);
    const mine = cells?.[i] === 'mine';
    fillRoundRect(ctx, x, y, size, size, 18, isRevealed ? (mine ? 'rgba(95,28,42,.96)' : 'rgba(19,70,54,.96)') : 'rgba(14,32,52,.96)', isRevealed ? (mine ? THEME.red : THEME.green) : THEME.stroke, 2);
    centerText(ctx, isRevealed ? (mine ? 'X' : 'SAFE') : String(i + 1), x + size/2, y + 72, isRevealed ? '900 25px "Noto Sans Arabic", "Neverless Latin"' : '900 28px "Noto Sans Arabic", "Neverless Latin"', isRevealed ? (mine ? THEME.red : THEME.green) : THEME.silver);
  }
  centerText(ctx, result === 'loss' ? 'انفجر اللغم' : result === 'win' ? 'نجوت وربحت' : 'اختر مربعاً', 450, 590, '900 26px "Noto Sans Arabic", "Neverless Latin"', accent);
  if (balance !== null) centerText(ctx, `الرهان ${money(wager)} • الرصيد ${money(balance)}`, 450, 620, '600 15px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

function fruitGameCard(wager, fruits, won, payout, balance) {
  const color = won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS FRUITS', 'لعبة الفواكه', 1000, 520, color);
  const labels = { cherry: 'CHERRY', lemon: 'LEMON', grape: 'GRAPE', melon: 'MELON' };
  fruits.forEach((fruit, i) => {
    const x = 155 + i * 245;
    fillRoundRect(ctx, x, 165, 190, 190, 22, 'rgba(238,244,249,.98)', THEME.stroke, 2);
    if (fruit === 'cherry') drawCherry(ctx, x + 95, 245, 1.1);
    else if (fruit === 'lemon') {
      ctx.fillStyle='#f2c94c'; ctx.beginPath(); ctx.ellipse(x+95,245,48,33,-.3,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#6fbf73'; ctx.beginPath(); ctx.ellipse(x+132,205,20,10,-.5,0,Math.PI*2); ctx.fill();
    } else if (fruit === 'grape') {
      ctx.fillStyle='#7653b5';
      for (const [dx,dy] of [[0,0],[-20,8],[20,8],[-10,28],[10,28],[0,48]]) {ctx.beginPath();ctx.arc(x+95+dx,225+dy,15,0,Math.PI*2);ctx.fill();}
    } else {
      ctx.fillStyle='#79b957'; ctx.beginPath(); ctx.arc(x+95,245,48,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#e55b68'; ctx.beginPath(); ctx.arc(x+95,245,38,0,Math.PI*2); ctx.fill();
    }
    centerText(ctx, labels[fruit], x+95, 340, '800 15px "Noto Sans Arabic", "Neverless Latin"', '#142338');
  });
  centerText(ctx, won ? `فوز • العائد ${money(payout)}` : `خسارة ${money(wager)}`, 500, 410, '900 28px "Noto Sans Arabic", "Neverless Latin"', color);
  centerText(ctx, `الرصيد ${money(balance)}`, 500, 455, '700 17px "Noto Sans Arabic", "Neverless Latin"', THEME.silver);
  return canvas.toBuffer('image/png');
}

function colorsCard(wager, target, picked = null, won = null, balance = null) {
  const palette = { red:'#d64c5f', blue:'#4f93df', green:'#4dbb82', gold:'#d6ae4d' };
  const accent = won === null ? THEME.blue : won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS COLORS', 'لعبة الألوان', 960, 500, accent);
  const names = ['red','blue','green','gold'];
  names.forEach((name,i)=>{
    const x=95+i*205;
    fillRoundRect(ctx,x,190,150,150,24,palette[name], picked===name ? '#ffffff' : THEME.stroke, picked===name ? 5 : 2);
    centerText(ctx,String(i+1),x+75,278,'900 34px "Noto Sans Arabic", "Neverless Latin"','#ffffff');
  });
  if (picked === null) {
    centerText(ctx,'اختر لوناً واحداً',480,395,'900 25px "Noto Sans Arabic", "Neverless Latin"',THEME.text);
  } else {
    centerText(ctx, won ? 'اختيار صحيح' : 'اختيار خاطئ',480,390,'900 27px "Noto Sans Arabic", "Neverless Latin"',accent);
    centerText(ctx,`اللون الفائز: ${target.toUpperCase()} • الرصيد ${money(balance)}`,480,430,'700 16px "Noto Sans Arabic", "Neverless Latin"',THEME.muted);
  }
  return canvas.toBuffer('image/png');
}

function coinCard(wager, side, result, won, balance) {
  const accent = won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS COIN', 'عملة', 820, 500, accent);
  ctx.beginPath(); ctx.arc(410,260,110,0,Math.PI*2); ctx.fillStyle='#d6ae4d'; ctx.fill(); ctx.strokeStyle='#f0d98a';ctx.lineWidth=8;ctx.stroke();
  centerText(ctx,result === 'heads' ? 'H' : 'T',410,292,'900 90px "Noto Sans Arabic", "Neverless Latin"','#17212c');
  centerText(ctx, won ? 'فوز' : 'خسارة',410,410,'900 28px "Noto Sans Arabic", "Neverless Latin"',accent);
  centerText(ctx,`اختيارك ${side === 'heads' ? 'وجه' : 'كتابة'} • ${money(wager)} • الرصيد ${money(balance)}`,410,450,'650 15px "Noto Sans Arabic", "Neverless Latin"',THEME.muted);
  return canvas.toBuffer('image/png');
}

function numberGuessCard(wager, picked, result, won, balance) {
  const accent = won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS NUMBER', 'تخمين الرقم', 860, 500, accent);
  metric(ctx,90,175,300,125,'اختيارك',String(picked),THEME.blue);
  metric(ctx,470,175,300,125,'الرقم الفائز',String(result),accent);
  centerText(ctx,won ? 'فوز x4' : 'خسارة',430,365,'900 30px "Noto Sans Arabic", "Neverless Latin"',accent);
  centerText(ctx,`الرهان ${money(wager)} • الرصيد ${money(balance)}`,430,420,'650 16px "Noto Sans Arabic", "Neverless Latin"',THEME.muted);
  return canvas.toBuffer('image/png');
}

module.exports = {
  investmentCard,
  betCard,
  diceCard,
  gambleCard,
  tradeGameCard,
  rouletteCard,
  hiloCard,
  boxesCard,
  minesCard,
  fruitGameCard,
  colorsCard,
  coinCard,
  numberGuessCard,
};
