'use strict';

const { EmbedBuilder } = require('discord.js');
const { getGuideByText, normalize } = require('./guides');
const { getCharacterNames, getCharacter, getCharacterStats } = require('./dataClient');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const COOLDOWN_MS = 2500;
const cooldowns = new Map();

const INTENTS = [
  { id: 'team', words: ['team', 'teams', 'comp', 'comps', 'تيم', 'فريق', 'تشكيلة', 'تشكيله', 'تركيبة', 'تركيبه'] },
  { id: 'weapon', words: ['weapon', 'weapons', 'sword', 'claymore', 'bow', 'catalyst', 'polearm', 'سلاح', 'اسلحة', 'أسلحة', 'سيف'] },
  { id: 'artifact', words: ['artifact', 'artifacts', 'set', 'ارتفاكت', 'ارتي', 'قطع', 'طقم'] },
  { id: 'stats', words: ['stats', 'stat', 'crit', 'cr', 'cd', 'atk', 'hp', 'er', 'em', 'احصائيات', 'إحصائيات', 'ستات', 'كريت', 'اتاك', 'طاقة', 'طاقه'] },
  { id: 'talent', words: ['talent', 'talents', 'priority', 'موهبة', 'مواهب', 'تالنت', 'اولوية', 'أولوية'] },
  { id: 'build', words: ['build', 'بيلد', 'بناء', 'ابني', 'أبني'] },
  { id: 'info', words: ['info', 'character', 'عنصر', 'سلاحه', 'سلاحها', 'معلومات'] },
];

function detectIntent(text) {
  const n = normalize(text);
  if (/^(help|مساعدة|مساعده|شلون استخدم|كيف استخدم)/u.test(n)) return 'help';
  for (const intent of INTENTS) {
    if (intent.words.some((word) => n.includes(normalize(word)))) return intent.id;
  }
  return 'build';
}

function phoneticSkeleton(input) {
  let value = String(input || '').toLowerCase();
  const arabicMap = {
    ا: 'a', أ: 'a', إ: 'a', آ: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh',
    د: 'd', ذ: 'dh', ر: 'r', ز: 'z', س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'z',
    ع: '', غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', ة: 'h', و: 'w', ي: 'y', ى: 'a', ء: '', ئ: 'y', ؤ: 'w',
  };
  value = [...value].map((ch) => arabicMap[ch] ?? ch).join('');
  value = value.replace(/sh/g, 's').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/th|dh/g, 't');
  value = value.replace(/[^a-z0-9]/g, '');
  value = value.replace(/[aeiouywh]/g, '');
  value = value.replace(/(.)\1+/g, '$1');
  return value;
}

function levenshtein(a, b) {
  const rows = b.length + 1;
  const cols = a.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
}

function extractLatinCandidate(text, names) {
  const lower = String(text || '').toLowerCase();
  const sorted = [...names].sort((a, b) => b.length - a.length);
  return sorted.find((name) => lower.includes(name.toLowerCase())) || null;
}

function extractArabicTokens(text) {
  return String(text || '').match(/[\u0600-\u06FF]{3,}(?:\s+[\u0600-\u06FF]{3,})?/g) || [];
}

async function resolveCharacter(text) {
  const curated = getGuideByText(text);
  if (curated) return { name: curated.name, guide: curated, source: 'curated' };

  let names = [];
  try {
    names = await getCharacterNames();
  } catch (error) {
    console.warn('[genshin] Could not fetch character names:', error.message);
  }

  const direct = extractLatinCandidate(text, names);
  if (direct) return { name: direct, guide: getGuideByText(direct), source: 'game-data' };

  const arabicTokens = extractArabicTokens(text);
  let best = null;
  for (const token of arabicTokens) {
    const tokenSkeleton = phoneticSkeleton(token);
    if (tokenSkeleton.length < 2) continue;
    for (const name of names) {
      const nameSkeleton = phoneticSkeleton(name);
      if (nameSkeleton.length < 2) continue;
      const distance = levenshtein(tokenSkeleton, nameSkeleton);
      const maxLen = Math.max(tokenSkeleton.length, nameSkeleton.length);
      const score = 1 - (distance / maxLen);
      if (score >= 0.58 && (!best || score > best.score)) best = { name, score };
    }
  }

  if (best) return { name: best.name, guide: getGuideByText(best.name), source: 'phonetic' };
  return null;
}

