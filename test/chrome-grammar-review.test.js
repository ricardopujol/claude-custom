'use strict';
/**
 * Miguel's round-1 review of PR #215 (chrome grammar), pinned: each finding's fix, read from the sources (renderer.js cannot be
 * required, and CSS has no other test). Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
const HTML = read('renderer.html');
const JS = read('renderer.js');
const DOCK = read('dock-tree-display.js');

test('finding 1: only a running suite shimmers; an unknown HP is a dashed border and nothing moves', () => {
  const shimmer = HTML.split('\n').filter(l => l.includes('animation: chip-shimmer'));
  assert.strictEqual(shimmer.length, 1);
  const rule = HTML.slice(0, HTML.indexOf('animation: chip-shimmer')).split('}').pop();
  assert.ok(rule.includes('.chip-hp:has(> #hp.running)'), 'the shimmer rule names the running chip');
  assert.ok(!rule.includes('#hp.unknown'), 'and not the unknown one');
  assert.match(HTML, /\.chip-hp:has\(> #hp\.unknown\)[^{]*\{[^}]*border-style: dashed/);
});

test('finding 2: renderHealth draws from chipModel.healthChip and remembers the last known value; a stale chip is dimmed', () => {
  assert.match(JS, /chipModel\.healthChip\(h, lastHealthKnown\)/);
  assert.match(JS, /if \(view\.known\) lastHealthKnown = view\.known/);
  assert.match(HTML, /#hp\.stale[^{]*\{[^}]*opacity/);
});

test('finding 3: the status-fields hover is built from the chips, not a regex over the joined text', () => {
  assert.match(JS, /statusFieldsEl\.title = view\.chips\.map\(\(c\) => c\.text\)\.join\(', '\)/);
  assert.doesNotMatch(JS, /view\.text\.replace\(/);
});

test('finding 4: no rule for a loading state nothing sets, and no duplicate in the reduced-motion block', () => {
  assert.ok(!HTML.includes('#hdr-warn.is-loading'));
  assert.ok(!/@media \(prefers-reduced-motion: reduce\) \{\s*#usage\.has-note, #quota\.is-note \{ border-style: dashed; \}/.test(HTML), 'the no-op border-style duplicate is gone');
});

test('finding 5: RAIL_SEP_PX is the 1 px line plus the margins in the CSS', () => {
  const css = HTML.match(/\.drail\[data-dir="h"\] \.rail-sep \{ width: (\d+)px; margin: \d+px (\d+)px; \}/);
  assert.ok(css, 'the horizontal separator rule');
  const px = Number(DOCK.match(/const RAIL_SEP_PX = (\d+);/)[1]);
  assert.strictEqual(px, Number(css[1]) + 2 * Number(css[2]));
});

test('finding 6: the project total is in the usage chip\'s own hover, so hiding its group keeps it reachable', () => {
  assert.match(JS, /usageEl\.title = `\$\{sessionTitle\}\\n\$\{projectTitle\}`/);
});
