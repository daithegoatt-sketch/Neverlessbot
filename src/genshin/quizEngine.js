'use strict';

const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getCharacterCatalog, getTalentCatalog } = require('./dataClient');
const { getGuideByText } = require('./guides');

const QUESTION_TIMEOUT_MS = 15 * 1000;
const MAX_QUESTIONS = 50;
const sessions = new Map();
let installed = false;

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

function shuffle(values) {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const j = Math.floor(Math.random() * (index + 1));
    [out[index], out[j]] = [out[j], out[index]];
  }
  return out;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function itemFromAscension(character, prefix) {
  const costs = character?.costs || {};
  for (const stage of ['ascend2', 'ascend3', 'ascend4', 'ascend5', 'ascend6']) {
    const rows = Array.isArray(costs[stage]) ? costs[stage] : [];
    const found = rows.find((row) => String(row?.id || '').startsWith(prefix) && row?.name);
    if (found) return String(found.name).trim();
  }
  return null;
}

function talentBook(talent) {
  const costs = talent?.costs || {};
  for (const stage of ['lvl7', 'lvl8', 'lvl9', 'lvl10', 'lvl6']) {
    const rows = Array.isArray(costs[stage]) ? costs[stage] : [];
    const named = rows.find((row) => /^Philosophies of /i.test(String(row?.name || '')));
    if (named?.name) return String(named.name).trim();
  }
  return null;
}

function quizRecord(character, talent = null, guide = null) {
  const rarity = Number(character?.rarity);
  return {
    name: String(character?.name || '').trim(),
    element: character?.elementText || null,
    weapon: character?.weaponText || null,
    region: character?.region || null,
    rarity: Number.isFinite(rarity) ? `${rarity}★` : null,
    birthday: character?.birthday || null,
    constellation: character?.constellation || null,
    title: character?.title || null,
    skill: talent?.combat2?.name || null,
    burst: talent?.combat3?.name || null,
    localSpecialty: itemFromAscension(character, '101'),
    bossMaterial: itemFromAscension(character, '113'),
    enemyMaterial: itemFromAscension(character, '112'),
    talentBook: talentBook(talent),
    recommendedWeapon: Array.isArray(guide?.weapons) ? guide.weapons[0] || null : null,
    recommendedArtifact: Array.isArray(guide?.artifacts) ? guide.artifacts[0] || null : null,
  };
}

const FIELD_PROMPTS = {
  element: {
    ar: (name) => `ما عنصر **${name}**؟`,
    en: (name) => `What is **${name}**'s element?`,
  },
  weapon: {
    ar: (name) => `شنو نوع سلاح **${name}**؟`,
    en: (name) => `What weapon type does **${name}** use?`,
  },
  region: {
    ar: (name) => `**${name}** مرتبطة بأي منطقة؟`,
    en: (name) => `Which region is **${name}** associated with?`,
  },
  rarity: {
    ar: (name) => `كم ندرة **${name}**؟`,
    en: (name) => `What rarity is **${name}**?`,
  },
  birthday: {
    ar: (name) => `متى عيد ميلاد **${name}**؟`,
    en: (name) => `When is **${name}**'s birthday?`,
  },
  constellation: {
    ar: (name) => `شنو اسم Constellation الخاصة بـ **${name}**؟`,
    en: (name) => `What is **${name}**'s constellation called?`,
  },
  title: {
    ar: (name) => `شنو لقب **${name}**؟`,
    en: (name) => `What is **${name}**'s title?`,
  },
  skill: {
    ar: (name) => `شنو اسم Elemental Skill لـ **${name}**؟`,
    en: (name) => `What is **${name}**'s Elemental Skill called?`,
  },
  burst: {
    ar: (name) => `شنو اسم Elemental Burst لـ **${name}**؟`,
    en: (name) => `What is **${name}**'s Elemental Burst called?`,
  },
  localSpecialty: {
    ar: (name) => `أي Local Specialty تستخدمها **${name}** للصعود؟`,
    en: (name) => `Which local specialty does **${name}** use for ascension?`,
  },
  bossMaterial: {
    ar: (name) => `أي Boss Material تستخدمها **${name}** للصعود؟`,
    en: (name) => `Which boss material does **${name}** use for ascension?`,
  },
  enemyMaterial: {
    ar: (name) => `أي Enemy Drop تستخدمها **${name}** للصعود؟`,
    en: (name) => `Which enemy drop does **${name}** use for ascension?`,
  },
  talentBook: {
    ar: (name) => `أي Talent Book تستخدمها **${name}**؟`,
    en: (name) => `Which talent book does **${name}** use?`,
  },
  recommendedWeapon: {
    ar: (name) => `شنو أول سلاح موصى به في Neverless لـ **${name}**؟`,
    en: (name) => `What is the first Neverless-recommended weapon for **${name}**?`,
  },
  recommendedArtifact: {
    ar: (name) => `شنو أول Artifact Set موصى به في Neverless لـ **${name}**؟`,
    en: (name) => `What is the first Neverless-recommended Artifact Set for **${name}**?`,
  },
};

