'use strict';
/**
 * main.js's half of the kill switch's STOP ALL button (documentation/PLAN_SAFETY_NET.md lane 2): the strip asks, main confirms once
 * and writes ~/.claude/STOP-ALL through host/atomic-write.js. The decision is host/kill-switch.js requestStopAll's (tested in
 * test/kill-switch.test.js); these pin main's wiring of it. Source assertions: main.js can't be loaded by a unit test.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

function block(startMarker, endMarker) {
  const at = MAIN.indexOf(startMarker);
  assert.ok(at !== -1, `missing: ${startMarker}`);
  const end = MAIN.indexOf(endMarker, at + startMarker.length);
  assert.ok(end !== -1, `missing end: ${endMarker}`);
  return MAIN.slice(at, end);
}

test('main requires the kill switch and the atomic write by name', () => {
  assert.match(MAIN, /const \{ stopAllHome, sentinelsFor, requestStopAll \} = require\('\.\.\/host\/kill-switch'\);/);
  assert.match(MAIN, /const \{ writeFileAtomic \} = require\('\.\.\/host\/atomic-write'\);/);
});

test('strip:stopAll answers only this window\'s strip, one at a time', () => {
  const b = block("ipcMain.handle('strip:stopAll', async (e) => {", '\n  });');
  assert.match(b, /if \(!fromStrip\(e\) \|\| stopAllBusy\) return null;/);
  assert.match(b, /stopAllBusy = true;/);
  assert.match(b, /finally \{ stopAllBusy = false; \}/);
});

test('the file is the one every host watches: STOP-ALL in the home folder\'s .claude (or the probe seam), written atomically', () => {
  const b = block("ipcMain.handle('strip:stopAll', async (e) => {", '\n  });');
  assert.match(b, /sentinelsFor\(\{ claudeHome: stopAllHome\(\{ seam: readSeams\(process\.env\)\.claudeHome, home: require\('os'\)\.homedir\(\) \}\) \}\)\[0\]/);
  assert.match(b, /requestStopAll\(\{ file, confirm: \(\) => confirmStopAll\(file\), write: \(f, data\) => writeFileAtomic\(f, data\) \}\)/);
});

test('a failed write is said in a dialog, not swallowed', () => {
  const b = block("ipcMain.handle('strip:stopAll', async (e) => {", '\n  });');
  assert.match(b, /if \(r\.outcome === 'failed'[ )&]/);
  assert.match(b, /dialog\.showMessageBox\(win, \{ type: 'error'/);
});

test('the confirm: one question, Cancel is the default, and the probe driver never writes the real file', () => {
  const b = block('async function confirmStopAll(file) {', '\n}\n');
  assert.match(b, /if \(PROBE_PORT\) \{ probeConfirms\.push\(\{ label: 'stop-all'/);
  assert.match(b, /return false; \}/);
  assert.match(b, /defaultId: 1,/);
  assert.match(b, /cancelId: 1,/);
  assert.match(b, /return r\.response === 0;/);
});
