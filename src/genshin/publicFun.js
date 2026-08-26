'use strict';

const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getLinkedUid, whenAccountStoreReady } = require('./accountStore');
const { fetchAccount, findCharacter } = require('./enkaClient');
const { rateCurrentCharacter } = require('./liveAccountRating');
const { resolveCharacter } = require('./characterResolver');
const { rewriteCharacterAliases } = require('./characterAliases');
const { getCharacterNames, getCharacter } = require('./dataClient');
const { buildRatingCard } = require('./buildCard');
const { formatStat } = require('./statProfile');

const QUIZ_TTL_MS = 2 * 60 * 1000;
const quizSessions = new Map();
let installed = false;

const ELEMENTS = ['Pyro', 'Hydro', 'Electro', 'Cryo', 'Anemo', 'Geo', 'Dendro'];
const WEAPONS = ['Sword', 'Claymore', 'Polearm', 'Bow', 'Catalyst'];
const REGIONS = ['Mondstadt', 'Liyue', 'Inazuma', 'Sumeru', 'Fontaine', 'Natlan', 'Nod-Krai', 'Snezhnaya'];

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function prefixBody(text) {
  let value = String(text || '').trim().replace(/\s+/g, ' ');
  value = value.replace(/^<@!?\d{15,22}>\s*/, '');
  if (!/^[-–—]/u.test(value)) return null;
  return value.replace(/^[-–—]\s*/u, '').trim();
}

function parsePublicFunCommand(text) {
  const body = prefixBody(text);
  if (!body) return null;
  if (/^(?:genshin\s+)?(?:quiz|كويز|اختبار\s+قينشن)$/iu.test(body)) {
    return { type: 'quiz' };
  }
  const flex = body.match(/^(?:فلكس|فليكس|flex|flix)\s+(?:بيلد|build)(?:\s+(.+))$/iu);
  if (!flex) return null;
  const query = String(flex[1] || '').trim();
  return query ? { type: 'flex', query } : null;
}

function isPublicFunCommand(text) {
  return Boolean(parsePublicFunCommand(text));
}

async function reply(message, payload) {
  const next = typeof payload === 'string' ? { content: payload } : { ...(payload || {}) };
  next.allowedMentions = { ...(next.allowedMentions || {}), repliedUser: false };
  await message.reply(next);
}

function topPercent(value) {
  const number = Number(value?.topPercent ?? value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatTop(value) {
  const number = topPercent(value);
  if (!Number.isFinite(number)) return '—';
  if (number < 0.01) return 'Top <0.01%';
  return `Top ${number >= 10 ? Math.round(number) : Number(number.toFixed(2))}%`;
}

async function handleFlex(message, query, lang) {
  await whenAccountStoreReady().catch(() => {});
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await reply(message, lang === 'ar'
      ? 'اربط حسابك أولًا داخل #neverless-ai: `ربط UID 7XXXXXXXXX`.'
      : 'Link your account first in #neverless-ai: `link UID 7XXXXXXXXX`.');
    return true;
  }

  const normalizedQuery = rewriteCharacterAliases(String(query || '').trim());
  const characterName = await resolveCharacter(normalizedQuery).catch(() => null);
  if (!characterName) {
    await reply(message, lang === 'ar' ? 'حدد اسم الشخصية، مثال: `-فلكس بيلد Skirk`.' : 'Include a character, e.g. `-flex build Skirk`.');
    return true;
  }

  let account;
  try {
    account = await fetchAccount(uid, { forceRefresh: true });
  } catch (error) {
    console.warn('[genshin-public-fun] Enka fetch failed:', error.message);
    await reply(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن Show Character Details مفعّل.'
      : 'I could not read your Showcase right now. Make sure Show Character Details is enabled.');
    return true;
  }

  const character = findCharacter(account, characterName);
  if (!character) {
    await reply(message, lang === 'ar'
      ? `**${characterName}** غير ظاهرة بالتفاصيل في الـShowcase حاليًا.`
      : `**${characterName}** is not visible with details in your Showcase.`);
    return true;
  }

  const rated = await rateCurrentCharacter(uid, account, characterName).catch(() => null);
  if (!rated) {
    await reply(message, lang === 'ar'
      ? `أقدر أشوف **${characterName}** لكن ما عندي Guide موثوق كفاية حتى أعرض Flex Build.`
      : `I can see **${characterName}**, but I do not have a reliable enough guide for a Flex Build.`);
    return true;
  }

  const stats = rated.snapshot.stats || {};
  const lines = [
    `**${rated.name} — Flex Build**`,
    `Neverless: **${rated.score}%** • Akasha: **${formatTop(rated.akasha)}**`,
    `CR **${formatStat('critRate', stats.critRate)}** • CD **${formatStat('critDmg', stats.critDmg)}** • ER **${formatStat('er', stats.er)}**`,
    `${lang === 'ar' ? 'السلاح' : 'Weapon'}: **${rated.snapshot.weapon?.name || '—'}${rated.snapshot.weapon?.refinement ? ` R${rated.snapshot.weapon.refinement}` : ''}**`,
  ];

  let files = [];
  try {
    const characterData = await getCharacter(rated.name).catch(() => null);
    const card = await buildRatingCard(
      rated.character,
      rated.snapshot,
      rated.evaluation,
      null,
      { characterData, akashaPercentile: rated.akasha },
    );
    files = [{ attachment: card, name: `${rated.name.replace(/[^a-z0-9]+/gi, '-')}-flex.png` }];
  } catch (error) {
    console.warn('[genshin-public-fun] Flex card failed:', error.message);
  }

  await reply(message, { content: lines.join('\n'), files });
  return true;
}

function shuffle(values) {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const j = Math.floor(Math.random() * (index + 1));
    [out[index], out[j]] = [out[j], out[index]];
  }
  return out;
}

