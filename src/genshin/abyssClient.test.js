'use strict';

const assert = require('node:assert/strict');
const { parseAbyssHtml, tagsFrom } = require('./abyssClient');

const html = `
<html><body>
<h1>Spiral Abyss Floor 12 Guide for Version 6.X</h1>
<table><tr><th>Ley Line Disorder</th><td>First Half Anemo DMG +75%. Second Half Cryo Normal Attack DMG +75%.</td></tr></table>
<h3>Blessing of the Abyssal Moon: Windlash Moon</h3>
<h3>Best Team Comps For Floor 12</h3>
<h4>First Half</h4>
<div>Swirl-Pyro and Swirl-Electro teams are recommended.</div>
<h4>Second Half</h4>
<div>Freeze teams are recommended. Cryo and Hydro are favored.</div>
<h3>Best Characters to Use</h3>
</body></html>`;

const parsed = parseAbyssHtml(html);
assert.match(parsed.title, /Floor 12/);
assert.match(parsed.leyLine, /Anemo/);
assert.equal(parsed.blessing, 'Blessing of the Abyssal Moon: Windlash Moon');
assert.ok(parsed.firstHalfTags.includes('Swirl-Pyro'));
assert.ok(parsed.firstHalfTags.includes('Swirl-Electro'));
assert.ok(parsed.secondHalfTags.includes('Freeze'));
assert.ok(tagsFrom('Use Hyperbloom or Freeze').includes('Hyperbloom'));

console.log('abyss client tests passed');
