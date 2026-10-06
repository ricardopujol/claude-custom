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

test('a folder whose name differs from the project\'s only in CASE is the project\'s on Windows (a session started from a c:\\ cwd); elsewhere it is not (backlog #57)', async () => {
  // a projects dir holding ONLY the lowercase spelling, so nothing else could be what was counted
  const dir = tmpDir('branch-ledger-');
  const lower = path.join(dir, projectDirName('c:\\p\\dev'));
  assert.ok(path.basename(lower).startsWith('c--p'), 'the folder is the lowercase spelling');
  fs.mkdirSync(lower, { recursive: true });
  fs.writeFileSync(path.join(lower, 's9.jsonl'), line('a', 'feat/x', 10, 'c:\\p\\dev'));
  const t = totals((await updateLedger(emptyLedger(), opts(dir))).ledger);
  if (process.platform === 'win32') assert.strictEqual(t['feat/x'].spend, 10);
  else assert.deepStrictEqual(t, {});
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

// ---- Mutation-survivor kills (backlog #58, release PR #101) ----

const BL = require('../host/branch-ledger');

const usageLine = (extra = {}, msg = {}) => JSON.stringify({
  type: 'assistant', gitBranch: 'feat/x', cwd: 'C:\\p\\dev', timestamp: '2026-09-20T10:00:00Z',
  message: { id: 'm', usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0 }, ...msg }, ...extra,
});
const spendOfBranches = rec => Object.fromEntries(Object.entries(rec.branches).map(([k, b]) => [k, b.spend + b.loose]));

test('loadLedger: every wrong shape is "invalid" (moved aside on save), a wrong version is "unreadable" (never overwritten)', async () => {
  const d = tmpDir('branch-ledger-');
  const load = async (name, text) => {
    fs.writeFileSync(path.join(d, name), text);
    return BL.loadLedger(path.join(d, name));
  };
  for (const [name, text] of [['null', 'null'], ['arr', '[]'], ['num', '42'], ['str', '"x"'], ['empty', '{}'],
    ['nofiles', '{"version":1}'], ['null-files', '{"version":1,"files":null}'], ['arr-files', '{"version":1,"files":[]}'],
    ['str-files', '{"version":1,"files":"x"}'], ['num-files', '{"version":1,"files":5}'], ['bool-files', '{"version":1,"files":true}']]) {
    assert.deepStrictEqual(await load(`${name}.json`, text), { ledger: BL.emptyLedger(), state: 'invalid', corrupt: true }, name);
  }
  assert.deepStrictEqual(await load('v2.json', '{"version":2,"files":{}}'), { ledger: BL.emptyLedger(), state: 'unreadable', corrupt: true });
  assert.deepStrictEqual(await load('v0.json', '{"files":{}}'), { ledger: BL.emptyLedger(), state: 'unreadable', corrupt: true });
  const files = { f: { offset: 3 } };
  assert.deepStrictEqual(await load('ok.json', JSON.stringify({ version: 1, files })), { ledger: { version: 1, files }, state: 'ok', corrupt: false });
  // a directory where the file should be is unreadable, not missing
  fs.mkdirSync(path.join(d, 'dir.json'));
  assert.deepStrictEqual(await BL.loadLedger(path.join(d, 'dir.json')), { ledger: BL.emptyLedger(), state: 'unreadable', corrupt: true });
});

test('saveLedger: a failed rename leaves no temp file behind, keeps the old ledger and throws the real error', async () => {
  const d = tmpDir('branch-ledger-');
  const file = path.join(d, 'branch-ledger.json');
  await BL.saveLedger(file, { version: 1, files: { f: { offset: 1, at: 1 } } });
  const before = fs.readFileSync(file, 'utf8');
  const boom = new Error('rename refused');
  await assert.rejects(BL.saveLedger(file, { version: 1, files: { g: { offset: 2, at: 2 } } }, { rename: async () => { throw boom; } }), boom);
  assert.deepStrictEqual(fs.readdirSync(d), ['branch-ledger.json'], 'no .tmp left');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('addLines skips a usage line unless it has a message with usage AND a non-empty string gitBranch', () => {
  const r = BL.emptyRecord();
  const cases = [
    '"usage"',                                                                  // a JSON string
    JSON.stringify({ gitBranch: 'b', cwd: 'C:\\p\\dev', usage: { input_tokens: 5 } }),   // usage not under message
    JSON.stringify({ gitBranch: 'b', message: { id: 'a', usage: null, note: '"usage"' } }),
    JSON.stringify({ gitBranch: 'b', message: { id: 'b', usage: 0, note: '"usage"' } }),
    usageLine({ gitBranch: undefined }),
    usageLine({ gitBranch: 7 }),
    usageLine({ gitBranch: '' }),
    usageLine({ gitBranch: null }),
    JSON.stringify({ gitBranch: 'b', message: null, note: '"usage"' }),
    'not json "usage"',
  ];
  BL.addLines(r, cases.join('\n') + '\n', ROOT);
  assert.deepStrictEqual(r.branches, {});
  assert.strictEqual(r.lastId, null, 'a skipped line does not move the resume id');
  BL.addLines(r, usageLine() + '\n', ROOT);
  assert.deepStrictEqual(spendOfBranches(r), { 'feat/x': 5 });
});

test('addLines: only a non-empty STRING id repeats; no id, an empty id and a non-string id always count', () => {
  const count = (id, n) => {
    const r = BL.emptyRecord();
    BL.addLines(r, Array.from({ length: n }, () => usageLine({}, { id })).join('\n') + '\n', ROOT);
    return r.branches['feat/x'].spend;
  };
  assert.strictEqual(count('same', 3), 5);
  assert.strictEqual(count(undefined, 3), 15);
  assert.strictEqual(count('', 3), 15);
  assert.strictEqual(count(7, 3), 15);
  assert.strictEqual(count(null, 3), 15);
  const r = BL.emptyRecord();
  BL.addLines(r, usageLine({}, { id: 'a' }) + '\n' + usageLine({}, { id: 7 }) + '\n', ROOT);
  assert.strictEqual(r.lastId, null, 'a non-string id resets the resume id');
});

test('addLines: a line with no cwd is loose spend with no cwd recorded, and does not throw', () => {
  const r = BL.emptyRecord();
  BL.addLines(r, usageLine({ cwd: undefined }) + '\n', ROOT);
  assert.deepStrictEqual(r.branches['feat/x'], { spend: 0, loose: 5, first: '2026-09-20', last: '2026-09-20', cwds: [] });
});

test('addLines: first and last day follow the line days, whichever order they arrive in', () => {
  const r = BL.emptyRecord();
  const at = ts => usageLine({ timestamp: ts }, { id: ts }) + '\n';
  BL.addLines(r, at('2026-09-20T10:00:00') + at('2026-09-18T10:00:00') + at('2026-09-25T10:00:00') + at('2026-09-22T10:00:00') + at('nope'), ROOT);
  const b = r.branches['feat/x'];
  assert.strictEqual(b.first, '2026-09-18');
  assert.strictEqual(b.last, '2026-09-25');
});

test('localDay: only a date-and-time string at the START of the value is a day', () => {
  assert.strictEqual(BL.localDay('2026-09-21T10:00'), '2026-09-21');
  assert.strictEqual(BL.localDay('2026-09-21T10:00:00'), '2026-09-21');
  for (const bad of [null, undefined, 5, {}, '2026-09-21', 'x2026-09-21T10:00', '2026-09-21T10', '2026-9-21T10:00', '26-09-21T10:00',
    '2026-09-21 10:00', '2026-13-45T10:00', '']) {
    assert.strictEqual(BL.localDay(bad), null, String(bad));
  }
});

test('spendOf: an infinite or non-numeric figure is nothing', () => {
  assert.strictEqual(BL.spendOf({ input_tokens: Infinity, output_tokens: -Infinity, cache_creation_input_tokens: 4 }), 4);
  assert.strictEqual(BL.spendOf({ input_tokens: {}, output_tokens: [], cache_creation_input_tokens: true }), 0);
  assert.strictEqual(BL.spendOf('x'), 0);
});

test('mergeLedgers: two records of the same age and the same offset: the second ledger\'s wins; an older or shorter one never does', () => {
  const rec = (over) => ({ offset: 10, at: null, marker: 'x', ...over });
  assert.strictEqual(BL.mergeLedgers({ files: { f: rec({ marker: 'a' }) } }, { files: { f: rec({ marker: 'b' }) } }).files.f.marker, 'b');
  assert.strictEqual(BL.mergeLedgers({ files: { f: rec({ marker: 'a', at: 5 }) } }, { files: { f: rec({ marker: 'b', at: 5 }) } }).files.f.marker, 'b');
  assert.strictEqual(BL.mergeLedgers({ files: { f: rec({ marker: 'a', offset: 20 }) } }, { files: { f: rec({ marker: 'b' }) } }).files.f.marker, 'a', 'no at: the further read');
  assert.strictEqual(BL.mergeLedgers({ files: { f: rec({ marker: 'a', at: 9 }) } }, { files: { f: rec({ marker: 'b', at: 4, offset: 99 }) } }).files.f.marker, 'a', 'older check loses');
  assert.strictEqual(BL.mergeLedgers({ files: { f: rec({ marker: 'a', at: 4, offset: 99 }) } }, { files: { f: rec({ marker: 'b', at: 9, offset: 1 }) } }).files.f.marker, 'b', 'newer check wins even when shorter');
  assert.strictEqual(BL.mergeLedgers(null, undefined).version, 1);
});

const sub1 = (rec, name, spend, loose = 0, extra = {}) => { rec.branches[name] = { spend, loose, first: null, last: null, cwds: [], ...extra }; };

test('totals: a subagent\'s run lands on the branch most of its spend went to; a tie goes to the first NAME, in any insertion order', () => {
  const run = (order, agentType = 'lane') => {
    const rec = { subagent: true, agentType, branches: {} };
    for (const [n, s, l] of order) sub1(rec, n, s, l);
    return BL.totals({ files: { f: rec } });
  };
  const runsOf = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.runs.length]));
  assert.deepStrictEqual(runsOf(run([['b', 5, 0], ['a', 5, 0]])), { b: 0, a: 1 });
  assert.deepStrictEqual(runsOf(run([['a', 5, 0], ['b', 5, 0]])), { a: 1, b: 0 });
  assert.deepStrictEqual(runsOf(run([['a', 5, 0], ['b', 9, 0]])), { a: 0, b: 1 });
  assert.deepStrictEqual(runsOf(run([['b', 9, 0], ['a', 5, 0]])), { b: 1, a: 0 });
  assert.deepStrictEqual(runsOf(run([['a', 1, 9], ['b', 5, 0]])), { a: 1, b: 0 }, 'loose spend counts toward the weight');
  assert.deepStrictEqual(runsOf(run([['c', 5, 0], ['b', 5, 0], ['a', 5, 0]])), { c: 0, b: 0, a: 1 });
  assert.deepStrictEqual(run([['a', 5, 2]]).a.runs, [{ agentType: 'lane', spend: 5, loose: 2 }]);
  assert.deepStrictEqual(run([['a', 5, 2]], null).a.runs, [{ agentType: 'unknown', spend: 5, loose: 2 }]);
  // a session's own file never makes a run
  assert.deepStrictEqual(BL.totals({ files: { f: { subagent: false, branches: { a: { spend: 1 } } } } }).a.runs, []);
});

