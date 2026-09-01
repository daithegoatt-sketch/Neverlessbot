'use strict';

const assert = require('node:assert/strict');
const {
  monthKey,
  splitNames,
  parseTimelineText,
  resolveDifficulty,
  genericAct,
} = require('./theaterClient');

assert.equal(monthKey(new Date('2026-09-02T00:00:00Z')), '2026-09');
assert.deepEqual(splitNames('Hydro, Electro, and Dendro'), ['Hydro', 'Electro', 'Dendro']);

const sample = [
  'Imaginarium Theater',
  'Required Elemental Types: Hydro, Electro, and Dendro.',
  'Opening Characters: Columbina, Xingqiu, Cyno, Kuki Shinobu, Lauma, and Kaveh.',
  'Special Guest Stars: Odette, Sandrone, Sucrose, and Nicole.',
].join(' ');
const parsed = parseTimelineText(sample, new Date('2026-09-02T00:00:00Z'));
assert.deepEqual(parsed.elements, ['Hydro', 'Electro', 'Dendro']);
assert.deepEqual(parsed.opening, ['Columbina', 'Xingqiu', 'Cyno', 'Kuki Shinobu', 'Lauma', 'Kaveh']);
assert.deepEqual(parsed.guests, ['Odette', 'Sandrone', 'Sucrose', 'Nicole']);
assert.equal(resolveDifficulty('Easy-سهل').key, 'easy');
assert.equal(resolveDifficulty('عادي').key, 'normal');
assert.equal(resolveDifficulty('Hard').key, 'hard');
assert.equal(resolveDifficulty('Visionary').key, 'visionary');
assert.equal(resolveDifficulty('Lunar').key, 'lunar');
assert.equal(resolveDifficulty('الحالي'), null);
assert.equal(resolveDifficulty('something else'), undefined);
assert.equal(genericAct(3).type, 'boss');
assert.equal(genericAct(11).type, 'arcana');

console.log('theater client tests passed');
