'use strict';

const assert = require('node:assert/strict');
const { normalizeQuestion, compactLongTerm } = require('./memory');
const { normalize, tokenize } = require('./messageIndex');
const { isCorrectionSignal } = require('./learning');
const { extractText, functionCalls, inputMessages } = require('./openaiClient');
const { isExistingCommandStyle, splitResponse } = require('./index');

assert.equal(normalizeQuestion('وش دخل هذا بهذا؟'), 'وش دخل هذا بهذا');
assert.equal(normalizeQuestion('  سكيرك   عندي  '), 'سكيرك عندي');
assert.equal(normalize('صَبَاحُ الخير!!'), 'صباح الخير');
assert.deepEqual(tokenize('Skirk build Skirk'), ['skirk', 'build']);

assert.equal(isCorrectionSignal('مو قصدي كذا، قصدي التقييم القديم'), true);
assert.equal(isCorrectionSignal('وش دخل هذا بهذا؟'), true);
assert.equal(isCorrectionSignal('الجو حلو اليوم'), false);

assert.equal(isExistingCommandStyle('-كويز'), true);
assert.equal(isExistingCommandStyle('#توب'), true);
assert.equal(isExistingCommandStyle('شنو أفضل تيم؟'), false);

assert.deepEqual(splitResponse('hello'), ['hello']);
assert.ok(splitResponse('a '.repeat(1200), 500).length > 1);

const fakeResponse = {
  output: [
    { type: 'function_call', name: 'get_member_activity', call_id: 'call_1', arguments: '{}' },
    { type: 'message', content: [{ type: 'output_text', text: 'النتيجة هنا' }] },
  ],
};
assert.equal(extractText(fakeResponse), 'النتيجة هنا');
assert.equal(functionCalls(fakeResponse).length, 1);
assert.equal(inputMessages([{ role: 'user', content: 'old' }], 'new').at(-1).content, 'new');

const compact = compactLongTerm('000000000000000000');
assert.ok(compact && Array.isArray(compact.m) && Array.isArray(compact.r));

console.log('neverless AI tests passed');
