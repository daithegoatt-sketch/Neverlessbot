'use strict';

const assert = require('node:assert/strict');
const {
  normalizeUid,
  normalizeServer,
  stateContent,
  parseState,
  sanitizeLobby,
  nextOwnerId,
  constants,
} = require('./gameLobby');

assert.equal(normalizeUid('700123456'), '700123456');
assert.equal(normalizeUid('UID: 700123456'), '700123456');
assert.equal(normalizeUid('123'), null);

assert.equal(normalizeServer('EU'), 'EU');
assert.equal(normalizeServer('Europe'), 'EU');
assert.equal(normalizeServer('North America'), 'NA');
assert.equal(normalizeServer('Asia'), 'ASIA');
assert.equal(normalizeServer('TW-HK-MO'), 'TW/HK/MO');
assert.equal(normalizeServer('Mars'), null);

const lobby = {
  id: 'abcdef123456',
  guildId: '1542716819327156244',
  ownerId: '1542716819327156245',
  members: [
    { userId: '1542716819327156245', uid: '700123456', server: 'EU', joinedAt: 100 },
    { userId: '1542716819327156246', uid: '600123456', server: 'NA', joinedAt: 200 },
  ],
  locked: false,
  joinMode: 'approve',
  limit: 5,
  textChannelId: '1542716819327156247',
  voiceChannelId: '1542716819327156248',
  parentId: null,
  controlMessageId: null,
  pending: [],
  createdAt: 100,
  updatedAt: 100,
};

const encoded = stateContent(lobby);
const decoded = parseState(encoded);
assert.equal(decoded.ownerId, lobby.ownerId);
assert.equal(decoded.joinMode, 'approve');
assert.equal(decoded.limit, 5);

const restored = sanitizeLobby(decoded, 1000);
assert.ok(restored);
assert.equal(restored.members.length, 2);
assert.equal(nextOwnerId(restored, lobby.ownerId), '1542716819327156246');
assert.equal(constants.DEFAULT_LIMIT, 4);
assert.equal(constants.MAX_LIMIT, 20);

const bad = sanitizeLobby({ ...decoded, ownerId: '1542716819327156299' }, 1000);
assert.equal(bad, null, 'owner must be part of the persisted lobby');

console.log('game lobby tests passed');
