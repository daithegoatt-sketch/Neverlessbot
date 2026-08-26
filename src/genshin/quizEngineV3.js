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
const channelSessions = new Map();
let installed = false;

const DIFFICULTY = {
  element: 'easy',
  weapon: 'easy',
  region: 'easy',
  rarity: 'easy',
  birthday: 'medium',
  constellation: 'medium',
  title: 'medium',
  recommendedWeapon: 'medium',
  recommendedArtifact: 'medium',
  skill: 'hard',
  burst: 'hard',
  localSpecialty: 'hard',
  bossMaterial: 'hard',
  enemyMaterial: 'hard',
  talentBook: 'hard',
};

const AR_VALUES = {
  Pyro: 'بايرو', Hydro: 'هايدرو', Electro: 'إلكترو', Cryo: 'كرايو', Anemo: 'أنيمو', Geo: 'جيو', Dendro: 'ديندرو',
  Sword: 'سيف', Claymore: 'كلايمور', Polearm: 'رمح', Bow: 'قوس', Catalyst: 'كاتاليست',
  Mondstadt: 'موندشتات', Liyue: 'ليويه', Inazuma: 'إينازوما', Sumeru: 'سوميرو', Fontaine: 'فونتين', Natlan: 'ناتلان',
  'Nod-Krai': 'نود-كراي', Snezhnaya: 'سنيزنايا',
};

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
  element: { ar: (n) => `ما عنصر **${n}**؟`, en: (n) => `What is **${n}**'s element?` },
  weapon: { ar: (n) => `شنو نوع السلاح اللي تستخدمه **${n}**؟`, en: (n) => `What weapon type does **${n}** use?` },
  region: { ar: (n) => `**${n}** مرتبطة بأي منطقة؟`, en: (n) => `Which region is **${n}** associated with?` },
  rarity: { ar: (n) => `كم نجمة ندرة **${n}**؟`, en: (n) => `What rarity is **${n}**?` },
  birthday: { ar: (n) => `متى عيد ميلاد **${n}**؟`, en: (n) => `When is **${n}**'s birthday?` },
  constellation: { ar: (n) => `شنو اسم Constellation الخاصة بـ **${n}**؟`, en: (n) => `What is **${n}**'s constellation called?` },
  title: { ar: (n) => `شنو لقب **${n}**؟`, en: (n) => `What is **${n}**'s title?` },
  skill: { ar: (n) => `شنو اسم الـElemental Skill لـ **${n}**؟`, en: (n) => `What is **${n}**'s Elemental Skill called?` },
  burst: { ar: (n) => `شنو اسم الـElemental Burst لـ **${n}**؟`, en: (n) => `What is **${n}**'s Elemental Burst called?` },
  localSpecialty: { ar: (n) => `أي Local Specialty تحتاجها **${n}** للصعود؟`, en: (n) => `Which local specialty does **${n}** use for ascension?` },
  bossMaterial: { ar: (n) => `أي Boss Material تحتاجها **${n}** للصعود؟`, en: (n) => `Which boss material does **${n}** use for ascension?` },
  enemyMaterial: { ar: (n) => `أي Enemy Drop تحتاجها **${n}** للصعود؟`, en: (n) => `Which enemy drop does **${n}** use for ascension?` },
  talentBook: { ar: (n) => `أي Talent Book تستخدمها **${n}**؟`, en: (n) => `Which talent book does **${n}** use?` },
  recommendedWeapon: { ar: (n) => `أي سلاح من هذي يعتبر أول توصية Neverless لـ **${n}**؟`, en: (n) => `Which weapon is Neverless' first recommendation for **${n}**?` },
  recommendedArtifact: { ar: (n) => `أي Artifact Set من هذي يعتبر أول توصية Neverless لـ **${n}**؟`, en: (n) => `Which Artifact Set is Neverless' first recommendation for **${n}**?` },
};

function displayValue(value, lang) {
  if (lang !== 'ar') return String(value);
  return AR_VALUES[value] || String(value);
}

function optionsFor(correct, pool, lang, wanted = 4) {
  const cleanPool = unique(pool);
  const wrong = shuffle(cleanPool.filter((value) => normalize(value) !== normalize(correct))).slice(0, Math.max(1, wanted - 1));
  const rawOptions = shuffle(unique([correct, ...wrong]));
  if (rawOptions.length < 2) return null;
  const options = rawOptions.map((value) => ({ raw: value, label: displayValue(value, lang) }));
  return options;
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
      const options = optionsFor(correct, pools[field], lang, wanted);
      if (!options) continue;
      questions.push({
        id: `${normalize(row.name)}:${field}`,
        type: field,
        difficulty: DIFFICULTY[field] || 'medium',
        character: row.name,
        prompt: FIELD_PROMPTS[field][lang === 'en' ? 'en' : 'ar'](row.name),
        correct: String(correct),
        correctLabel: displayValue(correct, lang),
        options,
        correctIndex: options.findIndex((value) => normalize(value.raw) === normalize(correct)),
      });
    }
  }
  return questions;
}

