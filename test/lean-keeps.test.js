'use strict';
/**
 * Lean mode keeps the Schedules panel mounted (PR #200, Ricardo 2026-10-21): its content is the night itself, so it must stay
 * live while a /bedtime night runs. Every other panel is unmounted exactly as before.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../app/lean-display');

test('LEAN_KEEPS names the Schedules panel and nothing else', () => {
  assert.deepStrictEqual([...L.LEAN_KEEPS], ['schedules']);
});

test('leanShown: lean keeps schedules mounted and unmounts every other panel', () => {
  const shown = new Set(['git', 'schedules', 'vault', 'agents']);
  assert.deepStrictEqual([...L.leanShown(shown, true)], ['schedules']);
});

test('leanShown: lean with schedules not on the dock mounts nothing (the exemption never adds a panel)', () => {
  assert.deepStrictEqual([...L.leanShown(new Set(['git', 'vault']), true)], []);
});

test('leanShown: not lean is the plan untouched', () => {
  const shown = new Set(['git', 'schedules']);
  assert.deepStrictEqual([...L.leanShown(shown, false)], ['git', 'schedules']);
});

test('leanShown: only a real true is lean (absence is not lean)', () => {
  const shown = new Set(['git']);
  assert.deepStrictEqual([...L.leanShown(shown, undefined)], ['git']);
  assert.deepStrictEqual([...L.leanShown(shown, 'yes')], ['git']);
});

test('renderLayout takes its shown set from leanShown, so Schedules stays mounted under lean', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.match(src, /const now = leanDisplay\.leanShown\(plan\.shown, leanOn\)/);
});

// --- visibility (PR #200, Ricardo 2026-10-21): kept means DRAWN, not only mounted --------------------------------------------------

const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8').replace(/\r\n/g, '\n');
const CSS = HTML.slice(HTML.indexOf('<style'), HTML.lastIndexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
// the declarations blocks of every rule whose selector list mentions `body.lean`, as { selectors: [..], body }
const leanRules = () => [...CSS.matchAll(/([^{}]*\bbody\.lean\b[^{}]*)\{([^}]*)\}/g)]
  .map(m => ({ selectors: m[1].split(',').map(s => s.trim()).filter(Boolean), body: m[2] }));

test('body.lean hides a dock box (.zone) only when it carries no data-lean-keep mark', () => {
  const hide = leanRules().filter(r => /display:\s*none/.test(r.body)).flatMap(r => r.selectors);
  assert.ok(hide.includes('body.lean .zone:not([data-lean-keep])'), 'the zone hide rule is scoped to unmarked boxes');
  assert.ok(!hide.includes('body.lean .zone'), 'and no plain "body.lean .zone" hide is left');
});

test('body.lean still hides the header, the diag line, the dividers, the rail and the drag overlay', () => {
  const hide = leanRules().filter(r => /display:\s*none/.test(r.body)).flatMap(r => r.selectors);
  for (const s of ['body.lean header', 'body.lean #diag', 'body.lean .dgutter', 'body.lean .drail', 'body.lean #dock-overlay']) assert.ok(hide.includes(s), s);
});

test('the terminal fills the page under lean only while no kept box is drawn; with one, it keeps the plan\'s rectangle beside it', () => {
  const rules = leanRules().filter(r => r.selectors.some(s => s.includes('#termwrap')));
  assert.strictEqual(rules.length, 1);
  assert.ok(rules[0].selectors.every(s => s.includes(':not(:has(.dgroup[data-lean-keep]))')), rules[0].selectors.join(' | '));
  assert.match(rules[0].body, /width:\s*100%\s*!important/);
});

test('applyBoxes is handed LEAN_KEEPS by the renderer, so the mark has one source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.match(src, /window\.dockTreeView\.applyBoxes\(plan, document, leanDisplay\.LEAN_KEEPS\)/);
});

test('under lean a marked box hides its tab bar, so no tab click can switch Schedules out (Miguel Y1)', () => {
  const r = leanRules().find(x => x.selectors.includes('body.lean .zone[data-lean-keep] .zone-tabs'));
  assert.ok(r, 'the rule exists');
  assert.match(r.body, /display:\s*none/);
});