function canonicalOption(value, pool) {
  const text = String(value || '').toLowerCase();
  return pool.find((item) => text === item.toLowerCase() || text.includes(item.toLowerCase())) || null;
}

function quizQuestionFromCharacter(name, data, lang) {
  const ar = lang === 'ar';
  const candidates = [];
  const element = canonicalOption(data?.elementText || data?.element || data?.vision, ELEMENTS);
  const weapon = canonicalOption(data?.weaponText || data?.weapon || data?.weaponType, WEAPONS);
  const region = canonicalOption(data?.region || data?.nation, REGIONS);

  if (element) candidates.push({
    prompt: ar ? `**Genshin Quiz**\nما عنصر **${name}**؟` : `**Genshin Quiz**\nWhat is **${name}**'s element?`,
    correct: element,
    pool: ELEMENTS,
  });
  if (weapon) candidates.push({
    prompt: ar ? `**Genshin Quiz**\nشنو نوع سلاح **${name}**؟` : `**Genshin Quiz**\nWhat weapon type does **${name}** use?`,
    correct: weapon,
    pool: WEAPONS,
  });
  if (region) candidates.push({
    prompt: ar ? `**Genshin Quiz**\n**${name}** مرتبطة بأي منطقة؟` : `**Genshin Quiz**\nWhich region is **${name}** associated with?`,
    correct: region,
    pool: REGIONS,
  });
  if (!candidates.length) return null;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const wrong = shuffle(chosen.pool.filter((item) => item !== chosen.correct)).slice(0, 3);
  const options = shuffle([chosen.correct, ...wrong]);
  return { ...chosen, options, correctIndex: options.indexOf(chosen.correct) };
}

async function makeQuiz(lang) {
  const names = await getCharacterNames();
  for (const name of shuffle(names).slice(0, 12)) {
    const data = await getCharacter(name).catch(() => null);
    const question = quizQuestionFromCharacter(name, data, lang);
    if (question) return question;
  }
  return null;
}

function quizRow(session, disabled = false) {
  return new ActionRowBuilder().addComponents(session.options.map((option, index) =>
    new ButtonBuilder()
      .setCustomId(`npquiz:${session.id}:${index}`)
      .setLabel(option.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)));
}

async function handleQuiz(message, lang) {
  const question = await makeQuiz(lang).catch(() => null);
  if (!question) {
    await reply(message, lang === 'ar' ? 'ما قدرت أجهز سؤال الآن، حاول مرة ثانية.' : 'I could not prepare a quiz question right now. Try again.');
    return true;
  }

  const id = crypto.randomBytes(5).toString('hex');
  const session = {
    ...question,
    id,
    userId: String(message.author.id),
    lang,
    expiresAt: Date.now() + QUIZ_TTL_MS,
  };
  quizSessions.set(id, session);
  const timer = setTimeout(() => quizSessions.delete(id), QUIZ_TTL_MS + 1000);
  timer.unref?.();
  await reply(message, {
    content: `${session.prompt}\n${lang === 'ar' ? 'اختر الإجابة:' : 'Choose an answer:'}`,
    components: [quizRow(session)],
  });
  return true;
}

async function handleQuizInteraction(interaction) {
  if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith('npquiz:')) return false;
  const [, id, rawIndex] = interaction.customId.split(':');
  const session = quizSessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    quizSessions.delete(id);
    await interaction.reply({ content: 'انتهى وقت هذا السؤال.', ephemeral: true }).catch(() => {});
    return true;
  }
  if (String(interaction.user.id) !== session.userId) {
    await interaction.reply({ content: 'هذا السؤال لصاحب الكويز. استخدم `-كويز` وسو سؤال خاص فيك.', ephemeral: true }).catch(() => {});
    return true;
  }

  const index = Number(rawIndex);
  const correct = index === session.correctIndex;
  quizSessions.delete(id);
  const result = correct
    ? (session.lang === 'ar' ? '✅ **إجابة صحيحة!**' : '✅ **Correct!**')
    : (session.lang === 'ar' ? `❌ **خطأ.** الإجابة الصحيحة: **${session.correct}**` : `❌ **Wrong.** Correct answer: **${session.correct}**`);

  await interaction.update({
    content: `${session.prompt}\n\n${result}`,
    components: [quizRow(session, true)],
    allowedMentions: { parse: [] },
  }).catch(() => {});
  return true;
}

async function handlePublicFunCommand(message, parsed = parsePublicFunCommand(message?.content)) {
  if (!parsed) return false;
  const lang = language(message.content);
  if (parsed.type === 'quiz') return handleQuiz(message, lang);
  if (parsed.type === 'flex') return handleFlex(message, parsed.query, lang);
  return false;
}

function installPublicFun(client) {
  if (installed) return;
  installed = true;

  client.on('messageCreate', (message) => {
    if (!message?.guildId || message.author?.bot) return;
    const parsed = parsePublicFunCommand(message.content);
    if (!parsed) return;
    handlePublicFunCommand(message, parsed).catch((error) => {
      console.error('[genshin-public-fun] command failed:', error);
      reply(message, 'صار خطأ أثناء تنفيذ الأمر. جرّب بعد شوي.').catch(() => {});
    });
  });

  client.on('interactionCreate', (interaction) => {
    Promise.resolve(handleQuizInteraction(interaction)).catch((error) => {
      console.error('[genshin-public-fun] quiz interaction failed:', error);
    });
  });
}

module.exports = {
  installPublicFun,
  handlePublicFunCommand,
  parsePublicFunCommand,
  isPublicFunCommand,
  quizQuestionFromCharacter,
};
