'use strict';
/**
 * The page's CSS for the dock rail and its panel (BACKLOG #85). A stylesheet error drops a declaration without a word, and no
 * other test reads this file: PR #168's popover lost `z-index: 1000` to a missing semicolon and it opened behind floats.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8').replace(/\r\n/g, '\n');
const css = HTML.slice(HTML.indexOf('<style'), HTML.lastIndexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The declarations of the FIRST rule whose selector is exactly `selector`, as { prop: value }.
function rule(selector) {
  const m = new RegExp(`(?:^|\\n|\\})\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `rule ${selector} must be findable`);
  const out = {};
  for (const d of m[1].split(';').map(x => x.trim()).filter(Boolean)) {
    const i = d.indexOf(':');
    assert.ok(i > 0, `"${d}" in ${selector} is not prop: value`);
    const prop = d.slice(0, i).trim();
    const val = d.slice(i + 1).trim();
    assert.ok(!/^[a-z-]+\s*:/.test(val), `"${d}" in ${selector} runs two declarations together (a missing semicolon)`);
    out[prop] = val;
  }
  return out;
}

test('B1: the rail panel keeps its z-index and its background (no declaration runs into the next)', () => {
  const r = rule('.dpeek');
  assert.equal(r['z-index'], '1000');
  assert.equal(r.background, 'var(--chrome)');
  assert.equal(r['pointer-events'], 'auto');
  assert.equal(r.overflow, 'hidden');
});

test('the rail panel is opaque with a background image too', () => {
  assert.equal(rule('body.has-bg .dpeek').background, 'var(--chrome)');
});

test('Y4: the dock rail scrolls instead of clipping its tabs', () => {
  const r = rule('.drail[data-rail="dock"]');
  assert.equal(r['overflow-y'], 'auto');
  assert.equal(r['overflow-x'], 'hidden');
  assert.ok(css.indexOf('.drail[data-rail="dock"] {') > css.indexOf('.drail { position: absolute'), 'after the base rule, so it wins');
});

test('Y6: the slide out has a keyframe set and a name per side, and reduced motion switches every one off (G2)', () => {
  for (const side of ['right', 'left', 'top', 'bottom']) {
    assert.match(css, new RegExp(`@keyframes dpeek-from-${side} \{`), `in: ${side}`);
    assert.match(css, new RegExp(`@keyframes dpeek-to-${side} \{`), `out: ${side}`);
    assert.equal(rule(`.dpeek[data-closing][data-from="${side}"]`)['animation-name'], `dpeek-to-${side}`);
    if (side !== 'right') assert.equal(rule(`.dpeek[data-from="${side}"]`)['animation-name'], `dpeek-from-${side}`);       // right is the default, set on .dpeek itself
  }
  assert.equal(rule('.dpeek[data-closing]')['animation-fill-mode'], 'forwards');
  assert.equal(rule('.dpeek[data-closing]')['pointer-events'], 'none', 'a panel on its way out takes no hover');
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{ ([^}]*) \{ animation: none; \} \}/.exec(css);
  assert.ok(reduced, 'the reduced-motion rule must be findable');
  for (const sel of ['.dpeek', '.dpeek[data-from]', '.dpeek[data-closing]', '.dpeek[data-closing][data-from]']) assert.ok(reduced[1].split(',').map(x => x.trim()).includes(sel), sel);
  assert.ok(css.indexOf(reduced[0]) > css.indexOf('.dpeek[data-closing][data-from="bottom"]'), 'after the rules it overrides');
});

test('Y6: the CSS and the page agree on how long the slide is', () => {
  const V = require('../app/dock-tree-display');
  assert.equal(V.SLIDE_MS, 160);
  assert.equal(rule('.dpeek[data-closing]')['animation-duration'], `${V.SLIDE_MS}ms`);
  assert.match(css, /\.dpeek \{ animation: dpeek-from-right 160ms ease-out; \}/);
});

module.exports = { rule, css };