test('totals: first is the earliest and last the latest day over every file, whichever file comes first; a missing day never erases one', () => {
  const file = (first, last) => { const r = { subagent: false, branches: {} }; sub1(r, 'a', 1, 0, { first, last }); return r; };
  const t = files => BL.totals({ files: Object.fromEntries(files.map((f, i) => [`f${i}`, f])) }).a;
  const days = [['2026-01-05', '2026-01-09'], ['2026-01-03', '2026-01-04'], ['2026-01-07', '2026-01-20'], [null, null]];
  for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    const out = t(order.map(i => file(...days[i])));
    assert.strictEqual(out.first, '2026-01-03', order.join());
    assert.strictEqual(out.last, '2026-01-20', order.join());
  }
  assert.deepStrictEqual([t([file(null, null)]).first, t([file(null, null)]).last], [null, null]);
});

test('totals: cwds are the distinct real paths over every file (same folder in another case is one, on Windows); non-strings are dropped; a branch with no cwds is fine', () => {
  const r1 = { branches: {} }; sub1(r1, 'a', 1, 0, { cwds: ['C:\\p\\dev', 5, null, 'C:\\p\\feat'] });
  const r2 = { branches: {} }; sub1(r2, 'a', 1, 0, { cwds: process.platform === 'win32' ? ['c:\\P\\DEV', 'C:\\q'] : ['C:\\p\\dev', 'C:\\q'] });
  const r3 = { branches: { a: { spend: 1 } } };
  assert.deepStrictEqual(BL.totals({ files: { r1, r2, r3 } }).a.cwds, ['C:\\p\\dev', 'C:\\p\\feat', 'C:\\q']);
  assert.deepStrictEqual(BL.totals({ files: { r3 } }).a.cwds, []);
  assert.deepStrictEqual(BL.totals({ files: { x: null, y: { branches: null } } }), {});
  assert.deepStrictEqual(BL.totals(null), {});
});

