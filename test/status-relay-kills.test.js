'use strict';
/**
 * Kill tests for the release-gate survivors S7 and S19 in host/status-relay.js (Mortimer, 2026-10-09): a sweep that finished must not be
 * followed by a second kill, and a sweep that failed must end every pid it reported. `run` is injected; no process is touched.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');
const { killTree, sweepPids, parseArgs, quiet } = require('../host/status-relay');

const onWin = process.platform === 'win32';

const owned = [];
test.after(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); });

test('S7: sweepPids reads the last complete ALIVE line (pid:start pairs), LF or CRLF, and nothing else', () => {
  const p = (pid, start) => ({ pid, start: String(start) });
  assert.deepStrictEqual(sweepPids('ALIVE 7:70 8:80\n'), [p(7, 70), p(8, 80)], 'LF only');
  assert.deepStrictEqual(sweepPids('ALIVE 5:50 6:60\r\n'), [p(5, 50), p(6, 60)], 'CRLF');
  assert.deepStrictEqual(sweepPids('ALIVE 7:70\nnoise\n'), [p(7, 70)], 'noise lines are not ALIVE lines');
  assert.deepStrictEqual(sweepPids('ALIVE 1:1\nALIVE 1:1 2:2\nALIVE 3:3\n'), [p(3, 3)], 'the LAST line is the pending set: pids the sweep ended are gone from it');
  assert.deepStrictEqual(sweepPids('ALIVE 1:1 2:2\nALIVE 1:1 2:2 3:3'), [p(1, 1), p(2, 2)], 'an unterminated last line may be cut mid-number: not read');
  assert.deepStrictEqual(sweepPids('ALIVE 10:5 1'), [], 'a single cut-off line names nothing');
  assert.deepStrictEqual(sweepPids('ALIVE 1:1\nALIVE 2:2 x\n'), [p(1, 1)], 'a line with a non-pair is not an ALIVE line');
  assert.deepStrictEqual(sweepPids('ALIVE 7 8\n'), [], 'a bare pid, with no start to prove, is not read');
  assert.deepStrictEqual(sweepPids('ALIVE 7:70 8\n'), [], 'one bare pid spoils the line');
  assert.deepStrictEqual(sweepPids('xALIVE 1:1\n'), []);
  assert.deepStrictEqual(sweepPids('ALIVE\n'), []);
  assert.deepStrictEqual(sweepPids('ALIVE \n'), [], 'nothing pending');
  assert.deepStrictEqual(sweepPids(''), []);
  assert.deepStrictEqual(sweepPids(null), []);
  const many = 'ALIVE ' + Array.from({ length: 300 }, (_, i) => `${i + 1}:${i + 1}`).join(' ') + '\n';
  const got = sweepPids(many);
  assert.strictEqual(got.length, 200, 'capped');
  assert.deepStrictEqual(got[0], p(1, 1));
  assert.deepStrictEqual(got[199], p(200, 200));
});

test('S7: a sweep that exited 0 is followed by NO taskkill; one that failed ends the root by number, and every pending pid in ONE proven batch', { skip: !onWin }, () => {
  const child = { pid: 100, kill() { assert.fail('the POSIX kill is not for Windows'); } };
  const mk = (result) => {
    const runs = []; const batches = [];
    return { runs, batches, run: (...a) => { runs.push(a); return runs.length === 1 ? result : { status: 0 }; }, proveBatch: (items, o) => { batches.push([items, o]); return new Map(); } };
  };

  const clean = mk({ status: 0, stdout: 'ALIVE 5:50 6:60\r\n' });
  killTree(child, 123, { run: clean.run, proveBatch: clean.proveBatch });
  assert.strictEqual(clean.runs.length, 1, 'only the sweep ran');
  assert.deepStrictEqual(clean.batches, [], 'a sweep that finished proves and kills nothing more');
  assert.strictEqual(clean.runs[0][0], 'powershell.exe');
  assert.deepStrictEqual(clean.runs[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(clean.runs[0][1][3], /\$root=100\b/);
  assert.doesNotMatch(clean.runs[0][1][3], /FromUnixTimeMilliseconds|\$since/, 'the sweep reads no wall clock (PR #126 F4)');
  assert.strictEqual(clean.runs[0][2].windowsHide, true);
  assert.strictEqual(clean.runs[0][2].encoding, 'utf8');
  assert.deepStrictEqual(clean.runs[0][2].stdio, ['ignore', 'pipe', 'ignore']);

  // Only the ROOT (our own child, its pid held by libuv) is ended by number; every other pid goes through ONE killProvenBatch with its start.
  const failed = mk({ status: 3, stdout: 'ALIVE 100:1 5:50 6:60\n' });
  killTree(child, 123, { run: failed.run, proveBatch: failed.proveBatch });
  assert.deepStrictEqual(failed.runs.slice(1).map(r => r[1][1]), ['100'], 'the only taskkill by number is the root');
  assert.strictEqual(failed.runs[1][0], 'taskkill');
  assert.deepStrictEqual(failed.runs[1][1].slice(2), ['/T', '/F']);
  assert.deepStrictEqual(failed.runs[1][2], { windowsHide: true, stdio: 'ignore' });
  assert.deepStrictEqual(failed.batches, [[[{ pid: 5, start: '50' }, { pid: 6, start: '60' }], { toleranceTicks: 20000, timeoutMs: 10000 }]]);

  const errored = mk({ status: null, error: new Error('timeout'), stdout: 'ALIVE 100:1 7:70\n' });
  killTree(child, 123, { run: errored.run, proveBatch: errored.proveBatch });
  assert.deepStrictEqual(errored.runs.slice(1).map(r => r[1][1]), ['100'], 'a sweep that errored (timed out): the root once');
  assert.deepStrictEqual(errored.batches.map(b => b[0].map(t => t.pid)), [[7]]);

  const silent = mk({ status: 4, stdout: '' });
  killTree(child, 123, { run: silent.run, proveBatch: silent.proveBatch });
  assert.deepStrictEqual(silent.runs.slice(1).map(r => r[1][1]), ['100'], 'a sweep that said nothing: the root first');
  assert.deepStrictEqual(silent.batches, [], 'nothing pending, no batch call');
});

test('Y2 (Miguel) / F3 (Dexter): ~200 pending pids are ONE proven batch with ONE timeout, not 200 PowerShell starts', { skip: !onWin }, () => {
  const pending = Array.from({ length: 199 }, (_, i) => `${1000 + i}:${5000 + i}`);
  const batches = []; const runs = [];
  killTree({ pid: 100, kill() {} }, 0, {
    run: (...a) => { runs.push(a); return runs.length === 1 ? { status: 5, stdout: `ALIVE 100:1 ${pending.join(' ')}\n` } : { status: 0 }; },
    proveBatch: (items, o) => { batches.push([items, o]); return new Map(); },
  });
  assert.strictEqual(batches.length, 1, 'one batch call');
  assert.strictEqual(batches[0][0].length, 199, 'the root plus 199 others: the line is capped at 200 pids');
  assert.strictEqual(batches[0][1].timeoutMs, 10000);
  assert.strictEqual(runs.length, 2, 'the sweep and one taskkill (the root); no per-pid spawn');
});

test('S7-1 (Dexter): a pid the sweep already ENDED is not in the pending set, so a failed sweep never re-kills it (pid 7000 reused by a stranger)', { skip: !onWin }, () => {
  // `ALIVE R:.. 7000:..` was said, 7000 was then killed, and the sweep failed (status 4). The sweep's last line no longer lists 7000.
  const runs = []; const batches = [];
  killTree({ pid: 100, kill() {} }, 0, {
    run: (...a) => { runs.push(a); return runs.length === 1 ? { status: 4, stdout: 'ALIVE 100:1 7000:7\nALIVE 100:1\n' } : { status: 0 }; },
    proveBatch: (items) => { batches.push(items); return new Map(); },
  });
  assert.deepStrictEqual(runs.slice(1).map(r => r[1][1]), ['100']);
  assert.deepStrictEqual(batches, [], 'pid 7000 is not touched: it was ended by the sweep and may be a stranger now');
});

test('S7: a proveBatch that throws is swallowed; the root was already ended', { skip: !onWin }, () => {
  const runs = [];
  assert.doesNotThrow(() => killTree({ pid: 100, kill() {} }, 0, {
    run: (...a) => { runs.push(a); return runs.length === 1 ? { status: 4, stdout: 'ALIVE 100:1 5:50\n' } : { status: 0 }; },
    proveBatch: () => { throw new Error('x'); },
  }));
  assert.deepStrictEqual(runs.slice(1).map(r => r[1][1]), ['100']);
});

test('S7: a run that throws is swallowed (the process is already gone)', { skip: !onWin }, () => {
  assert.doesNotThrow(() => killTree({ pid: 1 }, 0, { run: () => { throw new Error('gone'); } }));
});

test('S19: parseArgs reads each flag, and a flag with no value after it is ignored', () => {
  assert.deepStrictEqual(parseArgs(['--pipe', 'p', '--then', 'dGVzdA==', '--quiet-when', 'f.json']), { pipe: 'p', then: 'dGVzdA==', quietWhen: 'f.json' });
  assert.deepStrictEqual(parseArgs(['--quiet-when', 'f.json']), { pipe: null, then: null, quietWhen: 'f.json' });
  assert.deepStrictEqual(parseArgs(['--pipe']), { pipe: null, then: null, quietWhen: null });
  assert.deepStrictEqual(parseArgs(['--then']), { pipe: null, then: null, quietWhen: null });
  assert.deepStrictEqual(parseArgs(['--quiet-when']), { pipe: null, then: null, quietWhen: null });
  assert.deepStrictEqual(parseArgs(['--other', 'x']), { pipe: null, then: null, quietWhen: null });
  assert.deepStrictEqual(parseArgs([]), { pipe: null, then: null, quietWhen: null });
});

test('S19: quiet is true only for an exact statusInHeader: true in a readable file', () => {
  const dir = tmpDir('cc-relay-kills-');
  owned.push(dir);
  const put = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  assert.strictEqual(quiet(put('yes.json', '{"statusInHeader":true}')), true);
  assert.strictEqual(quiet(put('str.json', '{"statusInHeader":"true"}')), false);
  assert.strictEqual(quiet(put('one.json', '{"statusInHeader":1}')), false);
  assert.strictEqual(quiet(put('no.json', '{"statusInHeader":false}')), false);
  assert.strictEqual(quiet(put('none.json', '{}')), false);
  assert.strictEqual(quiet(put('null.json', 'null')), false);
  assert.strictEqual(quiet(put('junk.json', '{nope')), false);
  assert.strictEqual(quiet(path.join(dir, 'missing.json')), false);
  assert.strictEqual(quiet(null), false);
  assert.strictEqual(quiet(''), false);
});

// --- kill tests for the release-176 survivors: M14, the ENDED half of the sweep protocol (BACKLOG #94) ------------------------
//
// sweepEnded is not exported; what it read is observable in the SEEDED rescan a failed sweep starts for the parents it had ended
// (the second PowerShell run), so these go through killTree with `run` injected. No process is touched.

// What a failed sweep that printed `stdout` makes the fallback rescan: the [{id,start,exit}] in the seeded script, or null when no
// rescan was started.
function rescanFor(stdout) {
  const runs = [];
  killTree({ pid: 100, kill() {} }, 0, {
    run: (...a) => { runs.push(a); return runs.length === 1 ? { status: 5, stdout } : { status: 0 }; },
    proveBatch: () => new Map(),
  });
  const seeded = runs.slice(1).find(r => r[0] === 'powershell.exe');
  if (!seeded) return null;
  const script = seeded[1][3];
  assert.match(script, /^\$ErrorActionPreference='Stop'\r?\n\$root=100\r?\n/);
  assert.match(script, /\$seeded=\$true\r?\n\$pending=@\(\);\$known=@\{\};\$endedIds=@\{\}\r?\n\$levelParents=@\(/);
  assert.match(script, /\)\r?\n\$kill=@\(\)/);
  assert.doesNotMatch(script, /\$seeded=\$false/, 'a rescan is seeded, not rooted');
  assert.strictEqual(seeded[2].timeout, 10000);
  const list = /\$levelParents=@\((.*)\)\r?\n\$kill=@\(\)/.exec(script)[1];
  return list ? list.split(',').map((e) => {
    const m = /^\[pscustomobject\]@\{id=(\d+);start=(\d+);exit=(\d+);alive=\$false\}$/.exec(e);
    assert.ok(m, `an entry in the seed list: ${e}`);
    return { id: Number(m[1]), start: m[2], exit: m[3] };
  }) : [];
}
const ent = (id, start, exit) => ({ id, start: String(start), exit: String(exit) });

test('M14: the parents a failed sweep had ENDED are rescanned, each with its pid, start and exit bound', { skip: !onWin }, () => {
  assert.deepStrictEqual(rescanFor('ENDED 1:2:3 4:5:6\n'), [ent(1, 2, 3), ent(4, 5, 6)]);
  assert.deepStrictEqual(rescanFor('ENDED 11:22:33\r\n'), [ent(11, 22, 33)], 'CRLF');
  assert.deepStrictEqual(rescanFor('ENDED 123456:9876543210:9876543211\n'), [ent(123456, '9876543210', '9876543211')], 'multi-digit numbers');
  assert.deepStrictEqual(rescanFor('ENDED 1:2:3 \n'), [ent(1, 2, 3)], 'trailing blanks are allowed');
});

test('M14: only the LAST complete ENDED line counts, and noise lines are not ENDED lines', { skip: !onWin }, () => {
  assert.deepStrictEqual(rescanFor('ENDED 1:1:1\nENDED 2:2:2\nnoise\n'), [ent(2, 2, 2)]);
  assert.deepStrictEqual(rescanFor('ENDED 1:1:1\nALIVE 5:5\nENDED 2:2:2 3:3:3\nALIVE 6:6\n'), [ent(2, 2, 2), ent(3, 3, 3)]);
});

test('M14: a line that is not exactly ENDED followed by pid:start:exit triples is not read', { skip: !onWin }, () => {
  for (const bad of [
    ' ENDED 1:2:3\n', 'xENDED 1:2:3\n', 'ENDED 1:2:3x\n', 'ENDED 1:2:3 x\n', 'ENDED 1:2\n', 'ENDED 1:2:3:4\n', 'ENDED 1 2 3\n',
    'ENDED a:2:3\n', 'ENDED 1:b:3\n', 'ENDED 1:2:c\n', 'ENDED 1:2:3 4:5\n', 'ended 1:2:3\n', 'ENDED1:2:3\n',
  ]) assert.strictEqual(rescanFor(bad), null, JSON.stringify(bad));
});

test('M14: a bare ENDED line names no parent, so no rescan starts', { skip: !onWin }, () => {
  assert.strictEqual(rescanFor('ENDED\n'), null);
  assert.strictEqual(rescanFor('ENDED \n'), null);
  assert.strictEqual(rescanFor(''), null);
  assert.strictEqual(rescanFor(undefined), null);
  assert.strictEqual(rescanFor(null), null);
});

test('M14: an unterminated last line may be cut mid-number and is never read; the line before it is', { skip: !onWin }, () => {
  assert.strictEqual(rescanFor('ENDED 1:2:3'), null, 'a single unterminated line names nothing');
  assert.deepStrictEqual(rescanFor('ENDED 1:2:3\nENDED 4:5:6 7:8:9'), [ent(1, 2, 3)]);
  assert.strictEqual(rescanFor('ENDED 10:5:1'), null);
});

test('M14: at most 200 ended parents are rescanned, the first 200 of the line', { skip: !onWin }, () => {
  const triples = Array.from({ length: 250 }, (_, i) => `${i + 1}:${i + 1000}:${i + 2000}`);
  const got = rescanFor(`ENDED ${triples.join(' ')}\n`);
  assert.strictEqual(got.length, 200);
  assert.deepStrictEqual(got[0], ent(1, 1000, 2000));
  assert.deepStrictEqual(got[199], ent(200, 1199, 2199));
});

test('M14: a sweep that finished (exit 0) starts no rescan, whatever it printed', { skip: !onWin }, () => {
  const runs = [];
  killTree({ pid: 100, kill() {} }, 0, {
    run: (...a) => { runs.push(a); return { status: 0, stdout: 'ENDED 1:2:3\n' }; },
    proveBatch: () => new Map(),
  });
  assert.strictEqual(runs.length, 1);
});

test('M14: a rescan that throws is swallowed', { skip: !onWin }, () => {
  let n = 0;
  assert.doesNotThrow(() => killTree({ pid: 100, kill() {} }, 0, {
    run: () => { n += 1; if (n === 3) throw new Error('boom'); return n === 1 ? { status: 5, stdout: 'ENDED 1:2:3\n' } : { status: 0 }; },
    proveBatch: () => new Map(),
  }));
  assert.strictEqual(n, 3);
});

test('M14: sweepPids accepts trailing blanks on the ALIVE line, as ENDED does', () => {
  assert.deepStrictEqual(sweepPids('ALIVE 1:2 \n'), [{ pid: 1, start: '2' }]);
  assert.deepStrictEqual(sweepPids('ALIVE 1:2\t\n'), [{ pid: 1, start: '2' }]);
});
