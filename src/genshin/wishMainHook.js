'use strict';

const { Client } = require('discord.js');
const { installWishSimulator } = require('./wishSimulator');

const previousLogin = Client.prototype.login;

Client.prototype.login = function neverlessWishLogin(token) {
  if (!this.__neverlessWishInstalled) {
    this.__neverlessWishInstalled = true;
    installWishSimulator(this);
  }
  return previousLogin.call(this, token);
};
