'use strict';
/**
 * BACKLOG #43: the shortcuts page's ONE key table (app/shortcut-table.js).
 *
 * The page lists every key the app handles. Three places handle keys: main's `shortcutFor` (app/tab-shell.js), the
 * renderer's own handlers (app/renderer.js), and the CLI (not ours; listed, marked "Claude Code"). A row for a key the
 * app handles must stay true: each main-owned row names its `action` and a `sample` input, and `shortcutFor(sample)`
 * must return that action. A key added to `shortcutFor` without a row fails here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { GROUPS, ROWS, keysText, filterRows, groupedRows } = require('../app/shortcut-table');
const { shortcutFor } = require('../app/tab-shell');

test('every row is in one of the four groups, in the order Tabs, Panels, Claude Code, This page', () => {
  assert.deepStrictEqual(GROUPS, ['Tabs', 'Panels', 'Claude Code', 'This page']);
  for (const r of ROWS) assert.ok(GROUPS.includes(r.group), `${r.name}: ${r.group}`);
  for (const g of GROUPS) assert.ok(ROWS.some(r => r.group === g), `group ${g} is empty`);
});

test('every row has a name, keys, and an owner of app or claude', () => {
  for (const r of ROWS) {
    assert.ok(typeof r.name === 'string' && r.name !== '', JSON.stringify(r));
    assert.ok(Array.isArray(r.keys) && r.keys.length > 0 && r.keys.every(k => typeof k === 'string' && k !== ''), r.name);
    assert.ok(r.owner === 'app' || r.owner === 'claude', r.name);
  }
});

test('keysText joins the keys with +', () => {
  assert.strictEqual(keysText({ keys: ['Ctrl', 'Shift', 'D'] }), 'Ctrl+Shift+D');
  assert.strictEqual(keysText({ keys: ['F1'] }), 'F1');
});

test('every row main owns names an action, and shortcutFor(sample) gives that action', () => {
  const mains = ROWS.filter(r => r.handler === 'main');
  assert.ok(mains.length >= 8);
  for (const r of mains) {
    assert.ok(r.action && r.sample, `${r.name} needs an action and a sample`);
    const input = { type: 'keyDown', control: false, shift: false, alt: false, meta: false, ...r.sample };
    assert.strictEqual(shortcutFor(input), r.action, `${r.name}: ${keysText(r)}`);
  }
});

test('the keys the CLI owns are listed and marked Claude Code', () => {
  const cli = ROWS.filter(r => r.owner === 'claude');
  for (const k of ['Esc', 'Shift+Tab']) assert.ok(cli.some(r => keysText(r) === k), `${k} should be listed as the CLI's`);
  for (const r of cli) assert.strictEqual(r.group, 'Claude Code', r.name);
  for (const r of cli) assert.strictEqual(r.handler, 'claude', r.name);
});

test('the page itself: F1 opens it, Esc closes it', () => {
  const page = ROWS.filter(r => r.group === 'This page');
  assert.ok(page.some(r => keysText(r) === 'F1'));
  assert.ok(page.some(r => keysText(r) === 'Esc'));
});

test('no two rows share a name and key (a duplicate would be a stale copy)', () => {
  const seen = new Set();
  for (const r of ROWS) {
    const id = `${r.name}|${keysText(r)}`;
    assert.ok(!seen.has(id), id);
    seen.add(id);
  }
});

// --- search ---------------------------------------------------------------------

test('filterRows: empty or blank query keeps every row', () => {
  assert.strictEqual(filterRows('').length, ROWS.length);
  assert.strictEqual(filterRows('   ').length, ROWS.length);
  assert.strictEqual(filterRows(undefined).length, ROWS.length);
  assert.strictEqual(filterRows(null).length, ROWS.length);
});

test('filterRows: finds by name and by key, ignoring case, spacing and +', () => {
  const names = (q) => filterRows(q).map(r => r.name);
  assert.ok(names('panels').some(n => /panel/i.test(n)));
  assert.ok(filterRows('ctrl+b').some(r => keysText(r) === 'Ctrl+B'));
  assert.ok(filterRows('CTRL B').some(r => keysText(r) === 'Ctrl+B'));
  assert.ok(filterRows('ctrl + shift + d').some(r => keysText(r) === 'Ctrl+Shift+D'));
  assert.ok(filterRows('f1').some(r => keysText(r) === 'F1'));
  assert.deepStrictEqual(filterRows('zzzzqq'), []);
});

test('filterRows: a word matches the START of a word, not the middle (a lone "b" is not every "Tab")', () => {
  const got = filterRows('ctrl+b').map(r => r.name);
  assert.ok(!got.includes('Next tab'), 'Ctrl+Tab has a b only inside "Tab"');
  assert.ok(!got.includes('Previous tab'));
  assert.ok(got.includes('Show or hide every panel'));
  assert.ok(!filterRows('anel').some(r => /panel/i.test(r.name)), 'the middle of "panel" is not a match');
});

test('filterRows: every word must match, so a longer query narrows', () => {
  assert.ok(filterRows('ctrl tab').length <= filterRows('ctrl').length);
  assert.ok(filterRows('ctrl tab').every(r => /tab/i.test(r.name + keysText(r))));
});

test('groupedRows: keeps the group order and drops groups with no match', () => {
  assert.deepStrictEqual(groupedRows('').map(g => g.group), GROUPS);
  const g = groupedRows('f1');
  assert.ok(g.length >= 1 && g.every(x => x.rows.length > 0));
  assert.ok(g.every(x => x.rows.every(r => r.group === x.group)));
  assert.deepStrictEqual(groupedRows('zzzzqq'), []);
});

test('PROPERTY: a filter returns a subset, in table order, and a row always matches its own name and its own keys', () => {
  fc.assert(fc.property(fc.string({ maxLength: 12 }), (q) => {
    const got = filterRows(q);
    let last = -1;
    for (const r of got) { const i = ROWS.indexOf(r); assert.ok(i > last); last = i; }
  }));
  for (const r of ROWS) {
    assert.ok(filterRows(r.name).includes(r), `name of ${r.name}`);
    assert.ok(filterRows(keysText(r)).includes(r), `keys of ${r.name}`);
    assert.ok(filterRows(keysText(r).toLowerCase()).includes(r), `lowercase keys of ${r.name}`);
  }
});
