'use strict';

const assert = require('node:assert/strict');
const {
  isExtrasRequest,
  isQuiz,
  isFlexBuild,
  isFinishedBuild,
  isWeakestPiece,
  isBottleneck,
  isStatReview,
  isServerCompare,
  isWhyNot90,
  blockersForRated,
  quizQuestionFromCharacter,
} = require('./genshinExtras');

assert.equal(isQuiz('كويز'), true);
assert.equal(isQuiz('quiz'), true);
assert.equal(isFlexBuild('فلكس بيلد Skirk'), true);
assert.equal(isFlexBuild('flix build Furina'), true);
assert.equal(isFinishedBuild('هل خلص بيلد Skirk'), true);
assert.equal(isWeakestPiece('أضعف قطعة عندي في Skirk'), true);
assert.equal(isBottleneck('أضعف شخصية بتيم Sandrone بحسابي'), true);
assert.equal(isBottleneck('أضعف شخصية بتيم Sandrone Yae Miko Qiqi Nicole بحسابي'), true);
assert.equal(isStatReview('قيم احصائيات Mavuika'), true);
assert.equal(isServerCompare('قارن Skirk بالسيرفر'), true);
assert.equal(isWhyNot90('شنو يمنع Skirk من 90'), true);

for (const command of [
  'تقييم Skirk بحسابي',
  'إحصائيات Skirk بحسابي',
  'قارن Skirk بحسابي',
  'قارن Skirk مع @member',
  'قيم تيم Sandrone بحسابي',
  'ترتيب Skirk',
  'بروفايلي',
]) {
  assert.equal(isExtrasRequest(command), false, `legacy command must stay outside extras router: ${command}`);
}

const blockers = blockersForRated({
  evaluation: {
    relevantStats: [{
      key: 'critRate',
      label: 'CRIT Rate',
      effectiveValue: 50,
      ratio: 0.5,
      weight: 1.2,
      status: 'down',
      target: { key: 'critRate', min: 70, max: 70 },
    }],
    artifactCount: 5,
    artifactAvgLevel: 20,
    mainStatScore: 100,
    artifactSetScore: 100,
    weaponScore: 100,
  },
  snapshot: { artifacts: [] },
  guide: { stats: { main: [], priority: '', targets: [] } },
}, 'ar');
assert.equal(blockers[0]?.type, 'stat');
assert.match(blockers[0]?.text || '', /CRIT Rate/);

const question = quizQuestionFromCharacter('Furina', { elementText: 'Hydro' }, 'ar');
assert.ok(question);
assert.equal(question.correct, 'Hydro');
assert.equal(question.options.length, 4);
assert.ok(question.options.includes('Hydro'));

console.log('genshinExtras tests passed');
