'use strict';
// The real deps for listing and stopping sessions, shared by app/main.js (▾)
// and bin/claude-custom.js (--stop), so the two can't drift apart.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { listDeps, hostStopDeps } = require('../host/stop-deps');
const { tmpDir } = require('./tmp-dir');

test('hostStopDeps has every dep stopHost uses, each a function', () => {
  const d = hostStopDeps();
  for (const k of ['isAlive', 'startTimes', 'readIdentity', 'readToken', 'sendControl', 'windowCount', 'killPidTree', 'sleep', 'now']) {
    assert.strictEqual(typeof d[k], 'function', k);
  }
});

test('hostStopDeps reads identities and tokens from <install>/.harness', () => {
  const install = tmpDir('stop-deps-');
  const dir = path.join(install, '.harness', 'hosts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '7701.json'), JSON.stringify({ port: 7701, cwd: 'C:\\x', pid: process.pid, startedAt: 1 }));
  const d = hostStopDeps();
  const id = d.readIdentity({ install, port: 7701 });
  assert.ok(id, 'the identity is read from the install\'s own .harness');
  assert.strictEqual(id.cwd, 'C:\\x');
});

test('listDeps lists this install first, then the builds beside it', () => {
  const parent = tmpDir('stop-deps-list-');
  const own = path.join(parent, 'dev');
  const sib = path.join(parent, 'feat-a');
  for (const d of [own, sib]) {
    fs.mkdirSync(path.join(d, '.harness', 'hosts'), { recursive: true });
    fs.mkdirSync(path.join(d, 'host'), { recursive: true });
    fs.writeFileSync(path.join(d, 'host', 'host.js'), '');
  }
  const d = listDeps(own);
  assert.deepStrictEqual(d.installs(), [own, sib]);
  for (const k of ['identities', 'startTimes', 'windowCounts']) assert.strictEqual(typeof d[k], 'function', k);
});
