'use strict';
/**
 * BACKLOG #156: the renderer's wiring of the held-message cue (the logic is in test/peer-cue.test.js; this pins that the page uses
 * it). A source scan, because the renderer is a plain <script> that no unit test can load; the real-window probe is
 * verify/probe-agent-cues.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const js = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');

test('peer-cue.js loads before the renderer, which uses it', () => {
  const at = html.indexOf('<script src="./peer-cue.js"></script>');
  assert.ok(at > 0 && at < html.indexOf('<script src="./renderer.js"></script>'));
});

test('a peer-message attention goes to peerMessageArrived; every other kind is raised as it always was', () => {
  assert.match(js, /if \(msg\.kind === 'peer-message'\) peerMessageArrived\(msg\);\s*else raiseAttention\(msg\);/);
});

test('the count rides the tab status, is not added while you are looking, and a look clears it', () => {
  assert.match(js, /pendingMessages: peerCount/);
  assert.match(js, /if \(!looking\) \{ peerCount = window\.peerCue\.bumpCount\(peerCount\); reportTabStatus\(\); \}/);
  assert.match(js, /onTabSelected\(\(\) => \{ pend\('looked'\); peerCount = 0; peerHeld\.clear\(\); reportTabStatus\(\);/);
});

test('the knock reads the mute switch from the store at the moment it decides (never a value cached at load), and the toast is named from the screen after a beat', () => {
  assert.match(js, /shouldKnockFrom\(peerStorage\(\), looking\)\) window\.peerCue\.knock\(window\)/);
  assert.doesNotMatch(js, /peerMuted/);
  assert.match(js, /window\.addEventListener\('storage'/);
  assert.match(js, /if \(!peerHeld\.admit\(found\)\) return;/);
  assert.match(js, /scanHeldMessage\(visibleTerminalLines\(\)\)/);
  assert.match(js, /raiseAttention\(\{ \.\.\.msg, \.\.\.window\.peerCue\.toastFor\(msg\.project, found\) \}\)/);
});

test('the mute switch is a button in the roster header, saved by peerCue', () => {
  assert.match(html, /id="cue-sound-toggle"/);
  assert.match(js, /window\.peerCue\.writeMuted\(/);
});

test('"looking" is asked of the shell (selected + focused window), the page\'s own focus only when there is no shell', () => {
  assert.match(js, /window\.harness\.isLooked\)\s*return \(await window\.harness\.isLooked\(\)\) === true/);
  assert.match(js, /return document\.hasFocus\(\);/);
});

test('the tab page may play the knock with nobody having touched it (a hidden tab): one shared set of web preferences', () => {
  assert.match(main, /new WebContentsView\(\{ webPreferences: tabViewWebPreferences\(/);
  const { tabViewWebPreferences } = require('../app/tab-view-prefs');
  const prefs = tabViewWebPreferences('p.js');
  assert.deepStrictEqual(prefs, { contextIsolation: true, nodeIntegration: false, preload: 'p.js', autoplayPolicy: 'no-user-gesture-required' });
});
