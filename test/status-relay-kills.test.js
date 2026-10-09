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

test('S7: sweepPids reads the last complete ALIVE line, LF or CRLF, and nothing else', () => {
  assert.deepStrictEqual(sweepPids('ALIVE 7 8\n'), [7, 8], 'LF only');
  assert.deepStrictEqual(sweepPids('ALIVE 5 6\r\n'), [5, 6], 'CRLF');
  assert.deepStrictEqual(sweepPids('ALIVE 7\nnoise\n'), [7], 'noise lines are not ALIVE lines');
  assert.deepStrictEqual(sweepPids('ALIVE 1\nALIVE 1 2\nALIVE 1 2 3\n'), [1, 2, 3], 'cumulative: the last one');
  assert.deepStrictEqual(sweepPids('ALIVE 1 2\nALIVE 1 2 3'), [1, 2], 'an unterminated last line may be cut mid-pid: not read');
  assert.deepStrictEqual(sweepPids('ALIVE 10 1'), [], 'a single cut-off line names nothing');
  assert.deepStrictEqual(sweepPids('ALIVE 1\nALIVE 2 x\n'), [1], 'a line with a non-pid is not an ALIVE line');
  assert.deepStrictEqual(sweepPids('xALIVE 1\n'), []);
  assert.deepStrictEqual(sweepPids('ALIVE\n'), []);
  assert.deepStrictEqual(sweepPids(''), []);
  assert.deepStrictEqual(sweepPids(null), []);
  const many = 'ALIVE ' + Array.from({ length: 300 }, (_, i) => i + 1).join(' ') + '\n';
  const got = sweepPids(many);
  assert.strictEqual(got.length, 200, 'capped');
  assert.strictEqual(got[0], 1);
  assert.strictEqual(got[199], 200);
});

test('S7: a sweep that exited 0 is followed by NO taskkill; one that failed ends the root and every pid it reported', { skip: !onWin }, () => {
  const child = { pid: 100, kill() { assert.fail('the POSIX kill is not for Windows'); } };
  const mk = (result) => { const runs = []; return { runs, run: (...a) => { runs.push(a); return runs.length === 1 ? result : { status: 0 }; } }; };

  const clean = mk({ status: 0, stdout: 'ALIVE 5 6\r\n' });
  killTree(child, 123, { run: clean.run });
  assert.strictEqual(clean.runs.length, 1, 'only the sweep ran');
  assert.strictEqual(clean.runs[0][0], 'powershell.exe');
  assert.deepStrictEqual(clean.runs[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(clean.runs[0][1][3], /\$root=100\b/);
  assert.match(clean.runs[0][1][3], /FromUnixTimeMilliseconds\(123\)/);
  assert.strictEqual(clean.runs[0][2].windowsHide, true);
  assert.strictEqual(clean.runs[0][2].encoding, 'utf8');
  assert.deepStrictEqual(clean.runs[0][2].stdio, ['ignore', 'pipe', 'ignore']);

  const failed = mk({ status: 3, stdout: 'ALIVE 5 6\n' });
  killTree(child, 123, { run: failed.run });
  const targets = failed.runs.slice(1).map(r => { assert.strictEqual(r[0], 'taskkill'); assert.deepStrictEqual(r[1].slice(2), ['/T', '/F']); assert.strictEqual(r[1][0], '/pid'); return r[1][1]; });
  assert.deepStrictEqual(targets.sort(), ['100', '5', '6']);
  assert.deepStrictEqual(failed.runs[1][2], { windowsHide: true, stdio: 'ignore' });

  const errored = mk({ status: null, error: new Error('timeout'), stdout: 'ALIVE 100 7\n' });
  killTree(child, 123, { run: errored.run });
  assert.deepStrictEqual(errored.runs.slice(1).map(r => r[1][1]).sort(), ['100', '7'], 'a sweep that errored (timed out) is also followed by the plain kill, the root once');

  const silent = mk({ status: 4, stdout: '' });
  killTree(child, 123, { run: silent.run });
  assert.deepStrictEqual(silent.runs.slice(1).map(r => r[1][1]), ['100'], 'a sweep that said nothing: the root first');
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