function optionsFor(correct, pool, wanted = 4) {
  const cleanPool = unique(pool);
  const wrong = shuffle(cleanPool.filter((value) => normalize(value) !== normalize(correct))).slice(0, Math.max(1, wanted - 1));
  const options = shuffle(unique([correct, ...wrong]));
  return options.length >= 2 ? options : null;
}

function buildQuestionsFromRecords(records, lang = 'ar') {
  const fields = Object.keys(FIELD_PROMPTS);
  const pools = Object.fromEntries(fields.map((field) => [field, unique(records.map((row) => row[field]).filter(Boolean))]));
  const questions = [];

  for (const row of records) {
    if (!row.name) continue;
    for (const field of fields) {
      const correct = row[field];
      if (!correct) continue;
      const wanted = field === 'rarity' ? 2 : 4;
      const options = optionsFor(correct, pools[field], wanted);
      if (!options) continue;
      questions.push({
        id: `${normalize(row.name)}:${field}`,
        type: field,
        character: row.name,
        prompt: FIELD_PROMPTS[field][lang === 'en' ? 'en' : 'ar'](row.name),
        correct: String(correct),
        options,
        correctIndex: options.findIndex((value) => normalize(value) === normalize(correct)),
      });
    }
  }

  return shuffle(questions);
}

async function buildQuizBank(count = 1, lang = 'ar') {
  const [characters, talents] = await Promise.all([
    getCharacterCatalog(),
    getTalentCatalog().catch(() => []),
  ]);
  const talentMap = new Map((talents || []).map((row) => [normalize(row?.name), row]));
  const records = (characters || [])
    .map((character) => quizRecord(
      character,
      talentMap.get(normalize(character?.name)) || null,
      getGuideByText(character?.name) || null,
    ))
    .filter((row) => row.name);
  const bank = buildQuestionsFromRecords(records, lang);
  return bank.slice(0, Math.max(1, Math.min(MAX_QUESTIONS, Number(count) || 1)));
}

