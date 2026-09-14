'use strict';

const {
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
} = require('./bankVisualBase');
const {
  SALARY_CD,
  TIP_CD,
  money,
  commandCooldownLeft,
  formatDuration,
} = require('./bankUtils');

function helpCard() {
  const { canvas, ctx } = baseCard('NEVERLESS BANK', 'دليل أوامر البنك', 1100, 840, THEME.cyan);
  const sections = [
    ['الحساب', ['رصيد / بروفايل', 'ايداع 500', 'سحب 500', 'تحويل @member 500']],
    ['الدخل والوقت', ['راتب', 'بخشيش', 'وقت']],
    ['الألعاب', ['رهان كامل', 'استثمار نص', 'نرد ربع', 'قمار 1000', 'تداول كامل']],
    ['ألعاب تفاعلية', ['روليت 500', 'هايلو 500', 'صناديق 500']],
    ['السوق', ['سهم', 'شراء سهم 5', 'بيع سهم 5']],
    ['الترتيب والصداقة', ['توب', 'طلب صداقة @member', 'قائمة الأصدقاء', 'حذف صديق @member']],
  ];
  const positions = [
    [55, 145, 480, 205], [565, 145, 480, 205],
    [55, 375, 480, 205], [565, 375, 480, 205],
    [55, 600, 480, 175], [565, 600, 480, 175],
  ];

  sections.forEach(([title, commands], index) => {
    const [x, y, w, h] = positions[index];
    fillRoundRect(ctx, x, y, w, h, 20, 'rgba(10,22,37,.88)', THEME.strokeSoft, 1.5);
    rtlText(ctx, title, x + w - 24, y + 38, '800 21px "Noto Sans Arabic", "Neverless Latin"', THEME.silver);
    commands.forEach((command, i) => {
      const yy = y + 76 + i * 30;
      ctx.fillStyle = THEME.blue;
      ctx.beginPath();
      ctx.arc(x + w - 26, yy - 5, 3, 0, Math.PI * 2);
      ctx.fill();
      rtlText(ctx, command, x + w - 42, yy, '600 16px "Noto Sans Arabic", "Neverless Latin"', THEME.text);
    });
  });

  rtlText(ctx, 'خيارات المبلغ: كامل • نص • ربع • أو رقم محدد', 1042, 812, '600 14px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

async function balanceCard(user, state, price) {
  const { canvas, ctx } = baseCard('NEVERLESS BANK', 'بطاقة الحساب', 1100, 585, THEME.blue);
  drawAvatarImage(ctx, await loadAvatarImage(user), 64, 154, 158, THEME.cyan);

  const portfolio = Number(state.portfolioValue ?? (state.shares * price)) || 0;
  const positions = Math.max(0, Number(state.stockPositions ?? (state.shares > 0 ? 1 : 0)) || 0);
  const assetValue = Number(state.assetValue || 0);
  const net = state.balance + state.vault + portfolio + assetValue;
  const rate = state.games ? Math.round((state.wins / state.games) * 100) : 0;

  ctx.fillStyle = THEME.text;
  const size = fitText(ctx, playerName(user), 300, 31, 18, 800);
  ctx.font = `800 ${size}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 64, 350);
  if (state.rank) {
    ctx.fillStyle = THEME.gold;
    ctx.font = '800 18px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`#${state.rank}`, 64 + Math.min(300, ctx.measureText(playerName(user)).width + 18), 350);
  }
  ctx.fillStyle = THEME.muted;
  ctx.font = '500 15px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(`@${user.username}`, 64, 376);

  fillRoundRect(ctx, 64, 407, 250, 82, 18, 'rgba(10,24,39,.92)', THEME.strokeSoft, 1.5);
  ctx.fillStyle = THEME.muted;
  ctx.font = '600 13px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText('NET WORTH', 84, 434);
  ctx.fillStyle = THEME.green;
  ctx.font = '800 31px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(money(net), 84, 472);

  metric(ctx, 360, 150, 315, 92, 'الرصيد المتاح', money(state.balance), THEME.green);
  metric(ctx, 710, 150, 315, 92, 'الخزنة', money(state.vault), THEME.cyan);
  metric(ctx, 360, 265, 315, 92, 'محفظة الأسهم', `${positions} شركات • ${money(portfolio)}`, THEME.gold);
  metric(ctx, 710, 265, 315, 92, 'نسبة الفوز', `${rate}% • ${state.wins}/${state.games}`, THEME.silver);
  metric(ctx, 360, 380, 315, 92, 'إجمالي الأرباح', money(state.earned), THEME.green);
  metric(ctx, 710, 380, 315, 92, 'إجمالي الخسائر', money(state.lost), THEME.red);

  rtlText(ctx, `سعر NVRS الحالي: ${money(price)}`, 1025, 530, '600 14px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

async function rewardCard(user, label, amount, balance, kind) {
  const accent = kind === 'salary' ? THEME.green : kind === 'loan' ? THEME.cyan : THEME.gold;
  const { canvas, ctx } = baseCard('NEVERLESS BANK', label, 1000, 465, accent);
  drawAvatarImage(ctx, await loadAvatarImage(user), 76, 155, 118, accent);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 250, 26, 17, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 220, 195);
  ctx.fillStyle = THEME.muted;
  ctx.font = '500 15px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(kind === 'salary' ? 'PAYROLL CREDIT' : kind === 'loan' ? 'LOAN CREDIT' : 'BONUS CREDIT', 220, 222);

  fillRoundRect(ctx, 520, 145, 390, 190, 24, 'rgba(8,20,34,.94)', THEME.stroke, 1.5);
  centerText(ctx, kind === 'salary' ? 'تم إيداع الراتب' : kind === 'loan' ? 'تم إيداع القرض' : 'وصلتك مكافأة', 715, 190, '700 19px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  ctx.textAlign = 'center';
  ctx.fillStyle = accent;
  ctx.font = '900 55px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(`+${money(amount)}`, 715, 260);
  ctx.textAlign = 'left';
  centerText(ctx, `الرصيد الآن ${money(balance)}`, 715, 307, '700 17px "Noto Sans Arabic", "Neverless Latin"', THEME.text);
  rtlText(ctx, kind === 'loan' ? 'متاح مجدداً بعد ساعة' : 'متاح مجدداً بعد 5 دقائق', 910, 397, '600 15px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

async function vaultCard(user, action, amount, state) {
  const deposit = action === 'deposit';
  const accent = deposit ? THEME.cyan : THEME.green;
  const { canvas, ctx } = baseCard('NEVERLESS BANK', deposit ? 'إيداع في الخزنة' : 'سحب من الخزنة', 1000, 455, accent);
  drawAvatarImage(ctx, await loadAvatarImage(user), 70, 160, 110, accent);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 240, 24, 16, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 205, 196);
  ctx.fillStyle = THEME.muted;
  ctx.font = '500 14px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(deposit ? 'CASH → VAULT' : 'VAULT → CASH', 205, 222);

  metric(ctx, 500, 150, 410, 86, 'المبلغ', money(amount), accent);
  metric(ctx, 500, 255, 195, 86, 'الرصيد', money(state.balance), THEME.green);
  metric(ctx, 715, 255, 195, 86, 'الخزنة', money(state.vault), THEME.cyan);
  rtlText(ctx, deposit ? 'تم تأمين المبلغ في خزنتك' : 'تم تحويل المبلغ إلى رصيدك المتاح', 910, 397, '600 15px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

async function transferCard(from, to, amount, fromBalance, toBalance) {
  const { canvas, ctx } = baseCard('NEVERLESS BANK', 'تحويل ناجح', 1100, 510, THEME.green);
  const [fromAvatar, toAvatar] = await Promise.all([loadAvatarImage(from), loadAvatarImage(to)]);
  drawAvatarImage(ctx, fromAvatar, 80, 170, 120, THEME.blue);
  drawAvatarImage(ctx, toAvatar, 900, 170, 120, THEME.green);

  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(from), 245, 23, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(from), 70, 335);
  ctx.textAlign = 'right';
  ctx.font = `800 ${fitText(ctx, playerName(to), 245, 23, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(to), 1030, 335);
  ctx.textAlign = 'left';

  ctx.strokeStyle = 'rgba(90,168,255,.45)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(250, 230);
  ctx.lineTo(850, 230);
  ctx.stroke();
  ctx.fillStyle = THEME.green;
  ctx.beginPath();
  ctx.moveTo(850, 230);
  ctx.lineTo(828, 217);
  ctx.lineTo(828, 243);
  ctx.closePath();
  ctx.fill();

  centerText(ctx, 'قيمة التحويل', 550, 190, '600 16px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  ctx.textAlign = 'center';
  ctx.fillStyle = THEME.green;
  ctx.font = '900 47px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(money(amount), 550, 285);
  ctx.textAlign = 'left';

  metric(ctx, 115, 375, 340, 78, 'رصيد المرسل', money(fromBalance), THEME.silver);
  metric(ctx, 645, 375, 340, 78, 'رصيد المستلم', money(toBalance), THEME.green);
  return canvas.toBuffer('image/png');
}

function marketCard(market, companies, nextUpdateMs) {
  const entries = Object.values(companies);
  const height = 220 + entries.length * 105;
  const { canvas, ctx } = baseCard('NEVERLESS MARKET', 'سوق الأسهم الافتراضي', 1050, height, THEME.cyan);
  let y = 145;
  for (const company of entries) {
    const data = market.companies[company.code];
    const history = data.history?.length ? data.history : [data.price];
    const first = history[0] || data.price;
    const pct = ((data.price - first) / Math.max(1, first)) * 100;
    const color = pct >= 0 ? THEME.green : THEME.red;
    fillRoundRect(ctx, 55, y, 940, 92, 18, 'rgba(10,23,38,.92)', THEME.strokeSoft, 1.5);
    ctx.fillStyle = THEME.text;
    ctx.font = '800 22px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(company.name, 82, y + 38);
    ctx.fillStyle = THEME.muted;
    ctx.font = '700 14px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(company.code, 82, y + 67);
    ctx.textAlign = 'right';
    ctx.fillStyle = THEME.text;
    ctx.font = '900 25px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(money(data.price), 790, y + 39);
    ctx.fillStyle = color;
    ctx.font = '800 18px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, 950, y + 39);
    ctx.textAlign = 'left';
    y += 105;
  }
  centerText(ctx, `التحديث القادم بعد ${formatDuration(nextUpdateMs)}`, 525, height - 38, '700 16px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

async function stockTradeCard(user, action, company, units, total, price, state, portfolioValue, profit = null) {
  const buy = action === 'buy';
  const color = buy ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS MARKET', buy ? 'شراء أسهم' : 'بيع أسهم', 1000, 550, color);
  drawAvatarImage(ctx, await loadAvatarImage(user), 72, 155, 105, color);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 240, 24, 16, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 202, 195);
  ctx.fillStyle = THEME.muted;
  ctx.font = '700 15px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(`${company.name} - ${company.code}`, 202, 226);

  metric(ctx, 490, 150, 205, 84, 'الوحدات', Number(units).toFixed(4).replace(/0+$/,'').replace(/\.$/,''), THEME.silver);
  metric(ctx, 715, 150, 205, 84, 'سعر السهم', money(price), THEME.cyan);
  if (buy) {
    metric(ctx, 550, 255, 370, 76, 'قيمة الصفقة', money(total), color);
  } else {
    metric(ctx, 550, 255, 175, 76, 'قيمة الصفقة', money(total), color);
    const pl = Number(profit || 0);
    metric(ctx, 745, 255, 175, 76, pl >= 0 ? 'الربح' : 'الخسارة', `${pl >= 0 ? '+' : '-'}${money(Math.abs(pl))}`, pl >= 0 ? THEME.green : THEME.red);
  }
  metric(ctx, 72, 420, 260, 72, 'رصيدك', money(state.balance), THEME.green);
  metric(ctx, 370, 420, 260, 72, 'ملكيتك', Number(state.stocks?.[company.code] || 0).toFixed(4).replace(/0+$/,'').replace(/\.$/,''), THEME.gold);
  metric(ctx, 668, 420, 260, 72, 'قيمة المحفظة', money(portfolioValue), THEME.silver);
  return canvas.toBuffer('image/png');
}

function usageCard(command, lines) {
  const rows = Array.isArray(lines) ? lines : [String(lines || '')];
  const height = 280 + rows.length * 58;
  const { canvas, ctx } = baseCard('NEVERLESS BANK', `طريقة استخدام ${command}`, 980, height, THEME.cyan);
  let y = 165;
  rows.forEach((line, index) => {
    fillRoundRect(ctx, 70, y, 840, 44, 13, 'rgba(10,24,39,.92)', THEME.strokeSoft, 1.2);
    rtlText(ctx, line, 880, y + 29, '700 17px "Noto Sans Arabic", "Neverless Latin"', index === 0 ? THEME.text : THEME.silver);
    y += 58;
  });
  centerText(ctx, 'كامل • نص • ربع • أو مبلغ محدد', 490, height - 38, '600 14px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

function propertiesCard(state, market, companies, catalog, stockValue, assetValue) {
  const { canvas, ctx } = baseCard('NEVERLESS PROPERTIES', 'ممتلكاتك الحالية', 1050, 900, THEME.gold);

  const stockLines = Object.values(companies)
    .filter((company) => Number(state.stocks?.[company.code] || 0) > 0)
    .map((company) => `${company.code}  ${Number(state.stocks[company.code]).toFixed(2)}  ${money(Number(state.stocks[company.code]) * market.companies[company.code].price)}`);
  const byCategory = (cat) => Object.values(catalog)
    .filter((asset) => asset.category === cat && Number(state.assets?.[asset.code] || 0) > 0)
    .map((asset) => `${asset.name} x${Number(state.assets[asset.code]).toFixed(asset.fractional ? 3 : 0)}`);

  const groups = [
    ['الأسهم', stockLines.length ? stockLines.join('   ') : 'لا يوجد', THEME.cyan],
    ['العقارات', byCategory('PROPERTY').join('   ') || 'لا يوجد', THEME.green],
    ['السيارات', byCategory('CAR').join('   ') || 'لا يوجد', THEME.blue],
    ['الطائرات', byCategory('PLANE').join('   ') || 'لا يوجد', THEME.silver],
    ['الذهب', Number(state.assets?.GOLD || 0) > 0 ? `${Number(state.assets.GOLD).toFixed(3)} oz   ${money(Number(state.assets.GOLD) * market.assets.GOLD.price)}` : 'لا يوجد', THEME.gold],
  ];

  let y = 150;
  for (const [name, detail, color] of groups) {
    fillRoundRect(ctx, 60, y, 930, 112, 18, 'rgba(10,23,38,.92)', THEME.strokeSoft, 1.5);
    ctx.fillStyle = color;
    ctx.font = '900 23px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(name, 88, y + 39);
    ctx.fillStyle = THEME.text;
    const size = fitText(ctx, detail, 810, 18, 12, 600);
    ctx.font = `600 ${size}px "Noto Sans Arabic", "Neverless Latin"`;
    ctx.fillText(detail, 88, y + 78);
    y += 130;
  }

  const total = stockValue + assetValue;
  fillRoundRect(ctx, 250, 810, 550, 58, 18, 'rgba(21,70,53,.26)', THEME.green, 1.5);
  centerText(ctx, `قيمة ممتلكاتك ${money(total)}`, 525, 847, '900 22px "Noto Sans Arabic", "Neverless Latin"', THEME.green);
  return canvas.toBuffer('image/png');
}

async function assetTradeCard(user, action, asset, quantity, total, unitPrice, state, totalAssetsValue) {
  const buy = action === 'buy';
  const color = buy ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS ASSETS', buy ? 'شراء ممتلكات' : 'بيع ممتلكات', 1000, 510, color);
  drawAvatarImage(ctx, await loadAvatarImage(user), 70, 155, 100, color);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 260, 24, 16, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 195, 193);
  ctx.fillStyle = THEME.muted;
  ctx.font = '700 15px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(asset.name, 195, 220);

  metric(ctx, 490, 150, 205, 84, 'الكمية', asset.code === 'GOLD' ? Number(quantity).toFixed(3) : String(Math.round(quantity)), THEME.silver);
  metric(ctx, 715, 150, 205, 84, 'السعر الحالي', money(unitPrice), THEME.cyan);
  metric(ctx, 490, 255, 430, 84, 'قيمة العملية', money(total), color);
  metric(ctx, 72, 390, 260, 72, 'الرصيد', money(state.balance), THEME.green);
  metric(ctx, 370, 390, 260, 72, 'ما تملكه', asset.code === 'GOLD' ? Number(state.assets?.GOLD || 0).toFixed(3) : String(state.assets?.[asset.code] || 0), THEME.gold);
  metric(ctx, 668, 390, 260, 72, 'قيمة الممتلكات', money(totalAssetsValue), THEME.silver);
  return canvas.toBuffer('image/png');
}

async function topCard(rows, price) {
  const { canvas, ctx } = baseCard('NEVERLESS TOP 10', 'أغنى أعضاء البنك حسب صافي الثروة', 1050, 1280, THEME.gold);
  const avatars = await Promise.all(rows.slice(0, 10).map((row) => loadAvatarImage(row.user)));
  let y = 145;

  for (let i = 0; i < Math.min(10, rows.length); i += 1) {
    const row = rows[i];
    const accent = i === 0 ? THEME.gold : i === 1 ? THEME.silver : i === 2 ? '#c78d67' : THEME.blue;
    fillRoundRect(ctx, 55, y, 940, 102, 20, i < 3 ? 'rgba(15,31,49,.94)' : 'rgba(10,23,38,.90)', THEME.strokeSoft, 1.5);
    ctx.fillStyle = accent;
    ctx.font = '900 28px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`#${i + 1}`, 80, y + 62);
    drawAvatarImage(ctx, avatars[i], 145, y + 17, 68, accent);
    ctx.fillStyle = THEME.text;
    ctx.font = `800 ${fitText(ctx, playerName(row.user), 350, 22, 15, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
    ctx.fillText(playerName(row.user), 238, y + 43);
    ctx.fillStyle = THEME.muted;
    ctx.font = '500 14px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`${row.positions || 0} stocks • portfolio ${money(row.portfolio || 0)}`, 238, y + 71);
    ctx.textAlign = 'right';
    ctx.fillStyle = i === 0 ? THEME.gold : THEME.green;
    ctx.font = '900 25px "Noto Sans Arabic", "Neverless Latin"';
    ctx.fillText(`${money(row.net)}${i === 0 ? '  #1' : ''}`, 955, y + 60);
    ctx.textAlign = 'left';
    y += 112;
  }

  if (!rows.length) centerText(ctx, 'لا توجد حسابات بعد', 525, 640, '700 23px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  rtlText(ctx, `المركز الأول = الأغنى في السيرفر - سعر NVRS الحالي ${money(price)}`, 990, 1240, '600 14px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  return canvas.toBuffer('image/png');
}

function statusCard(user, state) {
  const { canvas, ctx } = baseCard('NEVERLESS BANK', 'حالة الأوامر • مدة الانتظار 5 دقائق', 1050, 695, THEME.cyan);
  const now = Date.now();
  const entries = [
    ['راتب', Math.max(0, state.salaryAt + SALARY_CD - now)],
    ['بخشيش', Math.max(0, state.tipAt + TIP_CD - now)],
    ['رهان', commandCooldownLeft(state, 'bet', now)],
    ['استثمار', commandCooldownLeft(state, 'invest', now)],
    ['نرد', commandCooldownLeft(state, 'dice', now)],
    ['قمار', commandCooldownLeft(state, 'gamble', now)],
    ['تداول', commandCooldownLeft(state, 'trade', now)],
    ['روليت', commandCooldownLeft(state, 'roulette', now)],
    ['هايلو', commandCooldownLeft(state, 'hilo', now)],
    ['صناديق', commandCooldownLeft(state, 'boxes', now)],
  ];

  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 330, 25, 16, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 58, 153);
  ctx.fillStyle = THEME.muted;
  ctx.font = '500 14px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText('COMMAND COOLDOWNS', 58, 178);

  entries.forEach(([label, ms], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 55 + col * 505;
    const y = 210 + row * 84;
    fillRoundRect(ctx, x, y, 475, 66, 16, 'rgba(11,24,39,.90)', THEME.strokeSoft, 1.3);
    rtlText(ctx, label, x + 445, y + 41, '800 18px "Noto Sans Arabic", "Neverless Latin"', THEME.text);
    const good = ms <= 0;
    drawStatusPill(ctx, x + 25, y + 15, good ? 'متاح' : formatDuration(ms), good);
  });
  return canvas.toBuffer('image/png');
}

function infoCard(title, message, ok = false) {
  const color = ok ? THEME.green : THEME.red;
  const { canvas, ctx } = baseCard('NEVERLESS BANK', title, 900, 330, color);
  centerText(ctx, message, 450, 205, '800 21px "Noto Sans Arabic", "Neverless Latin"', THEME.text);
  return canvas.toBuffer('image/png');
}

async function economyEventCard(user, title, amount, balance, kind = 'good') {
  const accent = kind === 'bad' ? THEME.red : kind === 'protect' ? THEME.cyan : THEME.green;
  const { canvas, ctx } = baseCard('NEVERLESS BANK', title, 1000, 455, accent);
  drawAvatarImage(ctx, await loadAvatarImage(user), 70, 155, 112, accent);
  ctx.fillStyle = THEME.text;
  ctx.font = `800 ${fitText(ctx, playerName(user), 260, 25, 16, 800)}px "Noto Sans Arabic", "Neverless Latin"`;
  ctx.fillText(playerName(user), 205, 195);
  fillRoundRect(ctx, 500, 145, 410, 190, 24, 'rgba(8,20,34,.94)', THEME.stroke, 1.5);
  centerText(ctx, title, 705, 190, '700 19px "Noto Sans Arabic", "Neverless Latin"', THEME.muted);
  ctx.textAlign = 'center'; ctx.fillStyle = accent; ctx.font = '900 52px "Noto Sans Arabic", "Neverless Latin"';
  ctx.fillText(amount ? money(amount) : 'ACTIVE', 705, 260); ctx.textAlign = 'left';
  centerText(ctx, `الرصيد الآن ${money(balance)}`, 705, 307, '700 17px "Noto Sans Arabic", "Neverless Latin"', THEME.text);
  return canvas.toBuffer('image/png');
}

module.exports = {
  helpCard,
  balanceCard,
  rewardCard,
  vaultCard,
  transferCard,
  marketCard,
  stockTradeCard,
  topCard,
  statusCard,
  infoCard,
  economyEventCard,
  usageCard,
  propertiesCard,
  assetTradeCard,
};