function sourceLines(guide) {
  if (!guide?.sources?.length) return 'لا يوجد مصدر توصيات موثّق مضاف لهذه الشخصية حاليًا.';
  return guide.sources.map((source) => `[${source.name}](${source.url})`).join(' • ');
}

function statusLabel(guide) {
  if (!guide) return '⚪ بيانات لعبة فقط';
  return guide.status === 'verified' ? '🟢 موثّق من مصدر Theorycrafting' : '🟡 مبدئي — يحتاج تحديث ما بعد الإصدار';
}

function guideEmbed(guide, intent) {
  const embed = new EmbedBuilder()
    .setColor(guide.status === 'verified' ? 0x4caf50 : 0xe0a800)
    .setTitle(`${guide.name} — ${intent.toUpperCase()}`)
    .setDescription(`${statusLabel(guide)}\n${guide.role || ''}`)
    .setFooter({ text: 'Neverless Genshin • Source-backed only — no guessed values' });

  if (intent === 'team') {
    embed.addFields({ name: 'فرق منشورة', value: guide.teams?.map((v) => `• ${v}`).join('\n').slice(0, 1024) || 'لا توجد فرق موثقة بعد.' });
  } else if (intent === 'weapon') {
    embed.addFields({ name: 'الأسلحة', value: guide.weapons?.map((v) => `• ${v}`).join('\n').slice(0, 1024) || 'لا يوجد ترتيب موثّق مضاف بعد.' });
  } else if (intent === 'artifact') {
    embed.addFields(
      { name: 'Main Stats', value: guide.stats?.main?.map((v) => `• ${v}`).join('\n') || 'غير متوفر' },
      { name: 'Artifact Sets', value: guide.artifacts?.map((v) => `• ${v}`).join('\n').slice(0, 1024) || 'غير متوفر' },
    );
  } else if (intent === 'stats') {
    embed.addFields(
      { name: 'Main Stats', value: guide.stats?.main?.map((v) => `• ${v}`).join('\n') || 'غير متوفر' },
      { name: 'الأولوية', value: guide.stats?.priority || 'غير متوفر' },
      { name: 'Targets / ER', value: guide.stats?.targets?.map((v) => `• ${v}`).join('\n').slice(0, 1024) || 'لا توجد أرقام موثقة مضافة.' },
    );
    if (guide.stats?.note) embed.addFields({ name: 'ملاحظة', value: guide.stats.note.slice(0, 1024) });
  } else if (intent === 'talent') {
    embed.addFields({ name: 'Talent Priority', value: guide.talentPriority || 'غير متوفر' });
  } else {
    embed.addFields(
      { name: 'Stats', value: `${guide.stats?.priority || 'غير متوفر'}\n${guide.stats?.main?.join(' • ') || ''}`.slice(0, 1024) },
      { name: 'Weapons', value: guide.weapons?.slice(0, 3).map((v) => `• ${v}`).join('\n').slice(0, 1024) || 'غير متوفر' },
      { name: 'Teams', value: guide.teams?.slice(0, 4).map((v) => `• ${v}`).join('\n').slice(0, 1024) || 'غير متوفر' },
    );
  }

  embed.addFields({ name: 'المصدر', value: sourceLines(guide).slice(0, 1024) });
  if (guide.statusNote) embed.addFields({ name: 'حالة البيانات', value: guide.statusNote.slice(0, 1024) });
  return embed;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 1 }) : null;
}

