'use strict';
/**
 * The SECOND review pass on the vault lock. Dexter re-falsified d82ab9d and
 * found four new High findings -- all introduced BY the first round of fixes
 * rather than surviving them, which is the ordinary shape of a second pass on
 * credential code.
 *
 *   G1  the generation token is check-then-act, with 300ms of measured EPERM
 *       backoff sitting inside the window, so F9's harm was still reachable.
 *   G2  the checksum was optional, so F1 was unfixed on every vault that
 *       already existed -- including the one on Ricardo's disk.
 *   G3  load()'s new strictness threw, main.js does not wrap createVault, so a
 *       malformed record meant NO WINDOW OPENED AT ALL. The machinery built to
 *       say "do not melt" was unreachable because the app died first.
 *   G4  setting a key in one window left every other window open, readable,
 *       and refusing to lock.
 *   G5  keylen was validated as "positive" while AES-256-GCM needs exactly 32.
 *   G6  the refusal prescribed an action that did nothing, and melt was refused
 *       on a stale handle -- the panic button, unreachable.
 *
 * G3 and G5's tests live in secret-vault-lock-findings.test.js beside the F-round
 * they correct. This file holds G1, G2, G4 and G6, which are all about TWO LIVE
 * HANDLES on one file -- the shape PR #41 makes an intended workflow.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVault, TEMP_SUFFIX } = require('../app/secret-vault');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-p2-')), 'secrets.enc');

const fakeCrypto = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => {
    const raw = Buffer.from(b).toString('utf8');
    if (!raw.startsWith('ENC:')) throw new Error('not encrypted by this cipher');
    return Buffer.from(raw.slice(4), 'base64').toString('utf8');
  },
});

// Cheap derivation; the real parameters are pinned in the sibling suite.
const FAST = { N: 1024, r: 8, p: 1, keylen: 32, maxmem: 32 * 1024 * 1024 };
const open = (file) => createVault({ file, crypto: fakeCrypto(), scrypt: FAST });
const KEY = 'correct horse battery staple';
const ANY = { project: 'C:/any' };
const readVault = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeVault = (f, j) => fs.writeFileSync(f, JSON.stringify(j));

// ---------------------------------------------------------------------------
// G1 -- the check-then-act window
// ---------------------------------------------------------------------------

test('G1: a write cannot land on top of a window that wrote during its EPERM retry', () => {
  // Dexter, PR #42, G1, a defect in my own F9 fix rather than a survivor.
  //
  // The generation token alone is CHECK-THEN-ACT, and the gap between the check
  // and the rename holds a `writeFileSync` plus up to 300ms of `sleepSync` on
  // the Windows EPERM path this repo measured on 2026-09-18:
  //
  //   A: currentGen() passes at G0, writes tmpA, rename hits EPERM, sleeps.
  //   B: currentGen() still reads G0 -- A has not renamed yet -- setKey lands.
  //   A: the retry succeeds, replacing the file with A's stale content:
  //      no `lock` field, every entry unwrapped. BOTH report success.
  //
  // That is F9's original harm, with the guard in place.
  //
  // INJECTED DETERMINISTICALLY, as he recommended: `onWrite` fires between the
  // temp write and the rename, so B's setKey happens inside A's window with no
  // timing dependence. A flaky race test gets deselected, and then the gap is
  // silent again.
  const file = tmp();
  const seed = open(file);
  seed.add({ label: 'first', secret: 's1', shared: true });

  const b = open(file);
  let injected = false;
  let bBlocked = null;
  const a = createVault({
    file,
    crypto: fakeCrypto(),
    scrypt: FAST,
    onWrite: (p) => {
      // Only on A's TEMP write, and only once: the instant A has passed its
      // check and not yet renamed.
      if (injected || !String(p).endsWith(TEMP_SUFFIX)) return;
      injected = true;
      // Swallowed, because B's failure is the EXPECTED outcome and letting it
      // propagate would abort A's write through the `onWrite` callback -- which
      // is a property of this harness, not of the vault. My first version did
      // let it through, and the test then failed claiming A's write never
      // completed. `bBlocked` records it so the assertion below can be real.
      try { b.setKey(KEY); } catch (err) { bBlocked = err; }
    },
  });

  a.add({ label: 'second', secret: 's2', shared: true });

  assert.ok(injected, 'precondition: the interleaving was actually attempted');
  assert.ok(bBlocked, "B must be BLOCKED, not allowed inside A's critical section");
  assert.match(bBlocked.message, /could not take the lock/i);

  // WHAT THE FIX ACTUALLY DOES, and my first version of this test asserted the
  // wrong thing. I expected "B's key survives A's write". It cannot come to
  // that: B's setKey now BLOCKS on A's exclusive lock and never gets inside A's
  // critical section at all. The interleaving is not resolved in someone's
  // favour, it is PREVENTED -- which is the difference between a file lock and
  // the check-then-act token it replaced.
  //
  // So the honest property is serialisation: the file ends up as the coherent
  // result of writes that did not overlap, never a mixture. Concretely, B never
  // wrote, so there is no `lock` and A's entry is present -- and critically NOT
  // the F9 outcome, which was a `lock` written by B and then silently erased.
  const after = readVault(file);
  assert.strictEqual(after.entries.length, 2, "A's write completed");
  assert.strictEqual(after.lock, undefined,
    'B never got inside A\'s critical section, so it never wrote a key');

  // The lock is released, so the vault is usable, and B can now do its work
  // properly -- serialised after A instead of on top of it.
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
  const c = open(file);
  c.setKey(KEY);
  assert.strictEqual(open(file).lockState().locked, true);
  assert.strictEqual(open(file).lockState().count, 2,
    "and A's two entries are still there, which is the no-lost-update property");
});

test('G1: the exclusive lock is released even when the write is refused', () => {
  // A lock that leaks on the failure path is a permanent tombstone over the
  // vault, which is worse than the race it prevents. `withFileLock` promises to
  // always release; this pins that the vault still works after a refused write.
  const file = tmp();
  const v = open(file);
  v.add({ label: 'a', secret: '1', shared: true });

  const stale = open(file);
  v.add({ label: 'b', secret: '2', shared: true });        // moves the generation
  assert.throws(() => stale.add({ label: 'c', secret: '3', shared: true }),
    /another window changed the vault/i);

  v.add({ label: 'd', secret: '4', shared: true });
  assert.strictEqual(v.list(ANY).length, 3, 'ordinary writes still work afterwards');
  assert.strictEqual(fs.existsSync(`${file}.lock`), false, 'the lockfile must be released');
});

// ---------------------------------------------------------------------------
// G2 -- the checksum was optional, so F1 was unfixed where it mattered
// ---------------------------------------------------------------------------

test('G2: a legacy vault with no checksum GAINS one on its first successful unlock', () => {
  // Dexter, PR #42, G2, the finding that decides whether F1 is fixed for Ricardo
  // or only for vaults created after today.
  //
  // `fp` was written by `setKey` and nowhere else, and `setKey` requires the
  // vault OPEN -- so a LOCKED vault written before the checksum existed could
  // never acquire it, and `delete j.lock.fp` restored F1 in full. Every vault on
  // disk today looks exactly like that.
  //
  // The first successful unlock is the one place that can fix it with no user
  // action: we hold the derived key AND have just proven the record intact by
  // decrypting its own verifier.
  const file = tmp();
  const v0 = open(file);
  const e = v0.add({ label: 'k', secret: 'sensitive', shared: true });
  v0.setKey(KEY);

  const j = readVault(file);
  delete j.lock.fp;                         // what every pre-d82ab9d vault is
  writeVault(file, j);
  assert.strictEqual(readVault(file).lock.fp, undefined, 'precondition: no checksum');

  const v = open(file);
  assert.strictEqual(v.unlock(KEY).ok, true);
  assert.ok(readVault(file).lock.fp, 'the unlock must have migrated the record');
  assert.strictEqual(v.get(e.id, ANY), 'sensitive', 'and the secret is still readable');

  // And F1's counterexample is now caught on this vault, which it was not before.
  const k = readVault(file);
  k.lock.check = k.lock.check.slice(0, -4);
  writeVault(file, k);
  assert.strictEqual(open(file).unlock(KEY).damaged, true,
    'after migrating, a truncated verifier is damage rather than a wrong key');
});

test('G2: a failed migration write never turns a good unlock into a failure', () => {
  // Best effort, deliberately. The migration write legitimately may not land --
  // the generation check refuses a write from a handle another window moved past
  // -- and failing there would cost the user the unlock they just earned.
  const file = tmp();
  const v0 = open(file);
  v0.add({ label: 'k', secret: 'sensitive', shared: true });
  v0.setKey(KEY);
  const j = readVault(file);
  delete j.lock.fp;
  writeVault(file, j);

  const stale = open(file);                 // loaded at the pre-migration gen

  const other = open(file);
  other.unlock(KEY);
  other.add({ label: 'x', secret: 'y', shared: true });   // moves the generation

  assert.strictEqual(stale.unlock(KEY).ok, true,
    'the unlock must stand even though the migration write could not land');
});

// ---------------------------------------------------------------------------
// G4 -- two windows, one vault: the worst of the four
// ---------------------------------------------------------------------------

test('G4: setting a key in one window LOCKS the other, which can see it', () => {
  // Dexter, PR #42, G4, and it defeats the stated threat model in the workflow
  // PR #41 makes intended.
  //
  // `load()` ran once per handle and no read path consulted the file again. After
  // B set a key, window A still held `lock: undefined`, `sessionKey: undefined`
  // and its own UNWRAPPED entries -- so A's panel said "no key set, anyone at
  // this machine can read the vault", A listed every label, A returned every
  // SECRET with no key, and A.lock() returned false because `hasKey()` was false
  // in A's memory. The user could not lock it even deliberately.
  //
  // Then they walk away from the machine, which is the entire scenario.
  const file = tmp();
  const a = open(file);
  const e = a.add({ label: 'client-x prod db', secret: 'sensitive', shared: true });
  assert.strictEqual(a.get(e.id, ANY), 'sensitive', 'precondition: A can read it');

  const b = open(file);
  b.setKey(KEY);

  assert.strictEqual(a.lockState().hasKey, true, 'A must notice a key now exists');
  assert.strictEqual(a.lockState().locked, true, 'and that A does not hold it');
  assert.deepStrictEqual(a.list(ANY), [], 'A must stop listing labels');
  assert.strictEqual(a.get(e.id, ANY), null, 'and must stop returning secrets');
});

test('G4: a window holding the key notices when another window REPLACES it', () => {
  // The other half of the reload rule, and getting it wrong is G1's sibling: a
  // stale Buffer that no longer decrypts makes every read silently return null,
  // which is worse than being told you are locked out.
  const file = tmp();
  const a = open(file);
  const e = a.add({ label: 'k', secret: 'sensitive', shared: true });
  a.setKey(KEY);
  assert.strictEqual(a.get(e.id, ANY), 'sensitive', 'A holds the key');

  const b = open(file);
  b.unlock(KEY);
  b.setKey('a different key');

  assert.strictEqual(a.lockState().locked, true,
    'a key that no longer opens the vault must read as locked out, not serve nulls');
  assert.strictEqual(a.get(e.id, ANY), null);

  const c = open(file);
  assert.strictEqual(c.unlock('a different key').ok, true);
  assert.strictEqual(c.get(e.id, ANY), 'sensitive', 'the new key opens it');
});

test('G4: destroying the key in one window leaves the other legitimately open', () => {
  // The reload must not fail closed in the one direction where open is correct.
  // A rule that only ever locks is easy and wrong.
  const file = tmp();
  const a = open(file);
  const e = a.add({ label: 'k', secret: 'sensitive', shared: true });
  a.setKey(KEY);

  const b = open(file);
  b.unlock(KEY);
  b.removeKey();

  assert.strictEqual(a.lockState().hasKey, false, 'A must see the key is gone');
  assert.strictEqual(a.lockState().locked, false);
  assert.strictEqual(a.get(e.id, ANY), 'sensitive', 'and the secrets are readable again');
});

test('G4: a window whose vault was melted elsewhere does not keep serving secrets', () => {
  // The case neither of us named, and it follows from the same missing
  // invariant: melt in one window must not leave another window handing out
  // secrets that no longer exist on disk.
  const file = tmp();
  const a = open(file);
  const e = a.add({ label: 'k', secret: 'sensitive', shared: true });
  a.setKey(KEY);

  const b = open(file);
  b.lock();
  assert.strictEqual(b.melt().ok, true);

  assert.deepStrictEqual(a.list(ANY), [], 'A must not list a melted vault');
  assert.strictEqual(a.get(e.id, ANY), null, 'and must not serve its secrets');
});

// ---------------------------------------------------------------------------
// G6 -- the refusal, and melt
// ---------------------------------------------------------------------------

test('G6: a stale window can still MELT, because melt has nothing to preserve', () => {
  // Dexter, PR #42, G6, second half, and the one that matters: `melt()` routes
  // through `persist`, so the generation check refused it -- the panic button
  // answered with a message about reopening a panel. Combined with the
  // `isLocked()` gate, a stale locked window whose key was lost had no working
  // action at all.
  //
  // melt discards everything, so there is nothing of the other window's work to
  // protect, and it is the one write with no merge problem.
  const file = tmp();
  const a = open(file);
  a.add({ label: 'first', secret: 's1', shared: true });

  const b = open(file);
  b.setKey(KEY);                            // moves the generation past `a`

  assert.strictEqual(a.melt().ok, true, 'melt must work from a stale handle');
  assert.deepStrictEqual(open(file).lockState(), { hasKey: false, locked: false, count: 0 });
});

test('G6: the refusal no longer prescribes an action that does nothing', () => {
  // The message used to say "reopen the secrets panel to pick up the change".
  // Dexter: reopening the panel calls `lockState()` on the SAME vault instance
  // built once at main.js, and nothing user-reachable re-ran `load()` -- so the
  // prescribed action changed nothing and every later write from that window was
  // refused for the rest of its life.
  //
  // My test commented `open(file)` as "what reopen the panel does", which was the
  // drift he caught: it proved a new HANDLE recovers, not that the prescribed
  // action does.
  //
  // Both halves are fixed. `lockState()` reloads on a generation mismatch, so
  // reopening the panel genuinely does pick up the change -- and this asserts the
  // RECOVERY rather than the wording, since wording is not a contract.
  const file = tmp();
  const a = open(file);
  a.add({ label: 'first', secret: 's1', shared: true });
  const b = open(file);
  b.add({ label: 'second', secret: 's2', shared: true });

  assert.throws(() => a.add({ label: 'third', secret: 's3', shared: true }),
    /another window changed the vault/i);

  // What the panel does on every render. After it, the window is usable again
  // with no restart -- which is what makes the message true.
  a.lockState();
  a.add({ label: 'third', secret: 's3', shared: true });
  assert.deepStrictEqual(open(file).list(ANY).map(e => e.label).sort(),
    ['first', 'second', 'third']);
});
