'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { probeWindowOptions, probeVisible, VISIBLE_VAR, OFFSCREEN } = require('../host/probe-window');
const { cleanElectronEnv, probeEnv } = require('../verify/lib/launch-electron');

test('probeWindowOptions: off the desktop, off the taskbar, unfocusable, unthrottled by default', () => {
  const o = probeWindowOptions({ width: 10, height: 20, show: true }, {});
  assert.strictEqual(o.x, OFFSCREEN);
  assert.strictEqual(o.y, OFFSCREEN);
  assert.strictEqual(o.skipTaskbar, true);
  assert.strictEqual(o.focusable, false);
  assert.strictEqual(o.webPreferences.backgroundThrottling, false);
  assert.strictEqual(o.width, 10);
  assert.strictEqual(o.show, true);
  assert.ok(OFFSCREEN <= -10000);
});

test('probeWindowOptions: keeps the probe\'s own webPreferences and does not modify its input', () => {
  const input = Object.freeze({ webPreferences: Object.freeze({ contextIsolation: true, preload: 'p.js' }) });
  const o = probeWindowOptions(input, {});
  assert.strictEqual(o.webPreferences.contextIsolation, true);
  assert.strictEqual(o.webPreferences.preload, 'p.js');
  assert.strictEqual(o.webPreferences.backgroundThrottling, false);
  assert.strictEqual(input.webPreferences.backgroundThrottling, undefined);
});

test('probeWindowOptions: a probe that needs focus says so and keeps it, still off screen', () => {
  const o = probeWindowOptions({ focusable: true }, {});
  assert.strictEqual(o.focusable, true);
  assert.strictEqual(o.x, OFFSCREEN);
});

test('probeWindowOptions: no argument still gives a hidden-position window', () => {
  const o = probeWindowOptions(undefined, {});
  assert.strictEqual(o.x, OFFSCREEN);
  assert.strictEqual(o.focusable, false);
});

test('probeWindowOptions: CLAUDE_CUSTOM_PROBE_VISIBLE=1 returns the options as the probe wrote them', () => {
  const input = { width: 10, show: true };
  const o = probeWindowOptions(input, { [VISIBLE_VAR]: '1' });
  assert.deepStrictEqual(o, input);
  assert.strictEqual(o.x, undefined);
  assert.strictEqual(o.focusable, undefined);
});

test('probeVisible: only the exact value 1 shows the windows', () => {
  assert.strictEqual(probeVisible({ [VISIBLE_VAR]: '1' }), true);
  for (const v of ['0', '', 'true', undefined]) assert.strictEqual(probeVisible({ [VISIBLE_VAR]: v }), false);
  assert.strictEqual(probeVisible({}), false);
});

test('the launcher passes CLAUDE_CUSTOM_PROBE_VISIBLE through to the Electron it starts, and still strips the rest', () => {
  const parent = { PATH: 'p', CLAUDE_CUSTOM_PORT: '7', [VISIBLE_VAR]: '1' };
  assert.deepStrictEqual(cleanElectronEnv(parent), { PATH: 'p', [VISIBLE_VAR]: '1' });
  assert.deepStrictEqual(probeEnv(undefined, parent), { PATH: 'p', [VISIBLE_VAR]: '1' });
  assert.deepStrictEqual(probeEnv({ ...parent }, parent), { PATH: 'p', [VISIBLE_VAR]: '1' });
});

test('the real app window takes probe options only when the probe port is set', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'main.js'), 'utf8');
  assert.match(main, /const forProbe = \(opts\) => \(PROBE_PORT \? require\('\.\.\/host\/probe-window'\)\.probeWindowOptions\(opts\) : opts\);/);
  assert.match(main, /win = new BrowserWindow\(forProbe\(\{/);
});
