'use strict';

const assert = require('node:assert/strict');
const {
  parsePersonalInvite,
  validUrl,
  messagePayload,
  splitPlainMessage,
  broadcastPayloads,
} = require('./serverTools');

const parsed = parsePersonalInvite('NLPINV1|1537000000000000000|abcDEF12|1537111111111111111|2026-08-19T02:00:00.000Z');
assert.equal(parsed.guildId, '1537000000000000000');
assert.equal(parsed.code, 'abcDEF12');
assert.equal(parsed.ownerId, '1537111111111111111');
assert.equal(parsePersonalInvite('NLPINV1|bad|code|owner|date'), null);

assert.equal(validUrl('https://example.com/event'), 'https://example.com/event');
assert.equal(validUrl('javascript:alert(1)'), null);
assert.equal(validUrl('not-a-url'), null);

// /embed remains the existing custom Embed system.
const payload = messagePayload({
  title: 'فعالية Neverless',
  message: 'تفاصيل الفعالية',
  imageUrl: 'https://example.com/banner.png',
  linkUrl: 'https://example.com/join',
  buttonText: 'التفاصيل',
});
assert.equal(payload.embeds.length, 1);
assert.equal(payload.components.length, 1);
assert.equal(payload.embeds[0].data.title, 'فعالية Neverless');
assert.equal(payload.embeds[0].data.image.url, 'https://example.com/banner.png');

// /broadcast is plain Discord content so Discord can generate native URL/image previews.
const broadcasts = broadcastPayloads({
  title: null,
  message: 'بعض الأماكن لكن تمر عليها... وبعضها يصير مكانك.',
  linkUrl: 'https://discord.gg/example',
  imageUrl: 'https://example.com/banner.png',
});
assert.equal(broadcasts.length, 1);
assert.equal(Boolean(broadcasts[0].embeds), false);
assert.equal(Boolean(broadcasts[0].components), false);
assert.match(broadcasts[0].content, /discord\.gg\/example/);
assert.match(broadcasts[0].content, /banner\.png/);
assert.equal(broadcasts[0].allowedMentions.parse.length, 0);

const titled = broadcastPayloads({ title: 'HUB', message: 'خذ مكانك.', imageUrl: null, linkUrl: null });
assert.equal(titled[0].content, '**HUB**\nخذ مكانك.');

const chunks = splitPlainMessage('a'.repeat(3900));
assert.ok(chunks.length >= 2);
assert.ok(chunks.every((chunk) => chunk.length <= 1900));

console.log('server tool tests passed');
