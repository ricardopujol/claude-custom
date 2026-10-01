'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { windowCount } = require('../host/window-count');

const ok = out => async () => out;

test('the count the query printed, for a valid pid and port on Windows', async () => {
  assert.strictEqual(await windowCount(4242, 7787, { exec: ok('COUNT 1\r\nEND\r\n'), platform: 'win32' }), 1);
  assert.strictEqual(await windowCount(4242, 7787, { exec: ok('COUNT 0\nEND\n'), platform: 'win32' }), 0);
  const BOM = String.fromCharCode(0xfeff);   // built, not typed (test/renderer-scope.test.js)
  assert.strictEqual(await windowCount(4242, 7787, { exec: ok(`${BOM}COUNT 3\nEND`), platform: 'win32' }), 3);
});

test('anything short of one clean count is "couldn\'t tell" (null), never 0', async () => {
  for (const out of ['', 'END', 'COUNT 1', 'FAILED PermissionDenied\nEND', 'COUNT x\nEND',
    'COUNT 1\nCOUNT 0\nEND', 'COUNT -1\nEND', 'COUNT 1.5\nEND']) {
    assert.strictEqual(await windowCount(4242, 7787, { exec: ok(out), platform: 'win32' }), null, JSON.stringify(out));
  }
  const throws = async () => { throw new Error('ETIMEDOUT'); };
  assert.strictEqual(await windowCount(4242, 7787, { exec: throws, platform: 'win32' }), null);
});

test('no query at all for a bad pid or port, or off Windows', async () => {
  let ran = 0;
  const exec = async () => { ran += 1; return 'COUNT 0\nEND'; };
  for (const [pid, port] of [[0, 7787], [-1, 7787], [1.5, 7787], ['4242', 7787], [null, 7787],
    [4242, 0], [4242, 65536], [4242, null], [4242, '7787']]) {
    assert.strictEqual(await windowCount(pid, port, { exec, platform: 'win32' }), null, `${pid}/${port}`);
  }
  assert.strictEqual(await windowCount(4242, 7787, { exec, platform: 'linux' }), null);
  assert.strictEqual(ran, 0);
});

test('the pid and port reach the script as plain integers, and nothing else does', async () => {
  let script = null;
  const exec = async (file, args) => { script = args[args.length - 1]; return 'COUNT 0\nEND'; };
  await windowCount(4242, 7787, { exec, platform: 'win32' });
  assert.match(script, /-LocalPort 7787 /);
  assert.match(script, /OwningProcess -eq 4242 /);
  assert.match(script, /-State Established/);
  // No matching connection is 0, any other failure is not -- told apart by the
  // error id, never the category a missing cmdlet shares (Dexter R2-1).
  assert.match(script, /FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound\*'/);
  assert.doesNotMatch(script, /CategoryInfo/);
});

// Against the REAL powershell.exe (Dexter, PR #76 R2-1): a missing or
// unloadable Get-NetTCPConnection throws ObjectNotFound too -- the same
// category as "no rows" -- and must read as "couldn't tell", never as 0.
const onWindows = process.platform === 'win32';

test('real shell: a cmdlet that is not there is "couldn\'t tell" (null), never 0', { skip: !onWindows }, async () => {
  assert.strictEqual(await windowCount(4242, 7999, { cmdlet: 'Get-NetTCPConnectionX' }), null);
});

test('real shell: a port with no connections is 0', { skip: !onWindows }, async () => {
  assert.strictEqual(await windowCount(process.pid, 1, {}), 0);
});

test('the cmdlet name is only ever a plain identifier', async () => {
  let ran = 0;
  const exec = async () => { ran += 1; return 'COUNT 0\nEND'; };
  for (const cmdlet of ['Get-X; Remove-Item -Recurse C:/', 'Get X', '$(evil)', '', 42]) {
    assert.strictEqual(await windowCount(4242, 7787, { exec, platform: 'win32', cmdlet }), null, String(cmdlet));
  }
  assert.strictEqual(ran, 0);
});
