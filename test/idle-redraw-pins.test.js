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
const js = read('renderer.js');

test('the attention cue is its own compositor layer, so breathing it repaints nothing', () => {
  const at = html.indexOf('body.attention-cue::after {');
  assert.ok(at >= 0, 'cue rule missing');
  const rule = html.slice(at, html.indexOf('}', at));
  assert.match(rule, /will-change:\s*opacity/, 'without it each frame repaints the full-window border');
  assert.match(rule, /contain:\s*strict/, 'a full-window fixed layer must not invalidate its neighbours');
});

test('the canvas safety-net tick does nothing while the window is hidden', () => {
  const m = /setInterval\(\(\) => \{([^}]*)\}, 250\);/.exec(js);
  assert.ok(m, 'the 250 ms canvas tick is missing');
  assert.match(m[1], /document\.hidden/, 'a hidden window has nothing to resync; visibilitychange resyncs on return');
});
