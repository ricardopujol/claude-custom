'use strict';
/**
 * The wiring of "which pages show the Resources panel" (BACKLOG #100 c), as source assertions in the style of
 * test/renderer-resources-wiring.test.js: renderer.js needs a real DOM, and verify/probe-shared-poller.js drives the
 * same path in real windows. The rules live in app/resources-service.js and host/poller-policy.js (tested directly).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const RAW = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const PRELOAD = strip(fs.readFileSync(path.join(APP, 'preload.js'), 'utf8'));
const MAIN = strip(fs.readFileSync(path.join(APP, 'main.js'), 'utf8'));
const BLOCK = strip(RAW.slice(RAW.indexOf('// RESOURCES-BEGIN'), RAW.indexOf('// RESOURCES-END')));

test('the bridge sends one boolean, fire-and-forget', () => {
  assert.match(PRELOAD, /viewing: \(on\) => ipcRenderer\.send\('resources:viewing', on === true\)/);
});

test('main takes it from tab views only, keyed by the page, and forgets a page that is destroyed', () => {
  assert.match(MAIN, /ipcMain\.on\('resources:viewing', \(e, on\) => \{ if \(isTabView\(e\.sender\) && resources\) noteResourcesViewer\(e\.sender, on === true\); \}\);/);
  assert.match(MAIN, /function noteResourcesViewer\(sender, on\) \{[\s\S]*?once\('destroyed'[\s\S]*?resources\.forgetViewer\([\s\S]*?resources\.setViewing\(sender\.id, on\)/);
});

test('the page reports whether the panel is on screen AND the page visible, only when that changes', () => {
  assert.match(BLOCK, /function reportResourcesViewing\(\) \{[\s\S]*?shownModules\.has\('resources'\) && document\.visibilityState === 'visible'/);
  assert.match(BLOCK, /if \(on === resViewingSent\) return;/);
  assert.match(BLOCK, /bridge\.viewing\(on\)/);
});

test('it is reported after every placement (the panel shown, hidden, peeked, popped) and when the page\'s visibility changes', () => {
  assert.match(RAW, /shownModules = now;[\s\S]{0,600}?ensureFontList\(\);[^\n]*\n\s*reportResourcesViewing\(\);/);
  assert.match(RAW, /document\.addEventListener\('visibilitychange', reportResourcesViewing\);/);
});

test('main builds the SHARED sampler, with a persistent PowerShell for the owner, and keeps the per-window one as the fallback seam', () => {
  assert.match(MAIN, /require\('\.\.\/host\/shared-sampler'\)/);
  assert.match(MAIN, /require\('\.\.\/host\/shared-poller'\)/);
  assert.match(MAIN, /createPersistentExec/);
  assert.match(MAIN, /resourceSampler = createSharedSampler\(/);
  assert.match(MAIN, /defaultPollerDir\(\{ uiStateDir: seams\.uiStateDir \}\)/);
});

test('the sampler is still stopped on quit (this ends the persistent shell by its own handle)', () => {
  assert.match(MAIN, /app\.on\('will-quit', \(\) => \{ if \(resourceSampler\) resourceSampler\.stop\(\);/);
});
