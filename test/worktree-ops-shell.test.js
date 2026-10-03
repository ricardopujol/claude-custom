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
  const hold = path.join(dir, 'hold.js');
  const release = path.join(dir, 'release');
  // The background process lives until the TEST says so (a release file), not
  // for a fixed ~5 s: a wall-clock bound on powershell's start-up failed under
  // full-suite load, while "the pipe was still held" is the actual claim. The
  // 120 s cap only stops an orphan if the test dies before releasing it.
  fs.writeFileSync(hold, [
    "const fs = require('fs');",
    'const t0 = Date.now();',
    'const timer = setInterval(() => {',
    '  if (fs.existsSync(process.argv[2]) || Date.now() - t0 > 120000) clearInterval(timer);',
    '}, 50);',
  ].join('\n'));
  fs.writeFileSync(script, [
    '[Console]::Out.WriteLine(\'{"ok":true}\')',
    '[Console]::Out.Flush()',
    // Inherits this script's stdout pipe and outlives it until released.
    `Start-Process -FilePath '${process.execPath}' -ArgumentList '"${hold}"','"${release}"' -NoNewWindow`,
    'exit 0',
  ].join('\r\n'));
  let closed = false;
  let onClose;
  const closedP = new Promise(r => { onClose = r; });
  const spawn = (...a) => {
    const child = childProcess.spawn(...a);
    child.on('close', () => { closed = true; onClose(); });
    return child;
  };
  try {
    const r = await ops.runScript({ script, timeoutMs: 120000, graceMs: 300, spawn });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /\{"ok":true\}/);
    assert.strictEqual(r.timedOut, false);
    assert.strictEqual(closed, false, 'the pipe was still held when runScript settled (else this test proves nothing)');
  } finally {
    fs.writeFileSync(release, '');          // let the background process end
  }
  await closedP;                            // and the pipe does close once it has
});
