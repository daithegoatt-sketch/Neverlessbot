'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { getLinkedUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot, listCharacters } = require('./enkaClient');
const { getGuide } = require('./guideClient');
const { resolveCharacter } = require('./characterResolver');
const { formatArtifactReview } = require('./ratingCopyV2');
const { formatArtifactDoctor } = require('./artifactDoctor');
const { buildArtifactCard } = require('./artifactCard');
const { evaluateBuild } = require('./buildEvaluator');
const {
  SLOT_LABELS,
  slotFromText,
  recognizeArtifactAttachment,
  scoreCandidateArtifact,
  formatPickerResult,
  projectedRecommendedSetCount,
} = require('./artifactImagePicker');

const PICKER_TTL = 20 * 60 * 1000;
const SLOT_ORDER = ['flower', 'plume', 'sands', 'goblet', 'circlet'];
const pickerSessions = new Map();

function emptyCounts() {
  return { flower: 0, plume: 0, sands: 0, goblet: 0, circlet: 0 };
}

function language(text) {
  const ar = (String(text).match(/[\u0600-\u06ff]/g) || []).length;
  const en = (String(text).match(/[A-Za-z]/g) || []).length;
  return ar && ar >= en * 0.25 ? 'ar' : 'en';
}

function accountPhrase(text) {
  return /بحسابي|في\s+حسابي|من\s+حسابي|my\s+account|in\s+my\s+account|on\s+my\s+account/i.test(String(text || ''));
}

function hasArtifactWord(value) {
  return /[اآأإ]?رت[يى]?[فڤ]ا?كت(?:ات)?|artifact(?:s)?/iu.test(String(value || ''));
}

function isDoctorHub(text) {
  return /^\s*(?:طبيب\s+(?:ال)?[اآأإ]?رت[يى]?[فڤ]ا?كت(?:ات)?|artifact\s+doctor)\s*$/iu.test(String(text || ''));
}

function isArtifactDoctor(text) {
  const value = String(text || '');
  const hasImprove = /تحسين|حس[ّ]?ن|طور|طوّر|رفع|ارفع|أرفع|improve|upgrade|doctor|increase|raise/iu.test(value);
  return hasArtifactWord(value) && hasImprove && !isDoctorHub(value);
}

function isArtifactReview(text) {
  const value = String(text || '');
  const hasReview = /تقييم|قيّم|قيم|حلل|راجع|rate|review|evaluate/iu.test(value);
  return hasArtifactWord(value) && hasReview && accountPhrase(value);
}

function isArtifactPicker(text) {
  const value = String(text || '');
  const choose = /أفضل|افضل|اختيار|اختر|اختار|قارن|best|pick|choose|compare/iu.test(value);
  return hasArtifactWord(value) && choose;
}

function isPickerCancel(text) {
  return /(?:الغاء|إلغاء|وقف|انهاء|إنهاء).*(?:اختيار|ارتيفاكت)|cancel.*artifact/iu.test(String(text || ''));
}

function keyFrom(guildId, userId) {
  return `${guildId || 'dm'}:${userId || 'unknown'}`;
}

function sessionKey(message) {
  return keyFrom(message?.guildId, message?.author?.id);
}

function interactionSessionKey(interaction) {
  return keyFrom(interaction?.guildId, interaction?.user?.id);
}

function getSessionByKey(key) {
  const session = pickerSessions.get(key);
  if (!session) return null;
  if (Date.now() - session.updatedAt > PICKER_TTL) {
    pickerSessions.delete(key);
    return null;
  }
  return session;
}

function getPickerSession(message) {
  const session = getSessionByKey(sessionKey(message));
  if (!session) return null;
  const channelId = message?.channel?.id || message?.channelId;
  if (session.channelId && channelId && String(session.channelId) !== String(channelId)) return null;
  return session;
}

function hasArtifactPickerSession(message) {
  return Boolean(getPickerSession(message));
}

function imageAttachments(message) {
  const values = message?.attachments?.values ? [...message.attachments.values()] : [];
  return values.filter((item) => {
    const type = String(item?.contentType || '');
    const name = String(item?.name || '');
    return type.startsWith('image/') || /\.(?:png|jpe?g|webp)$/i.test(name);
  }).slice(0, 10);
}

async function sendPayload(message, payload) {
  return message.channel.send({
    ...(payload || {}),
    allowedMentions: { users: [], repliedUser: false },
  });
}

