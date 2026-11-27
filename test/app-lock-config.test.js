'use strict';
/**
 * host/app-lock-config.js (single-instance PR 3 step 4): is the app lock on for this launch, and where does its `app.json` live? One pure
 * table, so a probe can never attach to the person's daily app by accident (plan risk 3).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const load = () => require('../host/app-lock-config');
const INSTALL = path.resolve('/apps/jiandu');
const cfg = (over = {}) => load().appLockConfig({ env: {}, installDir: INSTALL, explicitPort: null, seams: { uiStateDir: null }, ...over });

test('a plain launch: on, in <install>\\.harness', () => {
  assert.deepStrictEqual(cfg(), { on: true, reason: 'single instance', dir: path.join(INSTALL, '.harness'), probe: false });
});

test('a plain launch with the UI state seam set: on, in the seam\'s folder', () => {
  const dir = path.resolve('/tmp/ui');
  assert.deepStrictEqual(cfg({ seams: { uiStateDir: dir } }), { on: true, reason: 'single instance', dir, probe: false });
});

test('a named port (good or bad) -> off: a port-named launch is its own process (design 3.1)', () => {
  for (const explicitPort of [7742, { bad: '77x' }]) {
    const r = cfg({ explicitPort });
    assert.strictEqual(r.on, false);
    assert.strictEqual(r.reason, 'a named port');
    assert.strictEqual(r.dir, null);
  }
});

test('attach-only and the screenshot path -> off, each with its reason', () => {
  assert.deepStrictEqual(cfg({ env: { CLAUDE_CUSTOM_ATTACH_ONLY: '1' } }), { on: false, reason: 'attach-only', dir: null, probe: false });
  assert.deepStrictEqual(cfg({ env: { CLAUDE_CUSTOM_SCREENSHOT: 'C:\\x.png' } }), { on: false, reason: 'screenshot', dir: null, probe: false });
});

test('a probe -> off, unless the single-instance flag AND its own state folder are set -> on, in that folder', () => {
  const dir = path.resolve('/tmp/probe-ui');
  assert.deepStrictEqual(cfg({ env: { CLAUDE_CUSTOM_TABS_PROBE: '9123' } }), { on: false, reason: 'probe', dir: null, probe: true });
  assert.deepStrictEqual(cfg({ env: { CLAUDE_CUSTOM_TABS_PROBE: '9123', CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE: '1' }, seams: { uiStateDir: dir } }),
    { on: true, reason: 'single-instance probe', dir, probe: true });
});

test('the flag without the state folder -> off, reason "probe without its own state folder"', () => {
  assert.deepStrictEqual(cfg({ env: { CLAUDE_CUSTOM_TABS_PROBE: '9123', CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE: '1' } }),
    { on: false, reason: 'probe without its own state folder', dir: null, probe: true });
});

test('the flag is only the exact "1", and only means something under a probe', () => {
  const dir = path.resolve('/tmp/probe-ui');
  assert.strictEqual(cfg({ env: { CLAUDE_CUSTOM_TABS_PROBE: '9123', CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE: 'yes' }, seams: { uiStateDir: dir } }).on, false);
  assert.deepStrictEqual(cfg({ env: { CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE: '1' } }), { on: true, reason: 'single instance', dir: path.join(INSTALL, '.harness'), probe: false });
});

test('the order: a named port wins over everything (it is checked first)', () => {
  const r = cfg({ explicitPort: 7742, env: { CLAUDE_CUSTOM_TABS_PROBE: '1', CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE: '1' }, seams: { uiStateDir: '/x' } });
  assert.strictEqual(r.reason, 'a named port');
});
