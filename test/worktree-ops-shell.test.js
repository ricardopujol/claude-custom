'use strict';
/**
 * host/worktree-ops.js against a REAL powershell.exe: the two traps its header
 * names are measured here, not assumed.
 *   1. `-File` binding: a value bound `-Name:value` stays a value even when it
 *      starts with `-`.
 *   2. Completion keyed on EXIT: a background process that inherits the
 *      script's stdout keeps the pipe open after the script ends, so `close`
 *      comes late. runScript must settle anyway, with the JSON line.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { tmpDir } = require('./tmp-dir');

const ops = require('../host/worktree-ops');

const skip = process.platform !== 'win32' && 'needs Windows PowerShell';

test('a value starting with "-" passed as -Name:value reaches the script as that value', { skip }, async () => {
  const dir = tmpDir('cc-wops-sh-');
  const script = path.join(dir, 'echo.ps1');
  fs.writeFileSync(script, [
    'param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Branch)',
    '[Console]::Out.WriteLine((@{ project = $Project; branch = $Branch } | ConvertTo-Json -Compress))',
    'exit 0',
  ].join('\r\n'));
  const r = await ops.runScript({
    script, timeoutMs: 30000,
    args: [ops.psArg('Project', 'C:\\some where\\proj'), ops.psArg('Branch', '-Base')],
  });
  assert.strictEqual(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(out, { project: 'C:\\some where\\proj', branch: '-Base' });
});

test('a background process holding stdout does not hold runScript: it settles on exit', { skip }, async () => {
  const dir = tmpDir('cc-wops-sh-');
  const script = path.join(dir, 'bg.ps1');
  fs.writeFileSync(script, [
    '[Console]::Out.WriteLine(\'{"ok":true}\')',
    '[Console]::Out.Flush()',
    // Inherits this script's stdout pipe and outlives it by ~5 s.
    'Start-Process -FilePath ping.exe -ArgumentList \'-n\',\'6\',\'127.0.0.1\' -NoNewWindow',
    'exit 0',
  ].join('\r\n'));
  let closed = false;
  const spawn = (...a) => {
    const child = childProcess.spawn(...a);
    child.on('close', () => { closed = true; });
    return child;
  };
  const t0 = Date.now();
  const r = await ops.runScript({ script, timeoutMs: 30000, graceMs: 300, spawn });
  const took = Date.now() - t0;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /\{"ok":true\}/);
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(closed, false, 'the pipe was still held when runScript settled (else this test proves nothing)');
  assert.ok(took < 4500, `settled in ${took} ms, not after the background process`);
});
