'use strict';
/**
 * The branch ledger credits a SUBAGENT's spend to the worktree its tool calls point at.
 *
 * Measured 2026-10-03 on personal-agent session 3c8efad6: six teammates, each working in its own sibling
 * worktree, and EVERY line of every one of their transcripts says cwd `...\personal-agent\dev`, gitBranch
 * `develop` -- the launching session's. So the ledger put all of their spend on develop. Only the tool calls
 * name the real worktree, and host/agent-occupancy.js touchOf already reads those (the occupancy claim).
 *
 * The rule: a subagent's transcript keeps `where` (the last worktree one of its calls proved). Until a call
 * proves one, a line is credited as before, by its own gitBranch and cwd.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');

const { addLines, emptyRecord, spendOf, updateLedger, emptyLedger, totals } = require('../host/branch-ledger');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const ROOT = 'C:\\p';
const DEV = 'C:\\p\\dev';
const FEAT = 'C:\\p\\feat-a';
const FIX = 'C:\\p\\fix-b';
const DETACHED = 'C:\\p\\detached';
const NESTED = 'C:\\p\\dev\\.claude\\worktrees\\agent-x';
const PLACES = [
  { root: DEV, branch: 'develop' }, { root: FEAT, branch: 'feat/a' }, { root: FIX, branch: 'fix/b' },
  { root: DETACHED, branch: null }, { root: NESTED, branch: 'worktree-agent-x' },
];

const usage = n => ({ input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 999 });
// One transcript line of a subagent: the PARENT's cwd and branch on every line, as measured.
const sub = (id, n, blocks = [], extra = {}) => JSON.stringify({
  type: 'assistant', agentId: 'ag1', gitBranch: 'develop', cwd: DEV, timestamp: '2026-10-03T05:40:00Z',
  message: { id, usage: usage(n), content: blocks }, ...extra,
});
const use = (name, input) => ({ type: 'tool_use', id: 'toolu_x', name, input });
const read = file => use('Read', { file_path: file });
const text = t => ({ type: 'text', text: t });
const lines = (...l) => l.join('\n') + '\n';
const spendBy = rec => Object.fromEntries(Object.entries(rec.branches).map(([k, b]) => [k, b.spend]));

test('a subagent\'s lines are credited to the worktree its calls point at, not the parent\'s branch on the line', () => {
  const r = emptyRecord();
  addLines(r, lines(
    sub('m1', 10, [read(path.join(FEAT, 'src', 'a.py'))]),
    sub('m2', 5, [text('thinking about it')]),
    sub('m3', 2, [use('Bash', { command: 'cd /c/p/feat-a && pytest' })])), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { 'feat/a': 17 });
  assert.deepStrictEqual(r.where, { root: FEAT, branch: 'feat/a' });
});

test('until a call proves a worktree, a line stays where it always was: the line\'s own branch', () => {
  const r = emptyRecord();
  addLines(r, lines(sub('m1', 10, [text('reading my brief')]), sub('m2', 4, [read(path.join(FEAT, 'a.py'))]), sub('m3', 1)), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { develop: 10, 'feat/a': 5 });
});

test('THE REAL SHAPE: a message is several lines with one id, counted on its first; the call on a later line moves the NEXT message', () => {
  // Claude Code writes one line per content block, each repeating the message's id and usage. The usage is
  // counted on the first line (ONE MESSAGE IS ONE USAGE), and the tool_use block arrives on a later one: so
  // the message that first touches a worktree is still credited to where the agent was before. One message
  // of lag, once per move; the alternative is reading ahead in a file that is still being written.
  const r = emptyRecord();
  addLines(r, lines(
    sub('m1', 10, [text('I will read it')]),
    sub('m1', 10, [read(path.join(FEAT, 'a.py'))]),
    sub('m2', 7, [text('done reading')])), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { develop: 10, 'feat/a': 7 });
});

test('a call in the launching session\'s own folder never moves the agent back (a lane reads its brief in dev)', () => {
  const r = emptyRecord();
  addLines(r, lines(
    sub('m1', 1, [read(path.join(FEAT, 'a.py'))]),
    sub('m2', 2, [read(path.join(DEV, 'documentation', 'handoffs', 'CURRENT-feat-a.md'))]),
    sub('m3', 4, [use('Grep', { pattern: 'x', path: DEV })])), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { 'feat/a': 7 });
});

test('an agent that moves to a second worktree is credited there from then on', () => {
  const r = emptyRecord();
  addLines(r, lines(sub('m1', 1, [read(path.join(FEAT, 'a.py'))]), sub('m2', 2, [use('Glob', { pattern: '*', path: FIX })]), sub('m3', 4)), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { 'feat/a': 1, 'fix/b': 6 });
  assert.strictEqual(r.where.branch, 'fix/b');
});

test('the longest root wins: a nested worktree is its own branch, never dev\'s', () => {
  const r = emptyRecord();
  addLines(r, lines(sub('m1', 3, [read(path.join(NESTED, 'a.js'))])), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { 'worktree-agent-x': 3 });
});

test('a worktree with no branch (detached), a path outside every worktree, and a relative path move nothing', () => {
  const r = emptyRecord();
  addLines(r, lines(
    sub('m1', 1, [read(path.join(DETACHED, 'a.py'))]),
    sub('m2', 2, [read('C:\\elsewhere\\a.py')]),
    sub('m3', 4, [read('src\\a.py')])), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { develop: 7 });
  assert.strictEqual(r.where, null);
});

test('a detached worktree does not UNDO a place already proven', () => {
  const r = emptyRecord();
  addLines(r, lines(sub('m1', 1, [read(path.join(FEAT, 'a.py'))]), sub('m2', 2, [read(path.join(DETACHED, 'a.py'))])), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { 'feat/a': 3 });
});

test('`where` carries across reads: the next chunk of the same transcript is credited to the same worktree', () => {
  const r = emptyRecord();
  addLines(r, lines(sub('m1', 1, [read(path.join(FEAT, 'a.py'))])), ROOT, PLACES);
  addLines(r, lines(sub('m2', 8)), ROOT, PLACES);
  assert.deepStrictEqual(spendBy(r), { 'feat/a': 9 });
});

test('the branch\'s cwds name the WORKTREE, and loose is judged by it (not by the parent\'s cwd on the line)', () => {
  const r = emptyRecord();
  // the parent session runs OUTSIDE the project (an old-layout checkout); its agent works inside it
  addLines(r, lines(sub('m1', 5, [read(path.join(FEAT, 'a.py'))], { cwd: 'C:\\elsewhere\\repo' })), ROOT, PLACES);
  assert.deepStrictEqual(r.branches['feat/a'].cwds, [FEAT]);
  assert.strictEqual(r.branches['feat/a'].spend, 5);
  assert.strictEqual(r.branches['feat/a'].loose, 0);
});

test('without places (a main session\'s transcript, or a caller that never asked) nothing is redirected', () => {
  const r = emptyRecord();
  addLines(r, lines(sub('m1', 10, [read(path.join(FEAT, 'a.py'))]), sub('m2', 5)), ROOT);
  assert.deepStrictEqual(spendBy(r), { develop: 15 });
  assert.strictEqual(r.where, null);
  const r2 = emptyRecord();
  addLines(r2, lines(sub('m1', 10, [read(path.join(FEAT, 'a.py'))])), ROOT, []);
  assert.deepStrictEqual(spendBy(r2), { develop: 10 });
});

test('a line with no cwd proves nothing (there is no own folder to exclude); junk content never throws', () => {
  const r = emptyRecord();
  addLines(r, lines(
    sub('m1', 1, [read(path.join(FEAT, 'a.py'))], { cwd: undefined }),
    sub('m2', 1, 'not an array'),
    sub('m3', 1, [null, 5, { type: 'tool_use' }, { type: 'tool_use', name: 'Read', input: null }, { type: 'tool_use', name: 'Read', input: { file_path: 7 } }])), ROOT, PLACES);
  // all three stay on the line's branch; the one with no cwd is loose there, as it always was
  assert.deepStrictEqual(Object.keys(r.branches), ['develop']);
  assert.strictEqual(r.branches.develop.spend, 2);
  assert.strictEqual(r.branches.develop.loose, 1);
  assert.strictEqual(r.where, null);
});

test('a branch called __proto__ is data here too', () => {
  const r = emptyRecord();
  addLines(r, lines(sub('m1', 3, [read(path.join(FEAT, 'a.py'))])), ROOT, [{ root: DEV, branch: 'develop' }, { root: FEAT, branch: '__proto__' }]);
  assert.strictEqual(Object.getPrototypeOf(r.branches), Object.prototype);
  assert.strictEqual(Object.getOwnPropertyDescriptor(r.branches, '__proto__').value.spend, 3);
});

// ---------- properties ----------

const ROOTS = [FEAT, FIX, DETACHED, NESTED, DEV];
const block = fc.oneof(
  fc.constant(text('t')),
  fc.constantFrom(...ROOTS, 'C:\\elsewhere').map(root => read(path.join(root, 'a.py'))),
  fc.constantFrom(...ROOTS).map(root => use('Grep', { pattern: 'x', path: root })),
  fc.constantFrom(...ROOTS).map(root => use('Bash', { command: `git -C ${root.replace(/\\/g, '/')} status` })));
// messages: a fresh id each, or a repeat of the previous id (the several-lines-per-message shape)
const transcript = fc.array(fc.record({ repeat: fc.boolean(), n: fc.integer({ min: 0, max: 500 }), blocks: fc.array(block, { maxLength: 3 }) }),
  { minLength: 1, maxLength: 25 })
  .map((ms) => {
    let id = 0;
    let n = 0;
    return ms.map((m, i) => {
      if (!(m.repeat && i > 0)) { id += 1; n = m.n; }
      return { id: `m${id}`, n, blocks: m.blocks };
    });
  });
const asText = ms => ms.map(m => sub(m.id, m.n, m.blocks)).join('\n') + '\n';

test('PROPERTY: no token is lost or invented by the redirect -- the record\'s total is the transcript\'s', () => {
  fc.assert(fc.property(transcript, (ms) => {
    const r = addLines(emptyRecord(), asText(ms), ROOT, PLACES);
    const distinct = new Map(ms.map(m => [m.id, m.n]));
    // a repeated id counts once, with the figure of its first line (they are equal by construction)
    const expected = [...distinct.values()].reduce((s, n) => s + spendOf(usage(n)), 0);
    const got = Object.values(r.branches).reduce((s, b) => s + b.spend + b.loose, 0);
    assert.strictEqual(got, expected);
    // and it only ever lands on a branch that exists: the line's, or a listed worktree's
    for (const name of Object.keys(r.branches)) assert.ok(['develop', 'feat/a', 'fix/b', 'worktree-agent-x'].includes(name), name);
    return true;
  }), { numRuns: 300 });
});

test('PROPERTY: reading a transcript in any number of chunks gives the same record as reading it at once', () => {
  fc.assert(fc.property(transcript, fc.array(fc.nat(), { maxLength: 6 }), (ms, cuts) => {
    const whole = addLines(emptyRecord(), asText(ms), ROOT, PLACES);
    const all = ms.map(m => sub(m.id, m.n, m.blocks));
    const at = [...new Set(cuts.map(c => c % (all.length + 1)))].sort((a, b) => a - b);
    const r = emptyRecord();
    let from = 0;
    for (const cut of [...at, all.length]) {
      if (cut > from) addLines(r, all.slice(from, cut).join('\n') + '\n', ROOT, PLACES);
      from = Math.max(from, cut);
    }
    assert.deepStrictEqual(r, whole);
    return true;
  }), { numRuns: 300 });
});

test('PROPERTY: a transcript whose calls never leave the launching folder is credited exactly as before', () => {
  const home = fc.oneof(fc.constant(text('t')), fc.constant(read(path.join(DEV, 'a.py'))), fc.constant(read('C:\\elsewhere\\a.py')),
    fc.constant(use('Bash', { command: 'npm test' })));
  const quiet = fc.array(fc.record({ n: fc.integer({ min: 0, max: 500 }), blocks: fc.array(home, { maxLength: 3 }) }), { minLength: 1, maxLength: 15 })
    .map(ms => ms.map((m, i) => ({ id: `m${i}`, ...m })));
  fc.assert(fc.property(quiet, (ms) => {
    assert.deepStrictEqual(addLines(emptyRecord(), asText(ms), ROOT, PLACES), addLines(emptyRecord(), asText(ms), ROOT));
    return true;
  }), { numRuns: 200 });
});

// ---------- against real files (updateLedger) ----------

function projects() {
  const dir = tmpDir('branch-ledger-where-');
  const proj = path.join(dir, projectDirName(DEV));
  const subs = path.join(proj, 's1', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  return { dir, proj, subs };
}

test('updateLedger: a subagent\'s file is redirected, the session\'s own file never is, and the run lands on the worktree\'s branch', async () => {
  const { dir, proj, subs } = projects();
  fs.writeFileSync(path.join(proj, 's1.jsonl'), lines(sub('s1', 100, [read(path.join(FEAT, 'a.py'))])));
  fs.writeFileSync(path.join(subs, 'agent-ag1.jsonl'), lines(sub('m1', 10, [read(path.join(FEAT, 'a.py'))]), sub('m2', 5)));
  fs.writeFileSync(path.join(subs, 'agent-ag1.meta.json'), JSON.stringify({ agentType: 'lane-a' }));
  const { ledger, errors } = await updateLedger(emptyLedger(), { projectsDir: dir, projectRoot: ROOT, worktrees: PLACES });
  assert.strictEqual(errors, 0);
  const t = totals(ledger);
  assert.strictEqual(t.develop.spend, 100, 'the main session: by its own lines');
  assert.strictEqual(t['feat/a'].spend, 15);
  assert.deepStrictEqual(t['feat/a'].runs, [{ agentType: 'lane-a', spend: 15, loose: 0 }]);
  assert.deepStrictEqual(t.develop.runs, []);
});

test('updateLedger: a subagent whose meta can\'t be read is still redirected (which file it is decides, not the meta)', async () => {
  const { dir, subs } = projects();
  fs.writeFileSync(path.join(subs, 'agent-ag1.jsonl'), lines(sub('m1', 10, [read(path.join(FEAT, 'a.py'))])));
  fs.mkdirSync(path.join(subs, 'agent-ag1.meta.json'));       // EISDIR, not ENOENT
  const { ledger } = await updateLedger(emptyLedger(), { projectsDir: dir, projectRoot: ROOT, worktrees: PLACES });
  assert.strictEqual(totals(ledger)['feat/a'].spend, 10);
});

test('updateLedger: when the worktrees could not be listed (null), subagent files WAIT -- crediting the parent would be for good', async () => {
  const { dir, proj, subs } = projects();
  fs.writeFileSync(path.join(proj, 's1.jsonl'), lines(sub('s1', 100)));
  const file = path.join(subs, 'agent-ag1.jsonl');
  fs.writeFileSync(file, lines(sub('m1', 10, [read(path.join(FEAT, 'a.py'))])));
  const first = await updateLedger(emptyLedger(), { projectsDir: dir, projectRoot: ROOT, worktrees: null });
  assert.strictEqual(first.errors, 1, 'said, so the tree shows ledgerOk false');
  assert.strictEqual(totals(first.ledger).develop.spend, 100, 'the main session is still read');
  assert.strictEqual(first.ledger.files[file], undefined, 'not a byte of the subagent\'s file was consumed');
  const second = await updateLedger(first.ledger, { projectsDir: dir, projectRoot: ROOT, worktrees: PLACES });
  assert.strictEqual(second.errors, 0);
  assert.strictEqual(totals(second.ledger)['feat/a'].spend, 10);
});

test('updateLedger: a caller that passes no worktrees at all reads everything as before', async () => {
  const { dir, subs } = projects();
  fs.writeFileSync(path.join(subs, 'agent-ag1.jsonl'), lines(sub('m1', 10, [read(path.join(FEAT, 'a.py'))])));
  const { ledger, errors } = await updateLedger(emptyLedger(), { projectsDir: dir, projectRoot: ROOT });
  assert.strictEqual(errors, 0);
  assert.strictEqual(totals(ledger).develop.spend, 10);
});

test('updateLedger: a rewritten subagent transcript starts over, place included', async () => {
  const { dir, subs } = projects();
  const file = path.join(subs, 'agent-ag1.jsonl');
  fs.writeFileSync(file, lines(sub('m1', 10, [read(path.join(FEAT, 'a.py'))]), sub('m2', 5)));
  const first = await updateLedger(emptyLedger(), { projectsDir: dir, projectRoot: ROOT, worktrees: PLACES });
  assert.strictEqual(first.ledger.files[file].where.branch, 'feat/a');
  fs.writeFileSync(file, lines(sub('n1', 3)));     // shorter, different: a different file now
  const second = await updateLedger(first.ledger, { projectsDir: dir, projectRoot: ROOT, worktrees: PLACES });
  assert.strictEqual(second.ledger.files[file].where, null);
  assert.deepStrictEqual(spendBy(second.ledger.files[file]), { develop: 3 });
});
