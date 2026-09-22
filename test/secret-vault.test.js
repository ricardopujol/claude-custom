'use strict';
/**
 * The secret store.
 *
 * Lives in the MAIN process, deliberately: the host owns the pty, so a secret
 * that never reaches the host can never be written into the session by any
 * accident of wiring. That is a structural guarantee rather than a careful one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVault, CLIPBOARD_CLEAR_MS } = require('../app/secret-vault');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vault-')), 'secrets.enc');

// Stands in for Electron safeStorage. Reversible and obviously not real crypto:
// the tests care about what the vault DOES with it, not about the cipher.
const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => {
    const raw = Buffer.from(b).toString('utf8');
    if (!raw.startsWith('ENC:')) throw new Error('not encrypted by this cipher');
    return Buffer.from(raw.slice(4), 'base64').toString('utf8');
  },
});

const vault = (opts = {}) => createVault({ file: tmp(), crypto: fakeCrypto(), ...opts });

test('an added secret can be read back', () => {
  const v = vault();
  const e = v.add({ label: 'github token', secret: 'ghp_abc123' });
  assert.strictEqual(v.get(e.id), 'ghp_abc123');
});

test('list NEVER carries secret values', () => {
  // The list is what the window renders. A secret in it is a secret on screen,
  // and on screen is one screenshot away from everywhere.
  const v = vault();
  v.add({ label: 'github token', secret: 'ghp_abc123', note: 'personal' });
  const listed = v.list();
  assert.strictEqual(listed.length, 1);
  assert.ok(!('secret' in listed[0]), Object.keys(listed[0]).join(','));
  assert.ok(!JSON.stringify(listed).includes('ghp_abc123'));
});

test('the file on disk contains no plaintext secret', () => {
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  v.add({ label: 'db', secret: 'hunter2-correct-horse' });
  const raw = fs.readFileSync(file);
  assert.ok(!raw.includes('hunter2-correct-horse'), 'plaintext secret found on disk');
});

test('labels and notes are readable without decrypting anything', () => {
  // Only the SECRET is encrypted. Labels have to be searchable and listable, and
  // encrypting them would buy nothing while making the list a decrypt storm.
  const v = vault();
  v.add({ label: 'github token', secret: 's', note: 'work account' });
  const [e] = v.list();
  assert.strictEqual(e.label, 'github token');
  assert.strictEqual(e.note, 'work account');
});

test('secrets survive a reopen', () => {
  const file = tmp();
  const a = createVault({ file, crypto: fakeCrypto() });
  const id = a.add({ label: 'k', secret: 'value-1' }).id;
  const b = createVault({ file, crypto: fakeCrypto() });
  assert.strictEqual(b.get(id), 'value-1');
});

test('REFUSES to store anything when encryption is unavailable', () => {
  // Fail closed. Writing plaintext because the OS keyring is missing is the
  // one outcome that must never happen quietly -- the user believes it is
  // encrypted, because that is what the feature is for.
  const v = vault({ crypto: fakeCrypto(false) });
  assert.throws(() => v.add({ label: 'k', secret: 's' }), /encryption/i);
});

test('reports whether it can be used at all, so the UI can say so', () => {
  assert.strictEqual(vault().available(), true);
  assert.strictEqual(vault({ crypto: fakeCrypto(false) }).available(), false);
});

test('a missing file is an empty vault, not an error', () => {
  assert.deepStrictEqual(createVault({ file: tmp(), crypto: fakeCrypto() }).list(), []);
});

test('a corrupt file does not destroy what is still readable', () => {
  // Partial loss beats total loss: one unreadable entry must not take the
  // other nine with it.
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  v.add({ label: 'good', secret: 'keep-me' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.entries.push({ id: 'broken', label: 'bad', secret: 'not-base64-at-all' });
  fs.writeFileSync(file, JSON.stringify(onDisk));

  const reopened = createVault({ file, crypto: fakeCrypto() });
  assert.strictEqual(reopened.list().length, 2, 'both entries should still be listed');
  assert.strictEqual(reopened.get(reopened.list().find(e => e.label === 'good').id), 'keep-me');
  assert.strictEqual(reopened.get('broken'), null, 'an undecryptable secret reads as null');
});

test('a file that is not JSON at all is refused, not overwritten', () => {
  // Silently replacing an unreadable vault would delete every secret in it.
  const file = tmp();
  fs.writeFileSync(file, 'this is not json');
  assert.throws(() => createVault({ file, crypto: fakeCrypto() }), /unreadable|parse/i);
});

test('removing an entry removes the secret with it', () => {
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  const e = v.add({ label: 'k', secret: 'delete-me-entirely' });
  v.remove(e.id);
  assert.deepStrictEqual(v.list(), []);
  assert.strictEqual(v.get(e.id), null);
  assert.ok(!fs.readFileSync(file).includes('delete-me-entirely'));
});

test('ids are unique even for identical labels', () => {
  const v = vault();
  const a = v.add({ label: 'same', secret: '1' });
  const b = v.add({ label: 'same', secret: '2' });
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(v.get(a.id), '1');
  assert.strictEqual(v.get(b.id), '2');
});

test('an empty secret is refused', () => {
  // An entry with no secret is a label pretending to be protection.
  assert.throws(() => vault().add({ label: 'k', secret: '' }), /secret/i);
});

test('an empty label is refused, since the list is all labels', () => {
  assert.throws(() => vault().add({ label: '  ', secret: 's' }), /label/i);
});

test('get on an unknown id returns null rather than throwing', () => {
  assert.strictEqual(vault().get('nope'), null);
});

test('the file is written atomically', () => {
  // A crash mid-write must not leave a truncated vault, which is every secret
  // gone rather than one.
  const file = tmp();
  const writes = [];
  const v = createVault({
    file,
    crypto: fakeCrypto(),
    onWrite: (target) => writes.push(target),
  });
  v.add({ label: 'k', secret: 's' });
  assert.ok(writes.some(w => w !== file), `expected a temp file, got ${JSON.stringify(writes)}`);
});

test('the clipboard clear delay is long enough to paste and short enough to matter', () => {
  assert.ok(CLIPBOARD_CLEAR_MS >= 10000 && CLIPBOARD_CLEAR_MS <= 120000, String(CLIPBOARD_CLEAR_MS));
});

// --- the write itself, which Windows can refuse for a moment ------------------

test('a transient EPERM on the rename does NOT lose the secret', () => {
  // MEASURED, and this exact file: on 2026-09-18 a run of this suite failed
  // with `EPERM: operation not permitted, rename '...\.secrets-46740-....tmp'
  // -> '...\secrets.enc'`. Nothing was wrong with the file or the
  // permissions -- on Windows a rename fails while any process holds a
  // handle, and the antivirus scan of the file just written routinely does.
  //
  // Unretried, that is a secret the UI reported as saved and that is not on
  // disk, which is the worst failure this module has: the user believes it is
  // safe to discard the original.
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  const real = fs.renameSync;
  let failures = 2;
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls++;
    if (failures-- > 0) {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    }
    return real(from, to);
  };
  let entry;
  try {
    entry = v.add({ label: 'token', secret: 'survives-eperm' });
  } finally {
    fs.renameSync = real;
  }
  // Dexter, Finding 8: prove the retry RAN rather than that the data happened
  // to survive. This test sees the patch only because `rename = fs.renameSync`
  // is a default parameter re-evaluated per call; hoisting it to a module-level
  // const would silently make this pass while testing nothing.
  assert.strictEqual(calls, 3, 'the rename must have been retried, not merely succeeded');

  const reopened = createVault({ file, crypto: fakeCrypto() });
  assert.strictEqual(reopened.get(entry.id), 'survives-eperm',
    'the secret must be on disk, not merely in memory');
});

test('a rename that never recovers FAILS the save rather than reporting success', () => {
  // Fails closed, deliberately. Returning the entry while the file was never
  // replaced would tell the user their secret is stored when it is not.
  const v = createVault({ file: tmp(), crypto: fakeCrypto() });
  const real = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM: operation not permitted, rename');
    err.code = 'EPERM';
    throw err;
  };
  try {
    assert.throws(() => v.add({ label: 'token', secret: 'never-lands' }),
      (err) => err.code === 'EPERM');
  } finally {
    fs.renameSync = real;
  }
});

// --- what the vault SHOWS must never be ahead of what is on disk -------------
// Dexter, logic review of PR #30, Finding 1 (High). The retry made a failed
// save rarer; it did not make a failed save honest. `add` pushed into
// state.entries BEFORE persist(), so a permanent rename failure left the entry
// live in memory: `add` reported failure and `list`/`get`/`reveal`/`copy` all
// reported success, until a restart silently took the secret away. The harm
// the module's own docstring names -- the user believing it is safe to discard
// the original -- was still fully reachable.

const alwaysFails = (code = 'EPERM') => {
  const real = fs.renameSync;
  fs.renameSync = () => { const e = new Error(`${code}: fake`); e.code = code; throw e; };
  return () => { fs.renameSync = real; };
};

test('a secret whose save FAILED is not listed, revealed, or gettable', () => {
  const v = vault();
  const restore = alwaysFails();
  try {
    assert.throws(() => v.add({ label: 'aws', secret: 'AKIA-REAL' }), /EPERM/);
    // `list` is what the window renders, so it is the read path that matters
    // most -- and the only one reachable here, because `get` needs an id that
    // `add` never returned. An earlier version of this comment claimed three
    // read paths were asserted and named `reveal` and `copy`; those are not
    // even vault methods (they live on app/secret-service.js and reach the
    // vault through `get`), so the comment described an API this file does not
    // have (Miguel). What makes the single assertion sufficient is the SHAPE
    // of the fix: nothing is assigned to `state` at all, so no read path has
    // anything to find.
    assert.deepStrictEqual(v.list(), [], 'a save that did not land must not be listed');
  } finally {
    restore();
  }
});

test('a FAILED save is not silently committed by the NEXT successful one', () => {
  // The third-order effect, and the nastiest: the in-memory divergence
  // persisted, so the next write flushed it. An operation the user was told
  // had failed completed later, unannounced.
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });

  const restore = alwaysFails();
  try {
    assert.throws(() => v.add({ label: 'ghost', secret: 'SHOULD-NOT-PERSIST' }));
  } finally {
    restore();
  }

  v.add({ label: 'real', secret: 'KEEP-ME' });

  const reopened = createVault({ file, crypto: fakeCrypto() });
  assert.deepStrictEqual(reopened.list().map(e => e.label), ['real'],
    'the failed save must not ride along on the next successful write');
});

test('a DELETE that failed to reach disk still shows the entry', () => {
  // The mirror of the same defect: remove() filtered state.entries before
  // persist(), so a failed delete told the user it failed and showed them it
  // had succeeded -- a credential they believe is gone and is still on disk.
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  const entry = v.add({ label: 'keep', secret: 'STILL-HERE' });

  const restore = alwaysFails();
  try {
    assert.throws(() => v.remove(entry.id), /EPERM/);
  } finally {
    restore();
  }
  assert.deepStrictEqual(v.list().map(e => e.label), ['keep'],
    'a delete that did not land must not be shown as done');

  const reopened = createVault({ file, crypto: fakeCrypto() });
  assert.deepStrictEqual(reopened.list().map(e => e.label), ['keep']);
});

test('a permanently failed save leaves no temp file behind', () => {
  // Dexter, Finding 9. The temp is named .secrets-<pid>-<Date.now()>.tmp, so
  // it is unique per millisecond and every failure accumulates another one in
  // .harness\ with nothing ever collecting them. They hold the WHOLE vault --
  // and since only the `secret` field is encrypted, every label and note in
  // those orphans is readable plaintext. A scattered copy of the data this
  // module is otherwise careful about.
  const file = tmp();
  const dir = path.dirname(file);
  const v = createVault({ file, crypto: fakeCrypto() });

  const restore = alwaysFails();
  try {
    assert.throws(() => v.add({ label: 'leaky', secret: 'S' }));
  } finally {
    restore();
  }

  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `orphaned temp files: ${leftovers.join(', ')}`);
});

test('a temp is not left behind when the WRITE fails either, not just the rename', () => {
  // Miguel, review of the fixed branch, Importante 1. The first cleanup only
  // wrapped the rename, so a writeFileSync that threw -- ENOSPC, a quota, a
  // transient EACCES -- left the partially written temp on disk holding every
  // label and note in PLAINTEXT, with a millisecond in its name so they
  // accumulate. The comment claimed the failure path was cleaned; it cleaned
  // one of two.
  const file = tmp();
  const dir = path.dirname(file);
  const v = createVault({ file, crypto: fakeCrypto() });

  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (String(p).endsWith('.tmp')) {
      // Write it, THEN fail -- the nastier ordering, and the realistic one for
      // a disk filling up mid-write.
      realWrite(p, ...rest);
      const e = new Error('ENOSPC: no space left on device');
      e.code = 'ENOSPC';
      throw e;
    }
    return realWrite(p, ...rest);
  };
  try {
    assert.throws(() => v.add({ label: 'partial', secret: 'S' }), /ENOSPC/);
  } finally {
    fs.writeFileSync = realWrite;
  }

  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], `orphaned temp files: ${leftovers.join(', ')}`);
});

test('a cleanup that ITSELF fails does not mask the real error', () => {
  // Miguel, Importante 2. The unlink is most likely to fail under exactly the
  // condition that triggers it: the rename failed because something holds a
  // handle on the temp, and unlinkSync on a held handle fails the same way on
  // Windows. The previous test faked the rename while leaving a real,
  // working unlink -- it asserted cleanup in the one state where cleanup is
  // trivial, which is wiring rather than behaviour for the hard case.
  //
  // The cleanup is best-effort and cannot be made reliable here. What MUST
  // hold is that its failure never replaces the error the caller needs to see.
  const v = vault();
  const realRename = fs.renameSync;
  const realUnlink = fs.unlinkSync;
  fs.renameSync = () => { const e = new Error('EPERM: rename'); e.code = 'EPERM'; throw e; };
  fs.unlinkSync = () => { const e = new Error('EBUSY: unlink'); e.code = 'EBUSY'; throw e; };
  try {
    assert.throws(() => v.add({ label: 'x', secret: 'y' }), /EPERM: rename/,
      'the rename failure is what the caller must hear about, not the cleanup failure');
  } finally {
    fs.renameSync = realRename;
    fs.unlinkSync = realUnlink;
  }
});

// --- mutation-driven kills ---------------------------------------------------
// Mortimer's run on this branch put app/secret-vault.js at 73.3% with 32
// survivors. Most are error-MESSAGE mutants, which CLAUDE.md says to leave
// unkilled -- asserting exact wording is brittle and tests nothing. These are
// the ones that were behaviour rather than wording.

test('createVault refuses to be built without a file or a cipher', () => {
  // Survivors: both guard conditionals mutated to `false`. Nothing asserted
  // that a vault with no file, or no cipher, refuses to exist -- so a future
  // refactor could drop either guard and construct a vault that writes to
  // `undefined` or stores plaintext.
  assert.throws(() => createVault({ crypto: fakeCrypto() }), /file is required/);
  assert.throws(() => createVault({ file: tmp() }), /crypto is required/);
});

test('a vault file of the wrong SHAPE is refused, not silently emptied', () => {
  // Survivors: the `!parsed || !Array.isArray(parsed.entries)` guard, both as
  // a conditional and with the operator flipped to `&&`. With `&&`, a file
  // that parses to `null` or to `{}` would pass the guard -- and this module's
  // whole stated rule is that it never replaces a vault it cannot read,
  // because doing so deletes every secret to fix a display problem.
  for (const bad of ['null', '{}', '[]', '{"entries":"nope"}', '{"entries":null}']) {
    const file = tmp();
    fs.writeFileSync(file, bad);
    assert.throws(() => createVault({ file, crypto: fakeCrypto() }),
      /unreadable, refusing to replace it/, `contents: ${bad}`);
  }
});

test('the vault reports encryption as unavailable when the cipher says so', () => {
  // Survivors: `available()` mutated to return a constant, and its catch
  // emptied. Both matter: `add` fails closed on this, and a vault that
  // wrongly reports encryption available is how a secret gets stored in
  // plaintext while the user believes it is encrypted.
  assert.strictEqual(vault({ crypto: fakeCrypto(false) }).available(), false);
  assert.strictEqual(vault().available(), true);

  // A cipher that THROWS is unavailable, not available. The catch is the
  // fail-closed half and was mutated away without any test noticing.
  const throwing = { ...fakeCrypto(), isEncryptionAvailable: () => { throw new Error('no dpapi'); } };
  const v = createVault({ file: tmp(), crypto: throwing });
  assert.strictEqual(v.available(), false);
  assert.throws(() => v.add({ label: 'x', secret: 'y' }), /refusing to store a secret in plaintext/);
});

test('remove reports whether it actually removed anything', () => {
  // Survivors: the `next.length === before` early return and the final
  // `return true`, each mutated to a constant. The caller uses this to decide
  // what to tell the user, so "removed" and "there was nothing to remove"
  // collapsing into one answer is a wrong message either way round.
  const v = vault();
  const entry = v.add({ label: 'gone', secret: 's' });
  assert.strictEqual(v.remove('no-such-id'), false, 'removing nothing must say so');
  assert.strictEqual(v.list().length, 1, 'and must not have removed anything');
  assert.strictEqual(v.remove(entry.id), true, 'removing something must say so');
  assert.strictEqual(v.list().length, 0);
});

test('an entry with no createdAt lists as 0 rather than undefined', () => {
  // Survivor: `e.createdAt || 0` with the operator flipped. The window sorts
  // and formats on this, and `undefined` there renders as an invalid date
  // rather than as "unknown".
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ format: 1, entries: [
    { id: 'a', label: 'old', note: '', secret: 'x' },
  ] }));
  const v = createVault({ file, crypto: fakeCrypto() });
  assert.strictEqual(v.list()[0].createdAt, 0);
});

test('get on an unknown id is null, not a throw', () => {
  // Survivor: the `if (!entry) return null` guard. The service layer calls
  // this with ids that can be stale after a removal in another window.
  assert.strictEqual(vault().get('nope'), null);
});

test('removing one entry leaves every other one untouched', () => {
  // Mortimer SV-B, HIGH. The filter predicate `e => e.id !== id` had two
  // surviving mutants (`() => undefined` and `false`), and EVERY existing
  // remove test operated on a vault holding exactly ONE entry -- where
  // "delete the one you asked for" and "delete everything" are
  // indistinguishable.
  //
  // MEASURED: [{id:1},{id:2}].filter(() => undefined) returns []. Under either
  // mutant, removing one secret commits an EMPTY vault -- every other
  // credential gone -- and commit() persists it, so they are gone on restart
  // too. In a module whose entire job is storing secrets.
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  const a = v.add({ label: 'keep-a', secret: 'A' });
  const b = v.add({ label: 'drop-b', secret: 'B' });
  const c = v.add({ label: 'keep-c', secret: 'C' });

  assert.strictEqual(v.remove(b.id), true);
  assert.deepStrictEqual(v.list().map(e => e.label), ['keep-a', 'keep-c']);
  assert.strictEqual(v.get(a.id), 'A', 'the others must still decrypt');
  assert.strictEqual(v.get(c.id), 'C');

  const reopened = createVault({ file, crypto: fakeCrypto() });
  assert.deepStrictEqual(reopened.list().map(e => e.label), ['keep-a', 'keep-c'],
    'and the survivors must still be on disk');
});

test('an absent secret or label is refused, not stored as the string "undefined"', () => {
  // Mortimer SV-C (HIGH) and SV-D. The existing tests pass '' and '  ', which
  // take the NON-null branch of `secret == null ? '' : secret`, so the null
  // branch was never exercised. Under the surviving mutants,
  // `add({ label: 'k' })` stores the six-character string "undefined" as a
  // real, encrypted, retrievable secret and reports success -- the user is
  // told a credential is stored and what is stored is garbage.
  for (const bad of [{ label: 'k' }, { label: 'k', secret: null }, { label: 'k', secret: undefined }]) {
    assert.throws(() => vault().add(bad), /secret/i, JSON.stringify(bad));
  }
  for (const bad of [{ secret: 's' }, { label: null, secret: 's' }, { label: undefined, secret: 's' }]) {
    assert.throws(() => vault().add(bad), /label/i, JSON.stringify(bad));
  }
});

test('an unknown id is not removed, and is not written either', () => {
  // Mortimer SV-F. The return value was unasserted, and the early return is
  // what stops a pointless disk write -- so the onWrite spy is the half that
  // makes the conditional load-bearing rather than decorative.
  const writes = [];
  const v = createVault({ file: tmp(), crypto: fakeCrypto(), onWrite: p => writes.push(p) });
  const e = v.add({ label: 'one', secret: 's' });
  const afterAdd = writes.length;

  assert.strictEqual(v.remove('no-such-id'), false);
  assert.strictEqual(writes.length, afterAdd, 'a no-op remove must not write to disk');

  assert.strictEqual(v.remove(e.id), true);
  assert.ok(writes.length > afterAdd, 'a real remove must write');
  assert.strictEqual(v.remove(e.id), false, 'removing the same id twice reports false');
});

test('the committed file is announced exactly once per write', () => {
  // Mortimer SV-H. The existing test asserts only that SOME notification was
  // the temp path, so the post-rename onWrite(file) could vanish unnoticed --
  // and that callback is how anything downstream learns the write landed.
  const file = tmp();
  const writes = [];
  const v = createVault({ file, crypto: fakeCrypto(), onWrite: p => writes.push(p) });
  v.add({ label: 'k', secret: 's' });
  assert.strictEqual(writes.filter(w => w === file).length, 1,
    'the committed file must be announced exactly once');
  assert.strictEqual(writes.filter(w => w !== file).length, 1, 'and the temp exactly once');
});

test('notes are normalised: absent becomes empty, padded is trimmed', () => {
  // Mortimer SV-I. Every existing test that supplies a note supplies a clean
  // one, and none adds an entry WITHOUT a note and reads it back.
  const v = vault();
  v.add({ label: 'no-note', secret: 's' });
  assert.strictEqual(v.list()[0].note, '', 'an absent note reads as empty, never undefined');
  v.add({ label: 'padded', secret: 's', note: '   spaced out   ' });
  assert.strictEqual(v.list()[1].note, 'spaced out');
});
