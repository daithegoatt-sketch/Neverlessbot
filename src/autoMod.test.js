'use strict';

const assert = require('node:assert/strict');
const {
  normalizeText,
  singleWord,
  nextSpamSequence,
  findForbiddenPhrase,
  offenseAction,
  parseConfig,
  parseWarning,
} = require('./autoMod');

assert.equal(normalizeText('أهــلاً إِلَى'), 'اهلا الي');
assert.equal(singleWord('الو'), 'الو');
assert.equal(singleWord('الو!'), 'الو');
assert.equal(singleWord('الو وينكم'), null);

// A repeated-looking string inside one message is only one message, not spam.
let result = nextSpamSequence(null, 'هءهءهءهءهء', 0);
assert.equal(result.triggered, false);
assert.equal(result.count, 1);

// Five consecutive messages containing the same single word within one minute trigger spam.
let sequence = null;
for (const timestamp of [0, 10_000, 20_000, 30_000]) {
  result = nextSpamSequence(sequence, 'الو', timestamp);
  assert.equal(result.triggered, false);
  sequence = result.sequence;
}
result = nextSpamSequence(sequence, 'الو', 40_000);
assert.equal(result.triggered, true);
assert.equal(result.word, 'الو');
assert.equal(result.count, 5);
assert.equal(result.sequence, null);

// A different message breaks the repeated-word sequence.
sequence = nextSpamSequence(null, 'الو', 0).sequence;
sequence = nextSpamSequence(sequence, 'الو', 5_000).sequence;
result = nextSpamSequence(sequence, 'وينكم', 10_000);
assert.equal(result.triggered, false);
assert.equal(result.count, 1);
sequence = result.sequence;
result = nextSpamSequence(sequence, 'الو', 15_000);
assert.equal(result.triggered, false);
assert.equal(result.count, 1);

// A multi-word message also breaks the sequence.
sequence = nextSpamSequence(null, 'الو', 0).sequence;
result = nextSpamSequence(sequence, 'الو وينكم', 5_000);
assert.equal(result.triggered, false);
assert.equal(result.sequence, null);

// Only messages that fit inside the rolling 60-second window are counted.
sequence = null;
for (const timestamp of [0, 20_000, 40_000, 61_000]) {
  result = nextSpamSequence(sequence, 'الو', timestamp);
  assert.equal(result.triggered, false);
  sequence = result.sequence;
}
assert.equal(result.count, 3); // the 0s message has expired at 61s
result = nextSpamSequence(sequence, 'الو', 62_000);
assert.equal(result.triggered, false);
assert.equal(result.count, 4);
sequence = result.sequence;
result = nextSpamSequence(sequence, 'الو', 63_000);
assert.equal(result.triggered, true); // 20s..63s = five consecutive messages within a minute

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
