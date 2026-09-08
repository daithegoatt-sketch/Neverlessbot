'use strict';

const http = require('node:http');
const https = require('node:https');
const { Client } = require('discord.js');
const { DATA_CHANNEL_NAME, record, parseRecord } = require('./protocol');

const WORKER_ID = String(process.env.MUSIC_WORKER_ID || '').trim();
const HOST = String(process.env.LAVALINK_HOST || '').trim();
const PORT = Math.max(1, Number(process.env.LAVALINK_PORT || 2333));
const PASSWORD = String(process.env.LAVALINK_PASSWORD || '').trim();
const SECURE = /^(?:1|true|yes)$/i.test(String(process.env.LAVALINK_SECURE || 'false'));
const INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 2_500;
const hookKey = Symbol.for('neverless.music.worker-health-bridge');

function backendHealthy() {
  if (!HOST || !PASSWORD) return Promise.resolve(false);
  const transport = SECURE ? https : http;
  return new Promise((resolve) => {
    const req = transport.request({
      host: HOST,
      port: PORT,
      path: '/v4/info',
      method: 'GET',
      headers: { Authorization: PASSWORD },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
    req.end();
  });
}

async function dataChannel(guild) {
  let channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  if (!channel) {
    await guild.channels.fetch().catch(() => null);
    channel = guild.channels.cache.find((item) => item.name === DATA_CHANNEL_NAME && item.isTextBased?.()) || null;
  }
  return channel;
}

function installBridge(client) {
  if (client.__neverlessWorkerHealthBridgeInstalled) return;
  client.__neverlessWorkerHealthBridgeInstalled = true;
  const previousByGuild = new Map();
  const startedAt = Date.now();

  const publish = async (guild) => {
    const channel = await dataChannel(guild);
    if (!channel) return;
    const ready = await backendHealthy();
    const voiceId = guild.members.me?.voice?.channelId || null;
    const payload = {
      worker_id: WORKER_ID,
      bot_id: client.user?.id || null,
      guild_id: guild.id,
      voice_id: voiceId,
      pinned_voice_id: null,
      playing: false,
      current_title: null,
      queue_length: 0,
      volume: 100,
      backend: 'lavalink-health-bridge',
      backend_ready: ready,
      heartbeat_at: Date.now(),
      started_at: startedAt,
      bridge: true,
    };

    const message = await channel.send({
      content: record('STATUS', WORKER_ID, payload),
      allowedMentions: { parse: [] },
    }).catch(() => null);
    if (!message) return;

    const previousId = previousByGuild.get(guild.id);
    previousByGuild.set(guild.id, message.id);
    if (!previousId || previousId === message.id) return;

    const previous = await channel.messages.fetch(previousId).catch(() => null);
    const parsed = previous ? parseRecord(previous.content) : null;
    // Delete only snapshots still owned by this bridge. If workerLavalinkV4 adopted
    // the message and rewrote it, leave it alone so its normal status publisher stays intact.
    if (previous && parsed?.type === 'STATUS' && parsed?.id === WORKER_ID && parsed?.payload?.bridge === true) {
      await previous.delete().catch(() => {});
    }
  };

  const start = () => {
    if (!/^[123]$/.test(WORKER_ID)) return;
    for (const guild of client.guilds.cache.values()) publish(guild).catch(() => {});
    const timer = setInterval(() => {
      for (const guild of client.guilds.cache.values()) publish(guild).catch(() => {});
    }, INTERVAL_MS);
    timer.unref?.();
  };

  if (client.isReady?.()) start();
  else client.once('ready', start);
}

if (!Client.prototype[hookKey]) {
  const originalLogin = Client.prototype.login;
  Object.defineProperty(Client.prototype, hookKey, { value: true });
  Client.prototype.login = function neverlessWorkerHealthLogin(...args) {
    if (String(process.env.BOT_MODE || '').trim().toLowerCase() === 'music') installBridge(this);
    return originalLogin.apply(this, args);
  };
}

module.exports = { installBridge };
