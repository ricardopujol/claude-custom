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
 * second.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');

const { incrementalScan } = require('../host/agent-stats-cache');
const { tmpDir } = require('./tmp-dir');

const SLOTS = ['f0', 'f1', 'f2'];

// The "value" a file's content maps to. Deliberately NOT token math -- that is
// host/agent-stats.js's job and is covered by its own suite. This property is
// about the CACHE agreeing with a from-scratch scan for whatever a reader
// returns, so a trivial, easily-asserted reader (content length) is the
// right level of fidelity: anything richer would just be re-testing
// readTranscript under a different name.
async function readLength(file) {
  const raw = await fs.promises.readFile(file, 'utf8');
  return { length: raw.length };
}

const opArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant('add'), slot: fc.constantFrom(...SLOTS),
    len: fc.integer({ min: 1, max: 40 }) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('grow'), slot: fc.constantFrom(...SLOTS),
    extra: fc.integer({ min: 1, max: 40 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('shrink'), slot: fc.constantFrom(...SLOTS),
    len: fc.integer({ min: 0, max: 39 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('delete'), slot: fc.constantFrom(...SLOTS) }) },
);

test('property: an incremental scan equals a from-scratch scan for any add/grow/shrink/delete sequence', async () => {
  await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 15 }), async (ops) => {
    const dir = tmpDir('cc-cache-prop-');
    const pathFor = (slot) => path.join(dir, slot + '.txt');
    const content = new Map(); // slot -> string | absent

    let cache = {}; // the incremental cache, carried across steps -- the thing under test

    for (const o of ops) {
      const file = pathFor(o.slot);
      if (o.op === 'add') {
        content.set(o.slot, 'x'.repeat(o.len));
        fs.writeFileSync(file, content.get(o.slot));
      } else if (o.op === 'grow') {
        if (!content.has(o.slot)) continue; // grow with nothing there is a no-op, not an add
        content.set(o.slot, content.get(o.slot) + 'y'.repeat(o.extra));
        fs.writeFileSync(file, content.get(o.slot));
      } else if (o.op === 'shrink') {
        if (!content.has(o.slot)) continue;
        const cur = content.get(o.slot);
        const next = cur.slice(0, Math.min(o.len, cur.length));
        if (next === cur) continue; // not actually a change: nothing to assert here
        content.set(o.slot, next);
        fs.writeFileSync(file, next);
      } else if (o.op === 'delete') {
        if (!content.has(o.slot)) continue;
        content.delete(o.slot);
        fs.unlinkSync(file);
      }

      const filePaths = SLOTS.filter(s => content.has(s)).map(pathFor);

      const incremental = await incrementalScan(filePaths, readLength, cache);
      const fromScratch = await incrementalScan(filePaths, readLength, {});

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
        const real = await readLength(f);
        assert.deepStrictEqual(incremental.entries[f].value, real);
      }

      cache = incremental.entries; // carry forward, as a real caller would persist and reload it
    }
  }), { numRuns: 60 });
});
