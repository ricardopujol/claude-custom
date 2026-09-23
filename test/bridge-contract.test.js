'use strict';
/**
 * THE STRINGS THAT JOIN FOUR FILES, ASSERTED AGAINST SOURCE.
 *
 * Miguel, PR #33 review, R4. FF4's attention cue is four magic strings spread
 * across four files with no guard anywhere:
 *
 *   'attention-cue'   the IPC channel    app/main.js  <->  app/preload.js
 *   onAttentionCue    the bridge method  app/preload.js <-> app/renderer.js
 *   'attention-cue'   the CSS class      app/renderer.js <-> app/renderer.html
 *
 * and the renderer's call site is a TRUTHINESS GUARD:
 *
 *   if (window.harness && window.harness.onAttentionCue) { ... }
 *
 * so renaming the bridge method, or misspelling the channel in either file,
 * makes the feature do nothing forever -- with a green suite and no console
 * error. Silence is the whole failure mode.
 *
 * THIS REPO HAS SHIPPED SILENTLY-DEAD RENDERER CODE THREE TIMES:
 * `careerDisplay`, `quotaDisplay`, and `isPanelToggle` (Ctrl+B). The header of
 * test/renderer-scope.test.js is a monument to it -- but that file works on the
 * shared GLOBAL scope, and `window.harness.*` is a contextBridge object, not a
 * global. Its allow-list, its reachability list and its bare-global mirror test
 * are all structurally blind to this. FF4 reintroduced the old shape through a
 * door the existing guards do not watch.
 *
 * Check (2) below is the general one: it would have caught `isPanelToggle`
 * too, which is the argument for writing it once properly rather than once per
 * feature.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

// Comments are stripped before matching: a channel named only in prose is not
// a wiring, and the documentation of a bug must not satisfy the detector for
// it -- that exact trap was hit on this project's store.js header guard.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('every IPC channel main sends on is listened for in the preload', () => {
  const main = strip(read('main.js'));
  const preload = strip(read('preload.js'));

  const sent = [...main.matchAll(/webContents\.send\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(sent.length > 0, 'the scan must find something for this check to mean anything');

  const missing = sent.filter(ch => !preload.includes(`'${ch}'`) && !preload.includes(`"${ch}"`));
  assert.deepStrictEqual(missing, [],
    `main sends on these channels and the preload listens for none of them: ${missing.join(', ')}`);
});

test('every window.harness member the renderer reaches for is exposed by the preload', () => {
  // THE GENERAL CHECK. `isPanelToggle` died exactly this way once already --
  // reachable through the bridge in one file, absent in the other, silent.
  const renderer = strip(read('renderer.js'));
  const preload = strip(read('preload.js'));

  const used = new Set(
    [...renderer.matchAll(/window\.harness\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  assert.ok(used.size > 0, 'the scan must find something for this check to mean anything');

  // The bridge object is one `exposeInMainWorld` literal; a member is either a
  // key in it or nested one level (e.g. `secrets: { ... }`).
  const bridge = preload.slice(preload.indexOf('exposeInMainWorld'));
  const missing = [...used].filter(name => !new RegExp(`\\b${name}\\s*:`).test(bridge));
  assert.deepStrictEqual(missing, [],
    `renderer.js calls window.harness.X for these, and the preload exposes none of them: ${missing.join(', ')}`);
});

test('every class the renderer toggles has a rule in renderer.html', () => {
  // A cue whose class has no styling is a cue that raises nothing. The third
  // string in FF4's chain, and the one with no runtime error of any kind.
  const renderer = strip(read('renderer.js'));
  const html = read('renderer.html');

  const toggled = new Set(
    [...renderer.matchAll(/classList\.(?:toggle|add)\(\s*['"]([A-Za-z][\w-]*)['"]/g)].map(m => m[1]));
  assert.ok(toggled.size > 0, 'the scan must find something for this check to mean anything');

  const unstyled = [...toggled].filter(c => !html.includes(`.${c}`));
  assert.deepStrictEqual(unstyled, [],
    `renderer.js toggles these classes and renderer.html styles none of them: ${unstyled.join(', ')}`);
});

test('the attention cue is wired end to end, by name', () => {
  // The specific instance, stated plainly, so a failure above says WHICH
  // feature broke rather than only which rule did.
  const main = strip(read('main.js'));
  const preload = strip(read('preload.js'));
  const renderer = strip(read('renderer.js'));
  const html = read('renderer.html');

  assert.match(main, /webContents\.send\(\s*['"]attention-cue['"]/, 'main must send the cue');
  assert.match(preload, /ipcRenderer\.on\(\s*['"]attention-cue['"]/, 'the preload must listen for it');
  assert.match(preload, /onAttentionCue\s*:/, 'the preload must expose it');
  assert.match(renderer, /window\.harness\.onAttentionCue/, 'the renderer must subscribe');
  assert.match(renderer, /classList\.toggle\(\s*['"]attention-cue['"]/, 'the renderer must apply the class');
  assert.ok(html.includes('.attention-cue'), 'renderer.html must style it');
});