function balancedQuestions(questions, count) {
  const groups = {
    easy: shuffle(questions.filter((q) => q.difficulty === 'easy')),
    medium: shuffle(questions.filter((q) => q.difficulty === 'medium')),
    hard: shuffle(questions.filter((q) => q.difficulty === 'hard')),
  };
  const pattern = ['easy', 'medium', 'easy', 'hard', 'easy', 'medium'];
  const out = [];
  let cursor = 0;
  const wanted = Math.max(1, Number(count) || 1);

  while (out.length < wanted && Object.values(groups).some((rows) => rows.length)) {
    const preferred = pattern[cursor % pattern.length];
    cursor += 1;
    let next = groups[preferred].shift();
    if (!next) {
      const fallback = ['easy', 'medium', 'hard'].find((name) => groups[name].length);
      next = fallback ? groups[fallback].shift() : null;
    }
    if (next) out.push(next);
  }
  return out;
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
  const all = buildQuestionsFromRecords(records, lang);
  return balancedQuestions(all, Math.max(1, Math.min(MAX_QUESTIONS, Number(count) || 1)));
}

function repeatRow(lang = 'ar') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nq3repeat:${lang === 'en' ? 'en' : 'ar'}`)
      .setLabel(lang === 'en' ? 'Repeat' : 'تكرار')
      .setEmoji('🔁')
      .setStyle(ButtonStyle.Secondary),
  );
}

function answerRow(session, disabled = false) {
  return new ActionRowBuilder().addComponents(session.current.question.options.map((option, index) =>
    new ButtonBuilder()
      .setCustomId(`nq3:${session.id}:${session.current.token}:${index}`)
      .setLabel(String(option.label).slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)));
}

function difficultyLabel(value, lang) {
  const ar = lang === 'ar';
  if (value === 'easy') return ar ? 'سهل' : 'Easy';
  if (value === 'hard') return ar ? 'تحدي' : 'Challenge';
  return ar ? 'متوسط' : 'Medium';
}

function questionEmbed(session, closed = false) {
  const q = session.current.question;
  const title = session.total > 1 ? `Genshin Quiz • ${session.index + 1}/${session.total}` : 'Genshin Quiz';
  const footer = closed
    ? (session.lang === 'en' ? `Answer: ${q.correctLabel}` : `الإجابة: ${q.correctLabel}`)
    : (session.lang === 'en' ? `15 seconds • ${difficultyLabel(q.difficulty, 'en')}` : `15 ثانية • ${difficultyLabel(q.difficulty, 'ar')}`);
  return new EmbedBuilder()
    .setColor(closed ? 0x95a5a6 : 0x3498db)
    .setTitle(title)
    .setDescription(q.prompt)
    .setFooter({ text: footer });
}

function resultEmbed(session, userId, correct, elapsedMs) {
  const seconds = Math.max(0.1, Math.round(elapsedMs / 100) / 10);
  if (correct) {
    return new EmbedBuilder()
      .setColor(0x2ecc71)
      .setDescription(session.lang === 'en'
        ? `**Correct answer!**\n<@${userId}> answered in **${seconds}s**.`
        : `**إجابة صحيحة!**\n<@${userId}> أجاب خلال **${seconds} ثانية**.`);
  }
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setDescription(session.lang === 'en'
      ? `**Wrong answer.**\n<@${userId}> answered in **${seconds}s**.`
      : `**الإجابة خاطئة.**\n<@${userId}> أجاب خلال **${seconds} ثانية**.`);
}

function timeoutEmbed(session, stopped = false) {
  return new EmbedBuilder()
    .setColor(stopped ? 0xe74c3c : 0x95a5a6)
    .setDescription(session.lang === 'en'
      ? `No one answered. The answer was **${session.current.question.correctLabel}**.${stopped ? '\n**Quiz stopped.**' : ''}`
      : `لم يجب أحد، الإجابة كانت **${session.current.question.correctLabel}**.${stopped ? '\n**توقفت الأسئلة.**' : ''}`);
}

function playerRows(session) {
  return [...session.players.entries()].map(([userId, row]) => ({
    userId,
    correct: row.correct,
    wrong: row.wrong,
    answers: row.answers,
    avgMs: row.correct ? row.correctTimeMs / row.correct : Infinity,
  })).sort((a, b) =>
    b.correct - a.correct
    || a.avgMs - b.avgMs
    || a.wrong - b.wrong
    || a.userId.localeCompare(b.userId),
  );
}

function finalEmbed(session, stopped = false) {
  const rows = playerRows(session);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.slice(0, 10).map((row, index) => {
    const speed = Number.isFinite(row.avgMs) ? ` • ${(Math.round(row.avgMs / 100) / 10)}s` : '';
    return `${medals[index] || `${index + 1}.`} <@${row.userId}> — **${row.correct}** ${session.lang === 'en' ? 'correct' : 'صحيحة'}${speed}`;
  });

  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(session.lang === 'en' ? '🏆 Quiz finished!' : '🏆 الأسئلة انتهت!')
    .setDescription([
      stopped ? (session.lang === 'en' ? 'The round stopped after two unanswered questions.' : 'توقفت الجولة بعد سؤالين متتاليين بدون إجابة.') : null,
      `**${session.lang === 'en' ? 'Top players' : 'أفضل اللاعبين'}:**`,
      ...(lines.length ? lines : [session.lang === 'en' ? 'No players answered.' : 'ما شارك أحد بالإجابة.']),
    ].filter(Boolean).join('\n'));
}

function clearQuestionTimer(session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
}

async function closeQuestionMessage(session) {
  const messageId = session.current?.messageId;
  if (!messageId) return;
  const message = await session.channel.messages.fetch(messageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [questionEmbed(session, true)], components: [answerRow(session, true)] }).catch(() => {});
}

async function finishSession(session, options = {}) {
  clearQuestionTimer(session);
  sessions.delete(session.id);
  if (channelSessions.get(session.channel.id) === session.id) channelSessions.delete(session.channel.id);
  await session.channel.send({
    embeds: [finalEmbed(session, Boolean(options.stopped))],
    components: [repeatRow(session.lang)],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

async function sendQuestion(session) {
  if (!sessions.has(session.id)) return;
  if (session.index >= session.total || session.index >= session.bank.length) {
    await finishSession(session);
    return;
  }

  session.current = {
    question: session.bank[session.index],
    token: crypto.randomBytes(3).toString('hex'),
    startedAt: Date.now(),
    messageId: null,
    answers: new Set(),
  };

  const sent = await session.channel.send({ embeds: [questionEmbed(session)], components: [answerRow(session)] });
  session.current.messageId = sent.id;
  const token = session.current.token;
  session.timer = setTimeout(() => {
    handleQuestionTimeout(session.id, token).catch((error) => console.error('[quiz-v3] timeout failed:', error));
  }, QUESTION_TIMEOUT_MS);
  session.timer.unref?.();
}

async function handleQuestionTimeout(sessionId, token) {
  const session = sessions.get(sessionId);
  if (!session || !session.current || session.current.token !== token) return;
  clearQuestionTimer(session);
  await closeQuestionMessage(session);

  const nobodyAnswered = session.current.answers.size === 0;
  if (nobodyAnswered) session.noAnswerStreak += 1;
  else session.noAnswerStreak = 0;

  const stopped = session.total > 1 && session.noAnswerStreak >= 2;
  if (nobodyAnswered) {
    await session.channel.send({ embeds: [timeoutEmbed(session, stopped)] }).catch(() => {});
  }

  const lastQuestion = session.index + 1 >= session.total;
  if (stopped || lastQuestion) {
    await finishSession(session, { stopped });
    return;
  }

  session.index += 1;
  setTimeout(() => sendQuestion(session).catch((error) => console.error('[quiz-v3] next question failed:', error)), 800).unref?.();
}

async function startSession(channel, count, lang = 'ar') {
  const activeId = channelSessions.get(channel.id);
  if (activeId && sessions.has(activeId)) return { busy: true, session: sessions.get(activeId) };

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
    players: new Map(),
  };
  sessions.set(session.id, session);
  channelSessions.set(channel.id, session.id);
  await sendQuestion(session);
  return { busy: false, session };
}

async function handleQuizCommand(message, lang = 'ar') {
  const started = await startSession(message.channel, 1, lang);
  if (!started) {
    await message.reply({ content: lang === 'en' ? 'I could not prepare a quiz question right now.' : 'ما قدرت أجهز سؤال الآن، حاول مرة ثانية.', allowedMentions: { repliedUser: false } });
  } else if (started.busy) {
    await message.reply({ content: lang === 'en' ? 'There is already an active quiz in this channel.' : 'في جولة كويز شغالة حاليًا في هذا الروم.', allowedMentions: { repliedUser: false } });
  }
  return true;
}

function quizCountModal(lang = 'ar') {
  const ar = lang !== 'en';
  return new ModalBuilder()
    .setCustomId(`nq3modal:${ar ? 'ar' : 'en'}`)
    .setTitle(ar ? 'تكرار Genshin Quiz' : 'Repeat Genshin Quiz')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('count')
        .setLabel(ar ? 'عدد الأسئلة' : 'Number of questions')
        .setPlaceholder(ar ? 'مثال: 20' : 'Example: 20')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(2)
        .setRequired(true),
    ));
}

function parseQuizCount(value) {
  const count = Number(String(value || '').trim());
  return Number.isInteger(count) && count >= 1 && count <= MAX_QUESTIONS ? count : null;
}

async function handleAnswer(interaction) {
  const match = String(interaction.customId || '').match(/^nq3:([a-f0-9]+):([a-f0-9]+):(\d+)$/i);
  if (!match) return false;
  const [, sessionId, token, rawIndex] = match;
  const session = sessions.get(sessionId);
  if (!session || !session.current || session.current.token !== token) {
    await interaction.reply({ content: 'انتهى هذا السؤال.', ephemeral: true }).catch(() => {});
    return true;
  }

  const userId = String(interaction.user.id);
  if (session.current.answers.has(userId)) {
    await interaction.reply({ content: session.lang === 'en' ? 'You already answered this question.' : 'أنت جاوبت على هذا السؤال بالفعل.', ephemeral: true }).catch(() => {});
    return true;
  }

  session.current.answers.add(userId);
  const elapsed = Date.now() - session.current.startedAt;
  const selected = Number(rawIndex);
  const correct = selected === session.current.question.correctIndex;
  const player = session.players.get(userId) || { correct: 0, wrong: 0, answers: 0, correctTimeMs: 0 };
  player.answers += 1;
  if (correct) {
    player.correct += 1;
    player.correctTimeMs += elapsed;
  } else {
    player.wrong += 1;
  }
  session.players.set(userId, player);
  session.noAnswerStreak = 0;

  await interaction.reply({
    embeds: [resultEmbed(session, userId, correct, elapsed)],
    allowedMentions: { users: [userId] },
  }).catch(() => {});
  return true;
}

async function handleRepeat(interaction) {
  if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith('nq3repeat:')) return false;
  const lang = String(interaction.customId).endsWith(':en') ? 'en' : 'ar';
  await interaction.showModal(quizCountModal(lang));
  return true;
}

async function handleModal(interaction) {
  if (!interaction.isModalSubmit?.() || !String(interaction.customId || '').startsWith('nq3modal:')) return false;
  const lang = String(interaction.customId).endsWith(':en') ? 'en' : 'ar';
  const count = parseQuizCount(interaction.fields.getTextInputValue('count'));
  if (!count) {
    await interaction.reply({ content: lang === 'en' ? `Enter a number from 1 to ${MAX_QUESTIONS}.` : `اكتب رقم من 1 إلى ${MAX_QUESTIONS}.`, ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const started = await startSession(interaction.channel, count, lang).catch(() => null);
  if (!started) {
    await interaction.editReply(lang === 'en' ? 'I could not start the quiz.' : 'ما قدرت أبدأ الأسئلة الآن.');
    return true;
  }
  if (started.busy) {
    await interaction.editReply(lang === 'en' ? 'There is already an active quiz in this channel.' : 'في جولة كويز شغالة حاليًا في هذا الروم.');
    return true;
  }
  await interaction.editReply(lang === 'en' ? `Started **${started.session.total}** questions.` : `بدأت **${started.session.total}** سؤال.`);
  return true;
}

async function handleQuizInteraction(interaction) {
  if (interaction.isButton?.()) {
    if (String(interaction.customId || '').startsWith('nq3repeat:')) return handleRepeat(interaction);
    if (String(interaction.customId || '').startsWith('nq3:')) return handleAnswer(interaction);
  }
  if (interaction.isModalSubmit?.() && String(interaction.customId || '').startsWith('nq3modal:')) return handleModal(interaction);
  return false;
}

function installQuizEngine(client) {
  if (installed) return;
  installed = true;
  client.on('interactionCreate', (interaction) => {
    Promise.resolve(handleQuizInteraction(interaction)).catch((error) => console.error('[quiz-v3] interaction failed:', error));
  });
}

module.exports = {
  installQuizEngine,
  handleQuizCommand,
  handleQuizInteraction,
  buildQuizBank,
  buildQuestionsFromRecords,
  balancedQuestions,
  quizRecord,
  displayValue,
  playerRows,
  parseQuizCount,
  QUESTION_TIMEOUT_MS,
  MAX_QUESTIONS,
};
