'use strict';
/**
 * Dexter F5 / Miguel S5 (PR #64): while the images toggle is unknown (the
 * bridge exists but main has not answered, or the read failed) the UI must
 * claim neither "on" nor "off".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { mediaElementFor, faceMediaHtml } = require('../app/portrait-media-display');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
const fileResult = {
  kind: 'file', tier: 'uploaded', media: 'image', agent: 'a', state: 'working',
  path: 'C:\\a.png', mtimeMs: 1, fallback: { initials: 'A', hue: 3 },
};

test('an UNKNOWN toggle titles the placeholder "reading the setting", never "turned off"', () => {
  for (const v of [null, undefined, 'true', 1]) {
    const d = mediaElementFor(fileResult, { imagesEnabled: v });
    assert.strictEqual(d.tag, 'placeholder');
    assert.doesNotMatch(d.attrs.title, /turned off/, String(v));
    assert.match(d.attrs.title, /reading the setting/, String(v));
    assert.doesNotMatch(faceMediaHtml(fileResult, { imagesEnabled: v }), /turned off/);
  }
});

test('only an explicit false says "turned off"', () => {
  assert.match(mediaElementFor(fileResult, { imagesEnabled: false }).attrs.title, /turned off/);
});

// Source assertions: app/renderer.js needs a real DOM (same reasoning as
// test/renderer-avatar-wiring.test.js).
function body(start) {
  const i = SRC.indexOf(start);
  assert.ok(i !== -1, `renderer.js must still contain ${start}`);
  return SRC.slice(i, SRC.indexOf('\n}', i));
}

test('the header button starts with no confident state (no aria-pressed, no "shown")', () => {
  const tag = HTML.match(/<button[^>]*id="images-toggle"[^>]*>/)[0];
  assert.doesNotMatch(tag, /aria-pressed/);
  assert.doesNotMatch(tag, /shown/);
});

test('a failed read of the toggle is reported as unknown, never as "on"', () => {
  const b = body('function refreshAgentImages');
  assert.doesNotMatch(b, /applyAgentImages\(true\)/);
  assert.match(b, /removeAttribute\('aria-pressed'\)/);
  assert.match(b, /Click to try again/);
});

test('clicking the button while the state is unknown retries the read', () => {
  const i = SRC.indexOf("imagesToggleBtn.addEventListener('click'");
  assert.match(SRC.slice(i, i + 300), /else refreshAgentImages\(\)/);
});
