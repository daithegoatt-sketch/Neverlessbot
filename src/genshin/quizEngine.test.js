'use strict';

const assert = require('node:assert/strict');
const {
  buildQuestionsFromRecords,
  quizRecord,
  parseQuizCount,
  QUESTION_TIMEOUT_MS,
  MAX_QUESTIONS,
} = require('./quizEngine');

const records = [
  {
    name: 'Alpha', element: 'Cryo', weapon: 'Sword', region: 'Mondstadt', rarity: '5★', birthday: 'January 1',
    constellation: 'Astra', title: 'First Star', skill: 'Frozen Step', burst: 'Winter End', localSpecialty: 'Flower A',
    bossMaterial: 'Boss A', enemyMaterial: 'Drop A', talentBook: 'Philosophies of A',
  },
  {
    name: 'Beta', element: 'Pyro', weapon: 'Bow', region: 'Liyue', rarity: '4★', birthday: 'February 2',
    constellation: 'Flamma', title: 'Red Arrow', skill: 'Fire Step', burst: 'Blazing End', localSpecialty: 'Flower B',
    bossMaterial: 'Boss B', enemyMaterial: 'Drop B', talentBook: 'Philosophies of B',
  },
  {
    name: 'Gamma', element: 'Hydro', weapon: 'Catalyst', region: 'Inazuma', rarity: '5★', birthday: 'March 3',
    constellation: 'Aqua', title: 'Blue Moon', skill: 'Water Step', burst: 'Ocean End', localSpecialty: 'Flower C',
    bossMaterial: 'Boss C', enemyMaterial: 'Drop C', talentBook: 'Philosophies of C',
  },
  {
    name: 'Delta', element: 'Electro', weapon: 'Polearm', region: 'Sumeru', rarity: '4★', birthday: 'April 4',
    constellation: 'Volt', title: 'Purple Spear', skill: 'Shock Step', burst: 'Thunder End', localSpecialty: 'Flower D',
    bossMaterial: 'Boss D', enemyMaterial: 'Drop D', talentBook: 'Philosophies of D',
  },
];

const questions = buildQuestionsFromRecords(records, 'ar');
const types = new Set(questions.map((row) => row.type));
for (const type of ['element', 'weapon', 'region', 'rarity', 'birthday', 'constellation', 'title', 'skill', 'burst', 'localSpecialty', 'bossMaterial', 'enemyMaterial', 'talentBook']) {
  assert.equal(types.has(type), true, `missing quiz type: ${type}`);
}
assert.equal(questions.every((row) => row.options.length >= 2 && row.correctIndex >= 0), true);

const character = {
  name: 'Skirk', rarity: 5, elementText: 'Cryo', weaponText: 'Sword', birthday: 'November 5', constellation: 'Crystallina',
  costs: {
    ascend2: [
      { id: 101254, name: 'Skysplit Gembloom' },
      { id: 113067, name: 'Ensnaring Gaze' },
      { id: 112083, name: 'Meshing Gear' },
    ],
  },
};
const talent = {
  combat2: { name: 'Havoc: Warp' },
  combat3: { name: 'Havoc: Ruin' },
  costs: { lvl7: [{ id: 104349, name: 'Philosophies of Contention' }] },
};
const extracted = quizRecord(character, talent);
assert.equal(extracted.localSpecialty, 'Skysplit Gembloom');
assert.equal(extracted.bossMaterial, 'Ensnaring Gaze');
assert.equal(extracted.enemyMaterial, 'Meshing Gear');
assert.equal(extracted.skill, 'Havoc: Warp');
assert.equal(extracted.burst, 'Havoc: Ruin');
assert.equal(extracted.talentBook, 'Philosophies of Contention');

assert.equal(parseQuizCount('20'), 20);
assert.equal(parseQuizCount('1'), 1);
assert.equal(parseQuizCount('0'), null);
assert.equal(parseQuizCount(String(MAX_QUESTIONS + 1)), null);
assert.equal(QUESTION_TIMEOUT_MS, 15000);

console.log('quizEngine tests passed');
