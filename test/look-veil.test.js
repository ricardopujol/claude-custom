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

test('#25: in a light look the veil is WHITE-based, over the own picture and over the generated art alike', () => {
  const generated = rule('html[data-look-mode="light"] body.has-bg #bg::after');
  assert.match(generated, /background:\s*color-mix\(in srgb,\s*var\(--bg\)\s*\d+%,\s*#fff\)/);
  assert.doesNotMatch(generated, /#000/);
  assert.match(generated, /opacity:\s*var\(--bg-light-art-veil,\s*[\d.]+\)/);
  const custom = rule('html[data-look-mode="light"] body.has-custom-bg #bg::after');
  assert.match(custom, /opacity:\s*var\(--bg-darkness\)/, 'the own picture keeps the Brightness slider');
  assert.doesNotMatch(custom, /#000/);
  // dark is untouched: the generated art gets no veil of its own (it bakes in its dimming)
  const withoutLight = html.split('html[data-look-mode="light"] body.has-bg #bg::after {').join('');
  assert.ok(!/[^\w-]body\.has-bg #bg::after \{/.test(withoutLight));
});

test('the unfocused veil never eats a click and sits below the attention cue', () => {
  const veil = rule('#focus-veil');
  assert.match(veil, /pointer-events:\s*none/, 'a click on an unfocused window must still focus it');
  const z = Number((/z-index:\s*(\d+)/.exec(veil) || [])[1]);
  const cueZ = Number((/z-index:\s*(\d+)/.exec(rule('body.attention-cue::after')) || [])[1]);
  assert.ok(z < cueZ, 'the finished-task cue is FOR unfocused windows and must stay on top');
});
