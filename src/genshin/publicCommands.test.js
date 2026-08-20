'use strict';

const assert = require('node:assert/strict');
const {
  parseBannerCommand,
  parseQuestCommand,
  parseCodeCommand,
  parseBannerCountdownCommand,
  parseRedeemCommand,
  buildBannerEmbeds,
  shouldHandlePublicMessage,
  remainingText,
} = require('./publicCommands');
const { parseNotice, selectNotice, extractByRarity, phaseFromSubject } = require('./bannerClient');
const { parseYoutubeResults } = require('./questClient');

assert.deepEqual(parseBannerCommand('-بنر'), { type: 'character', mode: 'current' });
assert.deepEqual(parseBannerCommand('-بانر'), { type: 'character', mode: 'current' });
assert.deepEqual(parseBannerCommand('-banner'), { type: 'character', mode: 'current' });
assert.deepEqual(parseBannerCommand('-البنر القادم'), { type: 'character', mode: 'upcoming' });
assert.deepEqual(parseBannerCommand('-coming banner'), { type: 'character', mode: 'upcoming' });
assert.deepEqual(parseBannerCommand('-upcoming banner'), { type: 'character', mode: 'upcoming' });
assert.deepEqual(parseBannerCommand('-بنر الاسلحه'), { type: 'weapon', mode: 'current' });
assert.deepEqual(parseBannerCommand('-بانر الأسلحة القادم'), { type: 'weapon', mode: 'upcoming' });
assert.deepEqual(parseBannerCommand('-weapon banner'), { type: 'weapon', mode: 'current' });
assert.deepEqual(parseBannerCommand('-upcoming weapon banner'), { type: 'weapon', mode: 'upcoming' });
assert.equal(parseBannerCommand('بنر'), null);

assert.deepEqual(parseQuestCommand('-كويست "Chenyu Vale hidden quest"'), { quest: 'Chenyu Vale hidden quest' });
assert.deepEqual(parseQuestCommand('-quest In the Mountains'), { quest: 'In the Mountains' });
assert.equal(parseQuestCommand('كويست In the Mountains'), null);

assert.deepEqual(parseCodeCommand('-كود'), { type: 'codes' });
assert.deepEqual(parseCodeCommand('-أكواد'), { type: 'codes' });
assert.deepEqual(parseCodeCommand('-codes'), { type: 'codes' });
assert.equal(parseCodeCommand('كود'), null);

assert.deepEqual(parseBannerCountdownCommand('-كم باقي على البنر'), { type: 'countdown' });
assert.deepEqual(parseBannerCountdownCommand('-banner countdown'), { type: 'countdown' });
assert.match(remainingText((2 * 86400 + 3 * 3600 + 5 * 60) * 1000), /2 يوم.*3 ساعة.*5 دقيقة/);

assert.deepEqual(parseRedeemCommand('-ريديم'), { code: null });
assert.deepEqual(parseRedeemCommand('-ريديم ABC123'), { code: 'ABC123' });
assert.deepEqual(parseRedeemCommand('-redeem CODE123'), { code: 'CODE123' });
assert.equal(parseRedeemCommand('redeem CODE123'), null);

// Public prefix commands are intentionally server-wide; removed material commands must no longer route.
for (const content of ['-بنر', '-كويست In the Mountains', '-كود', '-كم باقي على البنر', '-ريديم ABC123']) {
  assert.equal(shouldHandlePublicMessage({ guildId: '1', channelId: 'random-general', author: { bot: false }, content }), true, content);
}
assert.equal(shouldHandlePublicMessage({ guildId: '1', channelId: 'random-general', author: { bot: false }, content: '-مواد Skirk' }), false);
assert.equal(shouldHandlePublicMessage({ guildId: '1', channelId: 'random-chat', author: { bot: true }, content: '-كود' }), false);
assert.equal(shouldHandlePublicMessage({ guildId: null, channelId: 'dm', author: { bot: false }, content: '-كود' }), false);

