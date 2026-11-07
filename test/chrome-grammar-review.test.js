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

test('finding 1: one shimmer rule, for a loading quota and a pending chip; nothing unknown moves', () => {
  const shimmer = HTML.split('\n').filter(l => l.includes('animation: chip-shimmer'));
  assert.strictEqual(shimmer.length, 1);
  const rule = HTML.slice(0, HTML.indexOf('animation: chip-shimmer')).split('}').pop();
  assert.ok(rule.includes('#quota.is-loading'), 'the shimmer rule names the loading quota');
  assert.ok(rule.includes('.chip:has(> .tb-chip.pending)'), 'and the pending chip');
});

// BACKLOG #163 (Ricardo 2026-11-06: "Remove it"). The HP heart (the test pass rate) left the top bar. host/health.js and
// app/chip-model.js's healthChip stay with their unit tests for a later game layer; nothing in the page draws them now.
test('#163: the HP heart is gone from the top bar: no markup, no CSS, no renderer wiring', () => {
  assert.ok(!HTML.includes('id="hp"'), 'no #hp element');
  assert.ok(!HTML.includes('chip-hp'), 'no chip-hp wrapper');
  assert.ok(!HTML.includes('heart-pulse'), 'no heart icon in the bar');
  assert.doesNotMatch(HTML, /#hp\b/, 'no #hp CSS rule');
  assert.ok(!HTML.includes('hp-pulse'), 'no hp-pulse keyframes');
  assert.ok(!JS.includes('renderHealth'), 'the renderer draws no health chip');
  assert.ok(!JS.includes('lastHealthKnown'), 'and keeps no last-known health');
  assert.ok(!JS.includes('chipModel.healthChip'), 'healthChip has no caller in the page');
  assert.ok(!JS.includes("closest('#hp')"), 'no click on the chip asks the host to run the suite');
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

test('r2 N1: each visible usage group\'s own hover carries both figures (a group title wins over the chip title)', () => {
  assert.match(JS, /<span class="grp" title="\$\{escapeHtml\(`\$\{sessionTitle\}\\n\$\{projectTitle\}`\)\}">/);
  assert.match(JS, /<span class="grp" title="\$\{escapeHtml\(`\$\{sessionTitle\}\\n\$\{projectTitle\}`\)\}">[\s\S]{0,200}<span class="grp" title="\$\{escapeHtml\(`\$\{sessionTitle\}\\n\$\{projectTitle\}`\)\}">/);
});

test('r2 N2: a pending hover-open does not open the popover once the chip is hidden', () => {
  assert.match(JS, /resPeekOpen = null; if \(!tbResourcesEl\.hidden\) resPopStep\(\{ type: 'hover-open' \}\)/);
});

test('finding 6: the project total is in the usage chip\'s own hover, so hiding its group keeps it reachable', () => {
  assert.match(JS, /usageEl\.title = `\$\{sessionTitle\}\\n\$\{projectTitle\}`/);
});

test('resources chip (pick A): only the number takes the level colour, the label stays grey, narrow drops labels and %', () => {
  assert.match(HTML, /#tb-resources \.tbr-v\.lv-amber \{ color: var\(--warn\); \}/);
  assert.match(HTML, /#tb-resources \.tbr-v\.lv-red \{ color: var\(--bad\); \}/);
  assert.match(HTML, /#tb-resources \.tbr-l \{ color: var\(--dim\); \}/);
  assert.ok(!HTML.includes('#tb-resources.res-amber') && !HTML.includes('#tb-resources.res-red'), 'the whole chip no longer changes colour');
  assert.match(HTML, /@media \(max-width: 1100px\) \{[^@]*#tb-resources \.tbr-l, #tb-resources \.tbr-pc \{ display: none; \}/);
});
