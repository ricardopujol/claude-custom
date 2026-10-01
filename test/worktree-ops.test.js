'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const ops = require('../host/worktree-ops');

const BOX = 'C:\\Users\\me\\VibeCode\\proj';
const BOM = String.fromCharCode(0xfeff);

// A child process as runScript sees it: exit / close / error events, two
// streams, and a kill that must never be called.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = 0;
  child.kill = () => { child.killed++; };
  return child;
}

function spawnOf(child, calls = []) {
  return (exe, args, opts) => { calls.push({ exe, args, opts }); return child; };
}

const run = (over = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null, ...over });

// --- scriptsDir / available ---------------------------------------------------

test('scriptsDir: the env override, else the worktree skill under the home folder', () => {
  assert.strictEqual(ops.scriptsDir({ CLAUDE_CUSTOM_WORKTREE_SCRIPTS: 'D:\\stand-ins' }), 'D:\\stand-ins');
  assert.strictEqual(ops.scriptsDir({ CLAUDE_CUSTOM_WORKTREE_SCRIPTS: '' }),
    path.join(os.homedir(), '.claude', 'skills', 'worktree', 'scripts'));
  assert.strictEqual(ops.scriptsDir({}), path.join(os.homedir(), '.claude', 'skills', 'worktree', 'scripts'));
});

test('available: one flag per contract script, by file name', () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return p.endsWith('setup-worktree.ps1'); };
  assert.deepStrictEqual(ops.available('D:\\s', exists), { create: false, setup: true, remove: false });
  assert.deepStrictEqual(seen.sort(), [
    path.join('D:\\s', 'new-worktree.ps1'), path.join('D:\\s', 'remove-worktree.ps1'),
    path.join('D:\\s', 'setup-worktree.ps1'),
  ].sort());
});

test('available: an exists() that throws counts as missing', () => {
  assert.deepStrictEqual(ops.available('D:\\s', () => { throw new Error('denied'); }),
    { create: false, setup: false, remove: false });
});

// --- psArg / checkBranch / cleanStderr ------------------------------------------

test('psArg binds the value with a colon, so a value starting with "-" stays a value', () => {
  assert.strictEqual(ops.psArg('Branch', 'feat/x'), '-Branch:feat/x');
  assert.strictEqual(ops.psArg('Branch', '-Base'), '-Branch:-Base');
});

test('checkBranch refuses only what cannot be passed safely; the script owns the naming rules', () => {
  for (const bad of ['', '   ', '-Base', 'feat/a b', 'feat/a\tb', 'feat/"x"', 'feat/\u0007x', null, undefined, 42]) {
    assert.strictEqual(typeof ops.checkBranch(bad), 'string', JSON.stringify(bad));
  }
  assert.strictEqual(ops.checkBranch('feat/x'), null);
  assert.strictEqual(ops.checkBranch('demo'), null, 'criterion 2: the SCRIPT refuses demo, word for word');
  assert.strictEqual(ops.checkBranch('  feat/x  '), null, 'surrounding spaces are trimmed by the caller');
});

test('Miguel G3: invisible bidi and zero-width characters are refused (a name must read as what it is)', () => {
  for (const c of [0x200b, 0x200d, 0x200e, 0x202e, 0x2066, 0x2069, 0xfeff].map(n => String.fromCharCode(n))) {
    assert.strictEqual(typeof ops.checkBranch(`feat/a${c}b`), 'string', `U+${c.charCodeAt(0).toString(16)}`);
  }
  assert.strictEqual(ops.checkBranch('feat/café'), null, 'an ordinary accented letter is fine');
});

