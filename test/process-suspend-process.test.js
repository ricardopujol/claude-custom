'use strict';
/**
 * host/process-suspend.js against a REAL process (PR #158 Dexter D8: the "already suspended" check was only string-matched, never executed). Windows
 * only. The process is this test's own child, held by its handle, with its start time proved before anything touches it; it is resumed and ended
 * on every exit path. Nothing is ever suspended, resumed or killed by pid alone.
 *
 * Real PowerShell, seconds each, so it is NOT in Stryker's command (test/stryker-config.test.js REPO_SCANNING). Run by hand:
 *   node --test test/process-suspend-process.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { suspendVerified } = require('../host/process-suspend');
const { startTimes } = require('../host/proc-start');
const { killChildTree, trackExit } = require('../host/kill-tree');
const { tmpDir } = require('./tmp-dir');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const exec = script => new Promise((resolve, reject) => execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 }, (err, out) => (err && !out ? reject(err) : resolve(String(out)))));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('the already-suspended check really runs: a second suspend is refused, one resume thaws it, and a doubled count is thawed by repeating', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmpDir('cc-suspend-process-');
  const beat = path.join(dir, 'beat.txt');
  const child = spawn(process.execPath, ['-e', `setInterval(() => require('fs').appendFileSync(${JSON.stringify(beat)}, 'x\\n'), 100)`], { stdio: 'ignore', windowsHide: true });
  trackExit(child);
  const beats = () => { try { return fs.readFileSync(beat, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  let target = null;
  try {
    await sleep(800);
    const start = (await startTimes([child.pid])).get(child.pid);
    assert.strictEqual(typeof start, 'string', 'the child\'s start time is proved before anything touches it');
    target = [{ pid: child.pid, start }];

    const first = await suspendVerified('suspend', target, { exec });
    assert.strictEqual(first[0].status, 'done');
    const a = beats();
    await sleep(700);
    assert.ok(beats() <= a + 1, 'it is frozen');

    const second = await suspendVerified('suspend', target, { exec });
    assert.deepStrictEqual(second.map(r => [r.status, r.text]), [['failed', 'already suspended']], 'the Susp check EXECUTED: a second suspend would have made the count 2');

    const resumed = await suspendVerified('resume', target, { exec });
    assert.strictEqual(resumed[0].status, 'done');
    const b = beats();
    await sleep(700);
    assert.ok(beats() > b + 2, 'one resume thawed it (count was 1)');

    // a count of 2, made behind the product's back with two raw suspends on one handle
    await exec(`$t = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'T2'), [Reflection.Emit.AssemblyBuilderAccess]::Run).DefineDynamicModule('m').DefineType('N2', 'Public,Class');
$m = $t.DefinePInvokeMethod('NtSuspendProcess', 'ntdll.dll', 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, [uint32], @([IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Auto);
$m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig); $T = $t.CreateType();
$p = Get-Process -Id ${child.pid}; if ($p.StartTime.ToFileTimeUtc() -ne ${start}) { exit 3 }
$h = $p.Handle; $T.GetMethod('NtSuspendProcess').Invoke($null, @([IntPtr]$h)) | Out-Null; $T.GetMethod('NtSuspendProcess').Invoke($null, @([IntPtr]$h)) | Out-Null`);
    const c = beats();
    await sleep(700);
    assert.ok(beats() <= c + 1, 'frozen at count 2');
    const thaw = await suspendVerified('resume', target, { exec });
    assert.strictEqual(thaw[0].status, 'done');
    const d = beats();
    await sleep(700);
    assert.ok(beats() > d + 2, 'ONE product resume brought a count of 2 to 0');
  } finally {
    if (target) await suspendVerified('resume', target, { exec }).catch(() => {});
    killChildTree(child);
  }
});
