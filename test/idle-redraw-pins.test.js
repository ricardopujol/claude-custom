'use strict';
/**
 * PINS for the idle-redraw fixes (BACKLOG #100 b). Source-text pins: renderer.html's CSS and renderer.js's pollers are not
 * executed by any unit test. What they cost is verify/probe-idle-redraw.js's job.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
const html = read('renderer.html');

test('the attention cue border is static: no animation, no opacity layer hint (BACKLOG #117)', () => {
  const at = html.indexOf('body.attention-cue::after {');
  assert.ok(at >= 0, 'cue rule missing');
  const rule = html.slice(at, html.indexOf('}', at));
  assert.doesNotMatch(rule, /animation/, 'a breathing border keeps the GPU process busy for as long as it shows');
  assert.doesNotMatch(rule, /will-change/, 'the layer hint only served the breathe');
  assert.match(rule, /contain:\s*strict/, 'a full-window fixed layer must not invalidate its neighbours');
  assert.ok(!html.includes('cue-breathe'), 'the keyframes must be gone');
});
