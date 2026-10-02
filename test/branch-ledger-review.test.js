'use strict';
/**
 * PR #84 review (Dexter + Miguel, 2026-10-01): each test is a finding's counterexample, so the fix
 * can't be undone in silence. Reports: C:\Users\ricar\.claude\reviews\claude-custom\2026-10-01-feat-git-tree-*.md
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { addLines, emptyRecord, emptyLedger, mergeLedgers, totals, updateLedger, saveLedger, loadLedger } =
  require('../host/branch-ledger');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const ROOT = 'C:\\p';
const line = (id, branch, input, cwd = 'C:\\p\\dev') => JSON.stringify({ type: 'assistant', gitBranch: branch, cwd,
  timestamp: '2026-09-20T10:00:00Z', message: { id, usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';
function projects() {
  const dir = tmpDir('ledger-review-');
  const proj = path.join(dir, projectDirName(ROOT));
  fs.mkdirSync(proj, { recursive: true });
  return { dir, proj };
}

test('Dexter F1: a shrunk transcript stays shrunk after save -- the stale longer read on disk does not win back', async () => {
  const { dir, proj } = projects();
  const file = path.join(tmpDir('ledger-review-'), 'branch-ledger.json');
  const f = path.join(proj, 's1.jsonl');
  let t = 1000;
  const opts = { projectsDir: dir, projectRoot: ROOT, now: () => t };
  fs.writeFileSync(f, line('a', 'feat/x', 10) + line('b', 'feat/x', 10));
  let ledger = (await updateLedger(emptyLedger(), opts)).ledger;
  ledger = await saveLedger(file, ledger);
  fs.writeFileSync(f, line('c', 'feat/x', 1));
  t = 2000;
  ledger = (await updateLedger(ledger, opts)).ledger;
  ledger = await saveLedger(file, ledger);
  assert.strictEqual(totals(ledger)['feat/x'].spend, 1);
  assert.strictEqual(totals((await loadLedger(file)).ledger)['feat/x'].spend, 1);
});

test('Dexter R2 Low: a clock that steps BACK between a shrink and the save still keeps the shrink', async () => {
  const { dir, proj } = projects();
  const file = path.join(tmpDir('ledger-review-'), 'branch-ledger.json');
  const f = path.join(proj, 's1.jsonl');
  let t = 5000;
  const opts = { projectsDir: dir, projectRoot: ROOT, now: () => t };
  fs.writeFileSync(f, line('a', 'feat/x', 10) + line('b', 'feat/x', 10));
  let ledger = await saveLedger(file, (await updateLedger(emptyLedger(), opts)).ledger);
  fs.writeFileSync(f, line('c', 'feat/x', 1));
  t = 1000; // the wall clock stepped backward
  ledger = await saveLedger(file, (await updateLedger(ledger, opts)).ledger);
  assert.strictEqual(totals(ledger)['feat/x'].spend, 1);
});

test('Dexter F1: across hosts, the more recent read of a file wins, whatever its offset', () => {
  const rec = (offset, at, spend) => ({ ...emptyRecord(), offset, at, branches: { b: { spend, loose: 0, first: null, last: null, cwds: [] } } });
  const stale = { version: 1, files: { f: rec(200, 1000, 20) } };
  const fresh = { version: 1, files: { f: rec(50, 2000, 1) } };
  assert.strictEqual(mergeLedgers(stale, fresh).files.f.offset, 50);
  assert.strictEqual(mergeLedgers(fresh, stale).files.f.offset, 50);
});

test('Dexter F4 / Miguel B1: a line over the carry cap is skipped, and every line after it still counts', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(5 * 1024 * 1024) } }) + '\n';
  fs.writeFileSync(f, line('a', 'feat/x', 10) + huge + line('b', 'feat/x', 3));
  const first = await updateLedger(emptyLedger(), { projectsDir: dir, projectRoot: ROOT });
  assert.strictEqual(first.errors, 0);
  assert.strictEqual(totals(first.ledger)['feat/x'].spend, 13);
  const again = await updateLedger(first.ledger, { projectsDir: dir, projectRoot: ROOT });
  assert.strictEqual(again.read, 0);
});

test('Dexter F8 / Miguel I1: a read that fails halfway changes nothing, so the retry counts each line once', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  // more than one 1 MiB chunk of usage lines
  let body = '';
  for (let i = 0; body.length < 3 * 1024 * 1024; i++) body += line(`m${i}`, 'feat/x', 1);
  fs.writeFileSync(f, body);
  const lines = body.split('\n').length - 1;
  let reads = 0;
  const flaky = async (p, flags) => {
    const fh = await fsp.open(p, flags);
    const read = fh.read.bind(fh);
    fh.read = async (...a) => { if (++reads === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return read(...a); };
    return fh;
  };
  const first = await updateLedger(emptyLedger(), { projectsDir: dir, projectRoot: ROOT, open: flaky });
  assert.strictEqual(first.errors, 1);
  const t1 = totals(first.ledger)['feat/x'];
  assert.ok(!t1 || t1.spend === 0, `nothing half-counted: ${t1 && t1.spend}`);
  const second = await updateLedger(first.ledger, { projectsDir: dir, projectRoot: ROOT });
  assert.strictEqual(totals(second.ledger)['feat/x'].spend, lines);
});

test('Miguel B2 / Dexter F12: branches named __proto__, constructor, toString and valueOf are just names', async () => {
  const names = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  const r = emptyRecord();
  addLines(r, names.map((n, i) => line(`i${i}`, n, i + 1)).join(''), ROOT);
  const t = totals({ version: 1, files: { f: r } });
  assert.deepStrictEqual(names.map(n => Object.prototype.hasOwnProperty.call(t, n) && t[n].spend), [1, 2, 3, 4, 5]);
  assert.strictEqual(Object.prototype.spend, undefined);
  assert.strictEqual({}.spend, undefined);
  // and they survive a save and load
  const file = path.join(tmpDir('ledger-review-'), 'branch-ledger.json');
  await saveLedger(file, { version: 1, files: { f: r } });
  const back = totals((await loadLedger(file)).ledger);
  assert.deepStrictEqual(names.map(n => Object.prototype.hasOwnProperty.call(back, n) && back[n].spend), [1, 2, 3, 4, 5]);
});

test('Dexter F14: a usage line with no cwd is loose, and leaves no undefined in cwds', () => {
  const r = emptyRecord();
  const noCwd = JSON.stringify({ type: 'assistant', gitBranch: 'feat/x', message: { id: 'a', usage: { input_tokens: 4 } } }) + '\n';
  addLines(r, noCwd + noCwd.replace('"a"', '"b"'), ROOT);
  assert.deepStrictEqual(r.branches['feat/x'].cwds, []);
  assert.strictEqual(r.branches['feat/x'].loose, 8);
});

test('Dexter F7: a subagent is ONE run, on the branch most of its spend landed on, worth only that branch\'s spend', () => {
  // Measured 2026-10-01: 63 of 257 subagents touched several branches -- agents in the shared dev\
  // checkout while other sessions switched branches under them. Spend stays split per line; the run
  // counts once, where it mostly worked, so a 1% brush never shows as "Dexter x1" on that card.
  const r = { ...emptyRecord(), subagent: true, agentType: 'logic-reviewer' };
  addLines(r, line('a', 'feat/a', 300) + line('b', 'develop', 10) + line('c', 'feat/b', 5), ROOT);
  const t = totals({ version: 1, files: { s: r } });
  assert.deepStrictEqual(t['feat/a'].runs, [{ agentType: 'logic-reviewer', spend: 300, loose: 0 }]);
  assert.deepStrictEqual([t.develop.runs, t['feat/b'].runs], [[], []]);
  assert.deepStrictEqual([t.develop.spend, t['feat/b'].spend], [10, 5]);
});

test('Dexter F7: loose spend is kept apart on the run, so the model can drop it', () => {
  const r = { ...emptyRecord(), subagent: true, agentType: 'logic-reviewer' };
  addLines(r, line('a', 'develop', 400, 'C:\\p-other') + line('b', 'feat/b', 5), ROOT);
  assert.deepStrictEqual(totals({ version: 1, files: { s: r } }).develop.runs, [{ agentType: 'logic-reviewer', spend: 0, loose: 400 }]);
});

test('Dexter F6 / Miguel I2: a ledger that cannot be read right now is never overwritten', async () => {
  const d = tmpDir('ledger-review-');
  const file = path.join(d, 'branch-ledger.json');
  fs.mkdirSync(file); // reading it fails with EISDIR, the way a locked file would fail
  await assert.rejects(saveLedger(file, { version: 1, files: { f: emptyRecord() } }), /not overwriting/);
  assert.ok(fs.statSync(file).isDirectory());
  assert.strictEqual((await loadLedger(file)).state, 'unreadable');
});

test('Miguel I2: a ledger from a newer version is never overwritten', async () => {
  const d = tmpDir('ledger-review-');
  const file = path.join(d, 'branch-ledger.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, files: {} }));
  assert.strictEqual((await loadLedger(file)).state, 'unreadable');
  await assert.rejects(saveLedger(file, emptyLedger()), /not overwriting/);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('Miguel I2: an invalid ledger is moved aside, not destroyed, before a new one is written', async () => {
  const d = tmpDir('ledger-review-');
  const file = path.join(d, 'branch-ledger.json');
  fs.writeFileSync(file, '{"version":1,"files":');
  assert.strictEqual((await loadLedger(file)).state, 'invalid');
  await saveLedger(file, emptyLedger());
  const aside = fs.readdirSync(d).filter(n => n.startsWith('branch-ledger.json.corrupt-'));
  assert.strictEqual(aside.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(d, aside[0]), 'utf8'), '{"version":1,"files":');
  assert.strictEqual((await loadLedger(file)).state, 'ok');
});

test('Miguel I4: a save whose rename fails leaves no temp file behind', async () => {
  const d = tmpDir('ledger-review-');
  const file = path.join(d, 'branch-ledger.json');
  await assert.rejects(saveLedger(file, emptyLedger(), { rename: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } }));
  assert.deepStrictEqual(fs.readdirSync(d).filter(n => n.endsWith('.tmp')), []);
});
