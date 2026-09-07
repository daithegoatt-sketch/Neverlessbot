'use strict';

const { commands } = require('../commands');
const { helpText } = require('../genshin/helpRouter');

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#/@<>-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PUBLIC_COMMANDS = Object.freeze([
  {
    syntax: '#رابط', kind: 'message', scope: 'public',
    description: 'إنشاء أو جلب رابط الدعوة الشخصي للعضو في Neverless.',
    aliases: ['رابط السيرفر', 'invite', 'server invite', 'دعوة'],
  },
  {
    syntax: 'توب', kind: 'message', scope: 'activity-channel', channelId: '1538570405617598505',
    description: 'ترتيب نشاط الأعضاء الإجمالي. ويمكن إضافة يومي/أسبوعي/شهري.',
    aliases: ['top', 'توب يومي', 'توب أسبوعي', 'توب اسبوعي', 'توب شهري', 'activity leaderboard', 'اكثر متفاعل'],
  },
  {
    syntax: 'توب دعوات', kind: 'message', scope: 'activity-channel', channelId: '1538570405617598505',
    description: 'ترتيب دعوات أعضاء Neverless.', aliases: ['top invites', 'ترتيب الدعوات', 'اكثر دعوات'],
  },
  {
    syntax: 'دعواتي', kind: 'message', scope: 'activity-channel', channelId: '1538570405617598505',
    description: 'عرض عدد دعوات العضو.', aliases: ['my invites', 'دعوات'],
  },
  {
    syntax: '-نك <الاسم>', kind: 'message', scope: 'public',
    description: 'تغيير لقبك داخل السيرفر. استخدام -نك بدون اسم يزيل لقبك.', aliases: ['nickname', 'غير اسمي', 'لقبي'],
  },
  {
    syntax: '-تيم المسرح الحالي', kind: 'message', scope: 'public',
    description: 'عرض معلومات Imaginarium Theater الحالي والعناصر وOpening Cast وSpecial Guests.', aliases: ['المسرح الحالي', 'theater current', 'imaginarium theater'],
  },
  {
    syntax: '-تيم المسرح <Easy|Normal|Hard|Visionary|Lunar>', example: '-تيم المسرح Hard', kind: 'message', scope: 'public',
    description: 'بناء Route للمسرح حسب الصعوبة مع Vigor والبوسات والتفاعلات.', aliases: ['تيم المسرح سهل', 'تيم المسرح صعب', 'theater team', 'theater plan'],
  },
  {
    syntax: '-flex neverless', kind: 'message', scope: 'public',
    description: 'عرض صاحب Top Neverless الحالي وبيلداته الأقوى.', aliases: ['-فلكس Neverless', '-فليكس Neverless', 'top neverless'],
  },
  {
    syntax: '@Neverless Bot Hall of fame', kind: 'mention', scope: 'public',
    description: 'عرض Neverless Hall of Fame لأصحاب Top Neverless منذ تفعيل القاعة.', aliases: ['قاعة الأبطال', 'Hall of Fame', 'قاعه الابطال'],
  },
]);

function slashCatalog() {
  return (commands || []).map((command) => ({
    syntax: `/${command.name}`,
    kind: 'slash',
    scope: command.default_member_permissions ? 'staff-or-permissioned' : 'server',
    description: command.description || '',
    aliases: [command.name],
  }));
}

function helpCatalogFor(lang) {
  const rows = [];
  for (const rawLine of String(helpText(lang) || '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('`')) continue;
    const divider = line.indexOf('—');
    const head = divider >= 0 ? line.slice(0, divider) : line;
    const description = divider >= 0 ? line.slice(divider + 1).trim() : '';
    const syntaxes = [...head.matchAll(/`([^`]+)`/g)].map((match) => String(match[1] || '').trim()).filter(Boolean);
    for (const syntax of syntaxes) {
      rows.push({
        syntax,
        kind: syntax.startsWith('-') ? 'message-public' : 'message-genshin',
        scope: syntax.startsWith('-') ? 'public' : 'genshin-bot-channel',
        description,
        aliases: [syntax],
        source: `Neverless Genshin Help (${lang})`,
      });
    }
  }
  return rows;
}

function helpCatalog() {
  return [...helpCatalogFor('ar'), ...helpCatalogFor('en')];
}

function allCommands() {
  const combined = [...PUBLIC_COMMANDS, ...helpCatalog(), ...slashCatalog()];
  const seen = new Set();
  return combined.filter((entry) => {
    const key = normalize(entry.syntax);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreEntry(entry, query) {
  const wanted = normalize(query);
  if (!wanted) return 1;
  const haystack = normalize([
    entry.syntax,
    entry.example,
    entry.description,
    ...(entry.aliases || []),
  ].filter(Boolean).join(' '));
  if (haystack.includes(wanted)) return 100 + wanted.length;
  const tokens = wanted.split(' ').filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length >= 4 ? 12 : 5;
  }
  return score;
}

function searchCommandCatalog(query, limit = 12) {
  return allCommands()
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.syntax.localeCompare(b.entry.syntax))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 12)))
    .map(({ entry }) => entry);
}

module.exports = {
  PUBLIC_COMMANDS,
  slashCatalog,
  helpCatalog,
  allCommands,
  searchCommandCatalog,
};
