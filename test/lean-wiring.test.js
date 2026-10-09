'use strict';
/**
 * Lean mode's wiring (BACKLOG #62), read from the source like test/renderer-dock-wiring.test.js: the pieces are tested
 * on their own (lean-state, lean-bridge, lean-display); these pin that they are CONNECTED, which no unit test sees and
 * only a real window proves (verify/probe-lean.js does).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const MAIN = strip(read('app/main.js'));
const PRELOAD = strip(read('app/preload.js'));
const RENDERER = strip(read('app/renderer.js'));
const HTML = read('app/renderer.html');

test('main registers the lean handlers for tab views and the strip, and pushes to both', () => {
  assert.match(MAIN, /registerLeanHandlers\(\{[^}]*isView: isTabView[^}]*isStrip: \(sender\) => fromStrip\(\{ sender \}\)/s);
  assert.match(MAIN, /pushToViews\(LEAN_PUSH, state\)/);
  assert.match(MAIN, /win\.webContents\.send\(LEAN_PUSH, state\)/);
});

test('main re-sends a lean state to a page that loads (or reloads) while the window is lean', () => {
  assert.match(MAIN, /wc\.send\(LEAN_PUSH, leanBridge\.view\(\)\)/);
  assert.match(MAIN, /win\.webContents\.send\(LEAN_PUSH, leanBridge\.view\(\)\)/);
});

test('a tab view going away drops its night, so a closed tab cannot keep the window lean', () => {
  assert.match(MAIN, /leanBridge\.dropOwner\(view\.webContents\.id\)/);
});

test('the tab preload exposes lean get / set / night / onChange on the channels main answers', () => {
  for (const ch of ['lean:get', 'lean:set', 'lean:night', 'lean-state']) assert.ok(PRELOAD.includes(`'${ch}'`), ch);
  assert.match(PRELOAD, /lean:\s*\{[\s\S]*get:[\s\S]*set:[\s\S]*night:[\s\S]*onChange:/);
});

test('the dock shows no panel while lean: renderLayout takes an empty set, so every panel\'s hide effect runs', () => {
  assert.match(RENDERER, /const now = new Set\(leanOn \? \[\] : plan\.shown\)/);
});

test('a night is reported to main only on the host\'s word: a dropped socket does not end it', () => {
  assert.match(RENDERER, /applyBedtime\(null, \{ fromHost: false \}\)/);
  assert.match(RENDERER, /if \(fromHost\) reportLeanNight\(\)/);
  assert.match(RENDERER, /window\.harness\.lean\.night\(at\)/);
});

test('the minute-ticks skip while lean, so nothing polls for a hidden header', () => {
  assert.match(RENDERER, /if \(!leanOn && \(bar\.prompt/);
  assert.match(RENDERER, /if \(leanOn \|\| !cooldownState\.length\) return/);
  assert.match(RENDERER, /if \(!leanOn && lastQuotaPayload\) renderQuota\(\)/);
});

test('the roster panel is not drawn while lean; the working agents go to the still strip', () => {
  assert.match(RENDERER, /function renderRoster\(\) \{[^}]*if \(leanOn\) \{ paintLeanFaces\(\); return; \}/s);
  assert.match(RENDERER, /portraitMedia\.stillFaceHtml\(/);
});

test('the terminal renderer swap and the background stills are registered pairs, and every pair is resumed by one registry', () => {
  for (const name of ['dock', 'ticks', 'roster', 'terminal-renderer', 'background']) {
    assert.match(RENDERER, new RegExp(`leanSuspender\\.register\\('${name}'`), name);
  }
  assert.match(RENDERER, /leanSuspender\.set\(on\)/);
  assert.match(RENDERER, /lean: leanOn,/, 'the video play rule is fed lean');
});

test('applyBackground no longer sets a CSS background itself: the image goes through paintBackgroundImage (GIF -> first frame while lean)', () => {
  assert.doesNotMatch(RENDERER, /style\.backgroundImage = `url\("\$\{media\.url\}"\)`;\s*\n\s*\}\s*\n\s*backgroundUrl = url/);
  assert.match(RENDERER, /paintBackgroundImage\(media\.url\)/);
  assert.match(RENDERER, /leanDisplay\.isAnimatedImageUrl\(url\)/);
});

test('the page keeps the terminal and the strip\'s marks: lean hides panels and chrome, never the terminal, the background or the theme', () => {
  const rules = HTML.match(/body\.lean [^{]*\{[^}]*\}/g).join('\n');
  assert.match(rules, /body\.lean header/);
  assert.match(rules, /body\.lean \.zone/);
  assert.doesNotMatch(rules, /body\.lean #termwrap\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(rules, /#bg\b/);
  assert.match(HTML, /<script src="\.\/lean-display\.js"><\/script>/);
  assert.ok(HTML.indexOf('lean-display.js') < HTML.indexOf('src="./renderer.js"'));
  assert.match(HTML, /<div id="lean-faces" hidden><\/div>/);
});