async function sendText(message, content, components = []) {
  return sendPayload(message, { content, components });
}

function endRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gdoc:end:${userId}`)
      .setLabel('إنهاء / End')
      .setStyle(ButtonStyle.Danger),
  );
}

function characterRow(userId, choices, lang) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gdoc:char:${userId}`)
    .setPlaceholder(lang === 'ar' ? 'اختيار الشخصية' : 'Choose character')
    .setMinValues(1)
    .setMaxValues(1);

  menu.addOptions(choices.map((item) => ({
    label: item.name.slice(0, 100),
    value: item.name.slice(0, 100),
    description: (lang === 'ar'
      ? `Lv.${item.level ?? '?'} • Neverless ${Number.isFinite(item.score) ? `${item.score}%` : '—'}`
      : `Lv.${item.level ?? '?'} • Neverless ${Number.isFinite(item.score) ? `${item.score}%` : '—'}`).slice(0, 100),
  })));
  return new ActionRowBuilder().addComponents(menu);
}

function allProgress(session) {
  return SLOT_ORDER.map((slot) => `${session.allCounts?.[slot] || 0}/2`).join('/');
}

function slotRow(session) {
  const ar = session.language === 'ar';
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gdoc:slot:${session.userId}`)
    .setPlaceholder(ar ? 'اختيار الارتيفاكتات' : 'Choose artifact slot')
    .setMinValues(1)
    .setMaxValues(1);

  for (const slot of SLOT_ORDER) {
    const label = SLOT_LABELS[slot];
    const count = session.singleCounts?.[slot] || 0;
    menu.addOptions({
      label: `${label} ${count}/10`,
      value: slot,
      description: ar ? `اختيار من 1 إلى 10 صور لـ ${label}` : `Compare 1–10 ${label} screenshots`,
    });
  }
  menu.addOptions({
    label: `${ar ? 'جميع الارتيفاكتات' : 'All artifacts'} ${allProgress(session)}`,
    value: 'all',
    description: ar ? 'أول صورتين لكل نوع؛ 2/2/2/2/2' : 'First two screenshots per slot; 2/2/2/2/2',
  });
  return new ActionRowBuilder().addComponents(menu);
}

function hubEmbed(lang) {
  return new EmbedBuilder()
    .setTitle(lang === 'ar' ? 'طبيب ارتيفاكتات Neverless بخدمتك' : 'Neverless Artifact Doctor')
    .setDescription(lang === 'ar'
      ? 'كيف يمكنني مساعدتك؟\n**يرجى اختيار الشخصية من الصندوق الذي بالأسفل.**'
      : 'How can I help?\n**Choose a character from the menu below.**');
}

function sessionEmbed(session) {
  const ar = session.language === 'ar';
  const score = Number.isFinite(session.score) ? `${session.score}%` : '—';
  const base = [
    `**${session.characterName}** • Lv.${session.level ?? '?'} • Neverless ${score}`,
  ];

  if (session.mode === 'single' && session.slot) {
    const label = SLOT_LABELS[session.slot];
    base.push(ar
      ? `\n**الوضع: ${label} ${session.singleCounts[session.slot]}/10**\nأرسل من 1 إلى 10 صور. استخدم شاشة تفاصيل الارتيفاكت مثل صور اللعبة: الـMain Stat والـSubstats والـSet ظاهرين.`
      : `\n**Mode: ${label} ${session.singleCounts[session.slot]}/10**\nSend 1–10 screenshots with main stat, substats and set visible.`);
  } else if (session.mode === 'all') {
    base.push(ar
      ? `\n**الوضع: جميع الارتيفاكتات ${allProgress(session)}**\nأرسل الصور مباشرة. البوت يأخذ **أول صورتين فقط لكل نوع** ويختار الأفضل، ثم يحسب القطعة التالية على البيلد المعدّل.`
      : `\n**Mode: All artifacts ${allProgress(session)}**\nSend screenshots directly. The bot uses the **first two per slot**, chooses the better one, then evaluates the next slot on the projected build.`);
  } else {
    base.push(ar
      ? '\nاختر نوع القطعة. وضع **جميع الارتيفاكتات** يسمح بصورتين لكل Flower / Plume / Sands / Goblet / Circlet.'
      : '\nChoose a slot. **All artifacts** accepts two screenshots for each artifact type.');
  }

  return new EmbedBuilder()
    .setTitle(ar ? 'Artifact Doctor — جلسة التطوير' : 'Artifact Doctor — Upgrade Session')
    .setDescription(base.join('\n'));
}

async function showcaseChoices(account) {
  const visible = listCharacters(account).slice(0, 25);
  const choices = [];
  for (const item of visible) {
    const character = findCharacter(account, item.name);
    const snapshot = getBuildSnapshot(character);
    let score = null;
    try {
      const guide = await getGuide(item.name);
      if (guide && snapshot) score = evaluateBuild(snapshot, guide).score;
    } catch {}
    choices.push({ name: item.name, level: item.level, score });
  }
  return choices;
}

async function startDoctorHub(message, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await sendText(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return true;
  }

  let account;
  try {
    account = await fetchAccount(uid, { forceRefresh: true });
  } catch (error) {
    console.warn('[artifact-doctor-ui] showcase fetch failed:', error.message);
    await sendText(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن **Show Character Details** مفعّل.'
      : 'I could not read your Showcase. Make sure **Show Character Details** is enabled.');
    return true;
  }

  const choices = await showcaseChoices(account);
  if (!choices.length) {
    await sendText(message, lang === 'ar' ? 'ما لقيت شخصيات ظاهرة في الـShowcase.' : 'No visible Showcase characters were found.');
    return true;
  }

  await sendPayload(message, {
    embeds: [hubEmbed(lang)],
    components: [characterRow(message.author.id, choices, lang), endRow(message.author.id)],
  });
  return true;
}

async function loadLinkedBuild(message, text, lang, forcedCharacter = null) {
  const characterName = forcedCharacter || await resolveCharacter(text);
  if (!characterName) {
    await sendText(message, lang === 'ar'
      ? 'حدد اسم الشخصية، مثال: `قيم ارتيفاكتات Skirk بحسابي` أو استخدم `طبيب الارتيفاكتات`.'
      : 'Include the character name, or use `artifact doctor` for the interactive menu.');
    return null;
  }

  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await sendText(message, lang === 'ar' ? 'اربط حسابك أولًا: `ربط UID 7XXXXXXXXX`.' : 'Link your account first: `link UID 7XXXXXXXXX`.');
    return null;
  }

  let account;
  try {
    account = await fetchAccount(uid, { forceRefresh: true });
  } catch (error) {
    console.warn('[artifact-review] Enka fetch failed:', error.message);
    await sendText(message, lang === 'ar'
      ? 'ما قدرت أقرأ الـShowcase الآن. تأكد أن **Show Character Details** مفعّل.'
      : 'I could not read the Showcase right now. Make sure **Show Character Details** is enabled.');
    return null;
  }

  const character = findCharacter(account, characterName);
  if (!character) {
    await sendText(message, lang === 'ar'
      ? `**${characterName}** مو ظاهرة بالتفاصيل في الـShowcase حاليًا.`
      : `**${characterName}** is not visible with details in your Showcase.`);
    return null;
  }

  const guide = await getGuide(characterName).catch(() => null);
  if (!guide) {
    await sendText(message, lang === 'ar'
      ? `أقدر أقرأ ارتيفاكتات **${characterName}**، لكن ما عندي Guide موثوق كفاية حتى أحدد أفضل بيلد.`
      : `I can read **${characterName}**, but I do not have a reliable enough guide to judge the build.`);
    return null;
  }

  return { uid, characterName, character, guide, snapshot: getBuildSnapshot(character) };
}

async function artifactCardFile(character, snapshot, guide, characterName, evaluation = null) {
  try {
    const buffer = await buildArtifactCard(character, snapshot, guide, evaluation);
    return [{ attachment: buffer, name: `${characterName.replace(/[^a-z0-9]+/gi, '-')}-artifacts.png` }];
  } catch (error) {
    console.warn('[artifact-card] generation failed:', error.message);
    return [];
  }
}

function pickerPrompt(session) {
  const ar = session.language === 'ar';
  if (!session.mode) return ar ? 'اختر نوع الارتيفاكت من الصندوق أولًا.' : 'Choose an artifact slot from the menu first.';
  if (session.mode === 'all') {
    return ar
      ? `**جميع الارتيفاكتات — ${allProgress(session)}**\nأرسل الصور مباشرة. أول صورتين فقط من كل نوع تدخل المقارنة.`
      : `**All artifacts — ${allProgress(session)}**\nSend screenshots directly; only the first two per slot are compared.`;
  }
  const label = SLOT_LABELS[session.slot];
  return ar
    ? `**${label} — ${session.singleCounts[session.slot]}/10**\nأرسل من 1 إلى 10 صور واضحة للقطعة.`
    : `**${label} — ${session.singleCounts[session.slot]}/10**\nSend 1–10 clear screenshots.`;
}

function candidateIsSafe(best, snapshot, guide) {
  const current = (snapshot?.artifacts || []).find((row) => row.slot === best.reviewed.slot) || null;
  const currentSet = current ? projectedRecommendedSetCount(snapshot, best.reviewed.slot, current, guide) : { count: 0 };
  const safeSet = !best.setFit?.required || best.setFit.matched || best.setFit.count >= currentSet.count;
  const safeTargets = !(best.targetDetails || []).some((row) => row.before >= row.target.min && row.after < row.target.min);
  const currentScored = current ? scoreCandidateArtifact(current, snapshot, guide, null, best.reviewed.slot) : null;
  const upgrade = !currentScored?.valid || best.score > currentScored.score + 1;
  return { safe: safeSet && safeTargets && upgrade, safeSet, safeTargets, upgrade };
}

function ocrFailureText(results, lang) {
  const ar = lang === 'ar';
  const partial = results.filter((row) => /PARTIAL_SUBSTATS/.test(String(row.reason))).length;
  const wrongMain = results.filter((row) => row.reason === 'WRONG_MAIN').length;
  const pieces = [];
  if (partial) pieces.push(ar ? `${partial} صورة قُرئ منها جزء من السب ستات فقط` : `${partial} image(s) had partial substats`);
  if (wrongMain) pieces.push(ar ? `${wrongMain} Main Stat غير مناسب` : `${wrongMain} had a wrong main stat`);
  return pieces.join(' • ');
}

async function refreshControlMessage(message, session) {
  if (!session.controlMessageId) return;
  try {
    const control = await message.channel.messages.fetch(session.controlMessageId);
    await control.edit({
      embeds: [sessionEmbed(session)],
      components: [slotRow(session), endRow(session.userId)],
    });
  } catch (error) {
    console.warn('[artifact-doctor-ui] control refresh failed:', error.message);
  }
}

async function processSingleImages(message, session, images) {
  const ar = session.language === 'ar';
  const slot = session.slot;
  const remaining = Math.max(0, 10 - session.singleCounts[slot]);
  if (!remaining) {
    await sendText(message, ar ? 'وصلت حد 10 صور لهذا النوع. اختر نوعًا ثانيًا أو اضغط إنهاء.' : 'You reached 10 images for this slot. Choose another slot or end the session.', [endRow(session.userId)]);
    return true;
  }

  const batch = images.slice(0, remaining);
  session.singleCounts[slot] += batch.length;
  const before = session.snapshot;
  const results = [];

  for (let index = 0; index < batch.length; index += 1) {
    try {
      const parsed = await recognizeArtifactAttachment(batch[index], session.guide, slot);
      if (!parsed.ok) {
        results.push({ index, valid: false, reason: parsed.reason });
        continue;
      }
      const scored = scoreCandidateArtifact(parsed.artifact, before, session.guide, session.evaluation, slot);
      results.push({ ...scored, index, artifact: parsed.artifact });
    } catch (error) {
      console.warn('[artifact-picker] OCR failed:', error.message);
      results.push({ index, valid: false, reason: error.message });
    }
  }

  const valid = results.filter((row) => row.valid).sort((a, b) => b.score - a.score);
  if (!valid.length) {
    session.updatedAt = Date.now();
    pickerSessions.set(sessionKey(message), session);
    await refreshControlMessage(message, session);
    const detail = ocrFailureText(results, session.language);
    await sendText(message, ar
      ? `ما قدرت أقرأ قطعة كاملة من الصور.${detail ? `\n${detail}.` : ''}\nاستخدم شاشة تفاصيل مثل الصور التي يظهر فيها **اسم القطعة + Main Stat + الأربع Substats + اسم الـSet** بوضوح.`
      : `I could not read a complete artifact.${detail ? `\n${detail}.` : ''}\nUse the in-game detail view with name, main stat, all four substats and set visible.`, [slotRow(session), endRow(session.userId)]);
    return true;
  }

  const best = valid[0];
  const safety = candidateIsSafe(best, before, session.guide);
  let adopted = false;
  if (safety.safe) {
    session.snapshot = best.projected;
    session.evaluation = evaluateBuild(session.snapshot, session.guide);
    session.selected[slot] = best.artifact;
    adopted = true;
  }
  session.updatedAt = Date.now();
  pickerSessions.set(sessionKey(message), session);
  await refreshControlMessage(message, session);

  const verdict = ar
    ? (adopted
      ? '\n✅ **أفضل من القطعة الحالية للبيلد؛ تم اعتمادها مؤقتًا داخل جلسة الطبيب.**'
      : '\nℹ️ **هذه الأفضل بين الصور المرسلة، لكن قطعتك الحالية ما زالت أفضل أو استبدالها يضر التارقت/الـSet؛ لن أغيّر البيلد بها.**')
    : (adopted
      ? '\n✅ **This improves the current build and is now the session choice.**'
      : '\nℹ️ **This is the best upload, but your current piece is still better or safer; it was not applied.**');
  await sendText(message, `${formatPickerResult(best, results, before, session.guide, session.language)}${verdict}`, [slotRow(session), endRow(session.userId)]);
  return true;
}

async function processAllImages(message, session, images) {
  const ar = session.language === 'ar';
  const parsedRows = [];

  for (let index = 0; index < images.length; index += 1) {
    try {
      const parsed = await recognizeArtifactAttachment(images[index], session.guide, null);
      if (!parsed.ok || !parsed.artifact?.slot) {
        parsedRows.push({ index, valid: false, reason: parsed.reason || 'SLOT_NOT_FOUND' });
        continue;
      }
      const slot = parsed.artifact.slot;
      if (session.allDone[slot] || session.allCandidates[slot].length >= 2) continue;
      session.allCandidates[slot].push({ artifact: parsed.artifact, index });
      session.allCounts[slot] = session.allCandidates[slot].length;
      parsedRows.push({ index, valid: true, slot });
    } catch (error) {
      console.warn('[artifact-picker-all] OCR failed:', error.message);
      parsedRows.push({ index, valid: false, reason: error.message });
    }
  }

  const summaries = [];
  for (const slot of SLOT_ORDER) {
    if (session.allDone[slot] || session.allCandidates[slot].length < 2) continue;
    const before = session.snapshot;
    const scored = session.allCandidates[slot].map((item) => ({
      ...scoreCandidateArtifact(item.artifact, before, session.guide, session.evaluation, slot),
      artifact: item.artifact,
      index: item.index,
    })).filter((row) => row.valid).sort((a, b) => b.score - a.score);

    session.allDone[slot] = true;
    if (!scored.length) {
      summaries.push(ar ? `• ${SLOT_LABELS[slot]}: الصورتان غير مناسبتين للـMain Stat.` : `• ${SLOT_LABELS[slot]}: both images have an unsuitable main stat.`);
      continue;
    }

    const best = scored[0];
    const safety = candidateIsSafe(best, before, session.guide);
    if (safety.safe) {
      session.snapshot = best.projected;
      session.evaluation = evaluateBuild(session.snapshot, session.guide);
      session.selected[slot] = best.artifact;
      summaries.push(ar
        ? `• ${SLOT_LABELS[slot]}: الصورة #${best.index + 1} أفضل وتم اعتمادها — RV ${best.quality.displayRv}% • CV ${best.reviewed.cv}`
        : `• ${SLOT_LABELS[slot]}: image #${best.index + 1} wins and was applied — RV ${best.quality.displayRv}% • CV ${best.reviewed.cv}`);
    } else {
      summaries.push(ar
        ? `• ${SLOT_LABELS[slot]}: الصورة #${best.index + 1} أفضل من المرسلتين، لكن الحالية أقوى/أأمن للبيلد.`
        : `• ${SLOT_LABELS[slot]}: image #${best.index + 1} is the better upload, but the equipped piece remains stronger/safer.`);
    }
  }

  session.updatedAt = Date.now();
  pickerSessions.set(sessionKey(message), session);
  await refreshControlMessage(message, session);

  const complete = SLOT_ORDER.every((slot) => session.allDone[slot]);
  const failed = ocrFailureText(parsedRows, session.language);
  const text = ar
    ? [
        `**تقدم جميع الارتيفاكتات: ${allProgress(session)}**`,
        ...summaries,
        failed ? `\nقراءة الصور: ${failed}.` : '',
        complete
          ? '\n✅ انتهت مقارنة أول صورتين لكل نوع. الاختيارات احتُسبت بالتتابع على البيلد المعدّل.'
          : '\nأرسل الصور الناقصة. كل نوع يتوقف تلقائيًا بعد أول صورتين مقروءتين.',
      ].filter(Boolean).join('\n')
    : [
        `**All-artifact progress: ${allProgress(session)}**`,
        ...summaries,
        failed ? `\nImage reading: ${failed}.` : '',
        complete ? '\n✅ First-two comparison is complete for every slot.' : '\nSend the remaining screenshots; each slot stops after its first two readable images.',
      ].filter(Boolean).join('\n');

  await sendText(message, text, [slotRow(session), endRow(session.userId)]);
  return true;
}

