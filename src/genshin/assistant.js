'use strict';

const { getGuideByText } = require('./guides');
const { getGuide } = require('./guideClient');
const { getCharacterNames, getCharacter, getCharacterStats } = require('./dataClient');
const { getLinkedUid, linkUid, unlinkUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot, listCharacters, accountSummary } = require('./enkaClient');
const {
  formatGuideAnswer,
  formatTeams,
  formatBaseData,
  formatAccountAnalysis,
  describeOpinion,
  normalizeTeams,
} = require('./responses');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const COOLDOWN_MS = 1800;
const cooldowns = new Map();
const sessions = new Map();

function sessionKey(message) {
  return `${message.guildId}:${message.author.id}`;
}

function getSession(message) {
  const key = sessionKey(message);
  const existing = sessions.get(key);
  if (existing && Date.now() - existing.updatedAt < 30 * 60 * 1000) return existing;
  const fresh = { updatedAt: Date.now(), character: null, teams: [], excluded: [], language: 'ar' };
  sessions.set(key, fresh);
  return fresh;
}

function saveSession(message, patch) {
  const next = { ...getSession(message), ...patch, updatedAt: Date.now() };
  sessions.set(sessionKey(message), next);
  return next;
}

function detectLanguage(text) {
  const ar = (String(text || '').match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (String(text || '').match(/[A-Za-z]/g) || []).length;
  return ar > 0 && ar >= latin * 0.35 ? 'ar' : 'en';
}

function phoneticSkeleton(input) {
  let value = String(input || '').toLowerCase();
  const arabicMap = {
    ا: 'a', أ: 'a', إ: 'a', آ: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh',
    د: 'd', ذ: 'dh', ر: 'r', ز: 'z', س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z',
    ع: '', غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', ة: 'h', و: 'w', ي: 'y', ى: 'a', ء: '', ئ: 'y', ؤ: 'w',
  };
  value = [...value].map((ch) => arabicMap[ch] ?? ch).join('');
  return value
    .replace(/sh/g, 's').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/th|dh/g, 't')
    .replace(/[^a-z0-9]/g, '').replace(/[aeiouywh]/g, '').replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, () => Array(a.length + 1).fill(0));
  for (let i = 0; i <= b.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= a.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i += 1) {
    for (let j = 1; j <= a.length; j += 1) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
}

async function resolveCharacter(text) {
  const curated = getGuideByText(text);
  if (curated) return curated.name;

  let names = [];
  try { names = await getCharacterNames(); } catch { return null; }

  const lower = String(text || '').toLowerCase();
  const direct = [...names].sort((a, b) => b.length - a.length).find((name) => lower.includes(name.toLowerCase()));
  if (direct) return direct;

  const tokens = String(text || '').match(/[\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,})?/g) || [];
  let best = null;
  for (const token of tokens) {
    const left = phoneticSkeleton(token);
    if (left.length < 2) continue;
    for (const name of names) {
      const right = phoneticSkeleton(name);
      if (right.length < 2) continue;
      const score = 1 - levenshtein(left, right) / Math.max(left.length, right.length);
      if (score >= 0.62 && (!best || score > best.score)) best = { name, score };
    }
  }
  return best?.name || null;
}

async function extractMentionedCharacters(text) {
  let names = [];
  try { names = await getCharacterNames(); } catch { return []; }

  const lower = String(text || '').toLowerCase();
  const found = [];
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (lower.includes(name.toLowerCase()) && !found.some((x) => x.toLowerCase() === name.toLowerCase())) found.push(name);
  }

  const tokens = String(text || '').match(/[\u0600-\u06FF]{3,}/g) || [];
  for (const token of tokens) {
    const left = phoneticSkeleton(token);
    if (left.length < 3) continue;
    let best = null;
    for (const name of names) {
      const right = phoneticSkeleton(name);
      const score = 1 - levenshtein(left, right) / Math.max(left.length, right.length);
      if (score >= 0.72 && (!best || score > best.score)) best = { name, score };
    }
    if (best && !found.some((x) => x.toLowerCase() === best.name.toLowerCase())) found.push(best.name);
  }
  return found;
}

