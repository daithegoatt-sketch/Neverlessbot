'use strict';

const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { parseTable } = require('./teamGroupClient');

const NAMES = [
  'Arlecchino', 'Bennett', 'Nicole', 'Yelan', 'Citlali', 'Fischl', 'Emilie', 'Kazuha',
  'Xilonen', 'Escoffier', 'Chevreuse', 'Thoma', 'Xiangling',
  'Sandrone', 'Yae Miko', 'Beidou', 'Qiqi',
  'Mavuika', 'Iansan', 'Durin',
];

function parse(html, scope, mainName) {
  const $ = cheerio.load(html);
  return parseTable($('table').first()[0], $, scope, NAMES, mainName);
}

const arlecchino = parse(`
<table>
  <tr><th colspan="4">Arlecchino Pyro DPS Teams</th></tr>
  <tr>
    <td>Arlecchino</td>
    <td>Bennett<br>Nicole</td>
    <td>Yelan<br>Citlali<br>Fischl<br>Emilie<br>Kazuha</td>
    <td>Xilonen<br>Escoffier<br>Chevreuse<br>Thoma<br>Xiangling</td>
  </tr>
  <tr><td colspan="4">Team Summary: Arlecchino can use Vaporize, Melt, Overload, Burning, and Mono-Pyro teams.</td></tr>
</table>`, { h2: 'Arlecchino DPS Teams', h3: null, h4: null }, 'Arlecchino');

assert.equal(arlecchino.length, 5, 'consolidated Arlecchino table should split into five reaction groups');
assert.deepEqual(arlecchino.map((group) => group.category), ['Vaporize', 'Melt', 'Overload', 'Burning', 'Mono-Pyro']);
for (const group of arlecchino) {
  assert.deepEqual(group.slotTeams[0][1], ['Bennett', 'Nicole'], 'Bennett/Nicole must stay alternatives in one slot');
  assert.equal(group.slotTeams[0][2].length, 1, 'reaction enabler slot should be narrowed to the source reaction row');
  assert.equal(group.slotTeams[0][3].length, 1, 'reaction support slot should be narrowed to the source reaction row');
}

const sandrone = parse(`
<table>
  <tr><th colspan="4">Sandrone Best Stellar-Conduct Team</th></tr>
  <tr>
    <td>Sandrone</td>
    <td>Yae Miko (C1)<br>Beidou (C6)</td>
    <td>Qiqi<br>Escoffier</td>
    <td>Nicole</td>
  </tr>
  <tr><td colspan="4">Team Summary: Stellar-Conduct setup.</td></tr>
</table>`, { h2: 'Stellar-Conduct Teams', h3: null, h4: null }, 'Sandrone');

assert.equal(sandrone.length, 1);
assert.deepEqual(sandrone[0].slotTeams[0], [
  ['Sandrone'],
  ['Yae Miko', 'Beidou'],
  ['Qiqi', 'Escoffier'],
  ['Nicole'],
]);
assert.equal(sandrone[0].requirements['yae miko'].constellation, 1);
assert.equal(sandrone[0].requirements.beidou.constellation, 6);
assert.ok(sandrone[0].teams.length >= 2);
assert.ok(!sandrone[0].teams.some((team) => team.includes('Yae Miko') && team.includes('Beidou')), 'same-slot alternatives must never become two party members');
assert.ok(!sandrone[0].teams.some((team) => team.includes('Qiqi') && team.includes('Escoffier')), 'same-slot alternatives must never become two party members');

const mavuika = parse(`
<table>
  <tr><th colspan="4">On-Field Melt Team</th></tr>
  <tr><th>Main DPS</th><th>Sub-DPS</th><th>Support</th><th>Support</th></tr>
  <tr><td>Mavuika</td><td>Citlali</td><td>Iansan</td><td>Bennett</td></tr>
  <tr><td>Mavuika</td><td>Citlali</td><td>Nicole</td><td>Durin</td></tr>
</table>`, { h2: 'Mavuika Main DPS Teams', h3: 'On-Field Melt Team', h4: null }, 'Mavuika');

assert.equal(mavuika.length, 1);
assert.equal(mavuika[0].teams.length, 2, 'standard row-based Game8 tables should keep their exact rows');
assert.deepEqual(mavuika[0].teams[0], ['Mavuika', 'Citlali', 'Iansan', 'Bennett']);
assert.deepEqual(mavuika[0].teams[1], ['Mavuika', 'Citlali', 'Nicole', 'Durin']);

console.log('teamGroupClient regression checks passed');
