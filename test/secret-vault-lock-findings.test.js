'use strict';
/**
 * The PR #42 review findings, each with the test that fails without its fix.
 *
 * Dexter F1-F4 and Miguel A4/A5/A6/B2(b), from two independent reviews of the
 * vault lock. Separate from test/secret-vault-lock.test.js because that file
 * says what the lock DOES and this one says what it must refuse to do -- the
 * same split, for the same reason, as test/drop.test.js and
 * test/drop-security.test.js.
 *
 * Every counterexample here was written by a reviewer and reproduced before the
 * fix. Where one of them proved a test could not fail, that is said in the test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createVault, SCRYPT, SALT_BYTES, IV_BYTES, TAG_BYTES,
  TEMP_PREFIX, TEMP_SUFFIX, validLockRecord,
} = require('../app/secret-vault');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lockf-')), 'secrets.enc');

// Same stand-in for Electron safeStorage as the sibling suite. Reversible and
// obviously not real crypto: these tests care what the vault DOES with it.
const fakeCrypto = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => {
    const raw = Buffer.from(b).toString('utf8');
    if (!raw.startsWith('ENC:')) throw new Error('not encrypted by this cipher');
    return Buffer.from(raw.slice(4), 'base64').toString('utf8');
  },
});

// Cheap derivation. The real cost is ~200ms per call by design and these tests
// unlock dozens of times; the REAL parameters are pinned by their own test
// below, and every vault records what it used, so a cheap test vault stays
// openable and can never be mistaken for a real one.
const FAST = { N: 1024, r: 8, p: 1, keylen: 32, maxmem: 32 * 1024 * 1024 };

const open = (file) => createVault({ file, crypto: fakeCrypto(), scrypt: FAST });
const KEY = 'correct horse battery staple';
const ANY = { project: 'C:/any' };

const readVault = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeVault = (f, j) => fs.writeFileSync(f, JSON.stringify(j));

// A locked vault holding one secret, with the file path and the entry id.
function lockedVault(label = 'k', secret = 'sensitive') {
  const file = tmp();
  const v = open(file);
  const e = v.add({ label, secret, shared: true });
  v.setKey(KEY);
  return { file, id: e.id };
}

// ---------------------------------------------------------------------------
// F1 -- a damaged lock header is NOT a wrong key
// ---------------------------------------------------------------------------

test('a TRUNCATED VERIFIER reports damage, not a wrong key', () => {
  // Dexter, PR #42, F1, the one he said to fix first, and his counterexample
  // verbatim. Four base64 characters off `lock.check` made the CORRECT password
  // return a bare `false` -- byte-identical to a wrong guess. The panel then
  // said "that key does not open this vault", and the only other thing it
  // offered was melt, which permanently destroys secrets that were still
  // wrapped under a fully recoverable key.
  //
  // The app was telling the user to destroy a vault it could have opened.
  const { file } = lockedVault();
  const j = readVault(file);
  j.lock.check = j.lock.check.slice(0, -4);
  writeVault(file, j);

  const res = open(file).unlock(KEY);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.damaged, true, 'the RIGHT key on a broken header is damage');
  assert.notStrictEqual(res.wrongKey, true, 'and must never be reported as a wrong key');
  assert.match(res.error, /recoverable/i,
    'and must say melting could destroy data that is still recoverable');
});

test('a MISSING SALT is refused at load, not reported as a wrong key', () => {
  // Dexter's structural variant. `Buffer.from(undefined, 'base64')` threw a
  // TypeError inside deriveKey, and the single catch turned it into `false` --
  // the same answer as a wrong password, from an unrelated cause.
  //
  // Refusing the FILE is a stronger answer than reporting damage at unlock: a
  // malformed lock record means the vault is damaged, and refusing to load it is
  // what stops the next setKey from re-wrapping on top of it (F4).
  const { file } = lockedVault();
  const j = readVault(file);
  delete j.lock.salt;
  writeVault(file, j);

  assert.throws(() => open(file), /unreadable|malformed/i);
});

test('a WRONG key is still reported as a wrong key, and nothing else', () => {
  // The other side of F1, and the reason the fix is a split rather than a
  // blanket reclassification. Calling ordinary wrong guesses "damage" would push
  // users away from melt at the one time melt is genuinely their only option.
  const { file } = lockedVault();
  const res = open(file).unlock('definitely not the key');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.wrongKey, true);
  assert.notStrictEqual(res.damaged, true, 'a bad guess must not read as a broken vault');
});

test('the three unlock outcomes are mutually distinguishable', () => {
  // The property F1 is really about. Not that each case carries a label, but
  // that no two cases produce the same answer -- the defect was exactly a
  // collapse of three causes into one value, so the test asserts on the
  // partition rather than on three labels one at a time.
  const good = lockedVault();
  const bad = lockedVault();
  const j = readVault(bad.file);
  j.lock.check = j.lock.check.slice(0, -4);
  writeVault(bad.file, j);

  const shape = (r) => JSON.stringify({ ok: r.ok, wrong: !!r.wrongKey, damaged: !!r.damaged });
  const outcomes = [
    shape(open(good.file).unlock(KEY)),
    shape(open(good.file).unlock('wrong')),
    shape(open(bad.file).unlock(KEY)),
  ];
  assert.strictEqual(new Set(outcomes).size, 3,
    `right key, wrong key and damaged header must differ: ${outcomes.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// F2 -- melt must destroy the copies, or its promise is false
// ---------------------------------------------------------------------------

test('melt destroys the ABANDONED TEMP COPIES, not just the vault file', () => {
  // Dexter, PR #42, F2. melt promised "no backup and no recovery" -- in words
  // the user reads before clicking -- and wrote exactly one path.
  //
  // `persist` writes a temp and renames it. When all five renames fail (the
  // Windows EPERM case measured against this very file on 2026-09-18) the
  // cleanup unlink is best-effort and, by its own comment, most likely to fail
  // under exactly the condition that caused it. What is left behind is the WHOLE
  // vault: every wrapped ciphertext, plus every label and note IN CLEARTEXT,
  // since only `secret` is ever encrypted.
  //
  // The old test asserted only on `readFileSync(file)` -- the one file
  // guaranteed clean, and none of the copies that are not.
  const file = tmp();
  const dir = path.dirname(file);
  const v0 = open(file);
  v0.add({ label: 'client-x prod database', secret: 'PLAINTEXT-MARKER', shared: true });
  v0.setKey(KEY);

  // Exactly what a failed rename leaves behind.
  const orphan = path.join(dir, `${TEMP_PREFIX}9999-1700000000000${TEMP_SUFFIX}`);
  fs.copyFileSync(file, orphan);
  assert.ok(fs.readFileSync(orphan, 'utf8').includes('client-x prod database'),
    'precondition: the orphan really does hold the label in cleartext');

  const v = open(file);
  assert.strictEqual(v.lockState().locked, true, 'precondition: locked out');
  const res = v.melt();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.leftovers, [], 'nothing should have resisted deletion here');

  // THE ASSERTION THAT MATTERS: scan the directory, not the one file.
  for (const name of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!body.includes('client-x prod database'),
      `${name} still holds the label after a melt that promised no recovery`);
    assert.ok(!body.includes('PLAINTEXT-MARKER'), `${name} still holds the ciphertext`);
  }
});

test('melt REPORTS a leftover it could not delete rather than claiming success', () => {
  // A copy we cannot remove must not make melt look like it failed -- the vault
  // itself IS gone and re-melting will not help -- but the user has to be told
  // which file to delete by hand, or the promise is still false and now silent.
  const file = tmp();
  const dir = path.dirname(file);
  const v0 = open(file);
  v0.add({ label: 'k', secret: 's', shared: true });
  v0.setKey(KEY);

  // A directory named like a temp cannot be unlinked, which stands in for the
  // EPERM case without needing to lock a file on this platform.
  fs.mkdirSync(path.join(dir, `${TEMP_PREFIX}1-1${TEMP_SUFFIX}`));

  const res = open(file).melt();
  assert.strictEqual(res.ok, true, 'the vault itself is gone, so melt did succeed');
  assert.strictEqual(res.leftovers.length, 1, 'and it must name what survived');
  assert.match(res.leftovers[0].path, /\.tmp$/);
});

test('the sweep cannot delete the vault itself, or an unrelated file', () => {
  // A sweep that matches too widely is a new way to lose data, inside the one
  // function whose whole job is deleting things.
  const file = tmp();
  const dir = path.dirname(file);
  const v0 = open(file);
  v0.add({ label: 'k', secret: 's', shared: true });
  v0.setKey(KEY);

  const bystander = path.join(dir, 'notes.txt');
  fs.writeFileSync(bystander, 'keep me');
  const wrongPrefix = path.join(dir, 'something-else.tmp');   // right suffix, wrong prefix
  fs.writeFileSync(wrongPrefix, 'keep me too');

  open(file).melt();
  assert.strictEqual(fs.readFileSync(bystander, 'utf8'), 'keep me');
  assert.strictEqual(fs.readFileSync(wrongPrefix, 'utf8'), 'keep me too');
  assert.ok(fs.existsSync(file), 'the vault file itself must still exist, emptied');
});

// ---------------------------------------------------------------------------
// F3 -- one bad entry must not brick the key
// ---------------------------------------------------------------------------

test('a CORRUPT ENTRY does not make the key unchangeable forever', () => {
  // Dexter, PR #42, F3. `rewrapAll` used `.map`, so the first throw aborted the
  // whole call -- and one entry with a truncated ciphertext made `setKey` and
  // `removeKey` throw permanently. The key became unchangeable AND
  // undestroyable, with a raw OpenSSL string rendered above the melt button,
  // which was then the only thing the panel offered.
  //
  // It contradicted this module's own principle, stated one screen below at
  // `get`: "One unreadable entry must not take the others with it: partial loss
  // beats total loss." The rule was right; this function was the exception.
  const file = tmp();
  const v0 = open(file);
  const a = v0.add({ label: 'good', secret: 'sensitive', shared: true });
  const b = v0.add({ label: 'broken', secret: 'other', shared: true });
  v0.setKey(KEY);

  const j = readVault(file);
  const target = j.entries.find(e => e.id === b.id);
  target.secret = target.secret.slice(0, -8);          // a torn write
  writeVault(file, j);

  const v = open(file);
  assert.strictEqual(v.unlock(KEY).ok, true, 'the header is intact, so it still opens');
  assert.strictEqual(v.get(a.id, ANY), 'sensitive');
  assert.strictEqual(v.get(b.id, ANY), null, 'the broken one reads as null, as it did before');

  const res = v.setKey('a new key');
  assert.strictEqual(res.ok, true, 'replacing the key must still work');
  assert.strictEqual(res.failed.length, 1, 'and must report what it could not carry');
  assert.strictEqual(res.failed[0].id, b.id);
  assert.strictEqual(res.failed[0].label, 'broken',
    'named, so the user can delete the ONE entry that is broken');

  const re = open(file);
  assert.strictEqual(re.unlock('a new key').ok, true);
  assert.strictEqual(re.get(a.id, ANY), 'sensitive', 'the good secret survived the rekey');
});

test('removeKey survives a corrupt entry, and CARRIES it rather than dropping it', () => {
  // The other half of F3. And the entry is carried, not discarded: silently
  // deleting a secret to fix a format problem is the disappearance this module
  // refuses everywhere else.
  const file = tmp();
  const v0 = open(file);
  const a = v0.add({ label: 'good', secret: 'sensitive', shared: true });
  const b = v0.add({ label: 'broken', secret: 'other', shared: true });
  v0.setKey(KEY);

  const j = readVault(file);
  j.entries.find(e => e.id === b.id).secret = 'AAAA';    // decodes, but far too short
  writeVault(file, j);

  const v = open(file);
  v.unlock(KEY);
  const res = v.removeKey();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.failed.length, 1);

  assert.strictEqual(open(file).get(a.id, ANY), 'sensitive');
  assert.strictEqual(readVault(file).entries.length, 2,
    'the broken entry must still be on disk, not quietly dropped');
});

// ---------------------------------------------------------------------------
// F4 / B2(b) -- a present-but-malformed lock record is a damaged file
// ---------------------------------------------------------------------------

test('a MALFORMED lock record is refused, never read as "no key"', () => {
  // Dexter F4 and Miguel B2(b) reached the same line from two directions.
  //
  // `sessionKey` was decided by the TRUTHINESS of `state.lock`, and `load()`
  // validated only `entries`. So `"lock": 0` -- a partial write, a hand edit,
  // two schema versions merged -- read as "no key": the panel announced "anyone
  // at this machine can read the vault", listed every label while every entry
  // was still wrapped, and the next `setKey` wrapped the already-wrapped bytes a
  // SECOND time, because `Buffer.from(b64, 'base64')` never throws on malformed
  // input. Unreadable forever, silently.
  const shapes = [
    0, true, '', 'yes', [], {},
    { salt: 'x' },
    { check: 'y' },
    { salt: 'x', check: 'y' },                                   // salt too short
    { salt: Buffer.alloc(SALT_BYTES).toString('base64'), check: 'tiny' },
    { salt: Buffer.alloc(SALT_BYTES).toString('base64'),
      check: Buffer.alloc(64).toString('base64'), scrypt: { N: 0, r: 8, p: 1, keylen: 32 } },
  ];

  for (const bad of shapes) {
    const { file } = lockedVault('client-x prod database');
    const j = readVault(file);
    j.lock = bad;
    writeVault(file, j);
    assert.throws(() => open(file), /unreadable|malformed/i,
      `lock: ${JSON.stringify(bad)} must be refused, not read as an open vault`);
  }
});

test('a lock record with NO key at all is still a legitimate vault', () => {
  // The other direction, which matters just as much: absent means "no key has
  // ever been set", which is this feature's default state. A validator that
  // rejected it would refuse every vault that has never been locked.
  const file = tmp();
  const v = open(file);
  const e = v.add({ label: 'k', secret: 'sensitive', shared: true });
  assert.strictEqual('lock' in readVault(file), false, 'precondition: no lock field');
  assert.strictEqual(open(file).get(e.id, ANY), 'sensitive');
  assert.deepStrictEqual(open(file).lockState(), { hasKey: false, locked: false, count: 1 });
});

test('validLockRecord accepts exactly what setKey writes, and nothing looser', () => {
  // The predicate guarding F4 needs its own pin: if it drifts from what setKey
  // produces, either every real vault stops loading or the hole reopens.
  const { file } = lockedVault();
  assert.strictEqual(validLockRecord(readVault(file).lock), true,
    'what setKey just wrote must be accepted');
  assert.strictEqual(validLockRecord(undefined), true, 'absent means no key, which is fine');
  for (const bad of [null, 0, 1, '', 'x', [], {}, { salt: 1, check: 2 }]) {
    assert.strictEqual(validLockRecord(bad), false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// A4 -- the derivation parameters are pinned AND versioned
// ---------------------------------------------------------------------------

test('the real scrypt parameters are PINNED', () => {
  // Miguel A4. The old code took Node's defaults -- N=16384, scrypt's 2009
  // minimum, measured at 26ms on this machine, roughly 38 guesses per second per
  // core for anyone who copies the file.
  //
  // Pinned because this project has shipped three unpinned constants already
  // (STALL_MS, ROSTER_SHARE), and an unpinned KDF cost is worse than those: if
  // Node's defaults move, every existing vault becomes unopenable and melt is
  // the only way out.
  assert.deepStrictEqual({ ...SCRYPT },
    { N: 2 ** 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 });
  assert.ok(SCRYPT.N >= 2 ** 17, 'the cost must not be lowered without a decision');
  assert.strictEqual(SALT_BYTES, 16);
  assert.strictEqual(IV_BYTES, 12);
  assert.strictEqual(TAG_BYTES, 16);
  // maxmem has to rise with N: the 32MB default is not enough at 2^17 with r=8
  // and scryptSync throws. A pin on N without this one is a pin on a crash.
  assert.ok(SCRYPT.maxmem >= 128 * SCRYPT.N * SCRYPT.r,
    'maxmem must cover 128 * N * r or scryptSync throws');
});

test('the parameters are WRITTEN INTO the vault, so the cost can be raised later', () => {
  // The half that matters more than the numbers. Parameters living only in code
  // cannot be changed: raising the cost tomorrow walls off every vault written
  // today, with no migration path and melt as the only exit. So they ride in the
  // lock record and are read back when deriving.
  const file = tmp();
  const v = open(file);
  const e = v.add({ label: 'k', secret: 'sensitive', shared: true });
  v.setKey(KEY);

  assert.deepStrictEqual(readVault(file).lock.scrypt, FAST,
    'a vault records what it actually used, not what the module prefers today');

  // And a vault written under one cost still opens when the module's default is
  // a different one, which is the entire point.
  const other = createVault({ file, crypto: fakeCrypto(), scrypt: SCRYPT });
  assert.strictEqual(other.unlock(KEY).ok, true,
    'a vault must open under ITS OWN recorded cost, not the current default');
  assert.strictEqual(other.get(e.id, ANY), 'sensitive');
});

test('a vault predating recorded parameters still opens, on the legacy defaults', () => {
  // The migration. A lock record with no `scrypt` key was written by the
  // previous build and must keep working, or this fix is a silent data-loss
  // event for anyone who had already set a key.
  const file = tmp();
  const legacyParams = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 32 * 1024 * 1024 };
  const legacy = createVault({ file, crypto: fakeCrypto(), scrypt: legacyParams });
  const e = legacy.add({ label: 'k', secret: 'sensitive', shared: true });
  legacy.setKey(KEY);

  const j = readVault(file);
  // Exactly what the old build wrote: NEITHER field. Deleting only `scrypt` and
  // leaving `fp` behind is not an old vault, it is an inconsistent one -- and
  // the checksum correctly refuses that, which is how my first version of this
  // test failed. Worth keeping as a comment: the fixture was wrong, not the code.
  delete j.lock.scrypt;
  delete j.lock.fp;
  writeVault(file, j);

  const v = createVault({ file, crypto: fakeCrypto(), scrypt: SCRYPT });
  assert.strictEqual(v.unlock(KEY).ok, true, 'an old vault must still open');
  assert.strictEqual(v.get(e.id, ANY), 'sensitive');
});

test('a lock record that disagrees with its own checksum is damage, not a wrong key', () => {
  // The mechanism behind F1's fix, pinned directly. AES-GCM cannot tell a wrong
  // password from a corrupted ciphertext -- both are auth-tag failures -- so
  // shape checks alone left the truncated-verifier case still reading as "wrong
  // key". The checksum is what makes the distinction possible, because it does
  // not involve the password at all.
  const { file } = lockedVault();
  const j = readVault(file);
  j.lock.check = j.lock.check.slice(0, -4);
  writeVault(file, j);

  const res = open(file).unlock(KEY);
  assert.strictEqual(res.damaged, true);
  assert.match(res.error, /checksum/i);

  // And it is not a security control -- anyone editing the file can recompute
  // it. Asserted so nobody mistakes it for one later.
  const forged = readVault(file);
  forged.lock.fp = require('crypto').createHash('sha256')
    .update(`${forged.lock.salt}|${forged.lock.check}|${JSON.stringify(forged.lock.scrypt)}`)
    .digest('base64');
  writeVault(file, forged);
  const after = open(file).unlock(KEY);
  assert.strictEqual(after.damaged, undefined,
    'a recomputed checksum passes: this detects ACCIDENTAL damage, not tampering');
  assert.strictEqual(after.wrongKey, true, 'and then the auth tag has the last word');
});

// ---------------------------------------------------------------------------
// A5 -- melt is for a forgotten key, and the vault enforces that
// ---------------------------------------------------------------------------

test('melt REFUSES on an open vault, where destroying the key would do', () => {
  // Miguel A5. `vaultLockDisplay` draws the melt button only in the locked
  // state, and there is a test for that -- but that is drawing policy, in the
  // renderer, the least trustworthy layer in the app. The harness's only
  // irreversible action had its sole guard there, so a stray
  // `window.harness.secrets.melt()` from anywhere destroyed the vault.
  const file = tmp();
  const v = open(file);
  const e = v.add({ label: 'k', secret: 'sensitive', shared: true });

  assert.throws(() => v.melt(), /forgotten key|destroy the key instead/i,
    'an open keyless vault has no business melting');
  assert.strictEqual(v.get(e.id, ANY), 'sensitive', 'and nothing was destroyed');

  v.setKey(KEY);
  assert.throws(() => v.melt(), /forgotten key|destroy the key instead/i,
    'an open vault WITH a key should removeKey, which keeps the secrets');
  assert.strictEqual(v.get(e.id, ANY), 'sensitive');

  v.lock();
  assert.strictEqual(v.melt().ok, true, 'locked out is exactly the case melt is for');
});

// ---------------------------------------------------------------------------
// A6 -- the old two-keys test could not fail
// ---------------------------------------------------------------------------

test('a derivation that IGNORES the password cannot pass', () => {
  // Miguel A6, replacing a test that proved nothing. The old one asserted that
  // two vaults with different passwords hold different ciphertexts -- but the IV
  // is random per wrap, so two wraps of the SAME secret under the SAME key also
  // differ. He proved it: substituting `deriveKey` with `Buffer.alloc(32, 7)`,
  // ignoring the password entirely, left that test green.
  //
  // He also said the mutant died elsewhere, in 'the old key must stop working',
  // so the suite as a whole was covered. What was wrong was this test's comment
  // promising a guarantee it did not give -- which is worse than no test, because
  // it stops the next reader looking.
  //
  // The real assertion is behavioural: a key that was never set must not open it.
  const { file } = lockedVault();
  assert.strictEqual(open(file).unlock('a key never set').ok, false,
    'a password that was never set must not open the vault');
  assert.strictEqual(open(file).unlock('').ok, false);
  assert.strictEqual(open(file).unlock(KEY).ok, true, 'and the real one still must');
});

// ---------------------------------------------------------------------------
// The count that makes melt a decision (Dexter F5 / Miguel B3, vault half)
// ---------------------------------------------------------------------------

test('lockState carries a COUNT that survives the lock', () => {
  // Both reviewers found this independently. The melt warning's "All 6 secrets"
  // branch was unreachable in production, so every user read the slogan the
  // module was written to avoid -- and the count could not come from `list()`,
  // which returns [] while locked by design and must stay that way.
  //
  // A count is not a secret: no label, no note, no value. The person about to
  // destroy them owns them. What it buys is the difference between a decision
  // and a slogan.
  const file = tmp();
  const v = open(file);
  for (const n of [1, 2, 3, 4, 5, 6]) v.add({ label: `s${n}`, secret: 'x', shared: true });
  v.setKey(KEY);

  const locked = open(file);
  assert.strictEqual(locked.lockState().locked, true);
  assert.strictEqual(locked.lockState().count, 6, 'the count must survive the lock');
  assert.deepStrictEqual(locked.list(ANY), [], 'while the labels must not');
});

// ---------------------------------------------------------------------------
// F9 -- two live instances, which PR #41 makes an intended workflow
// ---------------------------------------------------------------------------

test('a STALE instance cannot strip the key off the vault', () => {
  // Dexter, PR #42, F9, and this one is not hypothetical.
  //
  // `commit` spreads the in-memory `{ ...state }`, so a stale handle's ordinary
  // `add` rewrites the WHOLE file from what it last read. Before the lock that
  // cost one entry, which the module documents as accepted. The lock changed the
  // payload: a stale instance wrote the file back with NO `lock` field and every
  // entry UNWRAPPED -- undoing a key it never held, both processes reporting
  // success, and the next launch opening with no password.
  //
  // WHY IT IS NOT LATENT: PR #41 (`--new`) spawns a SECOND ELECTRON PROCESS
  // against the same project, deliberately, because Ricardo asked for a second
  // window in the same folder. Two live instances sharing one vault file are the
  // intended shape, not an accident -- which is also why the obvious fix,
  // `app.requestSingleInstanceLock()`, is the wrong one: it would delete that
  // feature to close this.
  const file = tmp();
  const a = open(file);                      // instance A
  a.add({ label: 'first', secret: 's1', shared: true });

  const b = open(file);                      // instance B, same file
  b.setKey(KEY);                             // B sets a key A knows nothing about

  assert.strictEqual(readVault(file).lock !== undefined, true, 'precondition: B set a key');

  // A's ordinary add would have rewritten the file from its stale state.
  assert.throws(() => a.add({ label: 'second', secret: 's2', shared: true }),
    /another window changed the vault/i,
    'a write against a file that moved must be refused, not silently applied');

  // And the key B set is still there.
  assert.strictEqual(readVault(file).lock !== undefined, true,
    'the key must survive a stale write attempt');
  assert.strictEqual(open(file).lockState().locked, true,
    'the vault must still be locked on the next launch');
});

test('the staleness check does not block ORDINARY consecutive writes', () => {
  // A guard that refuses legitimate work is worse than the race it prevents.
  // Several writes from one handle, and a fresh handle after them, must all work.
  const file = tmp();
  const v = open(file);
  v.add({ label: 'a', secret: '1', shared: true });
  v.add({ label: 'b', secret: '2', shared: true });
  v.setKey(KEY);
  v.add({ label: 'c', secret: '3', shared: true });
  v.lock();
  assert.strictEqual(v.unlock(KEY).ok, true);
  v.removeKey();
  assert.strictEqual(v.list(ANY).length, 3, 'all three writes landed');

  const fresh = open(file);
  fresh.add({ label: 'd', secret: '4', shared: true });
  assert.strictEqual(fresh.list(ANY).length, 4, 'a fresh handle writes fine');
});

test('the second instance can pick up the change and then write', () => {
  // The refusal has to be recoverable, or the message telling the user to reopen
  // the panel is a lie. A new handle reads the current generation and proceeds.
  const file = tmp();
  const a = open(file);
  a.add({ label: 'first', secret: 's1', shared: true });
  const b = open(file);
  b.add({ label: 'second', secret: 's2', shared: true });

  assert.throws(() => a.add({ label: 'third', secret: 's3', shared: true }),
    /another window changed the vault/i);

  const reopened = open(file);              // what "reopen the panel" does
  reopened.add({ label: 'third', secret: 's3', shared: true });
  assert.deepStrictEqual(reopened.list(ANY).map(e => e.label).sort(),
    ['first', 'second', 'third']);
});