test('PROPERTY: checkBranch either refuses a string or it is safe to pass', () => {
  fc.assert(fc.property(fc.string(), (s) => {
    if (ops.checkBranch(s) !== null) return true;
    const t = s.trim();
    return t !== '' && !t.startsWith('-') && !/\s/.test(t) && !/[\u0000-\u001f\u007f"]/.test(t);
  }), { numRuns: 500 });
});

test('cleanStderr: one line, word for word, with the BOM and a CLIXML progress block dropped', () => {
  assert.strictEqual(ops.cleanStderr('branch demo has no prefix (feat/, fix/, ...)\r\n'),
    'branch demo has no prefix (feat/, fix/, ...)');
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>\r\n';
  assert.strictEqual(ops.cleanStderr(BOM + clixml + 'the real line\r\n'), 'the real line');
  assert.strictEqual(ops.cleanStderr('first part\r\n  second part  \r\n\r\n'), 'first part second part');
  assert.strictEqual(ops.cleanStderr(''), '');
  assert.strictEqual(ops.cleanStderr(null), '');
});

// --- runScript ------------------------------------------------------------------

test('runScript spawns powershell -File with the script and its arguments, stdin closed, no window', async () => {
  const child = fakeChild();
  const calls = [];
  const p = ops.runScript({ script: 'D:\\s\\x.ps1', args: ['-Path:C:\\a'], timeoutMs: 1000, spawn: spawnOf(child, calls) });
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await p;
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].exe, /powershell\.exe$/i);
  assert.deepStrictEqual(calls[0].args, ['-NoProfile', '-NonInteractive', '-File', 'D:\\s\\x.ps1', '-Path:C:\\a']);
  assert.strictEqual(calls[0].opts.windowsHide, true);
  assert.strictEqual(calls[0].opts.stdio[0], 'ignore');
});

test('runScript collects stdout and stderr and reports the exit code', async () => {
  const child = fakeChild();
  const p = ops.runScript({ script: 's.ps1', timeoutMs: 1000, spawn: spawnOf(child) });
  child.stdout.emit('data', Buffer.from('{"a":'));
  child.stdout.emit('data', '1}\r\n');
  child.stderr.emit('data', 'warn\r\n');
  child.emit('exit', 2, null);
  child.emit('close', 2, null);
  const r = await p;
  assert.deepStrictEqual(r, { code: 2, stdout: '{"a":1}\r\n', stderr: 'warn\r\n', timedOut: false, spawnError: null });
});

test('Miguel Y1: a character split across two chunks is decoded whole', async () => {
  const child = fakeChild();
  const p = ops.runScript({ script: 's.ps1', timeoutMs: 1000, spawn: spawnOf(child) });
  const euro = Buffer.from('{"p":"C:\\\\caf\u00e9 \u20ac"}\n', 'utf8');
  const cut = euro.indexOf(0xe2) + 1;              // inside the euro sign's three bytes
  child.stdout.emit('data', euro.subarray(0, cut));
  child.stdout.emit('data', euro.subarray(cut));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.strictEqual((await p).stdout, '{"p":"C:\\\\caf\u00e9 \u20ac"}\n');
});

test('Miguel Y1: a long run keeps only the TAIL of each stream (the answer is the last line)', async () => {
  const child = fakeChild();
  const p = ops.runScript({ script: 's.ps1', timeoutMs: 1000, spawn: spawnOf(child) });
  const noise = 'x'.repeat(1024) + '\n';
  for (let i = 0; i < 200; i++) { child.stdout.emit('data', noise); child.stderr.emit('data', noise); }
  child.stdout.emit('data', '{"ok":true}\n');
  child.stderr.emit('data', 'the real error\n');
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const r = await p;
  assert.ok(r.stdout.length <= ops.STREAM_KEEP, `stdout kept ${r.stdout.length}`);
  assert.ok(r.stderr.length <= ops.STREAM_KEEP, `stderr kept ${r.stderr.length}`);
  assert.ok(r.stdout.endsWith('{"ok":true}\n'));
  assert.ok(r.stderr.endsWith('the real error\n'));
});

test('Miguel Y1: the one line shown in the strip is capped', () => {
  const t = ops.cleanStderr('e'.repeat(5000));
  assert.ok(t.length <= ops.LINE_SHOWN_MAX, `${t.length}`);
  assert.ok(t.endsWith('…'));
  assert.strictEqual(ops.cleanStderr('short'), 'short');
});

test('runScript keys completion on EXIT: a stream held open by a background process does not hold it', async () => {
  const child = fakeChild();
  const t0 = Date.now();
  const p = ops.runScript({ script: 's.ps1', timeoutMs: 60000, graceMs: 30, spawn: spawnOf(child) });
  child.stdout.emit('data', '{"ok":true}\n');
  child.emit('exit', 0, null);          // ...and no close ever comes
  const r = await p;
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '{"ok":true}\n');
  assert.ok(Date.now() - t0 < 1000);
});

