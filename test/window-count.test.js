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

// --- windowCounts: one powershell.exe for a whole list (the ▾ menu) ----------
const { windowCounts } = require('../host/window-count');
const net = require('net');

test('windowCounts: counts each (pid, port) from one query of established rows', async () => {
  let ran = 0;
  const exec = async () => {
    ran += 1;
    return 'ROW 7701 101\r\nROW 7701 101\r\nROW 7701 999\r\nROW 7702 101\r\nROW 7703 303\r\nOK\r\nEND\r\n';
  };
  const m = await windowCounts([{ pid: 101, port: 7701 }, { pid: 202, port: 7702 }, { pid: 303, port: 7703 }],
    { exec, platform: 'win32' });
  assert.deepStrictEqual([...m.entries()], [[101, 2], [202, 0], [303, 1]]);
  assert.strictEqual(ran, 1);
});

test('windowCounts: anything short of a clean answer is null for all, never 0', async () => {
  const targets = [{ pid: 101, port: 7701 }];
  for (const out of ['', 'END', 'OK', 'FAILED\nEND', 'ROW 7701 101\nFAILED\nOK\nEND', 'OK\nOK\nEND']) {
    assert.strictEqual(await windowCounts(targets, { exec: ok(out), platform: 'win32' }), null, JSON.stringify(out));
  }
  const throws = async () => { throw new Error('ETIMEDOUT'); };
  assert.strictEqual(await windowCounts(targets, { exec: throws, platform: 'win32' }), null);
  assert.strictEqual(await windowCounts(targets, { exec: ok('OK\nEND'), platform: 'linux' }), null);
});

test('windowCounts: a malformed row line is ignored, not miscounted', async () => {
  const m = await windowCounts([{ pid: 101, port: 7701 }],
    { exec: ok('ROW 7701\nROW x 101\nROW 7701 101 extra\nROW 7701 101\nOK\nEND'), platform: 'win32' });
  assert.deepStrictEqual([...m.entries()], [[101, 1]]);
});

test('windowCounts: bad targets get no entry and never reach the script; none valid, no query', async () => {
  let script = null;
  let ran = 0;
  const exec = async (file, args) => { ran += 1; script = args[args.length - 1]; return 'OK\nEND'; };
  const m = await windowCounts([{ pid: 0, port: 7701 }, { pid: 5, port: 70000 }, { pid: '7', port: 7 }, null,
    { pid: 101, port: 7701 }], { exec, platform: 'win32' });
  assert.deepStrictEqual([...m.keys()], [101]);
  assert.strictEqual(ran, 1);
  assert.match(script, /-State Established/);
  assert.match(script, /FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound\*'/);
  // Nothing from a target is spliced into the script: it filters in JS.
  assert.doesNotMatch(script, /7701|101/);
  assert.deepStrictEqual([...(await windowCounts([{ pid: -1, port: 1 }], { exec, platform: 'win32' })).keys()], []);
  assert.deepStrictEqual([...(await windowCounts([], { exec, platform: 'win32' })).keys()], []);
  assert.strictEqual(ran, 1);
});

test('real shell: windowCounts sees a real established connection, and 0 where there is none', { skip: !onWindows }, async () => {
  const server = net.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const client = net.connect(port, '127.0.0.1');
  await new Promise(r => client.on('connect', r));
  try {
    // Keyed by pid: a host listens on one port, so one target per pid.
    const live = await windowCounts([{ pid: process.pid, port }]);
    assert.ok(live, 'the query ran');
    assert.strictEqual(live.get(process.pid), 1);
    const none = await windowCounts([{ pid: process.pid, port: 1 }]);
    assert.ok(none, 'the query ran');
    assert.strictEqual(none.get(process.pid), 0);
  } finally {
    client.destroy();
    server.close();
  }
});
