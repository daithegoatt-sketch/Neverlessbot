'use strict';

const { ChannelType } = require('discord.js');

const CMD_CHANNEL_ID = '1538570405617598505';
const DATA_CHANNEL_NAME = 'neverless-data';
const PREFIX = 'NLMUSIC1';
const HEARTBEAT_STALE_MS = 35_000;

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function record(type, id, payload = {}) {
  return `${PREFIX}|${type}|${id}|${encode(payload)}`;
}

function parseRecord(content) {
  const value = String(content || '').trim();
  if (!value.startsWith(`${PREFIX}|`)) return null;
  const parts = value.split('|');
  if (parts.length !== 4) return null;
  const [, type, id, packed] = parts;
  const payload = decode(packed);
  return payload && type && id ? { type, id, payload } : null;
}

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMusicCommand(content) {
  const text = normalize(content);
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/^(?:امر|أمر|اوامر الاغاني|أوامر الأغاني|اوامر الأغاني|أوامر الاغاني|music commands)$/iu.test(text)) {
    return { action: 'help' };
  }

  const play = text.match(/^(?:ش|شغل|تشغيل|play|p)\s+(.+)$/iu);
  if (play) return { action: 'play', query: play[1].trim().slice(0, 400) };

  if (/^(?:س|سكب|تخطي|skip)$/iu.test(text)) return { action: 'skip' };
  if (/^(?:و|وقف|ايقاف|إيقاف|stop)$/iu.test(text)) return { action: 'stop' };

  const volume = text.match(/^(?:ص|صوت|volume|vol)\s+(\d{1,3})%?$/iu);
  if (volume) {
    const value = Number(volume[1]);
    if (value >= 0 && value <= 200) return { action: 'volume', value };
    return { action: 'volume_invalid' };
  }

  return null;
}

function isVoiceTextChannel(channel) {
  return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
}

function isAllowedCommandChannel(message) {
  if (!message?.guildId) return false;
  if (message.channelId === CMD_CHANNEL_ID) return true;
  if (!isVoiceTextChannel(message.channel)) return false;
  return message.member?.voice?.channelId === message.channelId;
}

function helpText() {
  return [
    '**أوامر الأغاني**',
    '`ش <اسم الأغنية>` / `شغل <اسم الأغنية>` / `play <song>` — تشغيل أو إضافة للانتظار',
    '`س` / `سكب` / `skip` — تخطي الأغنية الحالية',
    '`و` / `وقف` / `stop` — إيقاف التشغيل ومسح الانتظار',
    '`ص 50` / `صوت 50` / `volume 50` — مستوى الصوت من 0% إلى 200%',
    '`امر` / `أوامر الأغاني` — عرض هذه القائمة',
  ].join('\n');
}

function workerNumberFromName(name) {
  const value = String(name || '').toLowerCase();
  if (!value.includes('neverless') || !value.includes('music')) return null;
  if (/\b(?:1|i)\b/.test(value)) return '1';
  if (/\b(?:2|ii)\b/.test(value)) return '2';
  if (/\b(?:3|iii)\b/.test(value)) return '3';
  return null;
}

module.exports = {
  CMD_CHANNEL_ID,
  DATA_CHANNEL_NAME,
  PREFIX,
  HEARTBEAT_STALE_MS,
  record,
  parseRecord,
  parseMusicCommand,
  isAllowedCommandChannel,
  isVoiceTextChannel,
  helpText,
  workerNumberFromName,
};
