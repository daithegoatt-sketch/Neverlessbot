'use strict';

const { Client } = require('discord.js');
const { installMusicControllerV2 } = require('./controllerV2');

const hookKey = Symbol.for('neverless.music.main-controller-v2');

if (!Client.prototype[hookKey]) {
  const originalLogin = Client.prototype.login;
  Object.defineProperty(Client.prototype, hookKey, { value: true });

  Client.prototype.login = function neverlessMusicControlledLogin(...args) {
    const mode = String(process.env.BOT_MODE || 'main').trim().toLowerCase();
    if (mode !== 'music' && !this.__neverlessMusicControllerV2Installed) {
      this.__neverlessMusicControllerV2Installed = true;
      installMusicControllerV2(this);
    }
    return originalLogin.apply(this, args);
  };
}
