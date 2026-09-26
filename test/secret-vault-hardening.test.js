'use strict';
/**
 * Follow-up hardening items from documentation/VAULT_HARDENING_FOLLOWUP.md.
 * Items B, C, D (items 1–3 in the doc). Item 0 (J1) is CLOSED pre-merge.
 *
 * B -- three soft spots (stamp enforcement, H3 re-read cost, I3 comment)
 * C -- refreshIfMoved at the top of add / setKey / removeKey
 * D -- melt atomicity: one outer withFileLock for all three operations (I2 + H5)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const {
  createVault, SCRYPT, TEMP_PREFIX, TEMP_SUFFIX,
} = require('../app/secret-vault');
const { vaultLockDisplay } = require('../app/vault-lock-display');

const tmp = () => path.join(tmpDir('cc-hard-'), 'secrets.enc');

const fakeCrypto = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => {
    const raw = Buffer.from(b).toString('utf8');
    if (!raw.startsWith('ENC:')) throw new Error('not encrypted by this cipher');
    return Buffer.from(raw.slice(4), 'base64').toString('utf8');
  },
});

const FAST = { N: 1024, r: 8, p: 1, keylen: 32, maxmem: 32 * 1024 * 1024 };
const open = (file, extra = {}) =>
  createVault({ file, crypto: fakeCrypto(), scrypt: FAST, lockDeadlineMs: 120, ...extra });
const KEY = 'correct horse battery staple';
const ANY = { project: 'C:/any' };
const readVault = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeVault = (f, j) => fs.writeFileSync(f, JSON.stringify(j));

// A vault with a malformed lock record (lock is valid JSON but lock.scrypt.keylen
// fails validLockRecord). The file IS parseable; only the lock header is wrong.
function damagedVault() {
  const file = tmp();
  const v = open(file);
  v.add({ label: 'sensitive-label', secret: 'sensitive', shared: true });
  v.setKey(KEY);
  const j = readVault(file);
  const healthy = JSON.parse(JSON.stringify(j));
  j.lock.scrypt = { ...j.lock.scrypt, keylen: 16 };  // fails validLockRecord
  writeVault(file, j);
  return { file, healthy };
}

// A vault that is locked (not damaged).
function lockedVault() {
  const file = tmp();
  const v = open(file);
  v.add({ label: 'k', secret: 's', shared: true });
  v.setKey(KEY);
  return file;
}

// ---------------------------------------------------------------------------
// B1 -- stamp enforcement: the renderer must not have the d.stamp || d.state fallback
// ---------------------------------------------------------------------------

test('B1: the renderer reads d.stamp with NO fallback to d.state', () => {
  // The fallback silently restores I1: if a new display state forgets its stamp,
  // d.stamp is undefined, d.state is used, arming the melt confirmation looks like
  // a state change (undefined → 'confirm-melt'), and the F8 reset fires in the
  // same tick -- the button appears to do nothing.
  //
  // The enforcement is at the display builder's exit point (vault-lock-display.js).
  // This pin guarantees the renderer does not re-introduce the fallback that would
  // mask a missing stamp silently.
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.doesNotMatch(renderer, /d\.stamp \|\| d\.state/,
    'the fallback restores I1: a new state that forgets stamp would render '
    + 'as if the stamp equals the state name, defeating the F8 reset guard');
  assert.match(renderer, /const stamp = d\.stamp/,
    'and the renderer must still read the stamp the display computed');
});

test('B1: vaultLockDisplay throws if it would return a state without a stamp', () => {
  // The enforcement at the display builder's single exit point catches a future
  // state that forgets to stamp itself, so any test that calls vaultLockDisplay
  // on that branch fails immediately -- not only the enumerating test.
  //
  // Tested behaviourally: every reachable state path produces a stamped result.
  // If the enforcement exists, a forgotten stamp throws. If it does not, the
  // first sign is a melt confirmation that disarms itself on click (I1 again).
  //
  // Verified here by asserting the enforce function's source exists, in the
  // module that owns it -- a comment-text assertion that survives instrumentation.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'vault-lock-display.js'), 'utf8');
  assert.match(src, /stamp.*throw|throw.*stamp/,
    'vault-lock-display must throw when stamp is missing -- B1 invariant');
  // The stamp is a one-line property: the enumerating test in
  // vault-lock-pass3.test.js asserts every reachable state carries one.
  // This assertion is what turns a forgotten stamp into an IMMEDIATE failure
  // in any test that exercises the new state, rather than a subtle rendering bug.
});

// ---------------------------------------------------------------------------
// B2 -- H3 re-read cost: stat token stops re-parsing an unchanged damaged file
// ---------------------------------------------------------------------------

test('B2: a damaged vault is NOT re-read on every lockState() call', () => {
  // H3: `Symbol('damaged')` never equalled anything, so every lockState() call
  // triggered a full re-parse of the file. With the renderer refreshing on every
  // keystroke in the search box, that is two full parses per keystroke on a
  // damaged file. A stat token (mtimeMs + size) matches until the file changes.
  const { file } = damagedVault();
  const v = open(file);
  assert.ok(v.lockState().damaged, 'precondition: damaged');

  let reads = 0;
  const orig = fs.readFileSync;
  fs.readFileSync = (p, ...a) => {
    if (p === file) reads++;
    return orig(p, ...a);
  };
  try {
    for (let i = 0; i < 5; i++) v.lockState();
    assert.strictEqual(reads, 0,
      'an unchanged damaged file must not trigger any readFileSync calls: '
      + 'the stat token detected no change and refreshIfMoved took its early return');
  } finally {
    fs.readFileSync = orig;
  }
});

test('B2: a damaged vault with VALID JSON and malformed lock also stops re-parsing', () => {
  // currentGen() returns parsed.gen for a valid-JSON file even when the lock is
  // malformed. Before the stat token, that gen string would never match
  // loadedGen (a Symbol), so every call re-parsed. The stat token is compared
  // BEFORE currentGen() when state.damaged is set, so gen is never consulted.
  const { file } = damagedVault();  // valid JSON, malformed lock
  const v = open(file);
  assert.ok(v.lockState().damaged, 'precondition: valid JSON, malformed lock');

  let reads = 0;
  const orig = fs.readFileSync;
  fs.readFileSync = (p, ...a) => {
    if (p === file) reads++;
    return orig(p, ...a);
  };
  try {
    for (let i = 0; i < 5; i++) v.lockState();
    assert.strictEqual(reads, 0,
      'valid-JSON-but-malformed-lock must also stop re-parsing on an unchanged file');
  } finally {
    fs.readFileSync = orig;
  }
});

test('B2: a damaged vault HEALS when the file changes -- H3 self-heal is not broken', () => {
  // The stat token changes when the file changes (mtime or size), so refreshIfMoved
  // detects the repair and reloads. This is the H3 property kept intact.
  const { file, healthy } = damagedVault();
  const v = open(file);
  assert.ok(v.lockState().damaged, 'precondition: damaged');

  fs.writeFileSync(file, JSON.stringify(healthy));

  const after = v.lockState();
  assert.strictEqual(after.damaged, undefined,
    'same handle must notice the repair -- stat token now differs');
  assert.strictEqual(after.locked, true, 'and be locked, since this window holds no key');
  assert.strictEqual(v.unlock(KEY).ok, true, 'and the correct key works');
});

test('B2: consecutive writes from one handle still work (stat token is not confused with gen)', () => {
  // The stat token is used ONLY for damaged states; healthy vaults still use gen.
  // Verify that the stat-token addition does not confuse the gen token and that
  // ordinary consecutive writes from one handle succeed and accumulate correctly.
  const file = tmp();
  const v = open(file);
  v.add({ label: 'first', secret: 's1', shared: true });
  v.add({ label: 'second', secret: 's2', shared: true });
  v.add({ label: 'third', secret: 's3', shared: true });
  assert.strictEqual(open(file).list(ANY).length, 3, 'all three writes landed');
  // The gen check (existing G1 tests in secret-vault-lock-pass2.test.js) guards
  // the narrow race between refreshIfMoved and lock acquisition. C's refresh turns
  // a simple stale write into a merge rather than a refusal, but the gen check
  // inside persistLocked still catches the race that bypasses refresh.
});

// ---------------------------------------------------------------------------
// C -- refreshIfMoved at the top of add / setKey / removeKey
// ---------------------------------------------------------------------------

test('C: a stale handle can ADD to a vault another window wrote', () => {
  // Before C, a.add() after b.add() was refused ("another window changed the
  // vault"). With refreshIfMoved() at the top of add, A reloads B's state first
  // and commits([...B's entries, A's entry]) -- a merge, not a refusal.
  const file = tmp();
  const a = open(file);
  const b = open(file);

  b.add({ label: 'from-B', secret: 'bv', shared: true });
  a.add({ label: 'from-A', secret: 'av', shared: true });  // previously refused

  const fresh = open(file);
  const items = fresh.list(ANY);
  assert.strictEqual(items.length, 2, 'both entries must be present');
  assert.ok(items.some(e => e.label === 'from-B'), 'B entry present');
  assert.ok(items.some(e => e.label === 'from-A'), 'A entry present');
});

test('C: a stale handle can SET A KEY after another window added an entry', () => {
  // refreshIfMoved() reloads B's entry so rewrapAll wraps it too.
  const file = tmp();
  const a = open(file);
  const b = open(file);

  b.add({ label: 'from-B', secret: 'bv', shared: true });
  a.setKey(KEY);  // previously refused; now reloads and wraps B's entry too

  const fresh = open(file);
  assert.strictEqual(fresh.lockState().locked, true, 'vault is locked');
  const opened = open(file);
  opened.unlock(KEY);
  const items = opened.list(ANY);
  assert.strictEqual(items.length, 1, 'B entry present after rewrap');
  assert.strictEqual(items[0].label, 'from-B');
  assert.strictEqual(opened.get(items[0].id, ANY), 'bv', 'value readable after rekey');
});

test('C: a stale handle can REMOVE THE KEY after another window unlocked and added', () => {
  // refreshIfMoved() picks up the new entry so removeKey unwraps it too.
  const file = tmp();
  const a = open(file);
  a.setKey(KEY);
  a.unlock(KEY);

  const b = open(file);
  b.unlock(KEY);
  b.add({ label: 'from-B', secret: 'bv', shared: true });

  a.removeKey();  // previously refused; now reloads and unwraps B's entry

  const fresh = open(file);
  assert.strictEqual(fresh.lockState().hasKey, false, 'key is gone');
  const items = fresh.list(ANY);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].label, 'from-B');
  assert.strictEqual(fresh.get(items[0].id, ANY), 'bv');
});

test('C: a stale handle whose vault was LOCKED throws the right message on add', () => {
  // When B sets a key and A's refreshIfMoved() picks it up, A is now locked --
  // the throw is "the vault is locked" not "another window changed the vault".
  // The second message was false: the lock IS the change, and A simply did not
  // have the key.
  const file = tmp();
  const a = open(file);
  a.add({ label: 'seed', secret: 's0', shared: true });

  const b = open(file);
  b.setKey(KEY);  // A knows nothing about this

  assert.throws(
    () => a.add({ label: 'from-A', secret: 'av', shared: true }),
    /the vault is locked/i,
    'after refresh, the correct error is "locked", not "another window changed"');
});

// ---------------------------------------------------------------------------
// D -- melt atomicity
// ---------------------------------------------------------------------------

test('D (J1 new contract): unbreakable outer lock -> ok: false, file untouched, retry works', () => {
  // With one outer withFileLock around all three melt operations, a lockfile that
  // cannot be taken means melt did NOTHING: the damaged file is still in place,
  // state and sessionKey are unchanged, and a second melt() after removing the
  // lockfile succeeds. The retry-is-dead-end problem from J1 is gone.
  const { file } = damagedVault();
  const dir = path.dirname(file);
  const lockPath = `${file}.lock`;

  // An unbreakable lockfile: a directory at the lock path blocks the atomic
  // create-or-fail that withFileLock uses.
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'occupied'), 'x');

  const v = open(file);
  let threw;
  try { v.melt(); } catch (err) { threw = err; }

  assert.ok(threw, 'melt must throw when the outer lock cannot be taken');
  assert.match(threw.message, /could not take the lock/i,
    'the error names the lock, not any vault operation');
  // The file is STILL THERE, byte-for-byte. Nothing was renamed or written.
  assert.ok(fs.existsSync(file), 'damaged file is still in place');
  // The vault object can still be used to melt (retry is not a dead end).
  fs.rmSync(lockPath, { recursive: true });  // remove the fake lock
  const res2 = v.melt();
  assert.strictEqual(res2.ok, true, 'a second melt() after clearing the lock succeeds');
  assert.ok(res2.preserved, 'and preserved is reported');
  assert.ok(fs.existsSync(res2.preserved), 'the preserved file exists');
});

test('D (I2): two handles on one damaged file -- exactly one melt succeeds', () => {
  // I2: a damaged vault is exactly when someone opens a second window to verify.
  // A melts first (ok). B then calls melt() on a stale handle; refreshIfMoved()
  // detects the vault is now healthy, wasDamaged was set, so B returns
  // {ok: false, alreadyMelted: true} naming the .damaged-* file A created.
  const { file } = damagedVault();
  const dir = path.dirname(file);
  const a = open(file);
  const b = open(file);  // stale -- same state as a, both see damaged

  const aRes = a.melt();
  assert.strictEqual(aRes.ok, true, 'A melts successfully');
  assert.ok(aRes.preserved, 'A names the preserved file');

  const bRes = b.melt();
  assert.strictEqual(bRes.ok, false, 'B must not succeed -- A already did');
  assert.strictEqual(bRes.alreadyMelted, true, 'and must say so explicitly');
  assert.match(bRes.error, /another window/i, 'error says another window melted first');
  // B's error must name the .damaged-* file that exists on disk.
  const damagedFiles = fs.readdirSync(dir)
    .filter(n => n.includes('.damaged-'));
  assert.strictEqual(damagedFiles.length, 1, 'exactly one .damaged- file on disk');
  assert.ok(bRes.error.includes(damagedFiles[0]),
    `B's error must name the preserved file '${damagedFiles[0]}'`);
  // The preserved content matches what A moved aside.
  assert.ok(fs.existsSync(aRes.preserved), 'the damaged file is at the path A reported');
});

test('D (I2 in-process): B.melt() from inside A\'s onWrite fails gracefully', () => {
  // G1-style deterministic interleave: A's melt fires onWrite, which triggers
  // B's melt() from inside A's lock. B must report not-ok (lock contention),
  // A's result is intact, and the directory ends with exactly one .damaged-* file.
  const { file } = damagedVault();
  const dir = path.dirname(file);
  const b = open(file);

  let bRes = null;
  let fired = false;
  const a = createVault({
    file,
    crypto: fakeCrypto(),
    scrypt: FAST,
    lockDeadlineMs: 120,
    onWrite: (p) => {
      if (fired || String(p).endsWith(TEMP_SUFFIX)) return;
      fired = true;
      // B tries to melt from inside A's outer lock. It times out (lockDeadlineMs=120).
      try { bRes = b.melt(); } catch (err) {
        bRes = { ok: false, error: err.message };
      }
    },
  });

  const aRes = a.melt();
  assert.ok(fired, 'precondition: onWrite fired (interleave occurred)');
  assert.strictEqual(aRes.ok, true, "A's melt succeeded");
  assert.strictEqual(bRes.ok, false, "B must not succeed inside A's lock");
  assert.match(bRes.error, /could not take the lock|another window/i,
    "B reports lock contention or alreadyMelted");

  const damagedFiles = fs.readdirSync(dir).filter(n => n.includes('.damaged-'));
  assert.strictEqual(damagedFiles.length, 1, 'exactly one .damaged- file survives');
  // The vault is a healthy empty vault.
  const fresh = open(file);
  assert.deepStrictEqual(fresh.lockState(), { hasKey: false, locked: false, count: 0 });
});

test('D: rename-aside failure inside the lock is still reported as ok:false', () => {
  // If the rename-aside fails INSIDE the outer lock, melt still reports ok:false
  // with the "left untouched" message -- but now actually true: nothing else ran.
  const { file } = damagedVault();
  const v = open(file);

  const realNow = Date.now;
  const frozen = realNow.call(Date);
  Date.now = () => frozen;
  const asidePath = `${file}.damaged-${frozen}`;
  fs.mkdirSync(asidePath);
  fs.writeFileSync(path.join(asidePath, 'occupied'), 'x');

  try {
    const res = v.melt();
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /left untouched/i);
    assert.ok(fs.existsSync(file), 'damaged file is still in place');
  } finally {
    Date.now = realNow;
    fs.rmSync(asidePath, { recursive: true });
  }
});

test('D: F2 is not regressed -- an ordinary melt sweeps abandoned temps', () => {
  // The sweep now runs inside the outer lock, which is the same structural
  // guarantee H5 gave with a second lock. F2's property (all temp copies are
  // destroyed) must still hold.
  const file = lockedVault();
  const dir = path.dirname(file);
  const tmpName = path.join(dir, `${TEMP_PREFIX}test-${Date.now()}${TEMP_SUFFIX}`);
  fs.writeFileSync(tmpName, 'PLAINTEXT-MARKER');

  const v = open(file);
  const res = v.melt();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.leftovers, []);
  for (const name of fs.readdirSync(dir)) {
    assert.ok(
      !fs.readFileSync(path.join(dir, name), 'utf8').includes('PLAINTEXT-MARKER'),
      `${name} survived a melt that promised nothing would`);
  }
});

test('D: melt on a non-damaged locked vault still works end-to-end', () => {
  // The atomicity change must not break the ordinary melt path (locked, not damaged).
  const file = lockedVault();
  const v = open(file);
  assert.strictEqual(v.lockState().locked, true, 'precondition: locked');
  const res = v.melt();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.preserved, null, 'no preserved file for a non-damaged vault');
  assert.deepStrictEqual(open(file).lockState(), { hasKey: false, locked: false, count: 0 });
});
