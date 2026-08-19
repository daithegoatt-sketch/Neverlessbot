'use strict';

const assert = require('node:assert/strict');
const { parsePersonalInvite, validUrl, messagePayload } = require('./serverTools');

const parsed = parsePersonalInvite('NLPINV1|1537000000000000000|abcDEF12|1537111111111111111|2026-08-19T02:00:00.000Z');
assert.equal(parsed.guildId, '1537000000000000000');
assert.equal(parsed.code, 'abcDEF12');
assert.equal(parsed.ownerId, '1537111111111111111');
assert.equal(parsePersonalInvite('NLPINV1|bad|code|owner|date'), null);

assert.equal(validUrl('https://example.com/event'), 'https://example.com/event');
assert.equal(validUrl('javascript:alert(1)'), null);
assert.equal(validUrl('not-a-url'), null);

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

console.log('server tool tests passed');
