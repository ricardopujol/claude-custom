'use strict';
/**
 * Every Style-tab action the renderer sends has a handler in the host
 * (Miguel, PR #54 #1).
 *
 * The host's `style` branch ends in a bare `return` for an action it doesn't
 * know, so a renderer button whose action the host never learned does NOTHING
 * -- no refusal, no log, and every unit test passes, because the modules are
 * fine and only the wiring is missing. Same shape as control.test.js's "every
 * type host.js dispatches is on the control allow-list".
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const RENDERER = read('app', 'renderer.js');
const HOST = read('host', 'host.js');

function sentActions() {
  return new Set([...RENDERER.matchAll(/sendStyle\([^)]*?action: '([a-z-]+)'/g)].map((m) => m[1]));
}

function handledActions() {
  const start = HOST.indexOf("if (msg.type === 'style')");
  assert.ok(start !== -1, "host.js must have a 'style' branch for this check to mean anything");
  return new Set([...HOST.slice(start).matchAll(/msg\.action === '([a-z-]+)'/g)].map((m) => m[1]));
}

test('every style action the renderer sends is handled by the host', () => {
  const sent = sentActions();
  assert.ok(sent.size >= 4, `the scan found the renderer's actions: ${[...sent]}`);
  const handled = handledActions();
  const orphans = [...sent].filter((a) => !handled.has(a));
  assert.deepStrictEqual(orphans, [], `sent but never handled: ${orphans.join(', ')}`);
});

test('the "Random colours" button is drawn and sends reroll-look', () => {
  assert.match(RENDERER, /<button type="button" id="style-reroll"[^>]*>Random colours<\/button>/);
  assert.match(RENDERER,
    /getElementById\('style-reroll'\)[\s\S]{0,200}sendStyle\('colours', \{ action: 'reroll-look' \}\)/);
  assert.ok(sentActions().has('reroll-look'));
});

test('the "Match colours to this background" button is drawn, gated, and sends match-colours with only seeds (#34)', () => {
  assert.match(RENDERER, /<button type="button" id="style-match"\$\{v\.canMatch \? '' : ' disabled'\}[^>]*>Match colours to this background<\/button>/);
  assert.match(RENDERER,
    /getElementById\('style-match'\)[\s\S]{0,700}sendStyle\('background', \{ action: 'match-colours', seeds, setAt \}\)/);
  assert.ok(sentActions().has('match-colours'));
  // the pixels never leave the page: only colourSeeds' hex list is sent
  assert.match(RENDERER, /const seeds = colourSeeds\.seedsOf\(/);
  assert.doesNotMatch(RENDERER, /getImageData[^;]*\bsendStyle/);
});

test('M3: the Match button is re-enabled whatever happens to the request, even with no host to answer', () => {
  const click = RENDERER.slice(RENDERER.indexOf("getElementById('style-match')"), RENDERER.indexOf("getElementById('style-bg-reset')"));
  assert.match(click, /match\.disabled = true;/);
  assert.match(click, /\} finally \{[\s\S]*?match\.disabled = false;[\s\S]*?\}/);
  assert.match(RENDERER, /function sendStyle\(section, payload\) \{\s*try \{ ws\.send\([^\n]*\} catch \{/, 'sendStyle swallows a dead socket -- which is why the finally is needed');
});

test('M2: the Background section has a paused note, kept current by every playback change', () => {
  assert.match(RENDERER, /<div class="style-paused" id="style-bg-paused"\$\{pn \? '' : ' hidden'\}>/);
  const sync = RENDERER.slice(RENDERER.indexOf('function syncBackgroundPlayback()'));
  assert.match(sync.slice(0, sync.indexOf('\n}')), /showPausedNote\(\);/, 'every play-rule input updates the note');
  assert.match(RENDERER, /function removeBackgroundVideo\(\) \{[\s\S]*?showPausedNote\(\);\s*\}/, 'no video, no note');
  assert.match(RENDERER, /bgVideoEl \? bgMedia\.pausedNote\(backgroundPlaybackState\(\)\) : null/);
});

test('M5: applyBackground checks that mediaFor described the background before it reads .tag', () => {
  const body = RENDERER.slice(RENDERER.indexOf('function applyBackground('));
  const guard = body.indexOf('if (!media) return;');
  const firstUse = body.indexOf('media.tag');
  assert.ok(guard > 0 && guard < firstUse, 'the null check comes before the first media.tag');
  // and mediaFor really can answer null
  assert.strictEqual(require('../app/bg-media-display').mediaFor({ kind: 'video', url: '' }), null);
});

test('D5: Match colours says which background it sampled, taken before the frame is read', () => {
  const click = RENDERER.slice(RENDERER.indexOf("getElementById('style-match')"));
  const taken = click.indexOf('const setAt = backgroundSetAt;');
  const read = click.indexOf('await sampleBackgroundFrame()');
  assert.ok(taken > 0 && read > taken, 'setAt is captured before the await, not after');
  assert.match(RENDERER, /backgroundSetAt = custom && version \? version : null;/);
  assert.match(RENDERER, /backgroundUrl = null;\s+backgroundSetAt = null;/);
});

test('D5: the host hands the sampled background to matchLook', () => {
  const HOST = require('fs').readFileSync(require('path').join(__dirname, '..', 'host', 'host.js'), 'utf8');
  assert.match(HOST, /matchLook\(\{ cwd: STATE_ROOT, seeds: msg\.seeds, setAt: msg\.setAt,/);
});

test('the Background section takes video files and says so (#34)', () => {
  assert.match(RENDERER, /accept="image\/png,image\/jpeg,image\/webp,image\/gif,image\/svg\+xml,video\/webm,video\/mp4"/);
  assert.match(RENDERER, /drop an image or a short video here/);
  assert.match(RENDERER, /v\.note \? `<div class="style-note">/);
});

test('the background layer is drawn through bgMedia, and its play inputs come from the page and from main (#34)', () => {
  assert.match(RENDERER, /bgMedia\.mediaFor\(/);
  assert.match(RENDERER, /bgMedia\.applyPlayback\(/);
  assert.match(RENDERER, /bgMedia\.unplayableNote\(/);
  assert.match(RENDERER, /window\.harness\.playback\.onChange\(/);
  assert.match(RENDERER, /prefers-reduced-motion: reduce/);
  assert.match(RENDERER, /document\.addEventListener\('visibilitychange', syncBackgroundPlayback\)/);
});
