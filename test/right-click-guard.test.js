'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { installRightClickGuard, isRightButton, EVENTS } = require('../app/right-click-guard');

// A bare-bones element: records listeners, and `fire` runs them as the capture phase would, reporting whether it was stopped.
function fakeEl() {
  const l = [];
  return {
    l,
    addEventListener(type, fn, capture) { l.push({ type, fn, capture }); },
    removeEventListener(type, fn, capture) { const i = l.findIndex(x => x.type === type && x.fn === fn && x.capture === capture); if (i >= 0) l.splice(i, 1); },
    fire(type, button) {
      let stopped = false;
      const ev = { type, button, stopPropagation() { stopped = true; } };
      for (const x of l.filter(y => y.type === type)) x.fn(ev);
      return stopped;
    },
  };
}

test('a right-button press and release are swallowed before xterm sees them', () => {
  const el = fakeEl(); installRightClickGuard(el);
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick']) assert.equal(el.fire(type, 2), true, type);
});

test('the left and middle buttons still reach xterm', () => {
  const el = fakeEl(); installRightClickGuard(el);
  for (const b of [0, 1]) for (const type of ['mousedown', 'mouseup']) assert.equal(el.fire(type, b), false, `${type} ${b}`);
});

test('the contextmenu event is left alone, and every listener is a capture one', () => {
  const el = fakeEl(); installRightClickGuard(el);
  assert.ok(!el.l.some(x => x.type === 'contextmenu'));
  assert.ok(el.l.length === EVENTS.length && el.l.every(x => x.capture === true));
});

test('the remover takes every listener off', () => {
  const el = fakeEl(); const off = installRightClickGuard(el); off();
  assert.equal(el.l.length, 0);
});

test('isRightButton is strict about a missing event', () => {
  assert.equal(isRightButton(null), false);
  assert.equal(isRightButton({ button: 2 }), true);
  assert.equal(isRightButton({}), false);
});

test('the page loads the guard before renderer.js and the renderer installs it on the terminal', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.ok(html.indexOf('right-click-guard.js') > 0 && html.indexOf('right-click-guard.js') < html.indexOf('src="./renderer.js"'));
  assert.match(js, /installRightClickGuard\(document\.getElementById\('term'\)\)/);
});
