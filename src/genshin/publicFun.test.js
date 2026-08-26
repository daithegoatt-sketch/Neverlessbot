'use strict';

const assert = require('node:assert/strict');
const {
  parsePublicFunCommand,
  isPublicFunCommand,
  quizQuestionFromCharacter,
} = require('./publicFun');

assert.deepEqual(parsePublicFunCommand('-كويز'), { type: 'quiz' });
assert.deepEqual(parsePublicFunCommand('-quiz'), { type: 'quiz' });
assert.deepEqual(parsePublicFunCommand('-فلكس بيلد Skirk'), { type: 'flex', query: 'Skirk' });
assert.deepEqual(parsePublicFunCommand('-فليكس بيلد سكيرك'), { type: 'flex', query: 'سكيرك' });
assert.deepEqual(parsePublicFunCommand('-flex build Furina'), { type: 'flex', query: 'Furina' });
assert.deepEqual(parsePublicFunCommand('-flix build Furina'), { type: 'flex', query: 'Furina' });
assert.deepEqual(parsePublicFunCommand('<@123456789012345678> -فلكس بيلد Skirk'), { type: 'flex', query: 'Skirk' });

assert.equal(isPublicFunCommand('فلكس بيلد Skirk'), false);
assert.equal(isPublicFunCommand('بيلد Skirk'), false);
assert.equal(isPublicFunCommand('كويز'), false);
assert.equal(isPublicFunCommand('-بيلد Skirk'), false);

const question = quizQuestionFromCharacter('Furina', { elementText: 'Hydro' }, 'ar');
assert.ok(question);
assert.equal(question.correct, 'Hydro');
assert.equal(question.options.length, 4);
assert.ok(question.options.includes('Hydro'));

console.log('publicFun tests passed');
