'use strict';
/**
 * PROPERTY (BACKLOG D #16, item 5, required by name in the spec): for any
 * sequence of file adds, grows, shrinks, and deletes, the CACHED incremental
 * total equals a FROM-SCRATCH total.
 *
 * Modelled the same way test/mood-machine-properties.test.js models a session:
 * a small simulated filesystem (a handful of named "slots"), a generator that
 * emits well-formed operations on it, and an oracle -- here, a from-scratch
 * scan with an EMPTY cache -- checked against the thing actually under test,
 * an incremental scan carrying its cache forward from the previous step.
 *
 * Real files on real disk, deliberately: `host/agent-stats-cache.js` reads
 * size+mtime via `fs/promises.stat`, which is not injected, so a fake
 * in-memory filesystem would test a mock rather than the module. Kept to a
 * small slot count and short sequences so this still runs in well under a
 * few seconds.
 *
 * ONE `tmpDir()` PER TEST, NOT PER fc RUN. test/tmp-dir.js's own header
 * documents `mkdtempSync` degrading sharply as the OS temp directory
 * accumulates entries (measured there: 31ms fresh vs 452ms bloated, and this
 * machine's temp directory was found mid-review holding over a MILLION
 * leftover entries from repeated test runs across sessions). Calling
 * `tmpDir()` once per `fc.assert` iteration (60-100 times) turned that
 * per-call cost into minutes of wall clock for this file alone. Each property
 * now creates ONE temp directory up front and resets its own small, known
 * subtree between iterations -- `fs.rmSync`/`mkdirSync` on a directory this
 * test already knows the path of costs nothing proportional to how bloated the
 * OS-wide temp folder is.
 *
 * PR #59 REVIEW, Dexter F2 (Medium): the ORIGINAL reader here returned
 * `{ length: raw.length }`. Size is already part of the cache key
 * (`statKey`), so ANY mutation big enough to change the VALUE necessarily also
 * changed the KEY -- a same-size, different-content rewrite (`'xxxyy'` ->
 * `'xxxxx'`), which is the ONE case `mtime` exists to catch, mapped to an
 * IDENTICAL value either way. The property could not fail even if `sameStat`
 * were mutated to drop the mtime check entirely (verified by hand: temporarily
 * changing `sameStat` to `a.size === b.size` left the old version of this
 * suite green). Fixed two ways: the reader is now content-sensitive (the raw
 * text, not its length), and the generator has a dedicated `rewrite-same-size`
 * op that changes bytes without changing length and sets a distinct mtime, so
 * the case that needs `mtime` is actually exercised, not merely possible in
 * principle. A second property (below) covers the same requirement one layer
 * up, at `lifetimeAgentTokens` -- the actual "total" the spec names.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');

const { incrementalScan, lifetimeAgentTokens } = require('../host/agent-stats-cache');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const SLOTS = ['f0', 'f1', 'f2'];

// Content-sensitive, not length-sensitive -- see the header for why this is
// the fix for Dexter F2, not merely a style choice.
async function readText(file) {
  return { text: await fs.promises.readFile(file, 'utf8') };
}

// A distinct, always-increasing mtime per mutation, shared across BOTH
// properties in this file. Real filesystems can have mtime resolution coarser
// than this test's write rate, and a flaky property here would be worse than
// a slow one.
let mtimeCounter = 0;
function bumpMtime(file) {
  mtimeCounter += 1000;
  const t = new Date(Date.now() + mtimeCounter);
  fs.utimesSync(file, t, t);
}

const opArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('add'), slot: fc.constantFrom(...SLOTS),
    len: fc.integer({ min: 1, max: 40 }) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('grow'), slot: fc.constantFrom(...SLOTS),
    extra: fc.integer({ min: 1, max: 40 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('shrink'), slot: fc.constantFrom(...SLOTS),
    len: fc.integer({ min: 0, max: 39 }) }) },
  // Dexter F2: same length, different bytes -- the case mtime exists for.
  { weight: 2, arbitrary: fc.record({ op: fc.constant('rewrite-same-size'), slot: fc.constantFrom(...SLOTS) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('delete'), slot: fc.constantFrom(...SLOTS) }) },
);

test('property: an incremental scan equals a from-scratch scan for any add/grow/shrink/rewrite/delete sequence', async () => {
  const dir = tmpDir('cc-cache-prop-'); // ONE directory for every fc run -- see the header
  const pathFor = (slot) => path.join(dir, slot + '.txt');

  await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 15 }), async (ops) => {
    // Reset the (small, known) directory's own contents rather than minting a
    // new OS temp directory for every run.
    for (const slot of SLOTS) { try { fs.unlinkSync(pathFor(slot)); } catch { /* not present yet */ } }
    const content = new Map(); // slot -> string | absent

    let cache = {}; // the incremental cache, carried across steps -- the thing under test

    for (const o of ops) {
      const file = pathFor(o.slot);
      let wrote = false;
      if (o.op === 'add') {
        content.set(o.slot, 'x'.repeat(o.len));
        fs.writeFileSync(file, content.get(o.slot));
        wrote = true;
      } else if (o.op === 'grow') {
        if (!content.has(o.slot)) continue; // grow with nothing there is a no-op, not an add
        content.set(o.slot, content.get(o.slot) + 'y'.repeat(o.extra));
        fs.writeFileSync(file, content.get(o.slot));
        wrote = true;
      } else if (o.op === 'shrink') {
        if (!content.has(o.slot)) continue;
        const cur = content.get(o.slot);
        const next = cur.slice(0, Math.min(o.len, cur.length));
        if (next === cur) continue; // not actually a change: nothing to assert here
        content.set(o.slot, next);
        fs.writeFileSync(file, next);
        wrote = true;
      } else if (o.op === 'rewrite-same-size') {
        if (!content.has(o.slot)) continue;
        const cur = content.get(o.slot);
        if (cur.length === 0) continue; // nothing to flip
        const next = (cur[0] === 'z' ? 'q' : 'z') + cur.slice(1);
        content.set(o.slot, next);
        fs.writeFileSync(file, next);
        wrote = true;
      } else if (o.op === 'delete') {
        if (!content.has(o.slot)) continue;
        content.delete(o.slot);
        fs.unlinkSync(file);
      }

      if (wrote) bumpMtime(file);

      const filePaths = SLOTS.filter(s => content.has(s)).map(pathFor);

      const incremental = await incrementalScan(filePaths, readText, cache);
      const fromScratch = await incrementalScan(filePaths, readText, {});

      // THE PROPERTY: every file's cached value agrees with a cold read, and
      // the entry sets are identical -- no file the incremental pass carries
      // that a from-scratch pass would not, and none it drops that a
      // from-scratch pass would keep.
      assert.deepStrictEqual(
        Object.keys(incremental.entries).sort(),
        Object.keys(fromScratch.entries).sort(),
        `entry set diverged after ${JSON.stringify(o)}`,
      );
      for (const f of filePaths) {
        assert.deepStrictEqual(
          incremental.entries[f].value, fromScratch.entries[f].value,
          `${f} diverged after ${JSON.stringify(o)}`,
        );
        // And it must actually equal reality, not just agree by coincidence
        // with a second stale copy of itself.
        const real = await readText(f);
        assert.deepStrictEqual(incremental.entries[f].value, real);
      }

      cache = incremental.entries; // carry forward, as a real caller would persist and reload it
    }
  }), { numRuns: 60 });
});

