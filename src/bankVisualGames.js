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
  const { canvas, ctx } = baseCard('NEVERLESS ROULETTE', 'دولاب الحظ', 1000, 620, color);
  const cx = 500;
  const cy = 330;
  const radius = 185;
  const slots = [0, 1.5, 0, 2, 1, 0, 5, 0, 1.5, 0, 2, 1];

  slots.forEach((m, index) => {
    const a = -Math.PI / 2 + index * Math.PI * 2 / slots.length;
    const b = -Math.PI / 2 + (index + 1) * Math.PI * 2 / slots.length;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, a, b);
    ctx.closePath();
    ctx.fillStyle = index % 2 ? '#0e2740' : '#153553';
    ctx.fill();
    ctx.strokeStyle = '#45617e';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const mid = (a + b) / 2;
    const tx = cx + Math.cos(mid) * radius * 0.70;
    const ty = cy + Math.sin(mid) * radius * 0.70;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(mid + Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = THEME.silver;
    ctx.font = '800 16px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`x${m}`, 0, 5);
    ctx.restore();
  });

  ctx.beginPath();
  ctx.arc(cx, cy, 86, 0, Math.PI * 2);
  ctx.fillStyle = '#eaf0f5';
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0e2740';
  ctx.font = '900 38px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(`x${mult}`, cx, cy + 12);
  ctx.textAlign = 'left';

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, 126);
  ctx.lineTo(cx - 18, 155);
  ctx.lineTo(cx + 18, 155);
  ctx.closePath();
  ctx.fill();

  centerText(ctx, net > 0 ? `ربحت ${money(net)}` : net < 0 ? `خسرت ${money(-net)}` : 'عاد لك نفس المبلغ', 500, 558, '900 25px "Noto Sans Arabic", "Neverless Latin"', color);
  centerText(ctx, `الرهان ${money(wager)} • الرصيد ${money(balance)}`, 500, 590, '600 15px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

function hiloCard(current, next = null, won = null, wager = 0, balance = null) {
  const accent = won === null ? THEME.blue : won ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS HIGH / LOW', `الرهان ${money(wager)}`, 1000, 535, accent);

  const drawNumber = (x, number, color) => {
    fillRoundRect(ctx, x, 165, 225, 250, 24, '#eaf0f5', color, 3);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0b1726';
    ctx.font = '900 86px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(String(number), x + 112, 315);
    ctx.textAlign = 'left';
  };

  drawNumber(145, current, THEME.blue);
  if (next !== null) {
    drawNumber(630, next, accent);
    centerText(ctx, won ? 'اختيار صحيح' : 'اختيار خاطئ', 500, 462, '900 27px "Noto Sans Arabic", "Neverless Latin"', accent);
    if (balance !== null) centerText(ctx, `الرصيد ${money(balance)}`, 500, 497, '600 16px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  } else {
    centerText(ctx, 'هل الرقم القادم أعلى أم أقل؟', 720, 270, '800 23px "Noto Sans Arabic", "Neverless Latin"', THEME.text);
    centerText(ctx, 'اختر من الأزرار بالأسفل', 720, 309, '600 16px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  }
  return canvas.toBuffer('image/png');
}

function boxesCard(wager, boxes = null, picked = null, balance = null) {
  const pickedBox = picked === null ? null : boxes?.[picked];
  const accent = !pickedBox ? THEME.blue : pickedBox.bomb ? THEME.red : pickedBox.mult > 1 ? THEME.green : THEME.gold;
  const { canvas, ctx } = baseCard('NEVERLESS VAULT BOXES', `الدخول ${money(wager)}`, 1100, 535, accent);

  for (let index = 0; index < 5; index += 1) {
    const x = 65 + index * 202;
    const box = boxes?.[index];
    const selected = picked === index;
    const fill = !box ? '#0e1d2e' : box.bomb ? '#421c2a' : '#12342d';
    fillRoundRect(ctx, x, 170, 170, 205, 20, fill, selected ? accent : THEME.stroke, selected ? 3 : 1.5);
    ctx.textAlign = 'center';
    ctx.fillStyle = box?.bomb ? THEME.red : box ? THEME.green : THEME.cyan;
    ctx.font = '900 48px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(box ? (box.bomb ? 'X' : `x${box.mult}`) : '?', x + 85, 278);
    ctx.fillStyle = THEME.silver;
    ctx.font = '800 17px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`BOX ${index + 1}`, x + 85, 333);
    ctx.textAlign = 'left';
  }

  if (!boxes) {
    centerText(ctx, 'اختر صندوقاً واحداً • صندوق واحد مفخخ', 550, 435, '700 18px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  } else if (pickedBox) {
    centerText(ctx, pickedBox.bomb ? 'الصندوق انفجر' : `المضاعف x${pickedBox.mult}`, 550, 430, '900 24px "Noto Sans Arabic", "Neverless Latin"', accent);
    if (balance !== null) centerText(ctx, `الرصيد ${money(balance)}`, 550, 466, '600 16px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  }
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
};
