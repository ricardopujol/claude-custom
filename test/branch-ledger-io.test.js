'use strict';
/**
 * The branch ledger against real files (documentation/PLAN_GIT_TREE.md Task 5, G2-G3): read only
 * what's new, resume on a line boundary, re-read a rewritten file, and KEEP a transcript's spend
 * after the transcript is deleted -- the reason the ledger exists.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { updateLedger, loadLedger, saveLedger, totals, emptyLedger } = require('../host/branch-ledger');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const ROOT = 'C:\\p';
const line = (id, branch, input, cwd = 'C:\\p\\dev') => JSON.stringify({ type: 'assistant', gitBranch: branch, cwd,
  timestamp: '2026-09-20T10:00:00Z', message: { id, usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';

function projects() {
  const dir = tmpDir('branch-ledger-');
  const proj = path.join(dir, projectDirName(ROOT));
  fs.mkdirSync(proj, { recursive: true });
  return { dir, proj };
}
const opts = dir => ({ projectsDir: dir, projectRoot: ROOT });

test('first read: a session and its subagent, with the subagent identified from its meta', async () => {
  const { dir, proj } = projects();
  fs.writeFileSync(path.join(proj, 's1.jsonl'), line('a', 'feat/x', 10) + line('b', 'develop', 5));
  const sub = path.join(proj, 's1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), line('c', 'feat/x', 7));
  fs.writeFileSync(path.join(sub, 'agent-1.meta.json'), JSON.stringify({ agentType: 'logic-reviewer' }));
  const { ledger, errors } = await updateLedger(emptyLedger(), opts(dir));
  assert.strictEqual(errors, 0);
  const t = totals(ledger);
  assert.strictEqual(t['feat/x'].spend, 17);
  assert.strictEqual(t.develop.spend, 5);
  assert.deepStrictEqual(t['feat/x'].runs, [{ agentType: 'logic-reviewer', spend: 7, loose: 0 }]);
});

test("a subagent's meta that can't be read yet is asked for again next time", async () => {
  const { dir, proj } = projects();
  const sub = path.join(proj, 's1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), line('c', 'feat/x', 7));
  // a directory where the meta file should be: readFile fails with EISDIR, not ENOENT
  fs.mkdirSync(path.join(sub, 'agent-1.meta.json'));
  const first = await updateLedger(emptyLedger(), opts(dir));
  assert.deepStrictEqual(totals(first.ledger)['feat/x'].runs, []);
  fs.rmdirSync(path.join(sub, 'agent-1.meta.json'));
  fs.writeFileSync(path.join(sub, 'agent-1.meta.json'), JSON.stringify({ agentType: 'code-reviewer' }));
  const second = await updateLedger(first.ledger, opts(dir));
  assert.deepStrictEqual(totals(second.ledger)['feat/x'].runs, [{ agentType: 'code-reviewer', spend: 7, loose: 0 }]);
});

test('an appended file is read from where it stopped: only the new bytes', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  fs.writeFileSync(f, line('a', 'feat/x', 10));
  const first = await updateLedger(emptyLedger(), opts(dir));
  const more = line('b', 'feat/x', 3) + line('c', 'feat/x', 4);
  fs.appendFileSync(f, more);
  const second = await updateLedger(first.ledger, opts(dir));
  assert.strictEqual(second.read, Buffer.byteLength(more));
  assert.strictEqual(totals(second.ledger)['feat/x'].spend, 17);
  const third = await updateLedger(second.ledger, opts(dir));
  assert.strictEqual(third.read, 0);
});

test('a half-written last line is left for next time, then counted once it ends', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  const whole = line('a', 'feat/x', 10);
  fs.writeFileSync(f, whole + whole.slice(0, 20).replace('"a"', '"b"'));
  const first = await updateLedger(emptyLedger(), opts(dir));
  assert.strictEqual(totals(first.ledger)['feat/x'].spend, 10);
  fs.writeFileSync(f, whole + line('b', 'feat/x', 6));
  const second = await updateLedger(first.ledger, opts(dir));
  assert.strictEqual(totals(second.ledger)['feat/x'].spend, 16);
});

test('a file rewritten with different content is re-read from the start, replacing its record', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  fs.writeFileSync(f, line('a', 'feat/x', 10));
  const first = await updateLedger(emptyLedger(), opts(dir));
  fs.writeFileSync(f, line('z', 'feat/y', 2) + line('a', 'feat/x', 10) + line('q', 'feat/x', 1));
  const second = await updateLedger(first.ledger, opts(dir));
  const t = totals(second.ledger);
  assert.strictEqual(t['feat/y'].spend, 2);
  assert.strictEqual(t['feat/x'].spend, 11);
});

test('a file that shrank is re-read from the start', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  fs.writeFileSync(f, line('a', 'feat/x', 10) + line('b', 'feat/x', 10));
  const first = await updateLedger(emptyLedger(), opts(dir));
  fs.writeFileSync(f, line('c', 'feat/x', 1));
  const second = await updateLedger(first.ledger, opts(dir));
  assert.strictEqual(totals(second.ledger)['feat/x'].spend, 1);
});

test('A DELETED TRANSCRIPT KEEPS ITS SPEND: the ledger outlives Claude Code cleanup', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  fs.writeFileSync(f, line('a', 'feat/x', 10));
  const first = await updateLedger(emptyLedger(), opts(dir));
  fs.rmSync(f);
  const second = await updateLedger(first.ledger, opts(dir));
  assert.strictEqual(totals(second.ledger)['feat/x'].spend, 10);
});

test("a folder sharing the prefix whose lines' cwd is outside adds only LOOSE spend, never spend", async () => {
  const { dir } = projects();
  const other = path.join(dir, projectDirName('C:\\p-other'));
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 's9.jsonl'), line('a', 'feat/x', 10, 'C:\\p-other\\dev'));
  const t = totals((await updateLedger(emptyLedger(), opts(dir))).ledger);
  assert.strictEqual(t['feat/x'].spend, 0);
  assert.strictEqual(t['feat/x'].loose, 10);
});

test('a folder not sharing the prefix is never read', async () => {
  const { dir } = projects();
  const other = path.join(dir, projectDirName('C:\\q'));
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 's9.jsonl'), line('a', 'feat/x', 10, 'C:\\p\\dev'));
  assert.deepStrictEqual(totals((await updateLedger(emptyLedger(), opts(dir))).ledger), {});
});

test('a projects dir that does not exist is an error counted, not an empty project', async () => {
  const { ledger, errors } = await updateLedger(emptyLedger(), opts(path.join(tmpDir('branch-ledger-'), 'nope')));
  assert.strictEqual(errors, 1);
  assert.deepStrictEqual(ledger.files, {});
});

test('save writes the ledger and load reads it back', async () => {
  const file = path.join(tmpDir('branch-ledger-'), 'state', 'branch-ledger.json');
  const { dir, proj } = projects();
  fs.writeFileSync(path.join(proj, 's1.jsonl'), line('a', 'feat/x', 10));
  const { ledger } = await updateLedger(emptyLedger(), opts(dir));
  await saveLedger(file, ledger);
  const back = await loadLedger(file);
  assert.strictEqual(back.corrupt, false);
  assert.deepStrictEqual(back.ledger, ledger);
});

test("save merges with what another host saved: per file, the further read wins", async () => {
  const file = path.join(tmpDir('branch-ledger-'), 'branch-ledger.json');
  const rec = (offset, spend) => ({ offset, fp: null, lastId: null, subagent: false, agentType: null, runBranch: 'b',
    branches: { b: { spend, first: null, last: null, cwds: [] } } });
  await saveLedger(file, { version: 1, files: { f: rec(100, 9), g: rec(5, 1) } });
  const saved = await saveLedger(file, { version: 1, files: { f: rec(50, 4) } });
  assert.strictEqual(saved.files.f.offset, 100);
  assert.ok(saved.files.g);
  assert.deepStrictEqual((await loadLedger(file)).ledger, saved);
});

test('a missing ledger loads empty; a corrupt one loads empty and says so', async () => {
  const d = tmpDir('branch-ledger-');
  assert.deepStrictEqual(await loadLedger(path.join(d, 'none.json')), { ledger: emptyLedger(), state: 'missing', corrupt: false });
  fs.writeFileSync(path.join(d, 'bad.json'), '{"version":1,"files":');
  assert.deepStrictEqual(await loadLedger(path.join(d, 'bad.json')), { ledger: emptyLedger(), state: 'invalid', corrupt: true });
  fs.writeFileSync(path.join(d, 'shape.json'), '{"version":1,"files":[]}');
  assert.strictEqual((await loadLedger(path.join(d, 'shape.json'))).corrupt, true);
});
