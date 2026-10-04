'use strict';
/**
 * THE LOST UPDATE, MEASURED ACROSS REAL PROCESSES -- and the measurement that
 * says the fix is an improvement rather than a cure.
 *
 * Run:  node verify/probe-vault-concurrency.js
 *
 * Dexter, PR #29 review, F3B. `add()` and `setFixed()` are read-modify-write
 * over a shared file. `store.write`'s write-and-rename defends against a TORN
 * file, which is a different property: two hosts can each read the same vault,
 * each append their own record, and each write a complete, valid, atomic file
 * containing only their own. One record is simply gone, with no error anywhere.
 * `.harness/state` is install-wide, so this is every pair of open windows.
 *
 * WHY THIS IS A PROBE AND NOT A TEST. Every unit test of the lock passes
 * deterministically and lives in test/file-lock.test.js. This file needs eight
 * real OS processes and heavy disk contention to observe anything, and under
 * the full parallel suite it failed roughly 1 run in 12 -- because the
 * remaining gap below is real, not because the probe is badly written. A test
 * that fails one run in twelve gets re-run until it is green and then believed,
 * which is worse than a number somebody has to read. So it lives here, where
 * this project keeps claims that are measured rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MEASURED, on this machine, 2026-09-22
 * ---------------------------------------------------------------------------
 *
 *   No lock at all          12 of 120 records reported stored, then gone.
 *                           (`locked` stubbed to `fn => fn()`.)
 *
 *   With the lock           0 lost in isolation, every run.
 *                           Under the full parallel suite: 1 of 120 lost,
 *                           in roughly 1 run out of 12.
 *
 * So the lock removes the ordinary case -- two windows, a person clicking "add
 * bug" in each -- and does NOT close the race under pathological load. THAT IS
 * NOT A FIX, AND THIS FILE EXISTS SO NOBODY CAN REPORT IT AS ONE.
 *
 * Two hypotheses were tested and REJECTED by measurement, so neither is the
 * explanation:
 *
 *   - "stale-lock breaking is racing" (two waiters both judge a lock stale,
 *     both unlink, both acquire). Raising STALE_MS to an hour, which disables
 *     breaking entirely, still lost records.
 *
 *   - "it is the unrelated secret-vault flake". No: across twelve runs the
 *     only failing test was this one, named.
 *
 * A third defect WAS found this way and is fixed: `isStale` treated an
 * unusable pid as dead, and `openSync(path, 'wx')` creates the lock file EMPTY
 * before its pid is written -- so a competitor reading in that instant broke a
 * live lock. See host/file-lock.js. The unit test that covered it was pinning
 * the bug rather than the rule, which is why this probe exists at all.
 *
 * WHAT A REAL FIX PROBABLY LOOKS LIKE: not a better mutex. An append-only
 * record log removes the read-modify-write from `add` entirely, which is the
 * operation that matters -- an evidence log is append-mostly by nature. That
 * is a storage-format decision, not a patch, and it belongs to whoever owns
 * this feature rather than to a review round.
 *
 * SEPARATELY, AND ALREADY OWNED ELSEWHERE: under this load the rename inside
 * `store.write` fails with EPERM on Windows -- a platform transience that
 * appears whenever anything holds a handle on the target for a moment, which
 * an antivirus scan of the file just written routinely does. PR #30
 * (`host/atomic-write.js`) fixes exactly that line, measured 2026-09-18. The
 * children below retry a refused add for that reason: a refused add stored
 * NOTHING, so counting it would conflate two defects and make this probe
 * unable to tell you which one it found.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHILDREN = 8;
const PER_CHILD = 15;

const CHILD = `
const { createStore } = require(${JSON.stringify(path.join(ROOT, 'host', 'store.js'))});
const { createBugVault } = require(${JSON.stringify(path.join(ROOT, 'host', 'bugvault.js'))});
const store = createStore({ dir: process.argv[2] });
const vault = createBugVault({ store });
const who = process.argv[3];
const stored = [];
for (let i = 0; i < ${PER_CHILD}; i++) {
  const summary = 'record ' + who + '-' + i;
  let r = null;
  for (let attempt = 0; attempt < 25 && !(r && r.ok); attempt++) {
    r = vault.add({ category: 'race', summary });
    if (!r.ok) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (r && r.ok) stored.push(summary);
}
process.stdout.write(JSON.stringify(stored));
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-race-'));
  const childFile = path.join(dir, 'child.js');
  fs.writeFileSync(childFile, CHILD);

  // Seed in this process, so the children race on ADD rather than on first-run
  // seeding -- otherwise a loss could be blamed on either.
  const { createStore } = require('../host/store');
  const { createBugVault } = require('../host/bugvault');
  const before = createBugVault({ store: createStore({ dir }) }).list().length;
  assert.ok(before > 0, 'precondition: the vault seeded');

  const results = await Promise.all(Array.from({ length: CHILDREN }, (_, i) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [childFile, dir, String(i)], { stdio: 'pipe' });
      let out = '';
      let err = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('close', code => resolve({ code, out, err }));
    })));

  const crashed = results.filter(r => r.code !== 0);
  for (const c of crashed) console.log('  child crashed:', c.err.trim().split('\n')[0]);

  // THE PROPERTY: every record the vault told a child it had stored is still
  // there. Not "every record we tried to write" -- an add that was REFUSED
  // stored nothing, and counting it would measure the EPERM transience above
  // instead of the lost update this probe is for.
  const claimed = results.flatMap(r => (r.out ? JSON.parse(r.out) : []));
  const after = createBugVault({ store: createStore({ dir }) }).list();
  const present = new Set(after.map(b => b.summary));
  const lost = claimed.filter(c => !present.has(c));

  const rows = after.filter(b => b.category === 'race').map(b => b.summary);
  const duplicated = rows.length - new Set(rows).size;

  console.log(`\n  attempted     ${CHILDREN * PER_CHILD}`);
  console.log(`  reported ok   ${claimed.length}`);
  console.log(`  present       ${claimed.length - lost.length}`);
  console.log(`  LOST          ${lost.length}${lost.length ? '  <- reported stored, then overwritten' : ''}`);
  console.log(`  duplicated    ${duplicated}`);
  console.log(`  children lost ${crashed.length}`);
  for (const l of lost.slice(0, 5)) console.log(`    missing: ${l}`);

  const ok = lost.length === 0 && duplicated === 0 && crashed.length === 0;
  console.log(`\n  ${ok ? 'CLEAN' : 'LOSS DETECTED'} -- one run proves little either way; run it several times.`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
