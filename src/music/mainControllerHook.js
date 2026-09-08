'use strict';

const { Client } = require('discord.js');
const { installMusicControllerFinal } = require('./controllerFinal');

const hookKey = Symbol.for('neverless.music.main-controller-final');

if (!Client.prototype[hookKey]) {
  const originalLogin = Client.prototype.login;
  Object.defineProperty(Client.prototype, hookKey, { value: true });

  Client.prototype.login = function neverlessMusicControlledLogin(...args) {
    const mode = String(process.env.BOT_MODE || 'main').trim().toLowerCase();
    if (mode !== 'music' && !this.__neverlessMusicControllerFinalInstalled) {
      this.__neverlessMusicControllerFinalInstalled = true;
      installMusicControllerFinal(this);
    }
    return originalLogin.apply(this, args);
  };
}
