'use strict';
/**
 * BACKLOG #43: the shortcuts page's key table against the SOURCE of the code that handles keys (app/tab-shell.js,
 * app/main.js, app/renderer.js). Split from test/shortcut-table.test.js because it reads those files as text: it is
 * repo-scanning, so deliberately NOT in Stryker's command (test/stryker-config.test.js REPO_SCANNING).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ROWS, keysText } = require('../app/shortcut-table');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('every action shortcutFor can return has a row (a key added there without a row fails here)', () => {
  const src = read('app', 'tab-shell.js');
  const start = src.indexOf('function shortcutFor(');
  const body = src.slice(start, src.indexOf('\n}', start));
  const returned = new Set([...body.matchAll(/return (?:[^;]*\? )?'([a-z-]+)'/g)].map(m => m[1])
    .concat([...body.matchAll(/: '([a-z-]+)'/g)].map(m => m[1])));
  assert.ok(returned.size >= 8, [...returned].join());
  const inTable = new Set(ROWS.filter(r => r.handler === 'main').map(r => r.action));
  for (const a of returned) assert.ok(inTable.has(a), `shortcutFor returns '${a}' but no row lists it`);
});

test('every action main.js dispatches on has a row', () => {
  const src = read('app', 'main.js');
  const start = src.indexOf('function registerShortcuts(');
  const body = src.slice(start, src.indexOf('\n}', start));
  const used = new Set([...body.matchAll(/action === '([a-z-]+)'/g)].map(m => m[1]));
  assert.ok(used.size >= 7, [...used].join());
  const inTable = new Set(ROWS.map(r => r.action).filter(Boolean));
  for (const a of used) assert.ok(inTable.has(a), `main.js handles '${a}' but no row lists it`);
});

test('every key the renderer handles itself is a row, and the code it points at is still there', () => {
  const js = read('app', 'renderer.js');
  const own = ROWS.filter(r => r.handler === 'renderer');
  for (const needle of ["e.code === 'KeyD'", 'isPanelToggle(e)', 'isPasteKey(e)', 'copyKeyAction(', "e.key === 'Enter' && e.shiftKey"]) {
    assert.ok(js.includes(needle), `renderer.js no longer contains ${needle}: update the table`);
    assert.ok(own.some(r => r.where === needle), `no renderer row points at ${needle}`);
  }
  for (const r of own) assert.ok(js.includes(r.where), `${r.name}: renderer.js lacks ${r.where}`);
});