const officialText = `
Version "Luna VIII" Event Wishes Notice - Phase II
〓Event Wish Duration〓
2026/7/21 18:00–2026/8/11 14:59
● During this event wish, the event-exclusive 5-star character "Welkin Moon's Homecoming" Columbina (Hydro) will receive a huge drop-rate boost!
● During this event wish, the 4-star characters "Windthreading Shadow" Jahoda (Anemo), "Shadow of the Night-Wind" Ororon (Electro), and "Wisdom's Measure" Sethos (Electro) will receive a huge drop rate boost!
● During this event wish, the event-exclusive 5-star weapons Nocturne's Curtain Call (Catalyst) and Engulfing Lightning (Polearm) will receive a huge drop-rate boost!
● During the event, the event-exclusive 4-star weapon Waveriding Whirl (Catalyst), as well as the 4-star weapons Sacrificial Sword (Sword), The Bell (Claymore), Favonius Lance (Polearm), and Favonius Warbow (Bow) will receive a huge drop rate boost!
`;

const rated = extractByRarity(officialText);
assert.deepEqual(rated.fiveCharacters.map((row) => row.name), ['Columbina']);
assert.deepEqual(rated.fourCharacters.map((row) => row.name), ['Jahoda', 'Ororon', 'Sethos']);
assert.deepEqual(rated.fiveWeapons.map((row) => row.name), ["Nocturne's Curtain Call", 'Engulfing Lightning']);
assert.ok(rated.fourWeapons.some((row) => row.name === 'Sacrificial Sword'));
assert.equal(phaseFromSubject('Version "Luna VIII" Event Wishes Notice - Phase II'), 'II');

const full = {
  post: {
    post_id: '45647744',
    subject: 'Version "Luna VIII" Event Wishes Notice - Phase II',
    created_at: Math.floor(Date.UTC(2026, 6, 16) / 1000),
    structured_content: JSON.stringify([{ insert: officialText }]),
  },
  image_list: [
    { url: 'https://example.com/character-1.jpg' },
    { url: 'https://example.com/character-2.jpg' },
    { url: 'https://example.com/weapon.jpg' },
  ],
};
const notice = parseNotice(full);
assert.equal(notice.fiveCharacters[0].name, 'Columbina');
assert.equal(notice.fiveWeapons[0].name, "Nocturne's Curtain Call");
assert.equal(notice.startKnown, true);
assert.equal(notice.startAt, Date.UTC(2026, 6, 21, 18, 0));
assert.equal(notice.endAt, Date.UTC(2026, 7, 11, 14, 59));
assert.equal(notice.images.length, 3);

const current = {
  postId: 'old', createdAt: 1000, startKnown: true,
  startAt: Date.UTC(2026, 7, 1), endAt: Date.UTC(2026, 7, 20),
};
const announcedPhaseOne = {
  postId: 'new', createdAt: Date.UTC(2026, 7, 18), startKnown: false,
  startAt: null, endAt: Date.UTC(2026, 8, 9), phase: 'I',
};
const now = Date.UTC(2026, 7, 19);
assert.equal(selectNotice([current, announcedPhaseOne], 'current', now).postId, 'old');
assert.equal(selectNotice([current, announcedPhaseOne], 'upcoming', now).postId, 'new');
assert.equal(selectNotice([current, announcedPhaseOne], 'current', Date.UTC(2026, 7, 21)).postId, 'new');

const embeds = buildBannerEmbeds(notice, { type: 'weapon', mode: 'current' });
assert.equal(embeds.length, 1);
assert.match(embeds[0].data.description, /Nocturne's Curtain Call/);
assert.match(embeds[0].data.description, /HoYoLAB/);

const youtubeHtml = `{"videoRenderer":{"videoId":"abcdefghijk","title":{"runs":[{"text":"In the Mountains Quest Guide - Genshin Impact"}]}}}`;
const videos = parseYoutubeResults(youtubeHtml, 'In the Mountains');
assert.equal(videos[0].id, 'abcdefghijk');
assert.match(videos[0].title, /In the Mountains/);

console.log('public Genshin command tests passed');
