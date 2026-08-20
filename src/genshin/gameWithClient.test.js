'use strict';

const assert = require('node:assert/strict');
const { parseStatGoals, numericGoal, targetValue } = require('./gameWithClient');

const neuvHtml = `
<html><body>
<h2>Stat Goals For Neuvillette</h2>
<table>
<tr><th>Stat</th><th>Goal</th></tr>
<tr><td>HP</td><td>30,000+</td></tr>
<tr><td>CRIT Rate</td><td>49% (Marechaussee Hunter can add up to 36%)</td></tr>
<tr><td>CRIT DMG</td><td>300% or More</td></tr>
<tr><td>Energy Recharge</td><td>180% or More</td></tr>
</table>
<table><tr><td>Priority Sub-Stats</td><td>CRIT DMG > CRIT Rate > HP%</td></tr></table>
</body></html>`;

const neuv = parseStatGoals('Neuvillette', neuvHtml);
assert.deepEqual(neuv.targets, [
  'HP: 30,000+',
  'CRIT Rate: 49%',
  'CRIT DMG: 300%+',
]);
assert.doesNotMatch(neuv.targets.join(' '), /ER:/);
assert.match(neuv.priority, /CRIT DMG/);

const mavuikaHtml = `
<html><body>
<h3>Stat Goals For On-Field Mavuika</h3>
<table>
<tr><td>ATK</td><td>2,000 or above</td></tr>
<tr><td>CRIT Rate</td><td>60% or More (with Obsidian Codex)</td></tr>
<tr><td>CRIT DMG</td><td>200%+</td></tr>
<tr><td>Elemental Mastery</td><td>100 or More</td></tr>
<tr><td>Energy Recharge</td><td>None</td></tr>
</table>
</body></html>`;

const mavuika = parseStatGoals('Mavuika', mavuikaHtml);
assert.deepEqual(mavuika.targets, [
  'ATK: 2,000+',
  'CRIT Rate: 60%+',
  'CRIT DMG: 200%+',
  'EM: 100+',
]);

assert.equal(numericGoal('ER', '180%+'), null);
assert.equal(numericGoal('CRIT Rate', '49% (bonus can reach 36%)'), 'CRIT Rate: 49%');
assert.equal(targetValue('60 - 70%'), '60–70%');

console.log('secondary stat goal tests passed');
