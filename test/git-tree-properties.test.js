'use strict';
/**
 * Properties of the git tree's model (documentation/PLAN_GIT_TREE.md Task 7): whatever git and the
 * ledger say, every lane git knows is drawn exactly once, unknown spend is null (never 0), deleted
 * means "only in the transcripts", and the hub plus the spokes account for EXACTLY every token
 * that's ours.
 *
 * Since PR #84's review (Dexter F2): a name can be merged more than once, and a merged name is also
 * listed as a lane (git-history lists every ref), so the generator produces both.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { buildTree, purpose } = require('../host/git-tree');

const ROOT = 'C:\\p';
const nameArb = fc.constantFrom('feat/a', 'feat/b', 'fix/c', 'spike/d', 'try/e', 'gone/f', 'constructor',
  'develop', 'main', 'master', 'HEAD', 'worktree-agent-1');
const totalArb = fc.record({
  spend: fc.nat(1000), loose: fc.nat(1000),
  runs: fc.array(fc.record({ agentType: fc.constantFrom('logic-reviewer', 'code-reviewer', 'x'), spend: fc.nat(100), loose: fc.nat(100) }), { maxLength: 3 }),
}).map(t => ({ ...t, first: '2026-09-20', last: '2026-09-21', cwds: ['C:\\p\\dev'] }));

function totalsOf(entries) {
  const o = {};
  for (const [k, v] of entries) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  return o;
}

const scenarioArb = fc.record({
  merged: fc.array(nameArb, { maxLength: 6 }),
  lanes: fc.uniqueArray(fc.record({ name: nameArb, ahead: fc.option(fc.nat(5), { nil: null }) }), { selector: u => u.name, maxLength: 6 }),
  totals: fc.uniqueArray(fc.tuple(nameArb, totalArb), { selector: e => e[0], maxLength: 8 }),
  open: fc.option(fc.uniqueArray(nameArb, { maxLength: 3 }), { nil: null }),
}).map(s => ({
  history: {
    ok: true, integration: 'develop', mainMerges: 0, worktrees: [],
    merges: s.merged.map((b, i) => ({ branch: b, pr: i + 1, date: `2026-09-${10 + i}`, title: `feat: ${b}`, commits: 1 })),
    lanes: s.lanes.map(u => ({ name: u.name, remote: false, date: '2026-09-22', ahead: u.ahead, first: 'first', worktree: null })),
  },
  totals: totalsOf(s.totals),
  openPrs: s.open === null ? null : new Map(s.open.map((n, i) => [n, { pr: 100 + i, title: 't' }])),
}));

const HUB = new Set(['develop', 'main', 'master', 'HEAD']);
const isLane = n => !HUB.has(n) && !n.startsWith('worktree-agent-');
const gitNames = s => new Set([...s.history.merges.map(m => m.branch), ...s.history.lanes.map(u => u.name)].filter(isLane));
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

test('every lane git knows is drawn exactly once; nothing is drawn twice; non-lanes never', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const t = buildTree({ ...s, projectRoot: ROOT });
    const names = t.branches.map(b => b.name);
    assert.strictEqual(new Set(names).size, names.length, names.join());
    for (const n of gitNames(s)) assert.ok(names.includes(n), n);
    for (const n of names) assert.ok(isLane(n), n);
  }));
});

test('spend is null exactly when the ledger has nothing for the branch', () => {
  fc.assert(fc.property(scenarioArb, s => {
    for (const b of buildTree({ ...s, projectRoot: ROOT }).branches) {
      assert.strictEqual(b.spend === null, own(s.totals, b.name) === undefined, b.name);
    }
  }));
});

test('deleted means: only in the ledger, with spend from inside the project', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const known = gitNames(s);
    for (const b of buildTree({ ...s, projectRoot: ROOT }).branches) {
      assert.strictEqual(b.state === 'deleted', !known.has(b.name), b.name);
      if (b.state === 'deleted') assert.ok(own(s.totals, b.name).spend > 0);
    }
  }));
});

test('open only when a PR is known open for it; prsKnown says whether that could be known', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const t = buildTree({ ...s, projectRoot: ROOT });
    assert.strictEqual(t.prsKnown, s.openPrs !== null);
    for (const b of t.branches) if (b.state === 'open') assert.ok(s.openPrs && s.openPrs.has(b.name), b.name);
  }));
});

test('totalSpend is EXACTLY every token that is ours: all inside spend, plus loose on lanes git knows', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const t = buildTree({ ...s, projectRoot: ROOT });
    const known = gitNames(s);
    // "ours": the hub's names, lanes git knows, and an unknown name only with spend inside the
    // project. (Found by this property, seed -1386998037: a lone unknown branch with 0 spend is
    // NOT ours, so the total is null -- the oracle had said 0.)
    const entries = Object.entries(s.totals).filter(([n, v]) => !isLane(n) || known.has(n) || v.spend > 0);
    if (!entries.length) { assert.strictEqual(t.totalSpend, null); return; }
    const want = entries.reduce((x, [n, v]) => x + v.spend + (known.has(n) ? v.loose : 0), 0);
    assert.strictEqual(t.totalSpend, want);
    const spokes = t.branches.reduce((x, b) => x + (b.spend || 0), 0);
    assert.strictEqual(t.totalSpend, (t.hub.spend || 0) + spokes);
  }));
});

test('a person never shows more spend than the branch they are on', () => {
  fc.assert(fc.property(scenarioArb, s => {
    const t = buildTree({ ...s, projectRoot: ROOT });
    for (const b of t.branches) {
      if (b.spend === null) continue;
      for (const p of b.people) assert.ok(p.spend <= b.spend + own(s.totals, b.name).runs.reduce((x, r) => x + r.spend + r.loose, 0), b.name);
    }
  }));
});

test('why is always null or at most 15 words', () => {
  fc.assert(fc.property(fc.option(fc.string({ maxLength: 300 }), { nil: null }), title => {
    const p = purpose(title);
    if (p !== null) assert.ok(p.replace(/…$/, '').split(/\s+/).length <= 15, p);
  }));
});
