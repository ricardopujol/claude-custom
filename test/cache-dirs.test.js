'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cacheDirFor, cacheSwitches, sweepStale, useOwnCaches, PREFIX } = require('../app/cache-dirs');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cache-dirs-test-'));

test('two processes get two different disk-cache folders, never the shared user-data one', () => {
  const tmp = scratch();
  const a = Object.fromEntries(cacheSwitches(101, tmp)), b = Object.fromEntries(cacheSwitches(102, tmp));
  assert.notEqual(a['disk-cache-dir'], b['disk-cache-dir']);
  assert.equal(a['disk-cache-dir'], cacheDirFor(101, tmp));
  assert.ok(!/AppData|claude-custom$/i.test(path.basename(a['disk-cache-dir'])) || a['disk-cache-dir'].startsWith(tmp));
});

test('the GPU shader disk cache is switched off (it has no folder switch)', () => {
  assert.ok(cacheSwitches(1, 'x').some(([n]) => n === 'disable-gpu-shader-disk-cache'));
});

test('sweepStale removes a dead pid\'s folder and keeps a live one and unrelated folders', () => {
  const tmp = scratch();
  for (const n of [`${PREFIX}11`, `${PREFIX}22`, 'other-folder', `${PREFIX}notapid`]) fs.mkdirSync(path.join(tmp, n));
  const removed = sweepStale(tmp, (pid) => pid === 22);
  assert.deepEqual(removed, [`${PREFIX}11`]);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['other-folder', `${PREFIX}22`, `${PREFIX}notapid`].sort());
});

test('useOwnCaches appends the switches and removes the folder on will-quit', () => {
  const tmp = scratch();
  const seen = []; let quit;
  const app = { commandLine: { appendSwitch: (n, v) => seen.push([n, v]) }, once: (ev, fn) => { if (ev === 'will-quit') quit = fn; } };
  useOwnCaches(app, process.pid, tmp);
  assert.deepEqual(seen, cacheSwitches(process.pid, tmp));
  fs.mkdirSync(cacheDirFor(process.pid, tmp)); quit();
  assert.ok(!fs.existsSync(cacheDirFor(process.pid, tmp)));
});

test('main.js calls useOwnCaches before the app is ready', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const at = js.indexOf('useOwnCaches(app)');
  assert.ok(at > 0 && at < js.indexOf("app.commandLine.appendSwitch('disable-renderer-backgrounding')") + 400);
});