async function processPickerImages(message, session) {
  const images = imageAttachments(message);
  if (!images.length) {
    await sendText(message, pickerPrompt(session), [slotRow(session), endRow(session.userId)]);
    return true;
  }
  if (!session.mode) {
    await sendText(message, session.language === 'ar' ? 'اختر نوع الارتيفاكت من الصندوق أولًا، ثم أرسل الصور.' : 'Choose the artifact slot first, then send images.', [slotRow(session), endRow(session.userId)]);
    return true;
  }
  return session.mode === 'all'
    ? processAllImages(message, session, images)
    : processSingleImages(message, session, images);
}

async function startPicker(message, text, lang) {
  const slot = slotFromText(text);
  if (!slot) {
    await sendText(message, lang === 'ar'
      ? 'استخدم `طبيب الارتيفاكتات` لفتح الواجهة، أو حدد النوع: Flower / Plume / Sands / Goblet / Circlet.'
      : 'Use `artifact doctor` for the menu, or include Flower / Plume / Sands / Goblet / Circlet.');
    return true;
  }

  const linked = await loadLinkedBuild(message, text, lang);
  if (!linked) return true;
  const evaluation = evaluateBuild(linked.snapshot, linked.guide);
  const session = {
    uid: linked.uid,
    userId: message.author.id,
    characterName: linked.characterName,
    level: linked.snapshot?.level,
    score: evaluation.score,
    guide: linked.guide,
    evaluation,
    originalSnapshot: linked.snapshot,
    snapshot: linked.snapshot,
    selected: {},
    singleCounts: emptyCounts(),
    allCounts: emptyCounts(),
    allCandidates: Object.fromEntries(SLOT_ORDER.map((slotName) => [slotName, []])),
    allDone: Object.fromEntries(SLOT_ORDER.map((slotName) => [slotName, false])),
    mode: 'single',
    slot,
    language: lang,
    channelId: message?.channel?.id || message?.channelId,
    updatedAt: Date.now(),
  };
  pickerSessions.set(sessionKey(message), session);
  return processPickerImages(message, session);
}

