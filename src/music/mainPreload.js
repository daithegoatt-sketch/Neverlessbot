'use strict';

const { Client } = require('discord.js');
const { installMusicController } = require('./controller');

const previousLogin = Client.prototype.login;

Client.prototype.login = function neverlessMusicControllerLogin(token) {
  if (!this.__neverlessMusicControllerInstalled) {
    this.__neverlessMusicControllerInstalled = true;
    try {
      installMusicController(this);
    } catch (error) {
      console.error('[music] Controller install failed; Neverless core will continue:', error);
    }
  }
  return previousLogin.call(this, token);
};