// --- second property: the same requirement, one layer up ----------------------
//
// Dexter F2's second half: the property above only ever exercised
// `incrementalScan` directly, never `lifetimeAgentTokens` -- the per-AGENT
// total, merging across the identity join and a `readTranscript`-shaped
// reader, is what the spec actually names as "the cached total". This drives
// one real subagent transcript through add/remove/clear-turn edits and checks
// the incremental (cache-chaining) total at every step.
//
// PR #59 R2, Dexter's note: the first version of this property compared the
// incremental call against a SECOND `lifetimeAgentTokens` call with
// `prevEntries: {}` -- both calls of the SAME function under test, so a bug
// shared by both codepaths (there mostly aren't two, since the fresh call
// exercises the identical summing logic) couldn't be caught, and the property
// was really only checking "the function agrees with itself". The oracle now
// is `turns.reduce(sum)` -- a hand-summed total computed from what the test
// itself generated, entirely independent of any code under test.

const NL = String.fromCharCode(10);
const usage = (n) => ({ input_tokens: n, output_tokens: 0,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const turnLine = (minute, n) => JSON.stringify({
  type: 'assistant',
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString(),
  message: { usage: usage(n) },
});

const turnOpArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('add-turn'), n: fc.integer({ min: 1, max: 500 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('remove-turn') }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('clear') }) },
);

test('property: lifetimeAgentTokens matches a hand-summed, independent oracle for any sequence of transcript edits', async () => {
  const root = tmpDir('cc-lifetime-prop-'); // ONE directory for every fc run -- see the header
  const cwd = 'C:/w/prop-project';
  const dir = path.join(root, projectDirName(cwd));

  await fc.assert(fc.asyncProperty(fc.array(turnOpArb, { minLength: 1, maxLength: 12 }), async (ops) => {
    // Reset this ONE project's own subtree rather than minting a new OS temp
    // directory for every run -- cheap regardless of how large the shared OS
    // temp folder is, unlike `tmpDir()` itself.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString(),
      message: {
        usage: usage(1),
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'agent-x' } }],
      },
    }) + NL);
    const sd = path.join(dir, 's1', 'subagents');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'agent-a.meta.json'),
      JSON.stringify({ agentType: 'agent-x', toolUseId: 'toolu_1' }));
    const transcriptFile = path.join(sd, 'agent-a.jsonl');

    let turns = [];
    let cache = {};

    for (const o of ops) {
      if (o.op === 'add-turn') {
        turns.push(o.n);
      } else if (o.op === 'remove-turn') {
        if (!turns.length) continue;
        turns.pop();
      } else if (o.op === 'clear') {
        if (!turns.length) continue;
        turns = [];
      }

      const lines = turns.map((n, i) => turnLine(i, n));
      fs.writeFileSync(transcriptFile, lines.length ? lines.join(NL) + NL : '');
      bumpMtime(transcriptFile);

      const incremental = await lifetimeAgentTokens({ projectsDir: root, prevEntries: cache });

      // THE INDEPENDENT ORACLE: hand-summed from the generator's own record of
      // what it wrote, not from a second call to the function under test.
      const expected = turns.reduce((a, b) => a + b, 0);
      assert.strictEqual(incremental.agents.get('agent-x') || 0, expected,
        `agent-x total diverged after ${JSON.stringify(o)}, turns=${JSON.stringify(turns)}`);

      cache = incremental.entries;
    }
  }), { numRuns: 40 });
});
