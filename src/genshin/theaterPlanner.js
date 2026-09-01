'use strict';

const { EmbedBuilder } = require('discord.js');
const { getCurrentTheaterSeason, resolveDifficulty, DIFFICULTIES } = require('./theaterClient');
const { resolveCharacterMentions } = require('./characterResolver');
const { getCharacter } = require('./dataClient');

const SESSION_TTL = 30 * 60 * 1000;
const THEATER_COLOR = 0x7f6ab3;
const sessions = new Map();
let installed = false;

const PROFILES = Object.freeze({
  Columbina: { element: 'Hydro', strength: 9.6, tags: ['offfield', 'hydroApp', 'lunar', 'aoe', 'buff'] },
  Xingqiu: { element: 'Hydro', strength: 9.1, tags: ['offfield', 'hydroApp', 'defense'] },
  Neuvillette: { element: 'Hydro', strength: 10, tags: ['onfield', 'hydroApp', 'aoe'] },
  Furina: { element: 'Hydro', strength: 9.8, tags: ['offfield', 'hydroApp', 'buff', 'aoe'] },
  Yelan: { element: 'Hydro', strength: 9.4, tags: ['offfield', 'hydroApp', 'buff'] },
  'Sangonomiya Kokomi': { element: 'Hydro', strength: 9.1, tags: ['sustain', 'hydroApp', 'offfield', 'aoe'] },
  Kokomi: { element: 'Hydro', strength: 9.1, tags: ['sustain', 'hydroApp', 'offfield', 'aoe'] },
  Sigewinne: { element: 'Hydro', strength: 8, tags: ['sustain', 'hydroApp', 'buff'] },
  Barbara: { element: 'Hydro', strength: 6.5, tags: ['sustain', 'hydroApp'] },
  Mona: { element: 'Hydro', strength: 7.8, tags: ['offfield', 'hydroApp', 'buff'] },
  Tartaglia: { element: 'Hydro', strength: 8.4, tags: ['onfield', 'hydroApp', 'aoe'] },
  'Kamisato Ayato': { element: 'Hydro', strength: 8.1, tags: ['onfield', 'hydroApp', 'aoe'] },
  Mualani: { element: 'Hydro', strength: 8.8, tags: ['onfield', 'hydroApp'] },
  Nilou: { element: 'Hydro', strength: 8.4, tags: ['bloom', 'hydroApp', 'buff'] },
  Aino: { element: 'Hydro', strength: 8.4, tags: ['offfield', 'hydroApp', 'lunar'] },
  Cyno: { element: 'Electro', strength: 8.1, tags: ['onfield', 'electroApp', 'quicken'] },
  'Kuki Shinobu': { element: 'Electro', strength: 9, tags: ['sustain', 'electroApp', 'hyperbloom', 'offfield'] },
  'Raiden Shogun': { element: 'Electro', strength: 9.5, tags: ['onfield', 'offfield', 'electroApp', 'energy'] },
  'Yae Miko': { element: 'Electro', strength: 9.1, tags: ['offfield', 'electroApp', 'aoe', 'quicken'] },
  Fischl: { element: 'Electro', strength: 9.1, tags: ['offfield', 'electroApp', 'quicken'] },
  Clorinde: { element: 'Electro', strength: 9, tags: ['onfield', 'electroApp', 'quicken'] },
  Flins: { element: 'Electro', strength: 9.6, tags: ['onfield', 'electroApp', 'lunar', 'aoe'] },
  Ineffa: { element: 'Electro', strength: 9.5, tags: ['offfield', 'electroApp', 'lunar', 'sustain'] },
  Varesa: { element: 'Electro', strength: 8.8, tags: ['onfield', 'electroApp', 'aoe'] },
  Iansan: { element: 'Electro', strength: 8.5, tags: ['buff', 'electroApp', 'sustain'] },
  Ororon: { element: 'Electro', strength: 8.4, tags: ['offfield', 'electroApp', 'aoe'] },
  Beidou: { element: 'Electro', strength: 8, tags: ['offfield', 'electroApp', 'aoe', 'defense'] },
  Keqing: { element: 'Electro', strength: 7.8, tags: ['onfield', 'electroApp', 'quicken'] },
  Dori: { element: 'Electro', strength: 5.8, tags: ['sustain', 'electroApp', 'energy'] },
  Lauma: { element: 'Dendro', strength: 9.4, tags: ['offfield', 'dendroApp', 'buff', 'bloom', 'aoe'] },
  Kaveh: { element: 'Dendro', strength: 6, tags: ['onfield', 'dendroApp', 'bloom'] },
  Nahida: { element: 'Dendro', strength: 10, tags: ['offfield', 'dendroApp', 'buff', 'aoe', 'quicken'] },
  Alhaitham: { element: 'Dendro', strength: 9.4, tags: ['onfield', 'dendroApp', 'quicken'] },
  Nefer: { element: 'Dendro', strength: 9.4, tags: ['onfield', 'dendroApp', 'lunar', 'bloom'] },
  Kinich: { element: 'Dendro', strength: 8.5, tags: ['onfield', 'dendroApp'] },
  Tighnari: { element: 'Dendro', strength: 8.5, tags: ['onfield', 'dendroApp', 'quicken'] },
  Emilie: { element: 'Dendro', strength: 7.5, tags: ['offfield', 'dendroApp'] },
  Baizhu: { element: 'Dendro', strength: 9, tags: ['sustain', 'dendroApp', 'buff'] },
  Yaoyao: { element: 'Dendro', strength: 8.2, tags: ['sustain', 'dendroApp', 'offfield'] },
  Kirara: { element: 'Dendro', strength: 7.1, tags: ['defense', 'dendroApp'] },
  Collei: { element: 'Dendro', strength: 7.2, tags: ['offfield', 'dendroApp'] },
  'Dendro Traveler': { element: 'Dendro', strength: 7.3, tags: ['offfield', 'dendroApp'] },
  Odette: { element: 'Cryo', strength: 9.4, tags: ['offfield', 'buff', 'stellar', 'aoe'] },
  Sandrone: { element: 'Cryo', strength: 9.5, tags: ['onfield', 'stellar', 'aoe'] },
  Sucrose: { element: 'Anemo', strength: 8.5, tags: ['control', 'buff', 'aoe'] },
  Nicole: { element: 'Pyro', strength: 9, tags: ['buff', 'defense', 'offfield'] },
});

