'use strict';
/**
 * Properties of the git tree's model (documentation/PLAN_GIT_TREE.md Task 7): whatever git and the
 * ledger say, every branch git knows is drawn exactly once, unknown spend is null (never 0), deleted
 * means "only in the transcripts", and the hub plus the spokes account for every token that's ours.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { buildTree, purpose } = require('../host/git-tree');

const ROOT = 'C:\\p';
const nameArb = fc.constantFrom('feat/a', 'feat/b', 'fix/c', 'spike/d', 'try/e', 'gone/f', 'develop', 'main', 'HEAD', 'worktree-agent-1');
const totalArb = fc.record({
  spend: fc.nat(1000), loose: fc.nat(1000),
  runs: fc.array(fc.record({ agentType: fc.constantFrom('logic-reviewer', 'code-reviewer', 'x'), spend: fc.nat(100) }), { maxLength: 3 }),
}).map(t => ({ ...t, first: '2026-09-20', last: '2026-09-21', cwds: ['C:\\p\\dev'] }));

const scenarioArb = fc.record({
  merged: fc.uniqueArray(nameArb, { maxLength: 6 }),
  unmerged: fc.uniqueArray(fc.record({ name: nameArb, ahead: fc.option(fc.nat(5), { nil: null }) }), { selector: u => u.name, maxLength: 6 }),
  totals: fc.dictionary(nameArb, totalArb, { maxKeys: 8 }),
  open: fc.option(fc.uniqueArray(nameArb, { maxLength: 3 }), { nil: null }),
}).map(s => {
  const mergedSet = new Set(s.merged);
  return {
    history: {
      ok: true, integration: 'develop', mainMerges: 0, worktrees: [],
      merges: s.merged.map((b, i) => ({ branch: b, pr: i + 1, date: '2026-09-20', title: `feat: ${b}`, commits: 1 })),
      // git-history never lists a merged branch again as unmerged
      unmerged: s.unmerged.filter(u => !mergedSet.has(u.name))
        .map(u => ({ name: u.name, remote: false, date: '2026-09-22', ahead: u.ahead, first: 'first', worktree: null })),
    },
    totals: s.totals,
    openPrs: s.open === null ? null : new Map(s.open.map((n, i) => [n, { pr: 100 + i, title: 't' }])),
  };
});

const NOT_LANES = new Set(['develop', 'main', 'master', 'HEAD']);
const isLane = n => !NOT_LANES.has(n) && !n.startsWith('worktree-agent-');

test('every lane git knows is drawn exactly once; nothing is drawn twice; non-lanes never', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const t = buildTree({ ...s, projectRoot: ROOT });
    const names = t.branches.map(b => b.name);
    assert.strictEqual(new Set(names).size, names.length);
    for (const n of [...s.history.merges.map(m => m.branch), ...s.history.unmerged.map(u => u.name)].filter(isLane)) {
      assert.ok(names.includes(n), n);
    }
    for (const n of names) assert.ok(isLane(n), n);
  }));
});

test('spend is null exactly when the ledger has nothing for the branch', () => {
  fc.assert(fc.property(scenarioArb, s => {
    for (const b of buildTree({ ...s, projectRoot: ROOT }).branches) {
      assert.strictEqual(b.spend === null, !s.totals[b.name], b.name);
    }
  }));
});

test('deleted means: only in the ledger, with spend from inside the project', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const known = new Set([...s.history.merges.map(m => m.branch), ...s.history.unmerged.map(u => u.name)]);
    for (const b of buildTree({ ...s, projectRoot: ROOT }).branches) {
      assert.strictEqual(b.state === 'deleted', !known.has(b.name), b.name);
      if (b.state === 'deleted') assert.ok(s.totals[b.name].spend > 0);
    }
  }));
});

test('open only when a PR is known open for it; open PRs unknown means nothing is open', () => {
  fc.assert(fc.property(scenarioArb, s => {
    for (const b of buildTree({ ...s, projectRoot: ROOT }).branches) {
      if (b.state === 'open') assert.ok(s.openPrs && s.openPrs.has(b.name), b.name);
    }
  }));
});

test('totalSpend = hub + spokes, and never more than everything the ledger holds', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const t = buildTree({ ...s, projectRoot: ROOT });
    const spokes = t.branches.reduce((x, b) => x + (b.spend || 0), 0);
    assert.strictEqual(t.totalSpend, (t.hub.spend || 0) + spokes);
    const all = Object.values(s.totals).reduce((x, v) => x + v.spend + v.loose, 0);
    assert.ok(t.totalSpend <= all);
  }));
});

test('why is always null or at most 15 words', () => {
  fc.assert(fc.property(fc.option(fc.string({ maxLength: 300 }), { nil: null }), title => {
    const p = purpose(title);
    if (p !== null) assert.ok(p.replace(/…$/, '').split(/\s+/).length <= 15, p);
  }));
});
