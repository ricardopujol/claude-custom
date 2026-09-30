'use strict';
/**
 * verify/lib/settings-guard.js -- Miguel's PR #67 M1: a probe's settings
 * restore must survive process.exit() (the hygiene SIGINT handler), not only a
 * `finally`. The 'exit' event fires for process.exit(), so the guard registers
 * its synchronous restore there.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { tmpDir } = require('./tmp-dir');
const { createSettingsGuard } = require('../verify/lib/settings-guard');

test('restore puts a modified file back byte for byte, removes a file that did not exist, and reports both', () => {
  const dir = tmpDir('cc-guard-');
  const existing = path.join(dir, 'settings.json');
  const absent = path.join(dir, 'settings.local.json');
  const untouched = path.join(dir, 'other.json');
  fs.writeFileSync(existing, Buffer.from('{"a":1}\r\n'));
  fs.writeFileSync(untouched, 'same');
  const guard = createSettingsGuard([existing, absent, untouched]);
  fs.writeFileSync(existing, '{"model":"sonnet[1m]"}');
  fs.writeFileSync(absent, 'created by /model');
  const changed = guard.restore();
  assert.deepStrictEqual(changed.sort(), [absent, existing].sort());
  assert.strictEqual(fs.readFileSync(existing).toString(), '{"a":1}\r\n');
  assert.ok(!fs.existsSync(absent));
  assert.strictEqual(fs.readFileSync(untouched, 'utf8'), 'same');
  assert.deepStrictEqual(guard.restore(), [], 'idempotent: a second restore has nothing to do');
});

test('installExitRestore is idempotent and uninstallable', () => {
  const before = process.listenerCount('exit');
  const guard = createSettingsGuard([]);
  guard.installExitRestore();
  guard.installExitRestore();
  assert.strictEqual(process.listenerCount('exit'), before + 1);
  guard.uninstallExitRestore();
  assert.strictEqual(process.listenerCount('exit'), before);
});

test('the restore runs when the process is killed by process.exit() -- the path a finally block cannot see', () => {
  const dir = tmpDir('cc-guard-exit-');
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, 'ORIGINAL');
  const script = `
    const fs = require('fs');
    const { createSettingsGuard } = require(${JSON.stringify(path.join(__dirname, '..', 'verify', 'lib', 'settings-guard'))});
    const guard = createSettingsGuard([${JSON.stringify(f)}]);
    guard.installExitRestore();
    try {
      fs.writeFileSync(${JSON.stringify(f)}, 'REWRITTEN BY /model');
      process.exit(130);          // what process-hygiene's SIGINT handler does
    } finally { /* never reached */ }
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 130);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'ORIGINAL');
});

test('probe-context-window.js installs the exit restore BEFORE it types /model or spawns claude', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'verify', 'probe-context-window.js'), 'utf8');
  const install = src.indexOf('installExitRestore()');
  assert.ok(install !== -1, 'the probe must install the exit restore');
  assert.ok(install < src.indexOf('pty.spawn('), 'before the child is spawned');
  assert.ok(install < src.indexOf("child.write('/model"), 'before /model is typed');
});
