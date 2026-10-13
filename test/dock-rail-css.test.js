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

module.exports = { rule, css };