test('updateLedger: a ledger that is null or has no files starts empty, and the read stamps `at` so it only ever goes up', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  fs.writeFileSync(f, line('a', 'feat/x', 10));
  for (const bad of [null, undefined, {}, { version: 1 }]) {
    const { ledger } = await updateLedger(bad, { ...opts(dir), now: () => 500 });
    assert.strictEqual(ledger.files[f].at, 500);
    assert.strictEqual(totals(ledger)['feat/x'].spend, 10);
  }
  const first = await updateLedger(emptyLedger(), { ...opts(dir), now: () => 500 });
  const stepped = await updateLedger(first.ledger, { ...opts(dir), now: () => 100 });   // the clock stepped back
  assert.strictEqual(stepped.ledger.files[f].at, 501);
  const later = await updateLedger(stepped.ledger, { ...opts(dir), now: () => 9000 });
  assert.strictEqual(later.ledger.files[f].at, 9000);
});

test('updateLedger: an agentType that is not a string, or no meta file at all, makes an "unknown" run, with no error', async () => {
  for (const meta of ['{"agentType":5}', '{}', null]) {
    const { dir, proj } = projects();
    const subs = path.join(proj, 's1', 'subagents');
    fs.mkdirSync(subs, { recursive: true });
    fs.writeFileSync(path.join(subs, 'agent-1.jsonl'), line('c', 'feat/x', 7));
    if (meta !== null) fs.writeFileSync(path.join(subs, 'agent-1.meta.json'), meta);
    const { ledger, errors } = await updateLedger(emptyLedger(), opts(dir));
    assert.strictEqual(errors, 0, String(meta));
    assert.deepStrictEqual(totals(ledger)['feat/x'].runs, [{ agentType: 'unknown', spend: 7, loose: 0 }], String(meta));
  }
});

