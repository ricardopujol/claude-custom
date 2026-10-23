'use strict';
/**
 * The Style tab's switch for the claude-custom mod (BACKLOG #119 A2), next to the panel's: source assertions in the style of
 * test/renderer-canvas-wiring.test.js, because main.js and the renderer need Electron or a DOM. The file the switch writes and the
 * host reads is covered by test/cc-mod-settings.test.js; the view and reducer by test/style-display.test.js.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const MAIN = strip(read('app', 'main.js'));
const PRELOAD = strip(read('app', 'preload.js'));
const JS = read('app', 'renderer.js');

test('main answers the switch only to a tab page, from the same state folder the host reads', () => {
  assert.match(MAIN, /const \{ readModSetting, writeModSetting \} = require\('\.\.\/host\/cc-mod-settings'\);/);
  assert.match(MAIN, /ipcMain\.handle\('ccmod:settings-get', \(e\) => \(isTabView\(e\.sender\) \? readModSetting\(uiStore\.dir\) : null\)\);/);
  assert.match(MAIN, /ipcMain\.handle\('ccmod:settings-set', \(e, on\) => \(isTabView\(e\.sender\) && typeof on === 'boolean' \? writeModSetting\(uiStore\.dir, on\) : null\)\);/);
});

test('the preload offers exactly get and set on their own channels', () => {
  assert.match(PRELOAD, /ccMod: \{\s*settingsGet: \(\) => ipcRenderer\.invoke\('ccmod:settings-get'\),\s*settingsSet: \(on\) => ipcRenderer\.invoke\('ccmod:settings-set', on\),\s*\},/);
});

test('the Panel section draws the mod\'s checkbox with its description, disabled while unknown', () => {
  assert.match(JS, /id="style-cc-mod"\$\{v\.mod === true \? ' checked' : ''\}\$\{v\.mod === null \? ' disabled' : ''\}/);
  assert.match(JS, /escapeHtml\(v\.modDescription\)/);
});

test('the checkbox sends the desired state, settles on main\'s answer and re-reads on null', () => {
  assert.match(JS, /window\.harness\.ccMod\.settingsSet\(ccModBox\.checked\)\.then\(settledCcMod\)\.catch\(\(\) => refreshCcMod\(\)\);/);
  assert.match(JS, /function settledCcMod\(value\) \{\s*if \(typeof value === 'boolean'\) \{ styleState = reduceCcMod\(styleState, value\); renderStylePanel\(\); \} else refreshCcMod\(\);/);
  assert.match(JS, /^refreshCcMod\(\);/m);
});

test('the re-read backs off with the panel switch\'s own delays and never stacks a second loop', () => {
  const fn = JS.slice(JS.indexOf('function refreshCcMod('), JS.indexOf('function settledChrome('));
  assert.match(fn, /if \(attempt === 0\) \{ if \(ccModLoop\) return; ccModLoop = true; \}/);
  assert.match(fn, /canvasMcpRetryDelay\(attempt\)/);
  assert.match(fn, /if \(wait === null\) \{ ccModLoop = false; return; \}/);
});