test('runScript still reads output that arrives after exit but before close', async () => {
  const child = fakeChild();
  const p = ops.runScript({ script: 's.ps1', timeoutMs: 60000, graceMs: 1000, spawn: spawnOf(child) });
  child.emit('exit', 0, null);
  child.stdout.emit('data', '{"late":true}\n');
  child.emit('close', 0, null);
  const r = await p;
  assert.strictEqual(r.stdout, '{"late":true}\n');
});

test('runScript on timeout stops WAITING and kills nothing', async () => {
  const child = fakeChild();
  const r = await ops.runScript({ script: 's.ps1', timeoutMs: 20, spawn: spawnOf(child) });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.code, null);
  assert.strictEqual(child.killed, 0, 'a killed remover can leave a half-removed folder');
});

test('runScript: a spawn error or a throwing spawn settles, never rejects', async () => {
  const child = fakeChild();
  const p = ops.runScript({ script: 's.ps1', timeoutMs: 1000, spawn: spawnOf(child) });
  child.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
  const r = await p;
  assert.match(r.spawnError, /ENOENT/);
  assert.strictEqual(r.code, null);
  const r2 = await ops.runScript({ script: 's.ps1', timeoutMs: 1000, spawn: () => { throw new Error('nope'); } });
  assert.strictEqual(r2.spawnError, 'nope');
});

test('runScript: a process ended by a signal has no exit code (never 0)', async () => {
  const child = fakeChild();
  const p = ops.runScript({ script: 's.ps1', timeoutMs: 1000, spawn: spawnOf(child) });
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  assert.strictEqual((await p).code, null);
});

// --- parseCreate (Contract A) ------------------------------------------------------

const WT = `${BOX}\\feat-demo`;

test('parseCreate: exit 0 + one JSON line for a sibling of the container -> ok', () => {
  const out = JSON.stringify({ path: WT, branch: 'feat/demo' });
  assert.deepStrictEqual(ops.parseCreate(run({ stdout: BOM + out + '\r\n' }), BOX),
    { ok: true, path: WT, branch: 'feat/demo', warning: null });
});

test('parseCreate: the optional warning is carried', () => {
  const out = JSON.stringify({ path: WT, branch: 'feat/demo', warning: 'Active Lanes row not added' });
  assert.strictEqual(ops.parseCreate(run({ stdout: out }), BOX).warning, 'Active Lanes row not added');
});

test('parseCreate: a refusal shows the script\'s stderr word for word', () => {
  const r = ops.parseCreate(run({ code: 1, stderr: 'demo: a branch needs a prefix: feat/, fix/, spike/\r\n' }), BOX);
  assert.deepStrictEqual(r, { ok: false, error: 'demo: a branch needs a prefix: feat/, fix/, spike/' });
});

test('parseCreate: a failure with no stderr still says something true', () => {
  assert.deepStrictEqual(ops.parseCreate(run({ code: 3 }), BOX), { ok: false, error: 'new-worktree.ps1 failed (exit 3)' });
  assert.deepStrictEqual(ops.parseCreate(run({ code: null }), BOX), { ok: false, error: 'new-worktree.ps1 failed (no exit code)' });
});