async function gameDataEmbed(name, intent) {
  const character = await getCharacter(name).catch(() => null);
  if (!character) return null;

  const embed = new EmbedBuilder()
    .setColor(0x6f83d6)
    .setTitle(`${character.name || name} — بيانات اللعبة`)
    .setFooter({ text: 'Data: genshin-db API • factual game data, not build advice' });

  const element = character.elementText || character.element || character.elementtype || 'Unknown';
  const weapon = character.weaponText || character.weapontype || character.weaponType || 'Unknown';
  embed.setDescription(`${character.rarity ? '★'.repeat(Math.min(5, Number(character.rarity))) : ''} ${element} • ${weapon}`);

  if (intent === 'stats' || intent === 'info') {
    const stats = await getCharacterStats(character.name || name, '90').catch(() => null);
    const fields = [];
    if (stats) {
      const hp = number(stats.hp || stats.basehp);
      const atk = number(stats.attack || stats.atk || stats.baseatk);
      const def = number(stats.defense || stats.def || stats.basedef);
      if (hp) fields.push(`Base HP: ${hp}`);
      if (atk) fields.push(`Base ATK: ${atk}`);
      if (def) fields.push(`Base DEF: ${def}`);
    }
    if (fields.length) embed.addFields({ name: 'Level 90 Base Stats', value: fields.join('\n') });
  }

  if (character.description) embed.addFields({ name: 'الوصف', value: String(character.description).slice(0, 1024) });
  embed.addFields({ name: 'تنبيه', value: 'هذه Base/Game Stats وليست أهداف Build. أرقام البيلد لا تُعرض إلا عندما تكون موجودة في مصدر Theorycrafting موثّق.' });
  return embed;
}

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(0x6f83d6)
    .setTitle('Neverless Genshin')
    .setDescription('اسأل بشكل طبيعي داخل هذا الروم فقط. البوت لا يستخدم AI مدفوع ولا يخمّن بيانات غير موجودة.')
    .addFields(
      { name: 'أمثلة', value: '• احتاج تيم لأوديت\n• شنو ستات ساندروني؟\n• افضل سلاح لياي ميكو\n• ارتفاكت Furina\n• معلومات عن Hu Tao' },
      { name: 'مصادر البيانات', value: 'بيانات اللعبة: genshin-db API\nالتوصيات: بيانات منظمة من KQM / مصادر Theorycrafting محددة، مع رابط المصدر وحالة التحديث.' },
      { name: 'قاعدة الأمان', value: 'إذا المصدر غير موجود أو قديم، البوت يقول ذلك صراحة بدل اختراع Team أو أرقام.' },
    );
}

async function handleGenshinMessage(message) {
  if (!message?.guildId || message.author?.bot) return false;
  if (message.channelId !== CHANNEL_ID) return false;

  const text = String(message.content || '').trim();
  if (!text) return false;
  if (text.length > 600) {
    await message.reply('السؤال طويل جدًا. اختصره إلى أقل من 600 حرف.');
    return true;
  }

  const now = Date.now();
  const last = cooldowns.get(message.author.id) || 0;
  if (now - last < COOLDOWN_MS) return true;
  cooldowns.set(message.author.id, now);
  setTimeout(() => cooldowns.delete(message.author.id), COOLDOWN_MS + 1000).unref?.();

  const intent = detectIntent(text);
  if (intent === 'help') {
    await message.reply({ embeds: [helpEmbed()] });
    return true;
  }

  await message.channel.sendTyping().catch(() => {});
  const resolved = await resolveCharacter(text);
  if (!resolved) {
    await message.reply('ما قدرت أحدد الشخصية بثقة. اكتب اسم الشخصية الرسمي بالإنجليزي داخل السؤال، مثال: `Odette` أو `Yae Miko`.');
    return true;
  }

  if (['team', 'weapon', 'artifact', 'build', 'talent'].includes(intent)) {
    if (!resolved.guide) {
      await message.reply(`عرفت الشخصية: **${resolved.name}**، لكن ما عندي لها توصية Build موثقة ومنظمة في قاعدة Neverless حاليًا. ما راح أركب لك Team أو أرقام من عندي. أقدر فقط أعرض بيانات اللعبة الأساسية إلى أن نضيف مصدر Theorycrafting موثوق.`);
      return true;
    }
    await message.reply({ embeds: [guideEmbed(resolved.guide, intent)] });
    return true;
  }

  if (intent === 'stats' && resolved.guide) {
    await message.reply({ embeds: [guideEmbed(resolved.guide, 'stats')] });
    return true;
  }

  const factual = await gameDataEmbed(resolved.name, intent);
  if (factual) {
    await message.reply({ embeds: [factual] });
    return true;
  }

  if (resolved.guide) {
    await message.reply({ embeds: [guideEmbed(resolved.guide, 'build')] });
    return true;
  }

  await message.reply(`لقيت اسم **${resolved.name}** لكن مصدر بيانات اللعبة الخارجي ما رجّع تفاصيل لها حاليًا. ما راح أخمّن.`);
  return true;
}

module.exports = { CHANNEL_ID, handleGenshinMessage, resolveCharacter, detectIntent, phoneticSkeleton };
