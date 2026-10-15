'use strict';
/**
 * BACKLOG #43: app/shortcut-table.js and app/shortcuts-display.js as the renderer loads them, as plain <script> files in
 * one shared scope. Reads the files as text to run them in a vm, so it is repo-scanning and NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const { ROWS, keysText } = require('../app/shortcut-table');

test('loaded as a plain <script> (no module system) it declares no top-level names and publishes one namespace', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(read('shortcut-table.js'), ctx);
  vm.runInContext(read('shortcuts-display.js'), ctx);
  assert.strictEqual(typeof ctx.shortcutsDisplay.sheetBodyHtml, 'function');
  assert.strictEqual(typeof ctx.shortcutTable.filterRows, 'function');
  assert.doesNotThrow(() => vm.runInContext('const sheetBodyHtml = 1; const ROWS = 2; const GROUPS = 3; const escapeHtml = 4;', ctx));
  assert.ok(ctx.shortcutsDisplay.sheetBodyHtml('').includes(keysText(ROWS[0]).split('+')[0]));
});
