'use strict';

// Isolated runtime guard for BOT_MODE=music only.
// Prevents lavalink-client Player.connect() from blocking the worker forever while
// Discord has already moved the bot into the voice channel. The normal worker then
// verifies the actual Discord voice state + Lavalink handshake before playing.
const lavalinkClient = require('lavalink-client');
const Player = lavalinkClient.Player;

const PATCH_KEY = Symbol.for('neverless.music.player-connect-guard');

if (Player?.prototype && !Player.prototype[PATCH_KEY]) {
  const originalConnect = Player.prototype.connect;

  Object.defineProperty(Player.prototype, PATCH_KEY, { value: true });

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

module.exports = {};
