'use strict';

// Music-only runtime patch loaded before workerFinal.
// 1) Force lavalink-client autoSkip so queued tracks continue automatically on track end/error.
// 2) Make the explicit Neverless `وقف` handler leave voice after clearing playback.
// No Discord client/login is created here and no non-music system is touched.

const resolved = require.resolve('lavalink-client');
const originalExports = require(resolved);
const OriginalManager = originalExports.LavalinkManager;
const Player = originalExports.Player;

const MANAGER_PATCH = Symbol.for('neverless.music.queue-manager-patch');
const STOP_PATCH = Symbol.for('neverless.music.stop-leave-patch');

if (OriginalManager && !globalThis[MANAGER_PATCH]) {
  class NeverlessQueueManager extends OriginalManager {
    constructor(options = {}, ...rest) {
      super({ ...options, autoSkip: true }, ...rest);
    }
  }

  const cached = require.cache[resolved];
  if (cached) {
    cached.exports = new Proxy(originalExports, {
      get(target, property, receiver) {
        if (property === 'LavalinkManager') return NeverlessQueueManager;
        return Reflect.get(target, property, receiver);
      },
    });
  }

  globalThis[MANAGER_PATCH] = true;
}

if (Player?.prototype && !Player.prototype[STOP_PATCH]) {
  const originalStopPlaying = Player.prototype.stopPlaying;

  Object.defineProperty(Player.prototype, STOP_PATCH, { value: true });

  Player.prototype.stopPlaying = async function neverlessStopPlayingGuard(...args) {
    // workerFinal also calls stopPlaying() internally before starting a fresh candidate.
    // Only the explicit user command comes through handleStop(), so keep that behavior isolated.
    const stack = String(new Error().stack || '');
    const explicitUserStop = /\bhandleStop\b/.test(stack);

    const result = await originalStopPlaying.apply(this, args);

    if (explicitUserStop) {
      try {
        await this.destroy('USER_STOP', true);
      } catch {
        // The track is already stopped/queue-cleared. A failed destroy must not crash the worker.
      }
    }

    return result;
  };
}

module.exports = {};
