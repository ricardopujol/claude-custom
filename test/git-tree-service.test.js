'use strict';
/**
 * The host side of the git tree (documentation/PLAN_GIT_TREE.md Task 8): what `{type:'gitTree'}`
 * answers. Everything it touches is injected, so this runs no git, reads no transcripts and writes
 * no file.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createGitTreeService } = require('../host/git-tree-service');

const HISTORY = { ok: true, integration: 'develop', mainMerges: 0, worktrees: [], lanes: [],
  merges: [{ branch: 'feat/a', pr: 1, date: '2026-09-20', title: 'feat: a', commits: 2 }] };
const LINE_TOTALS = { files: { f: { offset: 1, subagent: false, runBranch: 'feat/a',
  branches: { 'feat/a': { spend: 10, loose: 0, first: '2026-09-20', last: '2026-09-20', cwds: ['C:\\p\\dev'] } } } } };

function deps(over = {}) {
  const calls = { history: 0, update: 0, save: 0, load: 0, prs: 0 };
  let t = 0;
  const d = {
    calls,
    advance: ms => { t += ms; },
    cwd: 'C:\\p\\dev', projectRoot: 'C:\\p', projectsDir: 'X', ledgerFile: () => 'L',
    readHistory: async () => { calls.history++; return HISTORY; },
    loadLedger: async () => { calls.load++; return { ledger: { version: 1, files: {} }, state: 'missing', corrupt: false }; },
    updateLedger: async () => { calls.update++; return { ledger: { version: 1, ...LINE_TOTALS }, read: 5, errors: 0 }; },
    saveLedger: async (file, l) => { calls.save++; return l; },
    readOpenPrs: async () => { calls.prs++; return new Map(); },
    currentBranch: () => 'develop',
    now: () => t,
    ...over,
  };
  return d;
}

test('answers the model for this repo: history + ledger totals + open PRs', async () => {
  const d = deps();
  const tree = await createGitTreeService(d).get();
  assert.strictEqual(tree.ok, true);
  assert.strictEqual(tree.current, 'develop');
  assert.strictEqual(tree.branches[0].name, 'feat/a');
  assert.strictEqual(tree.branches[0].spend, 10);
});

test('requests while one is running share it: one read of git, one of the transcripts', async () => {
  const d = deps();
  const s = createGitTreeService(d);
  const [a, b] = await Promise.all([s.get(), s.get()]);
  assert.strictEqual(a, b);
  assert.deepStrictEqual([d.calls.history, d.calls.update], [1, 1]);
  await s.get();
  assert.deepStrictEqual([d.calls.history, d.calls.update], [2, 2]);
});

test('the ledger is loaded once, and saved only when something new was read', async () => {
  let read = 5;
  const d = deps({ updateLedger: async l => ({ ledger: l, read, errors: 0 }) });
  const s = createGitTreeService(d);
  await s.get();
  read = 0;
  await s.get();
  assert.deepStrictEqual([d.calls.load, d.calls.save], [1, 1]);
});

test('open PRs are asked for at most once a minute', async () => {
  const d = deps();
  const s = createGitTreeService(d);
  await s.get();
  d.advance(59000);
  await s.get();
  assert.strictEqual(d.calls.prs, 1);
  d.advance(2000);
  await s.get();
  assert.strictEqual(d.calls.prs, 2);
});

test('git failing is an ok:false tree with the reason, not a throw', async () => {
  const d = deps({ readHistory: async () => ({ ok: false, error: 'not a git repository' }) });
  assert.deepStrictEqual(await createGitTreeService(d).get(), { ok: false, error: 'not a git repository' });
});

test('the transcripts failing to read still draws the tree, from what was saved before', async () => {
  // Miguel S: this test used to load an EMPTY ledger, so it couldn't tell "saved before" from nothing
  const d = deps({
    loadLedger: async () => ({ ledger: { version: 1, ...LINE_TOTALS }, state: 'ok', corrupt: false }),
    updateLedger: async () => { throw new Error('EBUSY'); },
  });
  const tree = await createGitTreeService(d).get();
  assert.strictEqual(tree.ok, true);
  assert.strictEqual(tree.branches[0].spend, 10);
  assert.strictEqual(tree.ledgerOk, false);
});

test('with nothing saved and the transcripts failing, spend is unknown (null), not 0', async () => {
  const d = deps({ updateLedger: async () => { throw new Error('EBUSY'); } });
  const tree = await createGitTreeService(d).get();
  assert.strictEqual(tree.branches[0].spend, null);
  assert.strictEqual(tree.totalSpend, null);
});

test('a saved ledger that cannot be read right now is not replaced: spend unknown, and it is read again next time', async () => {
  let state = 'unreadable';
  let loads = 0;
  const d = deps({ loadLedger: async () => { loads++; return { ledger: { version: 1, ...LINE_TOTALS }, state, corrupt: state !== 'ok' }; } });
  const s = createGitTreeService(d);
  const first = await s.get();
  assert.deepStrictEqual([first.ledgerOk, first.branches[0].spend, d.calls.save], [false, null, 0]);
  state = 'ok';
  const second = await s.get();
  assert.strictEqual(second.ledgerOk, true);
  assert.strictEqual(loads, 2);
});

test('Miguel B3: no safe place for the ledger (a linked .claude-custom): counted in memory, never written', async () => {
  const d = deps({ ledgerFile: () => null });
  const tree = await createGitTreeService(d).get();
  assert.strictEqual(tree.branches[0].spend, 10);
  assert.deepStrictEqual([d.calls.load, d.calls.save], [0, 0]);
});

// ---------- where the ledger lives (Miguel B3) ----------
const fs = require('fs');
const path = require('path');
const { ledgerFileFor } = require('../host/git-tree-service');
const { tmpDir } = require('./tmp-dir');

test("the ledger lives in the project's .claude-custom, which gets its '*' .gitignore", () => {
  const root = tmpDir('ledger-home-');
  const file = ledgerFileFor(root);
  assert.strictEqual(file, path.join(root, '.claude-custom', 'branch-ledger.json'));
  assert.strictEqual(fs.readFileSync(path.join(root, '.claude-custom', '.gitignore'), 'utf8').includes('*'), true);
});

test('Miguel B3: a .claude-custom that is a junction to somewhere else gets no ledger, and nothing is written there', () => {
  const root = tmpDir('ledger-home-');
  const elsewhere = tmpDir('ledger-elsewhere-');
  fs.symlinkSync(elsewhere, path.join(root, '.claude-custom'), 'junction');
  assert.strictEqual(ledgerFileFor(root), null);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('anything else that throws is an ok:false tree, and the next request tries again', async () => {
  let fail = true;
  const d = deps({ readHistory: async () => { if (fail) throw new Error('boom'); return HISTORY; } });
  const s = createGitTreeService(d);
  assert.deepStrictEqual(await s.get(), { ok: false, error: 'boom' });
  fail = false;
  assert.strictEqual((await s.get()).ok, true);
});