test('updateLedger: an unreadable meta is one error per read, and the run is still read', async () => {
  const { dir, proj } = projects();
  const subs = path.join(proj, 's1', 'subagents');
  fs.mkdirSync(path.join(subs, 'agent-1.meta.json'), { recursive: true });   // EISDIR
  fs.writeFileSync(path.join(subs, 'agent-1.jsonl'), line('c', 'feat/x', 7));
  const first = await updateLedger(emptyLedger(), opts(dir));
  assert.strictEqual(first.errors, 1);
  assert.strictEqual(totals(first.ledger)['feat/x'].spend, 7);
  const again = await updateLedger(first.ledger, opts(dir));
  assert.strictEqual(again.errors, 1, 'asked for again');
});

test('updateLedger: resuming a record that came from disk keeps its cwds, and one with no cwds at all still resumes', async () => {
  const { dir, proj } = projects();
  const f = path.join(proj, 's1.jsonl');
  fs.writeFileSync(f, line('a', 'feat/x', 10, 'C:\\p\\dev') + line('b', 'feat/y', 1, 'C:\\p\\dev'));
  const first = await updateLedger(emptyLedger(), opts(dir));
  const onDisk = JSON.parse(JSON.stringify(first.ledger));
  delete onDisk.files[f].branches['feat/y'].cwds;                  // an older ledger had no cwds on this branch
  fs.appendFileSync(f, line('c', 'feat/x', 2, 'C:\\p\\feat-x') + line('d', 'feat/y', 3, 'C:\\p\\dev'));
  const { ledger, errors } = await updateLedger(onDisk, opts(dir));
  assert.strictEqual(errors, 0);
  assert.deepStrictEqual(ledger.files[f].branches['feat/x'].cwds, ['C:\\p\\dev', 'C:\\p\\feat-x']);
  assert.deepStrictEqual(ledger.files[f].branches['feat/y'].cwds, ['C:\\p\\dev']);
  assert.strictEqual(ledger.files[f].branches['feat/y'].spend, 4);
});

test('readNew: a line longer than the carry limit is stepped over, in one chunk or across many, and the lines after it still count', async () => {
  const MAX = 4 * (1 << 20);
  for (const junk of [MAX + 1000, 7 * (1 << 20)]) {
    const { dir, proj } = projects();
    const f = path.join(proj, 's1.jsonl');
    const big = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(junk) } }) + '\n';
    fs.writeFileSync(f, line('a', 'feat/x', 10) + big + line('b', 'feat/x', 3));
    const { ledger, errors, read } = await updateLedger(emptyLedger(), opts(dir));
    const size = fs.statSync(f).size;
    assert.strictEqual(errors, 0);
    assert.strictEqual(totals(ledger)['feat/x'].spend, 13, `junk ${junk}`);
    assert.strictEqual(ledger.files[f].offset, size, 'the whole file is consumed, so it is not re-read');
    assert.strictEqual(read, size);
    assert.strictEqual((await updateLedger(ledger, opts(dir))).read, 0);
  }
});

