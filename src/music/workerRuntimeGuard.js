'use strict';

// Isolated runtime guards for BOT_MODE=music only.
// 1) Prevent lavalink-client Player.connect() from blocking the worker forever while
//    Discord has already moved the bot into the voice channel.
// 2) Prevent frequent STATUS message edits from clogging Discord REST and delaying
//    the critical playback path after the worker has been online for many hours.
const lavalinkClient = require('lavalink-client');
const { Message } = require('discord.js');
const Player = lavalinkClient.Player;

const CONNECT_PATCH_KEY = Symbol.for('neverless.music.player-connect-guard');
const STATUS_EDIT_PATCH_KEY = Symbol.for('neverless.music.status-edit-guard');

if (Player?.prototype && !Player.prototype[CONNECT_PATCH_KEY]) {
  const originalConnect = Player.prototype.connect;

  Object.defineProperty(Player.prototype, CONNECT_PATCH_KEY, { value: true });

  Player.prototype.connect = function neverlessConnectGuard(...args) {
    if (this.__neverlessConnectGate) return this.__neverlessConnectGate;

    let raw;
    try {
      raw = Promise.resolve(originalConnect.apply(this, args));
    } catch (error) {
      return Promise.reject(error);
    }

    // Handle a late rejection even if the timeout wins the race.
    raw.catch(() => {});

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(this), 4_000);
      timer.unref?.();
    });

    const gate = Promise.race([raw, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      if (this.__neverlessConnectGate === gate) this.__neverlessConnectGate = null;
    });

    this.__neverlessConnectGate = gate;
    return gate;
  };
}

if (Message?.prototype && !Message.prototype[STATUS_EDIT_PATCH_KEY]) {
  const originalEdit = Message.prototype.edit;
  Object.defineProperty(Message.prototype, STATUS_EDIT_PATCH_KEY, { value: true });

  Message.prototype.edit = function neverlessStatusEditGuard(options, ...rest) {
    if (String(process.env.BOT_MODE || '').trim().toLowerCase() !== 'music') {
      return originalEdit.call(this, options, ...rest);
    }

    const nextContent = typeof options === 'string' ? options : options?.content;
    const currentContent = this.content;
    const isMusicStatus = String(nextContent || currentContent || '').startsWith('NLMUSIC1|STATUS|');

    // workerHealthBridge already publishes a fresh STATUS snapshot every minute.
    // Re-editing the same durable STATUS message every 5 seconds is redundant and can
    // build a REST-rate-limit queue that blocks ensurePlayer() before search/play.
    if (isMusicStatus) return Promise.resolve(this);

    return originalEdit.call(this, options, ...rest);
  };
}

module.exports = {};
