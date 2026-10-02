'use strict';
/**
 * Properties of the branch ledger (documentation/PLAN_GIT_TREE.md Tasks 3-4).
 *
 * The dedupe rule keeps only the previous message id (G1). That's exact because a message's repeated
 * usage lines are adjacent: measured 2026-10-01 over all 381 claude-custom transcripts, 20,484
 * repeats, every one adjacent. So the generator here only ever repeats an id on the next line, and
 * the reference sums distinct ids with a Set.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { addLines, emptyRecord } = require('../host/branch-ledger');

const ROOT = 'C:\\p';
const branchArb = fc.constantFrom('develop', 'feat/a', 'fix/b');
const cwdArb = fc.constantFrom('C:\\p\\dev', 'C:\\p\\feat-a', 'C:\\p-other\\dev');
// A message: id, branch, cwd, its spend, and how many content-block lines repeat it (adjacent).
const messageArb = fc.record({
  branch: branchArb, cwd: cwdArb, input: fc.nat(1000), copies: fc.integer({ min: 1, max: 3 }), hasId: fc.boolean(),
});
const transcriptArb = fc.array(messageArb, { maxLength: 30 }).map(ms => ms.map((m, i) => ({ ...m, id: m.hasId ? `m${i}` : undefined })));

function render(ms) {
  const out = [];
  for (const m of ms) {
    const line = JSON.stringify({ type: 'assistant', gitBranch: m.branch, cwd: m.cwd, timestamp: '2026-09-20T00:00:00Z',
      message: { id: m.id, usage: { input_tokens: m.input, output_tokens: 0, cache_creation_input_tokens: 0 } } });
    // a message without an id is one line: its "copies" can't be told apart from new messages
    for (let k = 0; k < (m.id ? m.copies : 1); k++) out.push(line);
  }
  return out;
}

function reference(ms) {
  const by = {};
  for (const m of ms) {
    if (m.cwd.startsWith('C:\\p-other')) continue;
    by[m.branch] = (by[m.branch] || 0) + m.input;
  }
  return by;
}
const spends = rec => Object.fromEntries(Object.entries(rec.branches).map(([k, v]) => [k, v.spend]));

test('one read gives each message once, per branch, inside the project only', () => {
  fc.assert(fc.property(transcriptArb, ms => {
    const r = addLines(emptyRecord(), render(ms).join('\n') + '\n', ROOT);
    assert.deepStrictEqual(spends(r), reference(ms));
  }));
});

test('reading in any number of chunks, cut at any line boundaries, gives the same record as one read', () => {
  fc.assert(fc.property(transcriptArb, fc.array(fc.nat(), { maxLength: 6 }), (ms, cuts) => {
    const ls = render(ms);
    const whole = addLines(emptyRecord(), ls.join('\n') + '\n', ROOT);
    const r = emptyRecord();
    const at = [...new Set(cuts.map(c => (ls.length ? c % (ls.length + 1) : 0)))].sort((x, y) => x - y);
    let from = 0;
    for (const to of [...at, ls.length]) {
      if (to > from) addLines(r, ls.slice(from, to).join('\n') + '\n', ROOT);
      from = Math.max(from, to);
    }
    assert.deepStrictEqual(r, whole);
  }));
});

// ---------- merge (Task 4) ----------
const { mergeLedgers, totals } = require('../host/branch-ledger');

// Two hosts reading the same files: each has read some PREFIX of each file. Model a file as its
// message list; a host's record is addLines over the first k messages.
const fileArb = fc.tuple(transcriptArb, fc.nat(), fc.nat());
function ledgerOf(files, pick) {
  const out = { version: 1, files: {} };
  files.forEach(([ms, i, j], n) => {
    const ls = render(ms);
    const k = pick(i, j) % (ls.length + 1);
    const r = addLines(emptyRecord(), ls.slice(0, k).join('\n') + (k ? '\n' : ''), ROOT);
    r.offset = k;
    out.files[`f${n}`] = r;
  });
  return out;
}

test('merging two hosts never lowers any branch below what either one had', () => {
  fc.assert(fc.property(fc.array(fileArb, { maxLength: 4 }), files => {
    const x = ledgerOf(files, (i) => i), y = ledgerOf(files, (i, j) => j);
    const tm = totals(mergeLedgers(x, y)), tx = totals(x), ty = totals(y);
    for (const b of new Set([...Object.keys(tx), ...Object.keys(ty)])) {
      const want = Math.max(tx[b] ? tx[b].spend : 0, ty[b] ? ty[b].spend : 0);
      assert.ok(tm[b] && tm[b].spend >= want, `${b}: ${tm[b] && tm[b].spend} < ${want}`);
    }
  }));
});

test('merge is idempotent', () => {
  fc.assert(fc.property(fc.array(fileArb, { maxLength: 4 }), files => {
    const x = ledgerOf(files, i => i);
    assert.deepStrictEqual(mergeLedgers(x, x), x);
  }));
});