test('readNew: an unterminated tail of exactly the carry limit is WAITED on; one byte more is stepped over for good', async () => {
  const MAX = 4 * (1 << 20);
  const first = line('a', 'feat/x', 10);
  const padded = (len, id) => {                    // a valid usage line of exactly `len` bytes, no newline
    const base = JSON.stringify({ type: 'assistant', gitBranch: 'feat/x', cwd: 'C:\\p\\dev', pad: '', timestamp: '2026-09-20T10:00:00Z',
      message: { id, usage: { input_tokens: 4, output_tokens: 0, cache_creation_input_tokens: 0 } } });
    return base.replace('"pad":""', `"pad":"${'x'.repeat(len - base.length)}"`);
  };
  {
    const { dir, proj } = projects();
    const f = path.join(proj, 's1.jsonl');
    const tail = padded(MAX, 'b');
    assert.strictEqual(Buffer.byteLength(tail), MAX);
    fs.writeFileSync(f, first + tail);
    const one = await updateLedger(emptyLedger(), opts(dir));
    assert.strictEqual(one.ledger.files[f].offset, Buffer.byteLength(first), 'waits for the newline');
    fs.appendFileSync(f, '\n');
    const two = await updateLedger(one.ledger, opts(dir));
    assert.strictEqual(totals(two.ledger)['feat/x'].spend, 14, 'and counts it once it ends');
  }
  {
    const { dir, proj } = projects();
    const f = path.join(proj, 's1.jsonl');
    fs.writeFileSync(f, first + padded(MAX + 1, 'b'));
    const one = await updateLedger(emptyLedger(), opts(dir));
    assert.strictEqual(one.ledger.files[f].offset, fs.statSync(f).size, 'too long to be a usage record: consumed');
    assert.strictEqual(totals(one.ledger)['feat/x'].spend, 10);
  }
});

const fsp = require('fs/promises');

// An oversized "line" that is itself VALID JSON (a usage record behind megabytes of leading spaces) is the
// only way to see whether the reader really steps over the whole line: a reader that loses its place half
// way would parse the rest of it as a line of its own and count it.
test('readNew: the rest of an oversized line is never read as a line of its own, and reading resumes cleanly after it', async () => {
  const MIB = 1 << 20;
  const evil = line('evil', 'feat/evil', 1000000).trimEnd();
  const small = Array.from({ length: 12000 }, (_, i) => line(`s${i}`, 'feat/x', 1)).join('');   // > 1 MiB of good lines after it
  for (const spaces of [5 * MIB + 17, 6 * MIB, 7 * MIB + 3]) {
    const { dir, proj } = projects();
    const f = path.join(proj, 's1.jsonl');
    fs.writeFileSync(f, line('a', 'feat/x', 10) + ' '.repeat(spaces) + evil + '\n' + line('b', 'feat/x', 3) + small);
    assert.ok(Buffer.byteLength(small) > MIB);
    const { ledger, errors } = await updateLedger(emptyLedger(), opts(dir));
    const t = totals(ledger);
    assert.strictEqual(errors, 0);
    assert.strictEqual(t['feat/evil'], undefined, `spaces ${spaces}: the oversized line is skipped whole`);
    assert.strictEqual(t['feat/x'].spend, 13 + 12000, `spaces ${spaces}: every line after it counts`);
    assert.strictEqual(ledger.files[f].offset, fs.statSync(f).size);
  }
});

test('updateLedger closes every transcript it opens, whether the read worked or failed', async () => {
  const { dir, proj } = projects();
  fs.writeFileSync(path.join(proj, 's1.jsonl'), line('a', 'feat/x', 10));
  fs.writeFileSync(path.join(proj, 's2.jsonl'), line('b', 'feat/x', 5));
  let opened = 0;
  let closed = 0;
  const open = async (file, mode) => {
    const fh = await fsp.open(file, mode);
    opened++;
    const real = fh.close.bind(fh);
    const bad = file.endsWith('s2.jsonl');
    return {
      stat: () => (bad ? Promise.reject(new Error('stat failed')) : fh.stat()),
      read: (...a) => fh.read(...a),
      close: () => { closed++; return real(); },
    };
  };
  const { errors, ledger } = await updateLedger(emptyLedger(), { ...opts(dir), open });
  assert.strictEqual(opened, 2);
  assert.strictEqual(closed, 2, 'the failed read still closed its handle');
  assert.strictEqual(errors, 1);
  assert.strictEqual(totals(ledger)['feat/x'].spend, 10);
});