test('parseCreate: exit 0 with an unreadable answer is not success (the poll finds the worktree)', () => {
  for (const stdout of ['', 'garbage', '[1,2]', JSON.stringify({ path: 'D:\\elsewhere\\x', branch: 'feat/x' }),
    JSON.stringify({ path: `${BOX}\\a\\b`, branch: 'feat/x' }), JSON.stringify({ path: WT }),
    JSON.stringify({ path: `${BOX}\\dev`.replace('dev', '') , branch: 'feat/x' })]) {
    const r = ops.parseCreate(run({ stdout }), BOX);
    assert.strictEqual(r.ok, false, stdout);
    assert.match(r.error, /couldn't be read/, stdout);
    // Dexter F6 (PR #80): the worktree may exist, but nothing set it up.
    assert.match(r.error, /setup-worktree\.ps1 did not run/, stdout);
  }
});

test('parseCreate: a timeout or spawn failure has its own text', () => {
  assert.match(ops.parseCreate(run({ code: null, timedOut: true }), BOX).error, /didn't finish in time/);
  assert.match(ops.parseCreate(run({ code: null, timedOut: true }), BOX).error, /setup-worktree\.ps1 did not run/, 'Dexter F6');
  assert.match(ops.parseCreate(run({ code: null, spawnError: 'ENOENT' }), BOX).error, /couldn't run new-worktree\.ps1: ENOENT/);
});

// --- parseSetup (Contract E) -------------------------------------------------------

test('parseSetup: exit 0 is success, with the JSON when it can be read', () => {
  const json = { path: WT, manifest: true, copied: ['.env'], kept: [], ran: ['npm ci'], log: 'L' };
  assert.deepStrictEqual(ops.parseSetup(run({ stdout: JSON.stringify(json) })), { ok: true, result: json });
  assert.deepStrictEqual(ops.parseSetup(run({ stdout: 'noise' })), { ok: true, result: null });
});

test('parseSetup: a failure carries the stderr line and the log path it quotes', () => {
  const log = 'C:\\p\\dev\\.git\\worktrees\\feat-demo\\claude-setup.log';
  assert.deepStrictEqual(ops.parseSetup(run({ code: 1, stderr: `run: 'npm ci' exited with 1 (output in ${log}).` })),
    { ok: false, error: `run: 'npm ci' exited with 1 (output in ${log}).`, log });
  assert.deepStrictEqual(ops.parseSetup(run({ code: 1, stderr: `copy: '.env' failed: denied (log: ${log})` })),
    { ok: false, error: `copy: '.env' failed: denied (log: ${log})`, log });
  assert.deepStrictEqual(ops.parseSetup(run({ code: 1, stderr: 'bad manifest' })),
    { ok: false, error: 'bad manifest', log: null });
  assert.strictEqual(ops.parseSetup(run({ code: null, timedOut: true })).ok, false);
});

// --- parseRemove (Contract C) ------------------------------------------------------

test('parseRemove: exit 0 removed, or already removed by another remover (the reaper hook)', () => {
  assert.deepStrictEqual(ops.parseRemove(run({ stdout: `removed: ${WT}\r\n` })), { ok: true, already: false });
  assert.deepStrictEqual(ops.parseRemove(run({ stdout: `already removed: ${WT}\r\n` })), { ok: true, already: true });
});

test('parseRemove: exit 2 is KEPT on purpose, not an error', () => {
  assert.deepStrictEqual(ops.parseRemove(run({ code: 2, stderr: 'feat/demo still has a handoff brief\r\n' })),
    { ok: false, kept: true, reason: 'feat/demo still has a handoff brief' });
});

test('parseRemove: exit 1, a timeout and a spawn failure are errors', () => {
  assert.deepStrictEqual(ops.parseRemove(run({ code: 1, stderr: `${WT} has uncommitted changes. Nothing was removed.` })),
    { ok: false, error: `${WT} has uncommitted changes. Nothing was removed.` });
  assert.match(ops.parseRemove(run({ code: null, timedOut: true })).error, /may still be running/);
  assert.match(ops.parseRemove(run({ code: null, spawnError: 'ENOENT' })).error, /ENOENT/);
});

test('PROPERTY: parseRemove is ok only for exit 0', () => {
  fc.assert(fc.property(
    fc.oneof(fc.integer({ min: -5, max: 300 }), fc.constant(null)), fc.string(), fc.string(), fc.boolean(),
    (code, stdout, stderr, timedOut) => {
      const r = ops.parseRemove({ code, stdout, stderr, timedOut, spawnError: null });
      return r.ok !== true || (code === 0 && !timedOut);
    }), { numRuns: 500 });
});

// --- the setup log ---------------------------------------------------------------

test('lastLine: the last non-empty line, trimmed and capped; null when there is none', () => {
  assert.strictEqual(ops.lastLine('a\r\nb\r\n\r\n'), 'b');
  assert.strictEqual(ops.lastLine('  added 512 packages  '), 'added 512 packages');
  assert.strictEqual(ops.lastLine(''), null);
  assert.strictEqual(ops.lastLine('\r\n \n'), null);
  assert.strictEqual(ops.lastLine(null), null);
  assert.strictEqual(ops.lastLine('x'.repeat(500)).length, 200);
});

test('setupLogPath: <git-dir of the worktree>\\claude-setup.log, null without a .git file', () => {
  const dir = tmpDir('cc-wops-');
  const wt = path.join(dir, 'feat-x');
  const gitDir = path.join(dir, 'dev', '.git', 'worktrees', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
  assert.strictEqual(ops.setupLogPath(wt), path.join(gitDir, 'claude-setup.log'));
  assert.strictEqual(ops.setupLogPath(path.join(dir, 'nope')), null);
});

// --- createOps -----------------------------------------------------------------

test('createOps.create runs new-worktree.ps1 with -Project and -Branch bound by colon', async () => {
  const child = fakeChild();
  const calls = [];
  const o = ops.createOps({ dir: 'D:\\s', spawn: spawnOf(child, calls), exists: () => true });
  const p = o.create({ container: BOX, branch: 'feat/demo' });
  child.stdout.emit('data', JSON.stringify({ path: WT, branch: 'feat/demo' }));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.deepStrictEqual(await p, { ok: true, path: WT, branch: 'feat/demo', warning: null });
  assert.deepStrictEqual(calls[0].args.slice(3), [path.join('D:\\s', 'new-worktree.ps1'), `-Project:${BOX}`, '-Branch:feat/demo']);
});

test('createOps.create refuses an unsafe branch without running anything', async () => {
  const calls = [];
  const o = ops.createOps({ dir: 'D:\\s', spawn: spawnOf(fakeChild(), calls), exists: () => true });
  const r = await o.create({ container: BOX, branch: '-Base' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.length, 0);
});

test('createOps.remove runs remove-worktree.ps1 -Path and maps exit 2 to kept', async () => {
  const child = fakeChild();
  const calls = [];
  const o = ops.createOps({ dir: 'D:\\s', spawn: spawnOf(child, calls), exists: () => true });
  const p = o.remove({ path: WT });
  child.stderr.emit('data', 'feat/demo still has a handoff brief\r\n');
  child.emit('exit', 2, null);
  child.emit('close', 2, null);
  assert.deepStrictEqual(await p, { ok: false, kept: true, reason: 'feat/demo still has a handoff brief' });
  assert.deepStrictEqual(calls[0].args.slice(3), [path.join('D:\\s', 'remove-worktree.ps1'), `-Path:${WT}`]);
});

test('createOps.setup feeds onLine from the setup log while the script runs, then parses its result', async () => {
  const child = fakeChild();
  const calls = [];
  const lines = [];
  let log = '';
  const o = ops.createOps({
    dir: 'D:\\s', spawn: spawnOf(child, calls), exists: () => true, pollMs: 5,
    logPath: () => 'L', readFile: (p) => { assert.strictEqual(p, 'L'); return log; },
  });
  const p = o.setup({ path: WT, onLine: (l) => lines.push(l) });
  log = 'copied .env\r\n';
  await new Promise(r => setTimeout(r, 30));
  log += 'added 512 packages\r\n';
  await new Promise(r => setTimeout(r, 30));
  child.stdout.emit('data', JSON.stringify({ path: WT, manifest: true, copied: [], kept: [], ran: ['npm ci'], log: 'L' }));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const r = await p;
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(lines, ['copied .env', 'added 512 packages'], 'each new last line once');
  assert.deepStrictEqual(calls[0].args.slice(3), [path.join('D:\\s', 'setup-worktree.ps1'), `-Path:${WT}`]);
  const after = lines.length;
  log += 'too late\r\n';
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(lines.length, after, 'the log is no longer polled once setup ended');
});

test('createOps.setup: an unreadable log is no progress, never a failure', async () => {
  const child = fakeChild();
  const o = ops.createOps({
    dir: 'D:\\s', spawn: spawnOf(child), exists: () => true, pollMs: 5,
    logPath: () => 'L', readFile: () => { throw new Error('ENOENT'); },
  });
  const p = o.setup({ path: WT, onLine: () => assert.fail('no line') });
  await new Promise(r => setTimeout(r, 20));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.strictEqual((await p).ok, true);
});

test('createOps: a missing script is a value, never a spawn', async () => {
  const calls = [];
  const o = ops.createOps({ dir: 'D:\\s', spawn: spawnOf(fakeChild(), calls), exists: () => false });
  assert.deepStrictEqual(o.available(), { create: false, setup: false, remove: false });
  assert.match((await o.create({ container: BOX, branch: 'feat/x' })).error, /new-worktree\.ps1 isn't installed/);
  assert.match((await o.remove({ path: WT })).error, /remove-worktree\.ps1 isn't installed/);
  assert.match((await o.setup({ path: WT, onLine: () => {} })).error, /setup-worktree\.ps1 isn't installed/);
  assert.strictEqual(calls.length, 0);
});
