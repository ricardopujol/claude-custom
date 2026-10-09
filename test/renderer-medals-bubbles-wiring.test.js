'use strict';
/**
 * BACKLOG #80 wiring, by source: the frames the host sends are ones the renderer handles, the frames the renderer sends are
 * ones the host will not type into the pty, and the page has the elements and scripts the wiring looks up. The behaviour itself
 * is pinned by medals.test.js, bubbles.test.js and bubble-display.test.js, and measured in a real window by
 * verify/probe-medals-bubbles.js (no unit test can see a shared-scope collision or a bubble painted over a real card).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseControlFrame } = require('../host/control');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const renderer = read('app', 'renderer.js');
const html = read('app', 'renderer.html');
const host = read('host', 'host.js');
const bubblesSrc = read('host', 'bubbles.js');

test('a medal frame and a bubbles frame are control frames, never typed into the session', () => {
  assert.ok(parseControlFrame(JSON.stringify({ type: 'medal', action: 'give', agent: 'a', kind: 'fast' })));
  assert.ok(parseControlFrame(JSON.stringify({ type: 'bubbles', action: 'visible', visible: true })));
});

test('every frame the host broadcasts for medals and bubbles is handled by the renderer', () => {
  for (const type of ['medals', 'bubbles', 'bubble']) {
    assert.match(type === 'bubble' ? bubblesSrc : host, new RegExp(`type: '${type}'`), `host sends ${type}`);
    assert.match(renderer, new RegExp(`msg\\.type === '${type}'`), `renderer handles ${type}`);
  }
});

test('every frame the renderer sends for them is handled by the host', () => {
  assert.match(renderer, /type: 'medal', action: 'give'/);
  assert.match(renderer, /type: 'medal', action: 'remove'/);
  assert.match(renderer, /type: 'bubbles', action: 'set-enabled'/);
  assert.match(renderer, /type: 'bubbles', action: 'visible'/);
  assert.match(host, /msg\.type === 'medal'/);
  assert.match(host, /msg\.type === 'bubbles'/);
});

test('hello carries the medals and the bubbles switch, and the renderer reads both', () => {
  assert.match(host, /medals: medals\.all\(\)/);
  assert.match(host, /bubbles: \{ enabled: bubbleSettings\.enabled\(\) \}/);
  assert.match(renderer, /msg\.medals/);
  assert.match(renderer, /msg\.bubbles/);
});

test('the page has the scripts and elements the wiring looks up', () => {
  assert.match(html, /<script src="\.\/medals-display\.js"><\/script>/);
  assert.match(html, /<script src="\.\/bubble-display\.js"><\/script>/);
  for (const id of ['bubbles-toggle', 'agent-medals', 'medal-menu']) assert.match(html, new RegExp(`id="${id}"`), id);
  // the log panel hides every sibling but the log: the shelf is the other thing it keeps
  assert.match(html, /\.panel\.logging > :not\(#agent-log\):not\(#agent-medals\)/);
});

test('reduced motion turns the bubble animation off', () => {
  assert.match(html, /prefers-reduced-motion: reduce\) \{ \.agent-bubble, \.agent-bubble\[data-settled\] \{ animation: none; \} \}/);
});

test('a bubble never takes a click from its card', () => {
  assert.match(html, /\.agent-bubble \{[^}]*pointer-events: none/);
});

test('a repaint of the roster puts the bubbles back, and images going off takes them away', () => {
  assert.match(renderer, /setRosterHtml\(html\);\s*paintBubbles\(\);/);
  assert.match(renderer, /function applyAgentImages[\s\S]*?paintBubbles\(\);[\s\S]*?tellHostBubblesVisible\(\);/);
});

test('the host starts a bubble only through the mood listener, without waiting for it', () => {
  assert.match(host, /bubbles\.onMood\(\{ agent, state \}\);/);
  assert.ok(!/await bubbles\.onMood/.test(host));
});

test('every element renderer.js looks up at load comes BEFORE its script tag (the menu once sat after it, and was null)', () => {
  const script = html.indexOf('<script src="./renderer.js"></script>');
  assert.ok(script > 0);
  for (const id of ['bubbles-toggle', 'agent-medals', 'medal-menu']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0 && at < script, `${id} must be parsed before renderer.js runs`);
  }
});

test('visibility is per socket: a window that closes is dropped, and the install-wide files are watched for other hosts\' changes', () => {
  assert.match(host, /bubbles\.setViewer\(ws, msg\.visible === true\)/);
  assert.match(host, /bubbles\.dropViewer\(ws\)/);
  assert.match(host, /medalsWatch\.tick\(\); bubblesWatch\.tick\(\)/);
  assert.match(host, /medalsWatch\.note\(out\.medals\)/);
  assert.match(host, /bubblesWatch\.note\(told\)/);
  assert.ok(!/setVisible/.test(host));
});

test('a settled bubble does not replay its fade-in', () => {
  assert.match(html, /\.agent-bubble\[data-settled\] \{ animation: bubble-out/);
});