function detectIntent(text) {
  if (/\b(?:unlink|remove uid)\b/i.test(text) || /فك الربط|الغاء الربط|إلغاء الربط/u.test(text)) return 'unlink';
  if ((/\b(?:link|connect)\b/i.test(text) && /\buid\b/i.test(text)) || /ربط\s*(?:ال)?uid|اربط\s*(?:ال)?uid/u.test(text)) return 'link';
  if (/شخصياتي|شخصيات حسابي|my characters|my showcase/i.test(text)) return 'characters';
  if (/base\s*stats?|بيانات\s|بيانات$|الاحصائيات الاساسية|الإحصائيات الأساسية/u.test(text)) return 'base';
  if (/\bteam\b|\bteams\b|\bcomp\b|تيم|فريق|تشكيل|تركيب/u.test(text)) return 'team';
  if (/بحسابي|من حسابي|my account|analy[sz]e|حلل|قيّم|قيم/u.test(text)) return 'accountBuild';
  if (/ما عندي|ما املك|ما أملك|بدون|dont have|don't have|without/i.test(text)) return 'followupMissing';
  if (/عندي|املك|أملك|i have/i.test(text)) return 'followupOwned';
  if (/رأيك|رايك|what do you think|is .* good/i.test(text)) return 'opinion';
  if (/بيلد|\bbuild\b/i.test(text)) return 'build';
  if (/ارتيفاكت|ارتيفكت|ارتي|artifact|artifacts|طقم/i.test(text)) return 'artifacts';
  if (/weapon|weapons|سلاح|اسلحة|أسلحة/i.test(text)) return 'weapons';
  if (/\bstats?\b|ستات|احصائيات|إحصائيات|crit|كريت|\ber\b|energy recharge|\bem\b|elemental mastery|\batk\b|attack|\bhp\b/i.test(text)) return 'stats';
  if (/مساعدة|مساعده|help/i.test(text)) return 'help';
  return 'unknown';
}

async function replyPlain(message, text) {
  const parts = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    if ((current + '\n' + line).length > 1850) {
      if (current) parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  if (!parts.length) return;

  await message.reply({ content: parts[0], allowedMentions: { repliedUser: true } });
  for (const part of parts.slice(1)) await message.channel.send({ content: part });
}

async function linkedAccount(message, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await replyPlain(message, lang === 'ar'
      ? 'ما ربطت UID بعد. اكتب داخل هذا الروم: `ربط UID 7xxxxxxxx`'
      : 'No UID is linked yet. In this channel, type: `link UID 7xxxxxxxx`');
    return null;
  }

  try {
    return await fetchAccount(uid);
  } catch (error) {
    console.error('[genshin] Enka fetch failed:', error.message);
    await replyPlain(message, lang === 'ar'
      ? 'ما قدرت أوصل لبيانات Enka الآن. تأكد من الـUID وأن الـCharacter Showcase ظاهر ثم جرّب مرة ثانية.'
      : 'I could not reach Enka data right now. Check the UID and make sure the Character Showcase is visible, then try again.');
    return null;
  }
}

async function handleLink(message, lang, text) {
  const uid = text.match(/\b\d{9,10}\b/)?.[0];
  if (!uid) {
    await replyPlain(message, lang === 'ar' ? 'اكتبها بهذا الشكل: `ربط UID 712345678`' : 'Use: `link UID 712345678`');
    return;
  }

  try {
    const account = await fetchAccount(uid);
    const summary = accountSummary(account);
    await linkUid(message.author.id, uid);
    await replyPlain(message, lang === 'ar'
      ? `تم ربط **${summary.nickname || uid}** (AR ${summary.adventureRank ?? '?'}) بالـUID **${uid}**.\nEnka شايف حاليًا **${summary.characters.length}** شخصية من الـCharacter Showcase.${summary.showCharacterDetails ? '' : '\nفعّل Show Character Details داخل اللعبة عشان أقدر أقرأ البيلد.'}\nجرّب: \`شخصياتي\` أو \`حلل Skirk بحسابي\`.`
      : `Linked **${summary.nickname || uid}** (AR ${summary.adventureRank ?? '?'}) to UID **${uid}**.\nEnka currently sees **${summary.characters.length}** Character Showcase entries.${summary.showCharacterDetails ? '' : '\nEnable Show Character Details in-game so I can read builds.'}\nTry: \`my characters\` or \`analyze Skirk on my account\`.`);
  } catch (error) {
    console.error('[genshin] UID link failed:', error.message);
    await replyPlain(message, lang === 'ar'
      ? 'ما قدرت أقرأ هذا الـUID. تأكد من الرقم، وخلي الـCharacter Showcase ظاهر في بروفايل Genshin.'
      : 'I could not read that UID. Check the number and make your Genshin Character Showcase visible.');
  }
}

async function handleGenshinMessage(message) {
  if (!message?.guildId || message.author?.bot || message.channelId !== CHANNEL_ID) return false;
  const text = String(message.content || '').trim();
  if (!text) return false;
  const lang = detectLanguage(text);

  const now = Date.now();
  const last = cooldowns.get(message.author.id) || 0;
  if (now - last < COOLDOWN_MS) return true;
  cooldowns.set(message.author.id, now);
  setTimeout(() => cooldowns.delete(message.author.id), COOLDOWN_MS + 500).unref?.();

  const intent = detectIntent(text);

  if (intent === 'help') {
    await replyPlain(message, lang === 'ar'
      ? '**Neverless Genshin**\n`بيلد Skirk` = البيلد كامل\n`ارتيفاكت Skirk` = الآرتيفاكت وتقسيم القطع\n`سلاح Skirk` = الأسلحة فقط\n`إحصائيات Skirk` = الستات المطلوبة\n`بيانات Skirk` أو `Skirk base stats` = Base Stats\n`تيم Skirk` = التيمات المنشورة\n`ربط UID 7xxxxxxxx` = ربط حسابك\n`حلل Skirk بحسابي` = تحليل بيلدك الفعلي'
      : '**Neverless Genshin**\n`Skirk build` = full build\n`Skirk artifacts` = artifacts + main stats\n`Skirk weapon` = weapons only\n`Skirk stats` = recommended target stats\n`Skirk base stats` = base game stats\n`Skirk team` = published teams\n`link UID 7xxxxxxxx` = link your account\n`analyze Skirk on my account` = analyze your real build');
    return true;
  }

  if (intent === 'unlink') {
    await unlinkUid(message.author.id);
    await replyPlain(message, lang === 'ar' ? 'تم فك ربط الـUID.' : 'UID unlinked.');
    return true;
  }

  if (intent === 'link') {
    await handleLink(message, lang, text);
    return true;
  }

  if (intent === 'characters') {
    const account = await linkedAccount(message, lang);
    if (!account) return true;
    const chars = listCharacters(account);
    const content = chars.length
      ? chars.map((item) => `${item.name} Lv.${item.level} C${item.constellation}`).join(' • ')
      : (lang === 'ar' ? 'ما في شخصيات بتفاصيلها ظاهرة لـEnka حاليًا.' : 'No detailed Showcase characters are visible to Enka right now.');
    await replyPlain(message, `${lang === 'ar' ? '**الشخصيات الظاهرة عند Enka:**' : '**Characters visible to Enka:**'}\n${content}`);
    return true;
  }

  const session = getSession(message);

  if (intent === 'followupMissing' && session.character && session.teams.length) {
    const mentioned = await extractMentionedCharacters(text);
    const excluded = [...new Set([...(session.excluded || []), ...mentioned])];
    const guide = await getGuide(session.character);
    saveSession(message, { excluded, language: lang });
    if (guide) await replyPlain(message, formatTeams(guide, lang, [], excluded));
    return true;
  }

  if (intent === 'followupOwned' && session.character && session.teams.length) {
    const owned = await extractMentionedCharacters(text);
    const guide = await getGuide(session.character);
    if (guide) await replyPlain(message, formatTeams(guide, lang, owned, session.excluded || []));
    return true;
  }

  const characterName = await resolveCharacter(text) || session.character;
  if (!characterName) {
    await replyPlain(message, lang === 'ar'
      ? 'حدد اسم الشخصية في السؤال، مثال: `بيلد Skirk` أو `تيم Escoffier`.'
      : 'Include the character name, for example: `Skirk build` or `Escoffier team`.');
    return true;
  }
  saveSession(message, { character: characterName, language: lang });

  if (intent === 'base') {
    const [character, stats] = await Promise.all([
      getCharacter(characterName).catch(() => null),
      getCharacterStats(characterName, '90').catch(() => null),
    ]);
    if (!character) await replyPlain(message, lang === 'ar' ? `ما لقيت بيانات اللعبة لـ **${characterName}**.` : `No game data found for **${characterName}**.`);
    else await replyPlain(message, formatBaseData(character, stats, lang));
    return true;
  }

  if (intent === 'team') {
    const guide = await getGuide(characterName);
    if (!guide) {
      await replyPlain(message, lang === 'ar' ? `ما قدرت أستخرج تيمات موثوقة لـ **${characterName}** حاليًا.` : `I couldn't retrieve reliable teams for **${characterName}** right now.`);
      return true;
    }

    let owned = [];
    let excluded = [];
    if (/من حسابي|بحسابي|my account/i.test(text)) {
      const account = await linkedAccount(message, lang);
      if (!account) return true;
      owned = listCharacters(account).map((item) => item.name);
    } else {
      const mentioned = await extractMentionedCharacters(text);
      const others = mentioned.filter((name) => name.toLowerCase() !== characterName.toLowerCase());
      if (/بدون|ما عندي|ما املك|ما أملك|without|don't have|dont have/i.test(text)) excluded = others;
      else if (others.length) owned = [characterName, ...others];
    }

    const teams = normalizeTeams(guide.teams);
    saveSession(message, { character: characterName, teams, excluded, language: lang });
    await replyPlain(message, formatTeams(guide, lang, owned, excluded));
    return true;
  }

  if (intent === 'accountBuild') {
    const account = await linkedAccount(message, lang);
    if (!account) return true;
    const character = findCharacter(account, characterName);
    if (!character) {
      await replyPlain(message, lang === 'ar'
        ? `**${characterName}** مو ظاهرة عند Enka. حطها في Character Showcase داخل Genshin وفعّل **Show Character Details**، وبعدها أرسل نفس السؤال.`
        : `**${characterName}** is not visible to Enka. Put them in your Genshin Character Showcase and enable **Show Character Details**, then ask again.`);
      return true;
    }

    const guide = await getGuide(characterName);
    if (!guide) {
      await replyPlain(message, lang === 'ar'
        ? `أقدر أقرأ بيلد **${characterName}** من حسابك، لكن ما عندي Guide موثوق أقارنه فيه حاليًا.`
        : `I can read your **${characterName}** build, but I do not currently have a reliable guide to compare it against.`);
      return true;
    }
    await replyPlain(message, formatAccountAnalysis(getBuildSnapshot(character), guide, lang));
    return true;
  }

  const guide = await getGuide(characterName);
  if (!guide) {
    await replyPlain(message, lang === 'ar'
      ? `ما قدرت أستخرج Guide موثوق لـ **${characterName}** حاليًا. ما راح أحول سؤالك إلى Base Stats ولا أخمّن.`
      : `I couldn't retrieve a reliable guide for **${characterName}** right now. I won't replace your request with base stats or guess.`);
    return true;
  }

  if (intent === 'opinion') {
    await replyPlain(message, describeOpinion(guide, lang));
    return true;
  }

  const guideIntent = ['artifacts', 'weapons', 'stats', 'build'].includes(intent) ? intent : 'build';
  await replyPlain(message, formatGuideAnswer(guide, lang, guideIntent, text));
  return true;
}

module.exports = {
  CHANNEL_ID,
  handleGenshinMessage,
  resolveCharacter,
  detectIntent,
  detectLanguage,
};
