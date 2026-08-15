'use strict';

const { getGuideByText, normalize } = require('./guides');
const { getGuide } = require('./guideClient');
const { getCharacterNames, getCharacter, getCharacterStats } = require('./dataClient');
const { getLinkedUid, linkUid, unlinkUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot, listCharacters, accountSummary } = require('./enkaClient');

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
  const current = getSession(message);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  sessions.set(sessionKey(message), next);
  return next;
}

function detectLanguage(text) {
  const ar = (String(text || '').match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (String(text || '').match(/[A-Za-z]/g) || []).length;
  return ar >= latin * 0.35 && ar > 0 ? 'ar' : 'en';
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

  const arabicTokens = String(text || '').match(/[\u0600-\u06FF]{3,}/g) || [];
  for (const token of arabicTokens) {
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
  if (/بيلد|\bbuild\b|\bstats?\b|ارتيفاكت|ارتيفكت|artifact|weapon|سلاح|ستات|احصائيات|إحصائيات|crit|كريت|goblet|sands|circlet/i.test(text)) return 'build';
  if (/مساعدة|مساعده|help/i.test(text)) return 'help';
  return 'unknown';
}

function cleanRecommendation(value) {
  return String(value || '').split(/\s+[—–-]\s+/)[0].replace(/^\d+pc\s+/i, '').trim();
}

function expandTeamString(value) {
  const cleaned = String(value || '')
    .replace(/^Limited roster:\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  const slots = cleaned.split(/\s+[—–]\s+/).map((slot) => slot.trim()).filter(Boolean);
  let teams = [[]];
  for (const slot of slots) {
    const options = slot.split(/\s*\/\s*/).map((x) => x.replace(/^C\d+\s+/i, '').trim()).filter(Boolean);
    teams = teams.flatMap((team) => options.slice(0, 5).map((option) => [...team, option])).slice(0, 20);
  }
  return teams.filter((team) => team.length >= 3 && team.length <= 4).map((team) => team.slice(0, 4));
}

function normalizeTeams(teams) {
  const result = [];
  for (const team of teams || []) {
    const expanded = Array.isArray(team) ? [team] : expandTeamString(team);
    for (const members of expanded) {
      const clean = members.map((x) => String(x).trim()).filter(Boolean);
      if (clean.length !== 4) continue;
      const key = clean.join('|').toLowerCase();
      if (!result.some((x) => x.join('|').toLowerCase() === key)) result.push(clean);
    }
  }
  return result;
}

function rankTeams(teams, owned = [], excluded = []) {
  const ownedSet = new Set(owned.map((x) => x.toLowerCase()));
  const excludedSet = new Set(excluded.map((x) => x.toLowerCase()));
  return teams
    .filter((team) => !team.some((member) => excludedSet.has(member.toLowerCase())))
    .map((team, index) => ({
      team,
      index,
      ownedCount: team.filter((member) => ownedSet.has(member.toLowerCase())).length,
      missing: team.filter((member) => ownedSet.size && !ownedSet.has(member.toLowerCase())),
    }))
    .sort((a, b) => (b.ownedCount - a.ownedCount) || (a.missing.length - b.missing.length) || (a.index - b.index));
}

function isArabic(lang) { return lang === 'ar'; }

function formatBuild(guide, lang) {
  const ar = isArabic(lang);
  const lines = [`**${guide.name} — ${ar ? 'البيلد' : 'Build'}**`];
  if (guide.artifacts?.length) {
    lines.push(`**${ar ? 'الآرتيفاكت' : 'Artifacts'}:**`);
    guide.artifacts.slice(0, 3).forEach((item, i) => lines.push(`${i + 1}. ${cleanRecommendation(item)}`));
  }
  if (guide.stats?.main?.length) {
    lines.push(`**${ar ? 'تقسيم القطع' : 'Main Stats'}:**`);
    guide.stats.main.forEach((item) => lines.push(`• ${item}`));
  }
  if (guide.stats?.priority) lines.push(`**${ar ? 'الأولوية بالسب ستات' : 'Substat Priority'}:** ${guide.stats.priority}`);
  if (guide.weapons?.length) {
    lines.push(`**${ar ? 'الأسلحة' : 'Weapons'}:**`);
    guide.weapons.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${cleanRecommendation(item)}`));
  }
  if (guide.stats?.targets?.length) {
    lines.push(`**${ar ? 'أرقام تستهدفها تقريبًا' : 'Recommended Targets'}:**`);
    guide.stats.targets.slice(0, 7).forEach((item) => lines.push(`• ${item}`));
  }
  return lines.join('\n');
}

function formatTeams(guide, lang, owned = [], excluded = []) {
  const ar = isArabic(lang);
  const teams = normalizeTeams(guide.teams);
  const ranked = rankTeams(teams, owned, excluded);
  if (!ranked.length) return ar ? `ما لقيت تيم منشور لـ **${guide.name}** يطابق القيود اللي ذكرتها.` : `I couldn't find a published **${guide.name}** team matching those restrictions.`;
  const lines = [`**${guide.name} — ${ar ? 'التيمات' : 'Teams'}**`];
  ranked.slice(0, 4).forEach((entry, i) => {
    lines.push(`${i + 1}. ${entry.team.join(' • ')}`);
    if (owned.length && entry.missing.length) lines.push(`   ${ar ? 'ينقصك' : 'Missing'}: ${entry.missing.join(', ')}`);
  });
  return lines.join('\n');
}

function formatBaseData(character, stats, lang) {
  const ar = isArabic(lang);
  const name = character?.name || 'Character';
  const element = character?.elementText || character?.element || 'Unknown';
  const weapon = character?.weaponText || character?.weapontype || character?.weaponType || 'Unknown';
  const hp = stats?.hp || stats?.basehp;
  const atk = stats?.attack || stats?.atk || stats?.baseatk;
  const def = stats?.defense || stats?.def || stats?.basedef;
  return [
    `**${name} — ${ar ? 'البيانات الأساسية' : 'Base Stats'}**`,
    `${element} • ${weapon}`,
    hp != null ? `Base HP: ${Number(hp).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null,
    atk != null ? `Base ATK: ${Number(atk).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null,
    def != null ? `Base DEF: ${Number(def).toLocaleString('en-US', { maximumFractionDigits: 1 })}` : null,
  ].filter(Boolean).join('\n');
}

function parseTarget(target) {
  const text = String(target || '').replace(/,/g, '');
  let key = null;
  if (/CRIT Rate/i.test(text)) key = 'critRate';
  else if (/CRIT DMG/i.test(text)) key = 'critDmg';
  else if (/\bATK\b/i.test(text)) key = 'atk';
  else if (/\bHP\b/i.test(text)) key = 'hp';
  else if (/\bER\b|Energy Recharge/i.test(text)) key = 'er';
  else if (/\bEM\b|Elemental Mastery/i.test(text)) key = 'em';
  if (!key) return null;
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  if (!nums.length) return null;
  return { key, min: nums[0], max: nums[1] ?? nums[0], text: target };
}

function actualStatText(snapshot) {
  const s = snapshot.stats;
  return `HP ${s.hp ?? '?'} • ATK ${s.atk ?? '?'} • CR ${s.critRate ?? '?'}% • CD ${s.critDmg ?? '?'}% • ER ${s.er ?? '?'}% • EM ${s.em ?? '?'}`;
}

function compareTargets(snapshot, guide, lang) {
  const ar = isArabic(lang);
  const parsed = (guide.stats?.targets || []).map(parseTarget).filter(Boolean);
  const counts = parsed.reduce((acc, item) => ({ ...acc, [item.key]: (acc[item.key] || 0) + 1 }), {});
  const notes = [];
  for (const target of parsed) {
    if (counts[target.key] > 1) continue;
    const value = snapshot.stats[target.key];
    if (typeof value !== 'number') continue;
    const lowThreshold = target.min === target.max ? target.min * 0.93 : target.min;
    if (value < lowThreshold) notes.push(ar ? `${target.key}: عندك ${value} وأقل من الهدف ${target.text.split(':').slice(1).join(':').trim()}` : `${target.key}: ${value} is below ${target.text}`);
    else if ((target.key === 'critRate' || target.key === 'er') && target.max > target.min && value > target.max * 1.08) notes.push(ar ? `${target.key}: عندك ${value}؛ أعلى من الرينج المعتاد، وقد تقدر تحول جزء منه لستات هجومية.` : `${target.key}: ${value} is above the usual range; some rolls may be movable into offensive stats.`);
  }
  return notes.slice(0, 4);
}

function formatAccountAnalysis(snapshot, guide, lang) {
  const ar = isArabic(lang);
  const lines = [`**${snapshot.name} — ${ar ? 'تحليل بيلدك' : 'Your Build'}**`];
  lines.push(`${ar ? 'لفل' : 'Level'} ${snapshot.level} • C${snapshot.constellation}`);
  lines.push(`**${ar ? 'الستات الحالية' : 'Current Stats'}:** ${actualStatText(snapshot)}`);

  if (snapshot.weapon.name) {
    lines.push(`**${ar ? 'سلاحك' : 'Weapon'}:** ${snapshot.weapon.name}${snapshot.weapon.refinement ? ` R${snapshot.weapon.refinement}` : ''}`);
    if (guide.weapons?.length) lines.push(`${ar ? 'المقترح' : 'Recommended'}: ${guide.weapons.slice(0, 3).map(cleanRecommendation).join(' / ')}`);
  }

  const sets = Object.entries(snapshot.setCounts).sort((a, b) => b[1] - a[1]);
  if (sets.length) lines.push(`**${ar ? 'الآرتيفاكت الحالي' : 'Current Artifacts'}:** ${sets.map(([name, count]) => `${count}pc ${name}`).join(' + ')}`);
  if (guide.artifacts?.length) lines.push(`${ar ? 'المقترح' : 'Recommended'}: ${guide.artifacts.slice(0, 2).map(cleanRecommendation).join(' / ')}`);

  const slots = ['sands', 'goblet', 'circlet'];
  const actualMain = slots.map((slot) => snapshot.artifacts.find((item) => item.slot === slot)).filter(Boolean);
  if (actualMain.length) lines.push(`**Main Stats:** ${actualMain.map((item) => `${item.slot}: ${item.mainStat} ${item.mainValue}`).join(' • ')}`);
  if (guide.stats?.main?.length) lines.push(`${ar ? 'المطلوب غالبًا' : 'Usually Aim For'}: ${guide.stats.main.join(' • ')}`);

  const notes = compareTargets(snapshot, guide, lang);
  if (notes.length) {
    lines.push(`**${ar ? 'أهم الملاحظات' : 'Main Notes'}:**`);
    notes.forEach((note) => lines.push(`• ${note}`));
  } else {
    lines.push(ar ? 'أرقامك الأساسية ما فيها نقص واضح مقارنة بالرينجات المنشورة؛ بعدها يصير الحكم الأدق على القطع والروتيشن والتيم.' : 'Your core stats show no obvious shortfall against the published ranges; the next gains depend more on artifacts, rotation, and team context.');
  }
  return lines.join('\n');
}

async function replyPlain(message, text) {
  const parts = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    if ((current + '\n' + line).length > 1850) {
      if (current) parts.push(current);
      current = line;
    } else current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  if (!parts.length) return;
  await message.reply({ content: parts[0], allowedMentions: { repliedUser: true } });
  for (const part of parts.slice(1)) await message.channel.send({ content: part });
}

async function linkedAccount(message, lang) {
  const uid = getLinkedUid(message.author.id);
  if (!uid) {
    await replyPlain(message, isArabic(lang) ? 'ما ربطت UID بعد. اكتب داخل هذا الروم: `ربط UID 7xxxxxxxx`' : 'No UID is linked yet. In this channel, type: `link UID 7xxxxxxxx`');
    return null;
  }
  try { return await fetchAccount(uid); }
  catch (error) {
    console.error('[genshin] Enka fetch failed:', error.message);
    await replyPlain(message, isArabic(lang) ? 'ما قدرت أوصل لبيانات Enka الآن. تأكد من الـUID وأن الـShowcase عام ثم جرّب بعد شوي.' : 'I could not reach Enka data right now. Check the UID and public Showcase, then try again shortly.');
    return null;
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
    await replyPlain(message, isArabic(lang)
      ? '**Neverless Genshin**\n`بيلد Skirk` = آرتيفاكت + أسلحة + Main Stats + Targets\n`تيم Skirk` = التيمات المنشورة\n`بيانات Skirk` = Base Stats فقط\n`ربط UID 7xxxxxxxx` = ربط الـShowcase\n`شخصياتي` = الشخصيات الظاهرة في Showcase\n`حلل Skirk بحسابي` = تحليل بيلد Skirk الفعلي'
      : '**Neverless Genshin**\n`Skirk build` = artifacts + weapons + main stats + targets\n`Skirk team` = published teams\n`Skirk base stats` = base stats only\n`link UID 7xxxxxxxx` = link Showcase\n`my characters` = visible Showcase characters\n`analyze Skirk on my account` = analyze your actual build');
    return true;
  }

  if (intent === 'unlink') {
    await unlinkUid(message.author.id);
    await replyPlain(message, isArabic(lang) ? 'تم فك ربط الـUID.' : 'UID unlinked.');
    return true;
  }

  if (intent === 'link') {
    const uid = text.match(/\b\d{9,10}\b/)?.[0];
    if (!uid) {
      await replyPlain(message, isArabic(lang) ? 'اكتبها بهذا الشكل: `ربط UID 712345678`' : 'Use: `link UID 712345678`');
      return true;
    }
    try {
      const account = await fetchAccount(uid);
      const summary = accountSummary(account);
      await linkUid(message.author.id, uid);
      const visible = summary.characters.length;
      await replyPlain(message, isArabic(lang)
        ? `تم ربط **${summary.nickname || uid}** (AR ${summary.adventureRank ?? '?'}) بالـUID **${uid}**.\nEnka شايف حاليًا **${visible}** شخصية في Character Showcase.${summary.showCharacterDetails ? '' : '\nفعّل Show Character Details وحط الشخصيات اللي تبي أحللها في الـShowcase.'}\nجرّب الآن: \`شخصياتي\` أو \`حلل Skirk بحسابي\``
        : `Linked **${summary.nickname || uid}** (AR ${summary.adventureRank ?? '?'}) to UID **${uid}**.\nEnka currently sees **${visible}** Showcase characters.${summary.showCharacterDetails ? '' : '\nEnable Show Character Details and add the characters you want analyzed.'}\nTry: \`my characters\` or \`analyze Skirk on my account\``);
    } catch (error) {
      console.error('[genshin] UID link failed:', error.message);
      await replyPlain(message, isArabic(lang) ? 'ما قدرت أقرأ هذا الـUID. تأكد من الرقم ومن أن حسابك وCharacter Showcase ظاهرين.' : 'I could not read that UID. Check the number and make sure the Character Showcase is visible.');
    }
    return true;
  }

  if (intent === 'characters') {
    const account = await linkedAccount(message, lang);
    if (!account) return true;
    const chars = listCharacters(account);
    const content = chars.length
      ? chars.map((item) => `${item.name} Lv.${item.level} C${item.constellation}`).join(' • ')
      : (isArabic(lang) ? 'ما في شخصيات مفصلة ظاهرة في الـShowcase.' : 'No detailed characters are visible in the Showcase.');
    await replyPlain(message, `${isArabic(lang) ? '**الشخصيات الظاهرة عند Enka:**' : '**Characters visible to Enka:**'}\n${content}`);
    return true;
  }

  const session = getSession(message);
  if (intent === 'followupMissing' && session.character && session.teams.length) {
    const mentioned = await extractMentionedCharacters(text);
    const excluded = [...new Set([...(session.excluded || []), ...mentioned])];
    saveSession(message, { excluded, language: lang });
    const guide = await getGuide(session.character);
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
    await replyPlain(message, isArabic(lang) ? 'حدد اسم الشخصية في سؤالك، مثال: `بيلد Skirk` أو `تيم Escoffier`.' : 'Include the character name, for example: `Skirk build` or `Escoffier team`.');
    return true;
  }
  saveSession(message, { character: characterName, language: lang });

  if (intent === 'base') {
    const [character, stats] = await Promise.all([
      getCharacter(characterName).catch(() => null),
      getCharacterStats(characterName, '90').catch(() => null),
    ]);
    if (!character) await replyPlain(message, isArabic(lang) ? `ما لقيت بيانات اللعبة لـ **${characterName}**.` : `No game data found for **${characterName}**.`);
    else await replyPlain(message, formatBaseData(character, stats, lang));
    return true;
  }

  if (intent === 'team') {
    const guide = await getGuide(characterName);
    if (!guide) {
      await replyPlain(message, isArabic(lang) ? `ما قدرت أستخرج تيمات موثوقة لـ **${characterName}** حاليًا.` : `I couldn't retrieve reliable teams for **${characterName}** right now.`);
      return true;
    }
    let owned = [];
    if (/من حسابي|بحسابي|my account/i.test(text)) {
      const account = await linkedAccount(message, lang);
      if (!account) return true;
      owned = listCharacters(account).map((item) => item.name);
    } else {
      const mentioned = await extractMentionedCharacters(text);
      owned = mentioned.filter((name) => name.toLowerCase() !== characterName.toLowerCase());
      if (owned.length) owned.unshift(characterName);
    }
    const teams = normalizeTeams(guide.teams);
    saveSession(message, { character: characterName, teams, excluded: [], language: lang });
    await replyPlain(message, formatTeams(guide, lang, owned));
    return true;
  }

  if (intent === 'accountBuild') {
    const account = await linkedAccount(message, lang);
    if (!account) return true;
    const character = findCharacter(account, characterName);
    if (!character) {
      await replyPlain(message, isArabic(lang)
        ? `**${characterName}** مو ظاهرة عند Enka حاليًا. حطها في Character Showcase داخل Genshin وفعّل **Show Character Details**، بعدها اكتب نفس السؤال مرة ثانية.`
        : `**${characterName}** is not visible to Enka. Put them in your Genshin Character Showcase and enable **Show Character Details**, then ask again.`);
      return true;
    }
    const guide = await getGuide(characterName);
    if (!guide) {
      await replyPlain(message, isArabic(lang) ? `أقدر أقرأ بيلد **${characterName}** من حسابك، لكن ما عندي Guide موثوق أقدر أقارن به حاليًا.` : `I can read your **${characterName}** build, but I don't currently have a reliable guide to compare it against.`);
      return true;
    }
    await replyPlain(message, formatAccountAnalysis(getBuildSnapshot(character), guide, lang));
    return true;
  }

  const guide = await getGuide(characterName);
  if (!guide) {
    await replyPlain(message, isArabic(lang) ? `ما قدرت أستخرج Guide موثوق لـ **${characterName}** حاليًا. ما راح أحول الطلب إلى Base Stats ولا أخمّن بيلد.` : `I couldn't retrieve a reliable guide for **${characterName}** right now. I won't replace it with base stats or guess a build.`);
    return true;
  }

  if (intent === 'opinion') {
    await replyPlain(message, isArabic(lang)
      ? `**${characterName}** عندي لها توصيات بيلد وتيم منشورة. إذا تبي جواب عملي قل: \`بيلد ${characterName}\` أو \`تيم ${characterName}\`.`
      : `**${characterName}**${guide.role ? ` — ${guide.role}` : ''}. For a practical answer, ask: \`${characterName} build\` or \`${characterName} team\`.`);
    return true;
  }

  if (intent === 'build' || intent === 'unknown') {
    await replyPlain(message, formatBuild(guide, lang));
    return true;
  }

  return true;
}

module.exports = {
  CHANNEL_ID,
  handleGenshinMessage,
  resolveCharacter,
  detectIntent,
  detectLanguage,
  normalizeTeams,
  rankTeams,
};
