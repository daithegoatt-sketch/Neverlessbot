'use strict';

const assert = require('node:assert/strict');
const {
  normalizeText,
  detectRepeatedWord,
  findForbiddenPhrase,
  offenseAction,
  parseConfig,
  parseWarning,
} = require('./autoMod');

assert.equal(normalizeText('أهــلاً إِلَى'), 'اهلا الي');

assert.equal(detectRepeatedWord('hello hello hello hello hello', 5), null);
assert.deepEqual(
  detectRepeatedWord('hello hello hello hello hello hello', 5),
  { word: 'hello', count: 6 },
);
assert.deepEqual(
  detectRepeatedWord('سبام سبام سبام سبام سبام سبام', 5),
  { word: 'سبام', count: 6 },
);

const entries = [
  { normalized: normalizeText('كلمة ممنوعة'), original: 'كلمة ممنوعة' },
  { normalized: normalizeText('badword'), original: 'badword' },
];
assert.equal(findForbiddenPhrase('هذه كلمة ممنوعة هنا', entries), 'كلمة ممنوعة');
assert.equal(findForbiddenPhrase('this badword here', entries), 'badword');
assert.equal(findForbiddenPhrase('this badwordish here', entries), null);

assert.deepEqual(offenseAction(0), { action: 'warning1', nextCount: 1 });
assert.deepEqual(offenseAction(1), { action: 'warning2', nextCount: 2 });
assert.deepEqual(offenseAction(2), { action: 'mute', nextCount: 0 });

const encoded = Buffer.from(JSON.stringify(['كلمة', 'badword']), 'utf8').toString('base64url');
assert.deepEqual(parseConfig(`NLAUTOMOD1|config|123456789012345678|${encoded}`), {
  guildId: '123456789012345678',
  words: ['كلمة', 'badword'],
});
assert.deepEqual(parseWarning('NLAUTOMOD1|warn|123456789012345678|223456789012345678|spam|2'), {
  guildId: '123456789012345678',
  userId: '223456789012345678',
  type: 'spam',
  count: 2,
});

console.log('automod tests passed');
