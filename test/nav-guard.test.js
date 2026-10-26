'use strict';
/**
 * PR #204 Miguel B1, layer 2: a tab's webContents refuses every navigation. The guard is driven with a fake
 * webContents; app/main.js is pinned as source text (it needs Electron).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { guardNavigation, EVENTS } = require('../app/nav-guard');

test('every navigation event is prevented, whatever the url or the event shape', () => {
  const wc = new EventEmitter();
  const logged = [];
  const guarded = guardNavigation(wc, (m) => logged.push(m));
  assert.deepStrictEqual(guarded.sort(), ['will-frame-navigate', 'will-navigate', 'will-redirect']);
  for (const ev of EVENTS) {
    const e = { prevented: false, preventDefault() { this.prevented = true; }, url: 'https://example.com/' };
    wc.emit(ev, e, 'https://example.com/');
    assert.strictEqual(e.prevented, true, ev);
    const d = { prevented: false, preventDefault() { this.prevented = true; }, url: 'javascript:alert(1)' };
    wc.emit(ev, d);                                       // the details-only shape of Electron 33
    assert.strictEqual(d.prevented, true, `${ev} (details only)`);
  }
  assert.strictEqual(logged.length, EVENTS.length * 2);
  assert.ok(logged.every((m) => /refused/.test(m)));
});

test('a hostile or oversized url does not break the guard', () => {
  const wc = new EventEmitter();
  guardNavigation(wc, () => {});
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-navigate', e, 'x'.repeat(100000));
  assert.strictEqual(e.prevented, true);
  wc.emit('will-navigate', null);
  wc.emit('will-navigate', {});
});

test('app/main.js guards every tab view with it, next to the window-open handler', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/nav-guard'\)/);
  const at = main.indexOf('wc.setWindowOpenHandler(');
  assert.ok(at > 0);
  assert.match(main.slice(at - 200, at + 600), /guardNavigation\(wc\)/);
});
