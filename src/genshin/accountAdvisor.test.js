'use strict';

const assert = require('node:assert/strict');
const {
  isWhoBuild,
  isAccountSummary,
  isAccountMissing,
  isMemberCompare,
  isBestTeam,
  isAbyssTeams,
  isWhatChanged,
  bestAbyssPair,
  abyssAffinity,
  formatBestTeam,
} = require('./accountAdvisor');

assert.equal(isWhoBuild('مين ابني'), true);
assert.equal(isWhoBuild('who should i build'), true);
assert.equal(isAccountSummary('ملخص حسابي'), true);
assert.equal(isAccountMissing('شنو ناقص حسابي'), true);
assert.equal(isMemberCompare('قارن Skirk مع <@123456789012345678>'), true);
assert.equal(isBestTeam('أفضل تيم عندي'), true);
assert.equal(isAbyssTeams('تيمين Abyss'), true);
assert.equal(isWhatChanged('وش تغير Skirk'), true);

const catalog = [
  { team: ['A', 'B', 'C', 'D'], coverage: 4, buildAverage: 90, category: 'Freeze', missing: [], extrasUsed: [] },
  { team: ['E', 'F', 'G', 'H'], coverage: 4, buildAverage: 85, category: 'Vaporize', missing: [], extrasUsed: [] },
  { team: ['A', 'I', 'J', 'K'], coverage: 4, buildAverage: 99, category: 'Freeze', missing: [], extrasUsed: [] },
];
const pair = bestAbyssPair(catalog, { firstHalfTags: ['Freeze'], secondHalfTags: ['Vaporize'] });
assert.equal(pair.first.category, 'Freeze');
assert.equal(pair.second.category, 'Vaporize');
assert.equal(pair.first.team.some((name) => pair.second.team.includes(name)), false);
assert.ok(abyssAffinity(pair.first, ['Freeze']) > abyssAffinity(pair.first, ['Vaporize']));

const text = formatBestTeam({ best: { team: ['Skirk', 'Escoffier', 'Furina', 'Yelan'], category: 'Freeze', role: '', coverage: 4, missing: [], extrasUsed: ['Yelan'] } }, ['Yelan'], 'ar');
assert.match(text, /Skirk/);
assert.match(text, /Yelan/);
assert.match(text, /البيلد المقترح/);

console.log('account advisor tests passed');
