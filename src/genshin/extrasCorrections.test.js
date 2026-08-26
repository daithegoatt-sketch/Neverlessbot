'use strict';

const assert = require('node:assert/strict');
const {
  isCorrectionRequest,
  isStatReviewRequest,
  ratingTargetFromText,
  isLegacyFlexAttempt,
  isLegacyQuizAttempt,
} = require('./extrasCorrections');

assert.equal(isStatReviewRequest('قيم احصائيات Skirk'), true);
assert.equal(isStatReviewRequest('قيّم إحصائيات Furina'), true);
assert.equal(isStatReviewRequest('rate stats Skirk'), true);
assert.equal(isStatReviewRequest('إحصائيات Skirk بحسابي'), false);
assert.equal(isStatReviewRequest('بيلد Skirk'), false);

assert.equal(ratingTargetFromText('شنو يمنع Skirk من 90'), 90);
assert.equal(ratingTargetFromText('شنو يمنع Skirk من 95'), 95);
assert.equal(ratingTargetFromText('شنو يمنع Skirk من 100'), 100);
assert.equal(ratingTargetFromText('وش يمنع Furina من 97%'), 97);
assert.equal(ratingTargetFromText('what keeps Skirk from 100'), 100);
assert.equal(ratingTargetFromText('شنو يمنع Skirk من 101'), null);
assert.equal(ratingTargetFromText('تقييم Skirk بحسابي'), null);

assert.equal(isLegacyFlexAttempt('فلكس بيلد Skirk'), true);
assert.equal(isLegacyFlexAttempt('flix build Skirk'), true);
assert.equal(isLegacyFlexAttempt('بيلد Skirk'), false);
assert.equal(isLegacyQuizAttempt('كويز'), true);
assert.equal(isLegacyQuizAttempt('quiz'), true);

for (const command of [
  'تقييم Skirk بحسابي',
  'إحصائيات Skirk بحسابي',
  'قارن Skirk بحسابي',
  'قيم تيم Sandrone بحسابي',
  'بيلد Skirk',
  'ترتيب Skirk',
]) {
  assert.equal(isCorrectionRequest(command), false, `legacy command must stay untouched: ${command}`);
}

assert.equal(isCorrectionRequest('قيم احصائيات Skirk'), true);
assert.equal(isCorrectionRequest('شنو يمنع Skirk من 100'), true);

console.log('extrasCorrections tests passed');
