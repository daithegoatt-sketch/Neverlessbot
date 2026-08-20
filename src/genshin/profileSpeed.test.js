'use strict';

const assert = require('node:assert/strict');
const { latestValidRating, validSavedRating } = require('./profileRouter');
const { getCachedNeverlessLeaderboard } = require('./leaderboard');

const oldValid = { evaluation: { score: 79 }, savedAt: '2026-08-19T10:00:00Z' };
const newestZero = { evaluation: { score: 0 }, savedAt: '2026-08-20T10:00:00Z' };
assert.equal(validSavedRating(oldValid), true);
assert.equal(validSavedRating(newestZero), false);
assert.equal(latestValidRating([oldValid, newestZero]), oldValid);
assert.equal(getCachedNeverlessLeaderboard(null), null);
assert.equal(getCachedNeverlessLeaderboard({ id: 'never-built' }), null);

console.log('profile speed regression tests passed');