const RESERVE = Object.freeze({
  hydroBoss: new Set(['Neuvillette', 'Furina', 'Yelan', 'Xingqiu', 'Columbina', 'Sangonomiya Kokomi', 'Kokomi', 'Aino']),
  chargeBoss: new Set(['Flins', 'Ineffa', 'Columbina', 'Aino', 'Yae Miko', 'Fischl', 'Kuki Shinobu']),
  finalHealers: new Set(['Sangonomiya Kokomi', 'Kokomi', 'Baizhu', 'Yaoyao', 'Sigewinne', 'Kuki Shinobu', 'Ineffa', 'Barbara']),
});

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sessionKey(message) {
  return `${message.guildId}:${message.channelId}:${message.author.id}`;
}

function parseTheaterCommand(text) {
  const value = clean(text);
  const match = value.match(/^[-–—]\s*تيم\s+المسرح(?:\s+(.+))?$/iu);
  if (!match) return null;
  const arg = clean(match[1] || 'الحالي');
  const difficulty = resolveDifficulty(arg);
  if (difficulty === undefined) return { type: 'invalid', arg };
  if (!difficulty) return { type: 'overview' };
  return { type: 'plan', difficulty };
}

function isTheaterCommand(text) {
  return Boolean(parseTheaterCommand(text));
}

function isAllowedName(name, season, element) {
  if (season.guests.some((item) => item.toLowerCase() === String(name).toLowerCase())) return true;
  return season.elements.some((item) => item.toLowerCase() === String(element || '').toLowerCase());
}

function profile(name) {
  return PROFILES[name] || { element: null, strength: 5.5, tags: ['flex'] };
}

function characterElementFromData(row) {
  const candidates = [
    row?.elementText, row?.element, row?.vision, row?.visionText, row?.elementType,
    row?.element?.name, row?.vision?.name,
  ];
  const known = ['Hydro', 'Electro', 'Dendro', 'Pyro', 'Cryo', 'Anemo', 'Geo'];
  for (const value of candidates) {
    const text = String(value || '');
    const found = known.find((item) => text.toLowerCase().includes(item.toLowerCase()));
    if (found) return found;
  }
  return null;
}

