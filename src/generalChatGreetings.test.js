'use strict';

const assert = require('node:assert/strict');
const { normalizeGreeting, greetingReply } = require('./generalChatGreetings');

assert.equal(normalizeGreeting('  السلام عليكم!! '), 'السلام عليكم');
assert.equal(greetingReply('السلام عليكم'), 'وعليكم السلام ورحمة الله وبركاته');
assert.equal(greetingReply('السلام عليكم!'), 'وعليكم السلام ورحمة الله وبركاته');
assert.equal(greetingReply('صباح الخير'), 'صباح النور');
assert.equal(greetingReply('تصبحون على خير'), 'وانت من أهل الخير');
assert.equal(greetingReply('مساء الخير'), 'مساء النور');
assert.equal(greetingReply('السلام عليكم يا جماعة'), null);
assert.equal(greetingReply('صباح الخير جميعا'), null);

console.log('general chat greeting tests passed');
