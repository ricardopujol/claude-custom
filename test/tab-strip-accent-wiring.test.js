'use strict';
/**
 * Kill tests for app/tab-strip.js, from Mortimer's gate on release PR #109 (survivor 12): the strip page subscribes to the
 * accent push at LOAD time (backlog #64's whole path into the strip), and paintAccent takes only a real #rrggbb string.
 *
 * The load-time lines only run when the module is NOT a CommonJS module, i.e. as a plain <script>, so the module is
 * evaluated in a vm context with a fake `strip` bridge. That means reading it as text, which test/stryker-config.test.js
 * refuses by default, so this file is a named exception (TOLERATED there): it runs the text, it asserts no code shape.
 * `process` is passed in because Stryker's instrumentation looks for it on the global.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const { paintAccent } = require('../app/tab-strip');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.js'), 'utf8');

function fakeDoc() {
  const props = {};
  const log = [];
  return {
    props, log,
    documentElement: { style: {
      setProperty: (k, v) => { props[k] = v; log.push(['set', k, v]); },
      removeProperty: (k) => { delete props[k]; log.push(['remove', k]); },
    } },
  };
}

/** Run the strip page's script as a plain <script> in a fresh global. */
function load(globals) {
  const ctx = vm.createContext({ process, ...globals });
  vm.runInContext(SOURCE, ctx, { filename: 'tab-strip.js' });
  return ctx;
}

test('loaded as a page script, the strip subscribes to the accent push and paints what main sends', () => {
  const doc = fakeDoc();
  let handler = null;
  let subscribed = 0;
  load({ document: doc, strip: { onAccent: (cb) => { subscribed++; handler = cb; } } });
  assert.strictEqual(subscribed, 1);
  assert.strictEqual(typeof handler, 'function');

  handler('#00ff88');
  assert.deepStrictEqual(doc.props, { '--accent': '#00ff88' });
  handler(null);
  assert.deepStrictEqual(doc.props, {}, 'null: back to the strip\'s own accent');
  handler('#00ff88');
  for (const bad of ['x#00ff88', '#00ff88 ', '#00ff8800', '#00ff8', 5, undefined, {}, { toString: () => '#112233' }]) {
    handler(bad);
    assert.deepStrictEqual(doc.props, { '--accent': '#00ff88' }, `${String(bad && bad.toString ? bad.toString() : bad)} is refused and changes nothing`);
  }
});

test('loaded as a page script with no accent bridge (or one that is not a function), nothing throws', () => {
  assert.doesNotThrow(() => load({ document: fakeDoc() }));
  assert.doesNotThrow(() => load({ document: fakeDoc(), strip: {} }));
  assert.doesNotThrow(() => load({ document: fakeDoc(), strip: { onAccent: 'x' } }));
  assert.doesNotThrow(() => load({ document: fakeDoc(), strip: { onAccent: null } }));
});

test('paintAccent: a #rrggbb of either case is painted and answers true; anything else answers false and paints nothing', () => {
  const doc = fakeDoc();
  assert.strictEqual(paintAccent(doc, '#00FF88'), true);
  assert.deepStrictEqual(doc.log, [['set', '--accent', '#00FF88']]);
  doc.log.length = 0;
  for (const bad of ['x#00ff88', '#00ff88 ', '#00ff8800', 'red', '', 5, undefined, { toString: () => '#112233' }]) {
    assert.strictEqual(paintAccent(doc, bad), false);
  }
  assert.deepStrictEqual(doc.log, []);
  assert.strictEqual(paintAccent(doc, null), true);
  assert.deepStrictEqual(doc.log, [['remove', '--accent']]);
  assert.strictEqual(paintAccent(null, '#00ff88'), false);
  assert.strictEqual(paintAccent({}, '#00ff88'), false);
});