async function handleArtifactInteraction(interaction) {
  const customId = String(interaction?.customId || '');
  if (!customId.startsWith('gdoc:')) return false;
  const [, action, ownerId] = customId.split(':');
  if (!ownerId || interaction.user?.id !== ownerId) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'هذه جلسة Artifact Doctor لشخص آخر.', ephemeral: true }).catch(() => {});
    }
    return true;
  }

  const key = interactionSessionKey(interaction);
  if (action === 'end') {
    pickerSessions.delete(key);
    const payload = {
      content: 'تم إنهاء جلسة Artifact Doctor.',
      embeds: [],
      components: [],
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.update(payload).catch(() => {});
    return true;
  }

  if (action === 'char' && interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const characterName = interaction.values?.[0];
    const uid = getLinkedUid(interaction.user.id);
    if (!uid) {
      await interaction.editReply({ content: 'اربط حسابك أولًا.', embeds: [], components: [] });
      return true;
    }

    try {
      const account = await fetchAccount(uid, { forceRefresh: true });
      const character = findCharacter(account, characterName);
      const guide = character ? await getGuide(characterName).catch(() => null) : null;
      const snapshot = character ? getBuildSnapshot(character) : null;
      if (!character || !guide || !snapshot) {
        await interaction.editReply({ content: `ما قدرت أجهز Artifact Doctor لـ **${characterName}**.`, embeds: [], components: [endRow(ownerId)] });
        return true;
      }
      const evaluation = evaluateBuild(snapshot, guide);
      const session = {
        uid,
        userId: interaction.user.id,
        characterName,
        level: snapshot.level,
        score: evaluation.score,
        guide,
        evaluation,
        originalSnapshot: snapshot,
        snapshot,
        selected: {},
        singleCounts: emptyCounts(),
        allCounts: emptyCounts(),
        allCandidates: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, []])),
        allDone: Object.fromEntries(SLOT_ORDER.map((slot) => [slot, false])),
        mode: null,
        slot: null,
        language: 'ar',
        channelId: interaction.channelId,
        controlMessageId: interaction.message?.id,
        updatedAt: Date.now(),
      };
      pickerSessions.set(key, session);
      await interaction.editReply({
        content: null,
        embeds: [sessionEmbed(session)],
        components: [slotRow(session), endRow(ownerId)],
      });
    } catch (error) {
      console.warn('[artifact-doctor-ui] character select failed:', error.message);
      await interaction.editReply({ content: 'تعذر تجهيز الشخصية الآن. حاول مرة ثانية.', embeds: [], components: [endRow(ownerId)] });
    }
    return true;
  }

  if (action === 'slot' && interaction.isStringSelectMenu()) {
    const session = getSessionByKey(key);
    if (!session) {
      await interaction.reply({ content: 'انتهت جلسة Artifact Doctor. اكتب `طبيب الارتيفاكتات` لبدء جلسة جديدة.', ephemeral: true }).catch(() => {});
      return true;
    }
    const choice = interaction.values?.[0];
    if (choice === 'all') {
      session.mode = 'all';
      session.slot = null;
    } else if (SLOT_ORDER.includes(choice)) {
      session.mode = 'single';
      session.slot = choice;
    }
    session.updatedAt = Date.now();
    pickerSessions.set(key, session);
    await interaction.update({
      embeds: [sessionEmbed(session)],
      components: [slotRow(session), endRow(ownerId)],
    });
    return true;
  }

  return true;
}

