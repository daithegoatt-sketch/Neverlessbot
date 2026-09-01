'use strict';

const assert = require('node:assert/strict');
const {
  parseTheaterCommand,
  followupKind,
  requirementsForAct,
  remainingUses,
} = require('./theaterPlanner');

assert.equal(parseTheaterCommand('-تيم المسرح الحالي').type, 'overview');
assert.equal(parseTheaterCommand('-تيم المسرح Easy').difficulty.key, 'easy');
assert.equal(parseTheaterCommand('-تيم المسرح Easy-سهل').difficulty.key, 'easy');
assert.equal(parseTheaterCommand('-تيم المسرح Hard').difficulty.acts, 8);
assert.equal(parseTheaterCommand('-تيم المسرح Lunar').difficulty.acts, 12);
assert.equal(parseTheaterCommand('تيم المسرح Hard'), null);
assert.equal(parseTheaterCommand('-تيم المسرح مجهول').type, 'invalid');

assert.equal(followupKind('المتاح عندي: Furina, Kuki, Nahida, Cyno'), 'pool');
assert.equal(followupKind('ماعندي Furina'), 'missing');
assert.equal(followupKind('ما طلع لي Furina'), 'notdrawn');
assert.equal(followupKind('بدأت المرحلة 3'), 'stage');
assert.equal(followupKind('استعملت: Cyno, Kuki, Xingqiu, Lauma'), 'used');
assert.equal(followupKind('حالة المسرح'), 'status');
assert.equal(followupKind('شلونكم'), null);

assert.deepEqual(requirementsForAct({ reaction: 'Hydro application' }), ['hydro', 'hydro']);
assert.deepEqual(requirementsForAct({ reaction: 'Electro-Charged / Lunar-Charged' }), ['hydro', 'electro']);
assert.deepEqual(requirementsForAct({ reaction: 'Electro / Quicken' }), ['electro', 'dendro']);
assert.deepEqual(requirementsForAct({ reaction: 'Dendro / Electro' }), ['dendro', 'electro']);

const session = { used: new Map([['Furina', 0], ['Yelan', 1], ['Xingqiu', 2]]) };
assert.equal(remainingUses(session, 'Furina'), 2);
assert.equal(remainingUses(session, 'Yelan'), 1);
assert.equal(remainingUses(session, 'Xingqiu'), 0);

console.log('theater planner tests passed');
