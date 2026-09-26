'use strict';
/**
 * The two look veils are CSS in renderer.html, which no unit test executes.
 * These are PINS, not behaviour tests: they fail if a refactor quietly brings
 * back a shape a review already caught. What they look like on screen is
 * verify/probe-look.js's job.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');

function rule(selector) {
  const at = html.indexOf(selector + ' {');
  assert.ok(at >= 0, `${selector} rule is missing`);
  return html.slice(at, html.indexOf('}', at));
}

test('Dexter F8: the image darkness veil darkens for EVERY app colour -- mixed with black', () => {
  const veil = rule('body.has-custom-bg #bg::after');
  assert.match(veil, /background:\s*color-mix\(in srgb,\s*var\(--bg\)\s*\d+%,\s*#000\)/,
    'a pure var(--bg) veil washes the image out to white under a white app colour');
  assert.match(veil, /opacity:\s*var\(--bg-darkness\)/);
});

test('the unfocused veil never eats a click and sits below the attention cue', () => {
  const veil = rule('#focus-veil');
  assert.match(veil, /pointer-events:\s*none/, 'a click on an unfocused window must still focus it');
  const z = Number((/z-index:\s*(\d+)/.exec(veil) || [])[1]);
  const cueZ = Number((/z-index:\s*(\d+)/.exec(rule('body.attention-cue::after')) || [])[1]);
  assert.ok(z < cueZ, 'the finished-task cue is FOR unfocused windows and must stay on top');
});
