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
const { mainProcessSource } = require('./main-source');

test('every navigation event is prevented, whatever the url or the event shape', () => {
  const wc = new EventEmitter();
  const logged = [];
  const guarded = guardNavigation(wc, (m) => logged.push(m));
  assert.deepStrictEqual(guarded.sort(), ['will-attach-webview', 'will-frame-navigate', 'will-navigate', 'will-redirect']);
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

test('PR #263 Miguel G10: a webview is never attached (defence in depth: inert while webviewTag is off), and the refusal is logged', () => {
  const wc = new EventEmitter();
  const logged = [];
  const guarded = guardNavigation(wc, (m) => logged.push(m));
  assert.ok(guarded.includes('will-attach-webview'));
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-attach-webview', e, { preload: 'C:\\evil.js' }, { src: 'https://example.com/' });
  assert.strictEqual(e.prevented, true);
  assert.match(logged[0], /webview .*refused: https:\/\/example\.com\//);
  wc.emit('will-attach-webview', null);                      // a strange shape never throws
});

test('PR #263 Miguel G9: the refusal line names the window it came from; a tab page by default', () => {
  const lines = [];
  const home = new EventEmitter();
  guardNavigation(home, (m) => lines.push(m), { who: 'Jiandu Home' });
  home.emit('will-navigate', { preventDefault() {} }, 'file:///C:/x.html');
  assert.match(lines[0], /^\[main\] Jiandu Home tried to navigate \(will-navigate\) and was refused: file:\/\/\/C:\/x\.html$/);
  const tab = new EventEmitter();
  guardNavigation(tab, (m) => lines.push(m));
  tab.emit('will-navigate', { preventDefault() {} }, 'https://example.com/');
  assert.match(lines[1], /^\[main\] a tab page tried to navigate/);
  const home2 = new EventEmitter();
  guardNavigation(home2, (m) => lines.push(m), { who: 'Jiandu Home' });
  home2.emit('will-attach-webview', { preventDefault() {} }, {}, {});
  assert.match(lines[2], /^\[main\] Jiandu Home tried to attach a webview/);
});

test('app/home-window.js names Home in its refusal lines (G9)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'home-window.js'), 'utf8');
  assert.match(src, /guardNavigation\(w\.webContents, log, \{ who: 'Jiandu Home' \}\);/);
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
  const main = mainProcessSource();
  assert.match(main, /require\('\.\/nav-guard'\)/);
  const at = main.indexOf('wc.setWindowOpenHandler(');
  assert.ok(at > 0);
  assert.match(main.slice(at - 200, at + 600), /guardNavigation\(wc\)/);
});
