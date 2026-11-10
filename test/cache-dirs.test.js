'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cacheDirFor, cacheSwitches, sweepStale, livePeers, pidOfName, pidAlive, useOwnCaches, PREFIX } = require('../app/cache-dirs');

const scratch = () => require('./tmp-dir').tmpDir('cache-dirs-test-');
const fakeApp = () => {
  const o = { switches: [], quit: null };
  o.app = { commandLine: { appendSwitch: (n, v) => o.switches.push([n, v]) }, once: (ev, fn) => { if (ev === 'will-quit') o.quit = fn; } };
  return o;
};

test('two processes get two different disk-cache folders, and neither is the shared user-data folder', () => {
  const tmp = scratch();
  const userData = path.join(tmp, 'AppData', 'claude-custom');
  const a = Object.fromEntries(cacheSwitches(101, tmp)), b = Object.fromEntries(cacheSwitches(102, tmp));
  assert.notEqual(a['disk-cache-dir'], b['disk-cache-dir']);
  assert.equal(a['disk-cache-dir'], cacheDirFor(101, tmp));
  for (const dir of [a['disk-cache-dir'], b['disk-cache-dir']]) {
    assert.ok(!(dir + path.sep).startsWith(userData + path.sep), 'not inside user-data');
    assert.notEqual(path.resolve(dir), path.resolve(userData));
  }
});

test('the GPU shader disk cache is switched off only when another window is running (Miguel Y4)', () => {
  assert.ok(!cacheSwitches(1, 'x', false).some(([n]) => n === 'disable-gpu-shader-disk-cache'), 'the first window keeps its shader cache');
  assert.ok(cacheSwitches(1, 'x', true).some(([n]) => n === 'disable-gpu-shader-disk-cache'), 'a window with a peer drops it');
});

test('useOwnCaches: alone it appends only the disk-cache switch; with a live peer it also drops the shader cache', () => {
  const tmp = scratch();
  const alone = fakeApp(); useOwnCaches(alone.app, 4000, tmp);
  assert.deepEqual(alone.switches, [['disk-cache-dir', cacheDirFor(4000, tmp)]]);
  fs.mkdirSync(cacheDirFor(process.pid, tmp));           // a live peer: this very test process stands in for it
  const second = fakeApp(); useOwnCaches(second.app, 4001, tmp);
  assert.deepEqual(second.switches.map(([n]) => n), ['disk-cache-dir', 'disable-gpu-shader-disk-cache']);
});

test('CLAUDE_CUSTOM_SHARED_CACHE=1 leaves Chromium on its shared cache (the probe\'s baseline) and makes no folder', () => {
  const tmp = scratch();
  const o = fakeApp(); useOwnCaches(o.app, 4100, tmp, { CLAUDE_CUSTOM_SHARED_CACHE: '1' });
  assert.deepEqual(o.switches, []);
  assert.ok(!fs.existsSync(cacheDirFor(4100, tmp)));
  const on = fakeApp(); useOwnCaches(on.app, 4101, tmp, { CLAUDE_CUSTOM_SHARED_CACHE: '0' });
  assert.equal(on.switches.length, 1, 'any other value is the fix on');
});

test('pidOfName takes only a plain whole number after our prefix (no 1e3, 0x10, spaces, empty)', () => {
  assert.equal(pidOfName(`${PREFIX}123`), 123);
  for (const bad of ['1e3', '0x10', ' 12', '12 ', '', '-5', '0', '1.5', 'abc', '99999999999999999999']) assert.equal(pidOfName(PREFIX + bad), null, bad);
  assert.equal(pidOfName('other-123'), null);
  assert.equal(pidOfName(undefined), null);
});

test('pidAlive: this process is alive, a pid that cannot exist is not', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
});

test("sweepStale removes a dead pid's folder and keeps a live one, unrelated folders and odd names", () => {
  const tmp = scratch();
  for (const n of [`${PREFIX}11`, `${PREFIX}22`, 'other-folder', `${PREFIX}1e3`, `${PREFIX}0x10`]) fs.mkdirSync(path.join(tmp, n));
  const removed = sweepStale(tmp, (pid) => pid === 22);
  assert.deepEqual(removed, [`${PREFIX}11`]);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['other-folder', `${PREFIX}22`, `${PREFIX}1e3`, `${PREFIX}0x10`].sort());
});

test('livePeers lists other live windows only', () => {
  const tmp = scratch();
  for (const n of [`${PREFIX}5`, `${PREFIX}6`, `${PREFIX}7`, 'x']) fs.mkdirSync(path.join(tmp, n));
  assert.deepEqual(livePeers(6, tmp, (p) => p !== 7).sort(), [5]);
});

test('useOwnCaches removes its own folder on will-quit', () => {
  const tmp = scratch();
  const o = fakeApp(); useOwnCaches(o.app, process.pid, tmp);
  assert.ok(fs.existsSync(cacheDirFor(process.pid, tmp)), 'made at start');
  o.quit();
  assert.ok(!fs.existsSync(cacheDirFor(process.pid, tmp)));
});

test("main.js calls useOwnCaches at the top level, before app.whenReady, and not in a comment", () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const lines = js.split(/\r?\n/);
  const at = lines.findIndex(l => /^require\('\.\/cache-dirs'\)\.useOwnCaches\(app\);\s*$/.test(l));
  const ready = lines.findIndex(l => /^app\.whenReady\(\)/.test(l));
  assert.ok(at > 0, 'a top-level, uncommented call');
  assert.ok(ready > at, 'app.whenReady comes after it');
  assert.ok(!lines.slice(0, ready).some(l => /^app\.on\('ready'/.test(l)), 'no earlier ready handler');
});
