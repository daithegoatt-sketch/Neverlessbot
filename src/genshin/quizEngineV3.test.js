'use strict';

const assert = require('node:assert/strict');
const {
  buildQuestionsFromRecords,
  balancedQuestions,
  displayValue,
  playerRows,
  parseQuizCount,
  QUESTION_TIMEOUT_MS,
  MAX_QUESTIONS,
} = require('./quizEngineV3');

const records = [
  {
    name: 'Alpha', element: 'Cryo', weapon: 'Sword', region: 'Mondstadt', rarity: '5★', birthday: 'January 1',
    constellation: 'Astra', title: 'First Star', skill: 'Frozen Step', burst: 'Winter End', localSpecialty: 'Flower A',
    bossMaterial: 'Boss A', enemyMaterial: 'Drop A', talentBook: 'Philosophies of A', recommendedWeapon: 'Weapon A', recommendedArtifact: '4pc Set A',
  },
  {
    name: 'Beta', element: 'Pyro', weapon: 'Bow', region: 'Liyue', rarity: '4★', birthday: 'February 2',
    constellation: 'Flamma', title: 'Red Arrow', skill: 'Fire Step', burst: 'Blazing End', localSpecialty: 'Flower B',
    bossMaterial: 'Boss B', enemyMaterial: 'Drop B', talentBook: 'Philosophies of B', recommendedWeapon: 'Weapon B', recommendedArtifact: '4pc Set B',
  },
  {
    name: 'Gamma', element: 'Hydro', weapon: 'Catalyst', region: 'Inazuma', rarity: '5★', birthday: 'March 3',
    constellation: 'Aqua', title: 'Blue Moon', skill: 'Water Step', burst: 'Ocean End', localSpecialty: 'Flower C',
    bossMaterial: 'Boss C', enemyMaterial: 'Drop C', talentBook: 'Philosophies of C', recommendedWeapon: 'Weapon C', recommendedArtifact: '4pc Set C',
  },
  {
    name: 'Delta', element: 'Electro', weapon: 'Polearm', region: 'Sumeru', rarity: '4★', birthday: 'April 4',
    constellation: 'Volt', title: 'Purple Spear', skill: 'Shock Step', burst: 'Thunder End', localSpecialty: 'Flower D',
    bossMaterial: 'Boss D', enemyMaterial: 'Drop D', talentBook: 'Philosophies of D', recommendedWeapon: 'Weapon D', recommendedArtifact: '4pc Set D',
  },
];

const questions = buildQuestionsFromRecords(records, 'ar');
assert.ok(questions.some((q) => q.difficulty === 'easy'));
assert.ok(questions.some((q) => q.difficulty === 'medium'));
assert.ok(questions.some((q) => q.difficulty === 'hard'));
assert.equal(questions.every((q) => q.options.length >= 2 && q.correctIndex >= 0), true);
assert.equal(displayValue('Cryo', 'ar'), 'كرايو');
assert.equal(displayValue('Sword', 'ar'), 'سيف');
assert.equal(displayValue('Mondstadt', 'ar'), 'موندشتات');

const balanced = balancedQuestions(questions, 18);
assert.equal(balanced.length, 18);
const easyCount = balanced.filter((q) => q.difficulty === 'easy').length;
const hardCount = balanced.filter((q) => q.difficulty === 'hard').length;
assert.ok(easyCount > hardCount, 'quiz should favor understandable questions over challenge questions');

const session = {
  players: new Map([
    ['1', { correct: 5, wrong: 1, answers: 6, correctTimeMs: 10000 }],
    ['2', { correct: 5, wrong: 0, answers: 5, correctTimeMs: 15000 }],
    ['3', { correct: 3, wrong: 0, answers: 3, correctTimeMs: 3000 }],
  ]),
};
const board = playerRows(session);
assert.equal(board[0].userId, '1', 'same correct count should prefer faster average response');
assert.equal(board[1].userId, '2');
assert.equal(board[2].userId, '3');

assert.equal(parseQuizCount('20'), 20);
assert.equal(parseQuizCount('0'), null);
assert.equal(parseQuizCount(String(MAX_QUESTIONS + 1)), null);
assert.equal(QUESTION_TIMEOUT_MS, 15000);

console.log('quizEngineV3 tests passed');
