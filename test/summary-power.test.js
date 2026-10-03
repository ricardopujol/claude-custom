'use strict';
/**
 * "Never while the machine is on battery" (host/summary-power.js, backlog #39, DESIGN_SLAVE_MODE_SUMMARY.md decision 3).
 * A host is plain Node (no Electron powerMonitor), so on Windows it asks WMI once per job, cached for a minute.
 * true = on battery, false = on mains or no battery at all, null = couldn't tell (the scheduler runs on null: only a
 * real true pauses, so a failed probe can't switch the feature off silently).
 */
const test = require('node:test');
const assert = require('node:assert');

const { createPowerProbe, parseBatteryStatus, TTL_MS } = require('../host/summary-power');

test('Win32_Battery.BatteryStatus: 1, 4 and 5 are discharging (on battery); the rest are on mains', () => {
  assert.strictEqual(parseBatteryStatus('1'), true);
  assert.strictEqual(parseBatteryStatus('4'), true);
  assert.strictEqual(parseBatteryStatus('5'), true);
  for (const s of ['2', '3', '6', '7', '8', '9', '11']) assert.strictEqual(parseBatteryStatus(s), false, s);
});

test('no battery at all (an empty answer) is not on battery', () => {
  assert.strictEqual(parseBatteryStatus(''), false);
  assert.strictEqual(parseBatteryStatus('\r\n'), false);
});

test('an answer that is not a status is unknown, never a guess', () => {
  for (const s of ['abc', '1.5', '-1', '0', '12', '1 2', null, undefined, 7]) assert.strictEqual(parseBatteryStatus(s), null, String(s));
});

test('surrounding whitespace and a trailing newline are fine', () => {
  assert.strictEqual(parseBatteryStatus(' 1\r\n'), true);
  assert.strictEqual(parseBatteryStatus('2\n'), false);
});

test('on Windows it asks PowerShell for the battery status, with a timeout, and reports the answer', async () => {
  const calls = [];
  const p = createPowerProbe({ platform: 'win32', run: async (file, args, opts) => { calls.push({ file, args, opts }); return '1\r\n'; } });
  assert.strictEqual(await p.onBattery(), true);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].file, /powershell/i);
  assert.ok(calls[0].args.join(' ').includes('Win32_Battery'));
  assert.ok(calls[0].args.includes('-NoProfile'));
  assert.ok(Number.isFinite(calls[0].opts.timeout) && calls[0].opts.timeout > 0);
  assert.strictEqual(calls[0].opts.windowsHide, true);
});

test('anywhere but Windows it does not guess: unknown, and nothing is run', async () => {
  let ran = 0;
  for (const platform of ['linux', 'darwin']) {
    const p = createPowerProbe({ platform, run: async () => { ran += 1; return '1'; } });
    assert.strictEqual(await p.onBattery(), null);
  }
  assert.strictEqual(ran, 0);
});

test('a probe that fails or hangs is unknown, not "on mains" and not "on battery"', async () => {
  const bad = createPowerProbe({ platform: 'win32', run: async () => { throw new Error('powershell not found'); } });
  assert.strictEqual(await bad.onBattery(), null);
  const junk = createPowerProbe({ platform: 'win32', run: async () => 'Access denied' });
  assert.strictEqual(await junk.onBattery(), null);
});

test('the answer is cached for a minute, and asked again after it', async () => {
  let t = 1_000_000;
  let n = 0;
  let answer = '1';
  const p = createPowerProbe({ platform: 'win32', now: () => t, run: async () => { n += 1; return answer; } });
  assert.strictEqual(await p.onBattery(), true);
  answer = '2';
  t += TTL_MS - 1;
  assert.strictEqual(await p.onBattery(), true, 'still the cached answer');
  assert.strictEqual(n, 1);
  t += 1;
  assert.strictEqual(await p.onBattery(), false, 'plugged in: seen after the minute');
  assert.strictEqual(n, 2);
});

test('an unknown answer is not cached: the next ask tries again', async () => {
  let n = 0;
  const p = createPowerProbe({ platform: 'win32', run: async () => { n += 1; if (n === 1) throw new Error('slow'); return '2'; } });
  assert.strictEqual(await p.onBattery(), null);
  assert.strictEqual(await p.onBattery(), false);
  assert.strictEqual(n, 2);
});

test('two asks at once run one probe', async () => {
  let n = 0;
  const p = createPowerProbe({ platform: 'win32', run: async () => { n += 1; await new Promise(r => setTimeout(r, 20)); return '1'; } });
  const [a, b] = await Promise.all([p.onBattery(), p.onBattery()]);
  assert.deepStrictEqual([a, b], [true, true]);
  assert.strictEqual(n, 1);
});