async function elementFor(name) {
  const local = profile(name).element;
  if (local) return local;
  try {
    const row = await getCharacter(name);
    return characterElementFromData(row);
  } catch {
    return null;
  }
}

function remainingUses(session, name) {
  return Math.max(0, 2 - (session.used.get(name) || 0));
}

function hasTag(row, tag) {
  return row.tags.includes(tag);
}

function scoreRow(row, act, session, season) {
  let score = row.strength + row.remaining * 0.2;
  if (season.opening.includes(row.name) && act <= 3) score += 1.25;
  if (row.remaining === 1) {
    if (act < 6 && RESERVE.hydroBoss.has(row.name)) score -= 3.5;
    if (act < 8 && RESERVE.chargeBoss.has(row.name)) score -= 3.5;
    if (act < 10 && RESERVE.finalHealers.has(row.name)) score -= 3;
  }
  return score;
}

async function candidateRows(names, session, season, act) {
  const out = [];
  for (const name of [...new Set(names)]) {
    if (session.unavailable.has(name) || session.notDrawn.has(name)) continue;
    const remaining = remainingUses(session, name);
    if (remaining <= 0) continue;
    const element = await elementFor(name);
    if (!isAllowedName(name, season, element)) continue;
    const base = profile(name);
    const row = { name, element, strength: base.strength, tags: base.tags, remaining };
    row.score = scoreRow(row, act, session, season);
    out.push(row);
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function choose(rows, chosen, predicate) {
  const row = rows.find((item) => !chosen.has(item.name) && predicate(item));
  if (!row) return null;
  chosen.add(row.name);
  return row;
}

function requirementsForAct(actInfo) {
  const reaction = String(actInfo?.reaction || '').toLowerCase();
  if (reaction.includes('hydro application')) return ['hydro', 'hydro'];
  if (reaction.includes('electro-charged') || reaction.includes('lunar-charged')) return ['hydro', 'electro'];
  if (reaction.includes('electro / quicken')) return ['electro', 'dendro'];
  if (reaction.includes('quicken')) return ['electro', 'dendro'];
  if (reaction.includes('hyperbloom')) return ['hydro', 'dendro', 'electro'];
  if (reaction.includes('dendro / electro')) return ['dendro', 'electro'];
  if (reaction.includes('healing')) return ['sustain'];
  if (reaction.includes('sustain')) return ['sustain'];
  return [];
}

async function buildTeam(names, act, session, season) {
  const actInfo = season.act(act);
  const rows = await candidateRows(names, session, season, act);
  const chosen = new Set();
  const team = [];
  const needs = requirementsForAct(actInfo);
  for (const need of needs) {
    let row = null;
    if (need === 'sustain') row = choose(rows, chosen, (item) => hasTag(item, 'sustain'));
    else row = choose(rows, chosen, (item) => String(item.element).toLowerCase() === need);
    if (row) team.push(row);
  }
  if ((act === 10 || act === 11) && !team.some((item) => hasTag(item, 'sustain'))) {
    const healer = choose(rows, chosen, (item) => hasTag(item, 'sustain'));
    if (healer) team.push(healer);
  }
  if (!team.some((item) => hasTag(item, 'onfield'))) {
    const carry = choose(rows, chosen, (item) => hasTag(item, 'onfield'));
    if (carry) team.push(carry);
  }
  while (team.length < 4) {
    const row = choose(rows, chosen, () => true);
    if (!row) break;
    team.push(row);
  }
  return { team, rows, actInfo };
}

function curatedNames(season) {
  const names = new Set([...season.opening, ...season.guests]);
  for (const [name, row] of Object.entries(PROFILES)) {
    if (isAllowedName(name, season, row.element)) names.add(name);
  }
  return [...names];
}

function teamText(team) {
  if (!team.length) return 'ما عندي 4 شخصيات صالحة مؤكدة من القائمة الحالية.';
  return team.map((row) => `**${row.name}**${row.remaining === 1 ? '¹' : ''}`).join(' • ');
}

function reserveText(act) {
  if (act < 6) return 'احفظ Hydro سريع للبوس 6.';
  if (act < 8) return 'احفظ Hydro + Electro قوي للبوس 8.';
  if (act < 10) return 'احفظ Healer قوي + أقوى Carry للبوس 10.';
  return 'استعمل أفضل المتبقي؛ قربت نهاية المسار.';
}

function overviewEmbed(season) {
  const route = season.routeVerified
    ? 'مسار البوسات لهذا الشهر موثق داخل Neverless.'
    : 'الشخصيات/العناصر محدثة، لكن مسار البوسات غير موثق بعد؛ Neverless لن يخترع Counter.';
  return new EmbedBuilder()
    .setColor(THEATER_COLOR)
    .setTitle(`🎭 Imaginarium Theater — ${season.label}`)
    .setDescription([
      `**العناصر المسموحة:** ${season.elements.length ? season.elements.join(' • ') : 'غير متوفرة من المصدر الآن'}`,
      '',
      `**Opening Cast — Trial/مجاني:**\n${season.opening.join(' • ') || 'غير متوفر'}`,
      '',
      `**Special Guests:**\n${season.guests.join(' • ') || 'غير متوفر'}`,
      '',
      '**قاعدة مهمة:** كل شخصية تبدأ بـ **2 Vigor** = استعمالين فقط طوال الجولة.',
      route,
    ].join('\n'))
    .addFields({
      name: 'اختر الصعوبة',
      value: [
        '`-تيم المسرح Easy` — 3 Acts / 8 شخصيات',
        '`-تيم المسرح Normal` — 6 Acts / 12 شخصية',
        '`-تيم المسرح Hard` — 8 Acts / 16 شخصية',
        '`-تيم المسرح Visionary` — 10 Acts / 22 شخصية',
        '`-تيم المسرح Lunar` — 12 Challenge / 28 شخصية',
      ].join('\n'),
    })
    .setFooter({ text: 'Neverless Theater Planner • الخطة تراعي Vigor ولا تفترض أن RNG أعطاك كل شخصية.' });
}

async function planEmbeds(season, difficulty, session) {
  const simulated = {
    ...session,
    used: new Map(session.used),
    unavailable: new Set(session.unavailable),
    notDrawn: new Set(),
  };
  const names = curatedNames(season);
  const intro = new EmbedBuilder()
    .setColor(THEATER_COLOR)
    .setTitle(`🎭 تيم المسرح — ${difficulty.en}`)
    .setDescription([
      `**${difficulty.acts} مراحل** • تحتاج ${difficulty.minCharacters}-${difficulty.maxCharacters} شخصية • Lv.${difficulty.level}+`,
      `Opening المجاني: ${season.opening.join(' • ')}`,
      '',
      'الخطة تحت هي **أفضل Route نظري** من الشخصيات المسموحة؛ لا يعني أن اللعبة راح تعطيك كل كرت بنفس اللحظة.',
      'الرمز `¹` يعني أن الخطة استهلكت استعمالًا سابقًا للشخصية وباقي لها استعمال واحد وقت هذه المرحلة.',
    ].join('\n'));
  const stageEmbeds = [intro];
  let current = new EmbedBuilder().setColor(THEATER_COLOR).setTitle('مسار المراحل');
  let fields = 0;
  for (let act = 1; act <= difficulty.acts; act += 1) {
    const { team, actInfo } = await buildTeam(names, act, simulated, season);
    const label = actInfo.boss
      ? `${actInfo.type === 'arcana' ? 'Arcana' : `Act ${act}`} — ${actInfo.boss}`
      : `Act ${act} — ${actInfo.title || 'مرحلة عادية'}`;
    current.addFields({
      name: label,
      value: [
        `**التيم المقترح:** ${teamText(team)}`,
        `**الفكرة:** ${actInfo.reaction}`,
        actInfo.note,
        `**الحفظ:** ${reserveText(act)}`,
      ].join('\n').slice(0, 1024),
    });
    for (const row of team) simulated.used.set(row.name, (simulated.used.get(row.name) || 0) + 1);
    fields += 1;
    if (fields >= 4 && act < difficulty.acts) {
      stageEmbeds.push(current);
      current = new EmbedBuilder().setColor(THEATER_COLOR).setTitle('تكملة المسار');
      fields = 0;
    }
  }
  stageEmbeds.push(current);
  stageEmbeds.push(new EmbedBuilder()
    .setColor(THEATER_COLOR)
    .setTitle('إذا RNG غيّر الخطة')
    .setDescription([
      'رد في نفس الروم خلال 30 دقيقة بأحد هذه الأسطر:',
      '`المتاح عندي: Furina, Kuki, Nahida, Cyno, ...` — اكتب من 4 إلى 8 شخصيات ظاهرة عندك الآن.',
      '`ماطلع لي Furina` — يستبعدها من الجولة الحالية فقط ويعطيك بديل.',
      '`ماعندي Furina` — يستبعدها من حسابك لهذه الجلسة.',
      '`بدأت المرحلة 3` — ينقلك للمرحلة ويعطيك التيم الحالي.',
      '`استعملت: Cyno, Kuki, Xingqiu, Lauma` — يسجل Vigor المستهلك.',
      '`طلع لي Yelan, Fischl` — يضيف الكروت الجديدة للموجود الآن.',
    ].join('\n')));
  return stageEmbeds;
}

function followupKind(text) {
  const value = clean(text);
  if (/^(?:المتاح\s+عندي|المتاح|طلع\s+لي)\s*[:：]/u.test(value)) return 'pool';
  if (/^(?:ماعندي|ما\s+عندي)(?:\s|$)/u.test(value)) return 'missing';
  if (/^(?:ماطلع\s+لي|ما\s+طلع\s+لي)(?:\s|$)/u.test(value)) return 'notdrawn';
  if (/^(?:بدأت|بديت)\s+(?:المرحلة|مرحلة)\s*\d+/u.test(value)) return 'stage';
  if (/^(?:استعملت|استخدمت)\s*[:：]/u.test(value)) return 'used';
  if (/^(?:حالة\s+المسرح|المسرح\s+حالة)$/u.test(value)) return 'status';
  return null;
}

async function resolveNames(text) {
  return resolveCharacterMentions(text, 8).catch(() => []);
}

async function replyCurrentTeam(message, session, season, heading = null) {
  const source = session.pool.size >= 4 ? [...session.pool] : curatedNames(season);
  const { team, actInfo } = await buildTeam(source, session.currentAct, session, season);
  const missingSlots = Math.max(0, 4 - team.length);
  const lines = [
    heading,
    `**المرحلة ${session.currentAct}${actInfo.boss ? ` — ${actInfo.boss}` : ''}**`,
    `**أفضل 4 من الموجود:** ${teamText(team)}`,
    `**التفاعل/المطلوب:** ${actInfo.reaction}`,
    actInfo.note,
    missingSlots ? `⚠️ ناقصني ${missingSlots} اختيار صالح. اكتب \`المتاح عندي: ...\` وفيها 4-8 شخصيات ظاهرة.` : null,
  ].filter(Boolean);
  await message.reply({
    embeds: [new EmbedBuilder().setColor(THEATER_COLOR).setTitle('🎭 تعديل الخطة').setDescription(lines.join('\n'))],
    allowedMentions: { repliedUser: false },
  });
}

async function handleFollowup(message, session, kind) {
  const season = await getCurrentTheaterSeason();
  session.expiresAt = Date.now() + SESSION_TTL;
  const text = clean(message.content);
  if (kind === 'pool') {
    const names = await resolveNames(text);
    if (names.length < 4) {
      await message.reply({ content: 'اكتب لي **4 إلى 8 شخصيات** ظاهرة عندك الآن، مثال: `المتاح عندي: Cyno, Kuki, Xingqiu, Lauma`.', allowedMentions: { repliedUser: false } });
      return true;
    }
    session.pool = new Set(names.slice(0, 8));
    for (const name of names) session.notDrawn.delete(name);
    await replyCurrentTeam(message, session, season, `تم تحديث الموجود عندك: ${[...session.pool].join(' • ')}`);
    return true;
  }
  if (kind === 'missing' || kind === 'notdrawn') {
    const names = await resolveNames(text);
    if (!names.length) return false;
    for (const name of names) {
      if (kind === 'missing') session.unavailable.add(name);
      else session.notDrawn.add(name);
      session.pool.delete(name);
    }
    const head = kind === 'missing'
      ? `استبعدت من الحساب: ${names.join(' • ')}`
      : `استبعدت من الكروت الحالية فقط: ${names.join(' • ')}`;
    await replyCurrentTeam(message, session, season, head);
    return true;
  }
  if (kind === 'stage') {
    const stage = Number(text.match(/\d+/)?.[0]);
    if (!Number.isInteger(stage) || stage < 1 || stage > session.difficulty.acts) return false;
    session.currentAct = stage;
    session.notDrawn.clear();
    await replyCurrentTeam(message, session, season);
    return true;
  }
  if (kind === 'used') {
    const names = await resolveNames(text);
    if (!names.length) return false;
    const exhausted = [];
    for (const name of names) {
      const next = Math.min(2, (session.used.get(name) || 0) + 1);
      session.used.set(name, next);
      if (next >= 2) exhausted.push(name);
    }
    const nextAct = Math.min(session.difficulty.acts, session.currentAct + 1);
    session.currentAct = nextAct;
    session.notDrawn.clear();
    await replyCurrentTeam(message, session, season, `تم تسجيل الاستعمال: ${names.join(' • ')}${exhausted.length ? `\nانتهى Vigor: ${exhausted.join(' • ')}` : ''}`);
    return true;
  }
  if (kind === 'status') {
    const used = [...session.used.entries()].filter(([, count]) => count > 0);
    const lines = [
      `**الصعوبة:** ${session.difficulty.en}`,
      `**المرحلة الحالية:** ${session.currentAct}/${session.difficulty.acts}`,
      `**الموجود الآن:** ${session.pool.size ? [...session.pool].join(' • ') : 'لم ترسل القائمة بعد'}`,
      `**غير موجود بالحساب:** ${session.unavailable.size ? [...session.unavailable].join(' • ') : '—'}`,
      `**Vigor المستخدم:** ${used.length ? used.map(([name, count]) => `${name} ${count}/2`).join(' • ') : '—'}`,
    ];
    await message.reply({ embeds: [new EmbedBuilder().setColor(THEATER_COLOR).setTitle('🎭 حالة جلسة المسرح').setDescription(lines.join('\n'))], allowedMentions: { repliedUser: false } });
    return true;
  }
  return false;
}

async function handleTheaterMessage(message) {
  if (!message?.guildId || message.author?.bot) return false;
  const command = parseTheaterCommand(message.content);
  if (command) {
    const season = await getCurrentTheaterSeason();
    if (command.type === 'invalid') {
      await message.reply({ content: 'الصعوبات: `Easy` / `Normal` / `Hard` / `Visionary` / `Lunar`، أو `-تيم المسرح الحالي`.', allowedMentions: { repliedUser: false } });
      return true;
    }
    if (command.type === 'overview') {
      await message.reply({ embeds: [overviewEmbed(season)], allowedMentions: { repliedUser: false } });
      return true;
    }
    const session = {
      difficulty: command.difficulty,
      currentAct: 1,
      used: new Map(),
      unavailable: new Set(),
      notDrawn: new Set(),
      pool: new Set(),
      expiresAt: Date.now() + SESSION_TTL,
    };
    sessions.set(sessionKey(message), session);
    const embeds = await planEmbeds(season, command.difficulty, session);
    await message.reply({ embeds: embeds.slice(0, 10), allowedMentions: { repliedUser: false } });
    return true;
  }
  const key = sessionKey(message);
  const session = sessions.get(key);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(key);
    return false;
  }
  const kind = followupKind(message.content);
  if (!kind) return false;
  return handleFollowup(message, session, kind);
}

function installTheaterPlanner(client) {
  if (installed) return;
  installed = true;
  client.on('messageCreate', (message) => {
    handleTheaterMessage(message).catch((error) => {
      console.error('[theater] planner failed:', error);
      if (parseTheaterCommand(message.content) || sessions.has(sessionKey(message))) {
        message.reply({ content: 'صار خطأ أثناء تجهيز خطة المسرح. جرّب بعد شوي.', allowedMentions: { repliedUser: false } }).catch(() => {});
      }
    });
  });
  setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  }, 5 * 60 * 1000).unref?.();
}

module.exports = {
  installTheaterPlanner,
  handleTheaterMessage,
  parseTheaterCommand,
  isTheaterCommand,
  followupKind,
  requirementsForAct,
  buildTeam,
  remainingUses,
  curatedNames,
  DIFFICULTIES,
  PROFILES,
};