function repeatRow(lang = 'ar') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nq2repeat:${lang === 'en' ? 'en' : 'ar'}`)
      .setLabel(lang === 'en' ? 'Repeat' : 'تكرار')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Secondary),
  );
}

function answerRow(session, disabled = false) {
  const current = session.current;
  return new ActionRowBuilder().addComponents(current.question.options.map((option, index) =>
    new ButtonBuilder()
      .setCustomId(`nq2:${session.id}:${current.token}:${index}`)
      .setLabel(String(option).slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)));
}

function questionEmbed(session) {
  const currentNumber = session.index + 1;
  const title = session.total > 1
    ? `Genshin Quiz • ${currentNumber}/${session.total}`
    : 'Genshin Quiz';
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(title)
    .setDescription(session.current.question.prompt)
    .setFooter({ text: session.lang === 'en' ? 'You have 15 seconds' : 'لديك 15 ثانية' });
}

function resultEmbed(session, userId, correct, elapsedMs) {
  const seconds = Math.max(0.1, Math.round(elapsedMs / 100) / 10);
  const question = session.current.question;
  if (correct) {
    return new EmbedBuilder()
      .setColor(0x2ecc71)
      .setDescription(session.lang === 'en'
        ? `🎉 **Correct!**\n<@${userId}> answered in **${seconds}s**.`
        : `🎉 **أحسنت!**\n<@${userId}> أجاب خلال **${seconds} ثانية**.`);
  }
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setDescription(session.lang === 'en'
      ? `**Wrong answer.**\n<@${userId}> answered in **${seconds}s**.\nCorrect answer: **${question.correct}**`
      : `**الإجابة خاطئة.**\n<@${userId}> أجاب خلال **${seconds} ثانية**.\nالإجابة الصحيحة: **${question.correct}**`);
}

function timeoutEmbed(session, stopped = false) {
  return new EmbedBuilder()
    .setColor(stopped ? 0xe74c3c : 0x95a5a6)
    .setDescription(session.lang === 'en'
      ? `No one answered. The answer was **${session.current.question.correct}**.${stopped ? '\n**Quiz stopped.**' : ''}`
      : `لم يجب أحد، الإجابة كانت **${session.current.question.correct}**.${stopped ? '\n**توقفت الأسئلة.**' : ''}`);
}

async function editQuestionDisabled(session) {
  const messageId = session.current?.messageId;
  if (!messageId) return;
  const message = await session.channel.messages.fetch(messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [questionEmbed(session)], components: [answerRow(session, true)] }).catch(() => {});
}

function clearQuestionTimer(session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
}

async function finishSession(session, options = {}) {
  clearQuestionTimer(session);
  sessions.delete(session.id);
  if (options.sendSummary && session.total > 1) {
    const text = session.lang === 'en'
      ? `Questions finished • Correct: **${session.correctCount}** • Wrong: **${session.wrongCount}**`
      : `انتهت الأسئلة • الصحيحة: **${session.correctCount}** • الخاطئة: **${session.wrongCount}**`;
    await session.channel.send({ content: text, components: [repeatRow(session.lang)] }).catch(() => {});
  }
}

async function sendQuestion(session) {
  if (!sessions.has(session.id)) return;
  if (session.index >= session.total || session.index >= session.bank.length) {
    await finishSession(session, { sendSummary: true });
    return;
  }

  const question = session.bank[session.index];
  session.current = {
    question,
    token: crypto.randomBytes(3).toString('hex'),
    startedAt: Date.now(),
    locked: false,
    messageId: null,
  };

  const sent = await session.channel.send({
    embeds: [questionEmbed(session)],
    components: [answerRow(session)],
  });
  session.current.messageId = sent.id;
  const token = session.current.token;
  session.timer = setTimeout(() => {
    handleQuestionTimeout(session.id, token).catch((error) => console.error('[quiz-v2] timeout failed:', error));
  }, QUESTION_TIMEOUT_MS);
  session.timer.unref?.();
}

async function handleQuestionTimeout(sessionId, token) {
  const session = sessions.get(sessionId);
  if (!session || !session.current || session.current.token !== token || session.current.locked) return;
  session.current.locked = true;
  clearQuestionTimer(session);
  await editQuestionDisabled(session);

  session.noAnswerStreak += 1;
  const stopped = session.total > 1 && session.noAnswerStreak >= 2;
  const lastQuestion = session.index + 1 >= session.total;
  await session.channel.send({
    embeds: [timeoutEmbed(session, stopped)],
    components: stopped || lastQuestion || session.total === 1 ? [repeatRow(session.lang)] : [],
  }).catch(() => {});

  if (stopped || lastQuestion || session.total === 1) {
    await finishSession(session, { sendSummary: false });
    return;
  }

  session.index += 1;
  setTimeout(() => sendQuestion(session).catch((error) => console.error('[quiz-v2] next question failed:', error)), 900).unref?.();
}

async function startSession(channel, count, lang = 'ar') {
  const requested = Math.max(1, Math.min(MAX_QUESTIONS, Number(count) || 1));
  const bank = await buildQuizBank(requested, lang);
  if (!bank.length) return null;
  const session = {
    id: crypto.randomBytes(5).toString('hex'),
    channel,
    lang: lang === 'en' ? 'en' : 'ar',
    bank,
    total: Math.min(requested, bank.length),
    index: 0,
    current: null,
    timer: null,
    noAnswerStreak: 0,
    correctCount: 0,
    wrongCount: 0,
  };
  sessions.set(session.id, session);
  await sendQuestion(session);
  return session;
}

async function handleQuizCommand(message, lang = 'ar') {
  const session = await startSession(message.channel, 1, lang);
  if (!session) {
    await message.reply({
      content: lang === 'en' ? 'I could not prepare a quiz question right now.' : 'ما قدرت أجهز سؤال الآن، حاول مرة ثانية.',
      allowedMentions: { repliedUser: false },
    });
  }
  return true;
}

function quizCountModal(lang = 'ar') {
  const ar = lang !== 'en';
  return new ModalBuilder()
    .setCustomId(`nq2modal:${ar ? 'ar' : 'en'}`)
    .setTitle(ar ? 'تكرار Genshin Quiz' : 'Repeat Genshin Quiz')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('count')
          .setLabel(ar ? 'عدد الأسئلة' : 'Number of questions')
          .setPlaceholder(ar ? 'مثال: 20' : 'Example: 20')
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true),
      ),
    );
}

function parseQuizCount(value) {
  const count = Number(String(value || '').trim());
  return Number.isInteger(count) && count >= 1 && count <= MAX_QUESTIONS ? count : null;
}

async function handleAnswer(interaction) {
  const match = String(interaction.customId || '').match(/^nq2:([a-f0-9]+):([a-f0-9]+):(\d+)$/i);
  if (!match) return false;
  const [, sessionId, token, rawIndex] = match;
  const session = sessions.get(sessionId);
  if (!session || !session.current || session.current.token !== token) {
    await interaction.reply({ content: 'انتهى هذا السؤال.', ephemeral: true }).catch(() => {});
    return true;
  }
  if (session.current.locked) {
    await interaction.reply({ content: 'تمت الإجابة على هذا السؤال.', ephemeral: true }).catch(() => {});
    return true;
  }

  session.current.locked = true;
  clearQuestionTimer(session);
  const elapsed = Date.now() - session.current.startedAt;
  const selected = Number(rawIndex);
  const correct = selected === session.current.question.correctIndex;
  if (correct) session.correctCount += 1;
  else session.wrongCount += 1;
  session.noAnswerStreak = 0;

  await interaction.update({
    embeds: [questionEmbed(session)],
    components: [answerRow(session, true)],
    allowedMentions: { parse: [] },
  }).catch(() => {});

  const lastQuestion = session.index + 1 >= session.total;
  await interaction.channel.send({
    embeds: [resultEmbed(session, interaction.user.id, correct, elapsed)],
    components: lastQuestion || session.total === 1 ? [repeatRow(session.lang)] : [],
    allowedMentions: { users: [interaction.user.id] },
  }).catch(() => {});

  if (lastQuestion || session.total === 1) {
    await finishSession(session, { sendSummary: false });
    return true;
  }

  session.index += 1;
  setTimeout(() => sendQuestion(session).catch((error) => console.error('[quiz-v2] next question failed:', error)), 900).unref?.();
  return true;
}

async function handleRepeat(interaction) {
  if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith('nq2repeat:')) return false;
  const lang = String(interaction.customId).endsWith(':en') ? 'en' : 'ar';
  await interaction.showModal(quizCountModal(lang));
  return true;
}

async function handleModal(interaction) {
  if (!interaction.isModalSubmit?.() || !String(interaction.customId || '').startsWith('nq2modal:')) return false;
  const lang = String(interaction.customId).endsWith(':en') ? 'en' : 'ar';
  const count = parseQuizCount(interaction.fields.getTextInputValue('count'));
  if (!count) {
    await interaction.reply({
      content: lang === 'en' ? `Enter a number from 1 to ${MAX_QUESTIONS}.` : `اكتب رقم من 1 إلى ${MAX_QUESTIONS}.`,
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const session = await startSession(interaction.channel, count, lang).catch(() => null);
  if (!session) {
    await interaction.editReply(lang === 'en' ? 'I could not start the quiz.' : 'ما قدرت أبدأ الأسئلة الآن.');
    return true;
  }
  await interaction.editReply(lang === 'en'
    ? `Started **${session.total}** questions.`
    : `بدأت **${session.total}** سؤال.`);
  return true;
}

async function handleQuizInteraction(interaction) {
  if (interaction.isButton?.()) {
    if (String(interaction.customId || '').startsWith('nq2repeat:')) return handleRepeat(interaction);
    if (String(interaction.customId || '').startsWith('nq2:')) return handleAnswer(interaction);
  }
  if (interaction.isModalSubmit?.() && String(interaction.customId || '').startsWith('nq2modal:')) {
    return handleModal(interaction);
  }
  return false;
}

function installQuizEngine(client) {
  if (installed) return;
  installed = true;
  client.on('interactionCreate', (interaction) => {
    Promise.resolve(handleQuizInteraction(interaction)).catch((error) => {
      console.error('[quiz-v2] interaction failed:', error);
    });
  });
}

module.exports = {
  installQuizEngine,
  handleQuizCommand,
  handleQuizInteraction,
  buildQuizBank,
  buildQuestionsFromRecords,
  quizRecord,
  parseQuizCount,
  QUESTION_TIMEOUT_MS,
  MAX_QUESTIONS,
};