async function handleArtifactReviewMessage(message) {
  const text = String(message?.content || '').trim();
  const session = getPickerSession(message);
  const attachments = imageAttachments(message);
  const lang = text ? language(text) : (session?.language || 'ar');

  if (session && attachments.length) return processPickerImages(message, session);

  if (session && isPickerCancel(text)) {
    pickerSessions.delete(sessionKey(message));
    await sendText(message, lang === 'ar' ? 'تم إنهاء جلسة Artifact Doctor.' : 'Artifact Doctor session ended.');
    return true;
  }

  if (isDoctorHub(text)) return startDoctorHub(message, lang);

  if (session && !hasArtifactWord(text)) {
    const nextSlot = slotFromText(text);
    if (nextSlot) {
      session.mode = 'single';
      session.slot = nextSlot;
      session.updatedAt = Date.now();
      pickerSessions.set(sessionKey(message), session);
      await sendText(message, pickerPrompt(session), [slotRow(session), endRow(session.userId)]);
      return true;
    }
  }

  if (isArtifactPicker(text)) return startPicker(message, text, lang);

  const doctor = isArtifactDoctor(text);
  const review = isArtifactReview(text);
  if (!doctor && !review) return false;

  const linked = await loadLinkedBuild(message, text, lang);
  if (!linked) return true;
  const { characterName, character, guide, snapshot } = linked;
  const evaluation = evaluateBuild(snapshot, guide);
  const files = await artifactCardFile(character, snapshot, guide, characterName, evaluation);

  if (doctor) {
    await sendPayload(message, {
      content: formatArtifactDoctor(snapshot, guide, evaluation, lang, text),
      files,
      components: [endRow(message.author.id)],
    });
    return true;
  }

  await sendPayload(message, {
    content: formatArtifactReview(snapshot, guide, lang),
    files,
    components: [endRow(message.author.id)],
  });
  return true;
}

module.exports = {
  handleArtifactReviewMessage,
  handleArtifactInteraction,
  hasArtifactPickerSession,
  isDoctorHub,
  isArtifactReview,
  isArtifactDoctor,
  isArtifactPicker,
  hasArtifactWord,
};
