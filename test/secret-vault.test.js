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

const { createVault: unboundVault, CLIPBOARD_CLEAR_MS } = require('../app/secret-vault');
const { tmpDir } = require('./tmp-dir');

const tmp = () => path.join(tmpDir('cc-vault-'), 'secrets.enc');

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

// PROJECT-BOUND, deliberately, and this is the most important line in the file.
//
// Production NEVER calls this vault without a project: `createSecretService`
// injects the window's own project into every call. The suite below predates
// scoping and passed none -- so when scoping landed and `add()` began refusing
// an unusable scope, every pre-existing call site was mechanically given
// `shared: true` to keep the suite green.
//
// That repair was worse than the red suite it silenced. It moved the ENTIRE
// pre-existing suite onto the SHARED path, where `visibleFrom` returns at the
// `scope === null` line and the `samePath` comparison is never reached -- so
// the DEFAULT path, the one the whole feature exists to create, was tested only
// by the handful of tests written for it. Dexter predicted it from a grep,
// without reading the fix.
//
// MEASURED, 2026-09-23, replacing the scoped branch with `return false` so it
// never matches:
//
//   sprayed suite   4 of 47 tests fail
//   bound suite    17 of 47 tests fail
//
// Note WHICH sabotage discriminates, because the obvious one does not: making
// `visibleFrom` return `true` always -- deleting scoping from the product
// outright -- fails the same 4 either way. It is a WIDENING, and every test
// here reads from the project it wrote to, so nothing notices. Only narrowing
// the scoped branch tells the two suites apart.
//
// So the helper binds one project and threads it through every call. The tests
// below now read as what production actually does -- one window, one project,
// everything scoped -- and a test that wants sharing asks for it by name.
const HOME = process.platform === 'win32' ? 'C:/work/home-project' : '/work/home-project';

function bindProject(v, project) {
  return {
    ...v,
    add: (e = {}) => v.add({ project, ...e }),
    get: (id, q) => v.get(id, q === undefined ? { project } : q),
    list: (q) => v.list(q === undefined ? { project } : q),
    remove: (id, q) => v.remove(id, q === undefined ? { project } : q),
  };
}

// Shadows the import so EVERY construction in this file is bound, including the
// two dozen that call it directly. A binding that covered only the `vault()`
// helper would leave most of the suite exactly as blind as it was.
const createVault = (opts) => bindProject(unboundVault(opts), HOME);

const vault = (opts = {}) => createVault({ file: tmp(), crypto: fakeCrypto(), ...opts });

test('an added secret can be read back', () => {
  const v = vault();
  const e = v.add({ label: 'github token', secret: 'ghp_abc123'});
  assert.strictEqual(v.get(e.id), 'ghp_abc123');
});

test('list NEVER carries secret values', () => {
  // The list is what the window renders. A secret in it is a secret on screen,
  // and on screen is one screenshot away from everywhere.
  const v = vault();
  v.add({ label: 'github token', secret: 'ghp_abc123', note: 'personal'});
  const listed = v.list();
  assert.strictEqual(listed.length, 1);
  assert.ok(!('secret' in listed[0]), Object.keys(listed[0]).join(','));
  assert.ok(!JSON.stringify(listed).includes('ghp_abc123'));
});

test('the file on disk contains no plaintext secret', () => {
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  v.add({ label: 'db', secret: 'hunter2-correct-horse'});
  const raw = fs.readFileSync(file);
  assert.ok(!raw.includes('hunter2-correct-horse'), 'plaintext secret found on disk');
});

test('labels and notes are readable without decrypting anything', () => {
  // Only the SECRET is encrypted. Labels have to be searchable and listable, and
  // encrypting them would buy nothing while making the list a decrypt storm.
  const v = vault();
  v.add({ label: 'github token', secret: 's', note: 'work account'});
  const [e] = v.list();
  assert.strictEqual(e.label, 'github token');
  assert.strictEqual(e.note, 'work account');
});

test('secrets survive a reopen', () => {
  const file = tmp();
  const a = createVault({ file, crypto: fakeCrypto() });
  const id = a.add({ label: 'k', secret: 'value-1'}).id;
  const b = createVault({ file, crypto: fakeCrypto() });
  assert.strictEqual(b.get(id), 'value-1');
});

test('REFUSES to store anything when encryption is unavailable', () => {
  // Fail closed. Writing plaintext because the OS keyring is missing is the
  // one outcome that must never happen quietly -- the user believes it is
  // encrypted, because that is what the feature is for.
  const v = vault({ crypto: fakeCrypto(false) });
  assert.throws(() => v.add({ label: 'k', secret: 's'}), /encryption/i);
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
  v.add({ label: 'good', secret: 'keep-me'});
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
  //
  // THE PROPERTY IS UNCHANGED; THE MECHANISM MOVED. Dexter, PR #42, G3. This
  // used to assert that `createVault` THROWS, which is the spelling rather than
  // the rule -- and the spelling turned out to be wrong: `app/main.js` does not
  // wrap the constructor, so an unreadable vault meant no window opened at all.
  // The panel that would have explained it, and the melt button that is the only
  // way out, were both unreachable because the app died first.
  //
  // So a damaged file now LOADS, reports itself damaged and locked, and refuses
  // every write. Not overwriting is still guaranteed -- it is asserted below
  // against the bytes on disk, which is a stronger check than the throw was.
  const file = tmp();
  fs.writeFileSync(file, 'this is not json');

  const v = createVault({ file, crypto: fakeCrypto() });
  assert.ok(v.lockState().damaged, 'it must announce the damage');
  assert.strictEqual(v.lockState().locked, true, 'and fail closed');

  assert.throws(() => v.add({ label: 'k', secret: 's' }), /damaged/i,
    'and refuse the write that would destroy what is in there');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'this is not json',
    'THE PROPERTY: the bytes on disk are untouched');
});

test('removing an entry removes the secret with it', () => {
  const file = tmp();
  const v = createVault({ file, crypto: fakeCrypto() });
  const e = v.add({ label: 'k', secret: 'delete-me-entirely'});
  v.remove(e.id);
  assert.deepStrictEqual(v.list(), []);
  assert.strictEqual(v.get(e.id), null);
  assert.ok(!fs.readFileSync(file).includes('delete-me-entirely'));
});

test('ids are unique even for identical labels', () => {
  const v = vault();
  const a = v.add({ label: 'same', secret: '1'});
  const b = v.add({ label: 'same', secret: '2'});
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(v.get(a.id), '1');
  assert.strictEqual(v.get(b.id), '2');
});

test('an empty secret is refused', () => {
  // An entry with no secret is a label pretending to be protection.
  assert.throws(() => vault().add({ label: 'k', secret: ''}), /secret/i);
});

test('an empty label is refused, since the list is all labels', () => {
  assert.throws(() => vault().add({ label: '  ', secret: 's'}), /label/i);
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
  v.add({ label: 'k', secret: 's'});
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
    entry = v.add({ label: 'token', secret: 'survives-eperm'});
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
    assert.throws(() => v.add({ label: 'token', secret: 'never-lands'}),
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
    assert.throws(() => v.add({ label: 'aws', secret: 'AKIA-REAL'}), /EPERM/);
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
    assert.throws(() => v.add({ label: 'ghost', secret: 'SHOULD-NOT-PERSIST'}));
  } finally {
    restore();
  }

  v.add({ label: 'real', secret: 'KEEP-ME'});

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
  const entry = v.add({ label: 'keep', secret: 'STILL-HERE'});

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
    assert.throws(() => v.add({ label: 'leaky', secret: 'S'}));
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
    assert.throws(() => v.add({ label: 'partial', secret: 'S'}), /ENOSPC/);
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
    assert.throws(() => v.add({ label: 'x', secret: 'y'}), /EPERM: rename/,
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
  //
  // Same move as the not-JSON test above (Dexter G3): the guard is unchanged and
  // the mutants it kills are unchanged, but "refused" now means "loads as
  // damaged and refuses to write" rather than "throws at construction", because
  // throwing at construction cost the user the whole window.
  //
  // The mutation-driven part still holds. Flip the guard to `&&` and a file
  // parsing to `null` or `{}` sails through; the assertions below fail, because
  // such a file must be damaged rather than treated as an empty vault.
  for (const bad of ['null', '{}', '[]', '{"entries":"nope"}', '{"entries":null}']) {
    const file = tmp();
    fs.writeFileSync(file, bad);

    const v = createVault({ file, crypto: fakeCrypto() });
    assert.ok(v.lockState().damaged, `contents: ${bad} must be damaged`);
    assert.strictEqual(v.lockState().locked, true, `contents: ${bad} must fail closed`);
    assert.throws(() => v.add({ label: 'k', secret: 's' }), /damaged/i,
      `contents: ${bad} must refuse writes`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), bad,
      `contents: ${bad} must be left on disk untouched`);
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
  assert.throws(() => v.add({ label: 'x', secret: 'y'}), /refusing to store a secret in plaintext/);
});

test('remove reports whether it actually removed anything', () => {
  // Survivors: the `next.length === before` early return and the final
  // `return true`, each mutated to a constant. The caller uses this to decide
  // what to tell the user, so "removed" and "there was nothing to remove"
  // collapsing into one answer is a wrong message either way round.
  const v = vault();
  const entry = v.add({ label: 'gone', secret: 's'});
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
  const a = v.add({ label: 'keep-a', secret: 'A'});
  const b = v.add({ label: 'drop-b', secret: 'B'});
  const c = v.add({ label: 'keep-c', secret: 'C'});

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
  const e = v.add({ label: 'one', secret: 's'});
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
  v.add({ label: 'k', secret: 's'});
  assert.strictEqual(writes.filter(w => w === file).length, 1,
    'the committed file must be announced exactly once');
  assert.strictEqual(writes.filter(w => w !== file).length, 1, 'and the temp exactly once');
});

test('notes are normalised: absent becomes empty, padded is trimmed', () => {
  // Mortimer SV-I. Every existing test that supplies a note supplies a clean
  // one, and none adds an entry WITHOUT a note and reads it back.
  const v = vault();
  v.add({ label: 'no-note', secret: 's'});
  assert.strictEqual(v.list()[0].note, '', 'an absent note reads as empty, never undefined');
  v.add({ label: 'padded', secret: 's', note: '   spaced out   '});
  assert.strictEqual(v.list()[1].note, 'spaced out');
});

// --- scope: which projects can see a secret ----------------------------------
//
// Ricardo asked for a "shared" option so vault secrets would be available in
// other folders. The measurement inverted the request: the vault file is
// `<install>/.harness/secrets.enc` (app/main.js), ONE PER INSTALL -- so every
// secret already was visible in every project, and nothing said so.
//
// That is the direction that stings. A client credential added while working
// on one project sat in the picker for every other project, including ones
// belonging to somebody else.
//
// So the feature is the inverse of the request, which is what he agreed to:
// project-scoped by DEFAULT, `shared` as an explicit opt-in.
//
// MIGRATION, stated because it is a silent-data decision: entries that predate
// this have no `project` field, and they stay SHARED. Narrowing them would make
// secrets vanish from projects where they are relied on -- a disappearance the
// user cannot debug, to fix a problem they never saw. New entries are scoped.

const A = 'C:/work/project-a';
const B = 'C:/work/project-b';

test('a secret added in a project is not visible from another one', () => {
  const v = vault();
  v.add({ label: 'a-only', secret: 's1', project: A });
  assert.deepStrictEqual(v.list({ project: B }).map(e => e.label), []);
  assert.deepStrictEqual(v.list({ project: A }).map(e => e.label), ['a-only']);
});

test('a SHARED secret is visible from every project', () => {
  const v = vault();
  v.add({ label: 'global', secret: 's', project: A, shared: true });
  assert.deepStrictEqual(v.list({ project: B }).map(e => e.label), ['global']);
  assert.deepStrictEqual(v.list({ project: A }).map(e => e.label), ['global']);
});

test('get() ENFORCES the scope -- an id from another project reveals nothing', () => {
  // The security property, and the reason scope cannot live in `list` alone.
  // The renderer asks by id; if `get` did not check, a window for project B
  // could reveal project A's secret by guessing or replaying an id.
  const v = vault();
  const e = v.add({ label: 'a-only', secret: 'top-secret', project: A });
  assert.strictEqual(v.get(e.id, { project: A }), 'top-secret');
  assert.strictEqual(v.get(e.id, { project: B }), null);
});

test('a shared secret can be read from anywhere', () => {
  const v = vault();
  const e = v.add({ label: 'global', secret: 'everywhere', project: A, shared: true });
  assert.strictEqual(v.get(e.id, { project: B }), 'everywhere');
});

test('remove() enforces the scope too', () => {
  // Otherwise a window for B could delete A's secret without ever seeing it.
  const v = vault();
  const e = v.add({ label: 'a-only', secret: 's', project: A });
  assert.strictEqual(v.remove(e.id, { project: B }), false);
  assert.strictEqual(v.list({ project: A }).length, 1, 'it must still be there');
  assert.strictEqual(v.remove(e.id, { project: A }), true);
});

test('EXISTING entries with no project stay shared', () => {
  // The migration. These were written when every secret was global; narrowing
  // them retroactively would make them vanish from projects that rely on them.
  //
  // THE FIXTURE IS RAW JSON, and it has to be. Dexter F2 / Miguel B2, found
  // independently: this test used to build its legacy entry through `add()`,
  // which ALWAYS writes the `project` key -- so the fixture was
  // `{"project": null}`, a deliberately-shared entry, and the branch under test
  // (`entry.project === undefined`) was never taken by any test in the file.
  // It reported the migration as covered while covering the opposite case.
  //
  // Miguel mutated the line to prove it: `const scope = entry.project;` fails
  // two tests, and neither is this one -- they are about `createdAt` and about
  // corrupt files. The migration branch was killed only by accident, from tests
  // that are about something else.
  //
  // The key must be genuinely ABSENT, which no path through `add()` can produce.
  const file = tmp();
  const enc = (s) => fakeCrypto().encryptString(s).toString('base64');
  fs.writeFileSync(file, JSON.stringify({
    format: 1,
    entries: [{ id: 'legacy-id', label: 'legacy', secret: enc('old'), createdAt: 1 }],
  }));

  const v = createVault({ file, crypto: fakeCrypto() });
  assert.deepStrictEqual(v.list({ project: B }).map(x => x.label), ['legacy'],
    'an entry predating scoping must stay visible everywhere');
  assert.strictEqual(v.get('legacy-id', { project: B }), 'old');
  assert.strictEqual(v.list({ project: B })[0].shared, true,
    'and must SAY it is shared -- the marker reads the same rule, from a second place');
});

test('a legacy entry keeps no project key, so the migration cannot silently expire', () => {
  // The migration is a read-time rule, not a rewrite. If some future write path
  // began stamping `project` onto entries it merely read, every legacy secret
  // would narrow to whichever window happened to touch it first -- the exact
  // disappearance the rule above exists to prevent, arriving later and looking
  // like something else.
  const file = tmp();
  const enc = (s) => fakeCrypto().encryptString(s).toString('base64');
  fs.writeFileSync(file, JSON.stringify({
    format: 1,
    entries: [{ id: 'legacy-id', label: 'legacy', secret: enc('old'), createdAt: 1 }],
  }));

  const v = createVault({ file, crypto: fakeCrypto() });
  v.list({ project: A });
  v.get('legacy-id', { project: A });
  v.add({ label: 'unrelated', secret: 's', project: A });   // forces a rewrite of the file

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    .entries.find(e => e.id === 'legacy-id');
  assert.strictEqual('project' in onDisk, false,
    'reading a legacy entry must not give it a scope');
  // From B: the legacy entry, and NOT the scoped one just added under A.
  // (My first version of this line expected 2 and was simply wrong -- the
  // `unrelated` entry is scoped to A, so B correctly cannot see it.)
  assert.deepStrictEqual(createVault({ file, crypto: fakeCrypto() })
    .list({ project: B }).map(e => e.label), ['legacy'],
    'it stays visible from elsewhere, and drags nothing scoped along with it');
});

test('the list says which entries are shared, so the scope is visible', () => {
  // The whole defect was that the scope was invisible. A shared secret that
  // does not announce itself is the same surprise in a new place.
  const v = vault();
  v.add({ label: 'local', secret: 's', project: A });
  v.add({ label: 'global', secret: 's', project: A, shared: true });
  const rows = v.list({ project: A });
  assert.strictEqual(rows.find(r => r.label === 'local').shared, false);
  assert.strictEqual(rows.find(r => r.label === 'global').shared, true);
});

test('asking with no project shows only shared entries, never everything', () => {
  // Fail closed: an unknown project must not become a skeleton key. Before
  // this, "no project" was the only mode and it meant "all of them".
  const v = vault();
  v.add({ label: 'local', secret: 's', project: A });
  v.add({ label: 'global', secret: 's', project: A, shared: true });
  assert.deepStrictEqual(v.list({}).map(e => e.label), ['global']);
  assert.deepStrictEqual(v.list().map(e => e.label), ['global']);
});

// --- the two nulls ----------------------------------------------------------
//
// Dexter, PR #40 review, Finding 1. Severity High, and it is this project's
// signature defect wearing the worst possible hat.
//
// `normalizeProjectPath` returns null for TWO different things: "shared" and
// "I cannot use this input". Every reader failed closed on that null --
// `visibleFrom`, `get`, `remove` all treat it as "deny unless shared" -- and
// `add` alone read it as an INTENTION. So one value meant deny-everything in
// three places and grant-everyone in the fourth, in one file.
//
// Reproduced before the fix:
//   add({ label:'prod-db', secret:'hunter2', project:'   ', shared:false })
//     -> visible from an unrelated project
//     -> revealed from an unrelated project: hunter2
//
// And it is reachable through the real wiring, not just the API: main.js takes
// PROJECT_CWD from CLAUDE_CUSTOM_CWD, and a single space is truthy, so it
// passes ' ' straight in. Every verify/probe-*.js sets that variable by hand.
//
// A scope that cannot be determined is not a scope. It refuses, the way
// `available()` already refuses to store plaintext when the cipher is gone.

test('an unusable project REFUSES rather than storing the secret shared', () => {
  const v = vault();
  for (const bad of ['   ', '', null, undefined, 42, {}, []]) {
    assert.throws(
      () => v.add({ label: 'prod-db', secret: 'hunter2', project: bad, shared: false }),
      /scope/i,
      `project ${JSON.stringify(bad)} with shared:false must refuse`);
  }
  assert.deepStrictEqual(v.list({ project: 'C:/anywhere' }), [],
    'and nothing may have been stored');
});

test('an explicit shared:true still stores, whatever the project is', () => {
  // Refusing must not make the shared path unreachable: `shared` is a decision
  // the user made, and it does not need a project to be valid.
  const v = vault();
  const e = v.add({ label: 'global', secret: 's', project: '   ', shared: true });
  assert.strictEqual(v.get(e.id, { project: 'C:/anywhere' }), 's');
});

test('a LEGACY entry -- no project KEY at all -- is shared', () => {
  // Dexter, Finding 2. The migration test asserted this and never built one:
  // `add()` without a project stored `project: null`, an explicit share, so
  // the `undefined` branch in visibleFrom was dead to the suite. The only way
  // to make a real legacy entry is to write the file the way the old code did.
  const file = tmp();
  const v0 = createVault({ file, crypto: fakeCrypto() });
  v0.add({ label: 'seed', secret: 'x', shared: true });

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.entries[0].project;                       // as written before scoping existed
  fs.writeFileSync(file, JSON.stringify(raw));

  const v1 = createVault({ file, crypto: fakeCrypto() });
  assert.strictEqual(raw.entries[0].project, undefined, 'precondition: the key is absent');
  assert.deepStrictEqual(v1.list({ project: 'C:/any' }).map(e => e.label), ['seed']);
  assert.strictEqual(v1.list({ project: 'C:/any' })[0].shared, true);
});

// --- the fixes Dexter and Miguel asked for, each with the test that pins it ---

test('remove deletes ONE entry, even when two share an id', () => {
  // Dexter, PR #40, F5. The guard authorized `target` and the filter deleted by
  // ID, so a window scoped to A could destroy B's secret -- one it was never
  // allowed to see -- and `remove` returned true with nothing raised.
  //
  // Not reachable through this API: ids come from randomUUID. It needs a
  // hand-edited vault, a restored secrets.enc from another install, or a sync
  // feature. The fix is to filter on identity, which is right however the
  // duplicate arrived, so the test seeds the file directly.
  const file = tmp();
  const enc = (s) => fakeCrypto().encryptString(s).toString('base64');
  fs.writeFileSync(file, JSON.stringify({
    format: 1,
    entries: [
      { id: 'SAME', label: 'a-side', secret: enc('A'), createdAt: 1, project: A },
      { id: 'SAME', label: 'b-side', secret: enc('B'), createdAt: 2, project: B },
    ],
  }));

  const v = unboundVault({ file, crypto: fakeCrypto() });
  assert.strictEqual(v.remove('SAME', { project: A }), true);

  assert.deepStrictEqual(v.list({ project: B }).map(e => e.label), ['b-side'],
    "B's secret must survive a delete authorized only against A's");
  assert.strictEqual(v.get('SAME', { project: B }), 'B', 'and must still be readable');
  assert.deepStrictEqual(v.list({ project: A }).map(e => e.label), []);
});

test('the shared marker and the visibility rule cannot drift apart', () => {
  // Miguel, PR #40, A4. The rule was written out twice -- once deciding
  // visibility, once deciding what the marker says. This asserts they AGREE on
  // every shape of scope, which is the property that made two copies dangerous:
  // a marker that disagrees with visibility lies about the one thing it exists
  // to announce.
  const file = tmp();
  const enc = (s) => fakeCrypto().encryptString(s).toString('base64');
  fs.writeFileSync(file, JSON.stringify({
    format: 1,
    entries: [
      { id: 'legacy', label: 'legacy', secret: enc('x'), createdAt: 1 },       // no key
      { id: 'null', label: 'deliberate', secret: enc('x'), createdAt: 1, project: null },
      { id: 'scoped', label: 'scoped', secret: enc('x'), createdAt: 1, project: A },
    ],
  }));

  const v = unboundVault({ file, crypto: fakeCrypto() });
  // Listed from a project that matches NONE of them: anything still visible is
  // visible because it is shared, so the marker must say so -- and anything the
  // marker calls shared must be visible from here.
  for (const e of v.list({ project: B })) {
    assert.strictEqual(e.shared, true,
      `${e.label} is visible from an unrelated project, so the marker must say shared`);
  }
  assert.deepStrictEqual(
    v.list({ project: B }).map(e => e.id).sort(), ['legacy', 'null'],
    'and the scoped one must not be there at all');
});

test('the shape production actually sends -- { project: null } -- is denied', () => {
  // Miguel, PR #40, A5. The existing test pins `list({})` and `list()`, which
  // is right: it fixes the RULE rather than a spelling. But neither is what
  // production sends. `createSecretService` defaults `project = null`, so
  // `{ project: null }` is the real call, and it was the one spelling with no
  // test. `'   '` too, which normalizeProjectPath also collapses to null.
  const v = vault();
  v.add({ label: 'scoped', secret: 's', project: A });

  for (const q of [{ project: null }, { project: '   ' }, { project: '' }, {}, undefined]) {
    assert.deepStrictEqual(unboundVault({ file: v.file, crypto: fakeCrypto() }).list(q), [],
      `an unusable project (${JSON.stringify(q)}) must see nothing, not everything`);
  }
});

// --- scope: a window sees its state root AND the container root -------------
//
// PR 2 (worktree tabs): the vault is created with `project: stateRoot(project)`
// (= <container>\dev), while entries saved before the 2026-09-28 layout move are
// scoped to the container root. `project` may therefore be a LIST of paths, and
// an entry is visible when its scope matches ANY of them.
const ROOT = 'C:/work/container';
const DEV = 'C:/work/container/dev';
const OTHER_ROOT = 'C:/work/other';
const OTHER_DEV = 'C:/work/other/dev';

function twoScoped() {
  const v = vault();
  const root = v.add({ label: 'root-scoped', secret: 's-root', project: ROOT });
  const dev = v.add({ label: 'dev-scoped', secret: 's-dev', project: DEV });
  return { v, root, dev };
}

test('an array of projects shows entries scoped to any of them', () => {
  const { v } = twoScoped();
  assert.deepStrictEqual(
    v.list({ project: [ROOT, DEV] }).map(e => e.label).sort(), ['dev-scoped', 'root-scoped']);
});

test('an array that matches neither scope sees neither entry', () => {
  const { v } = twoScoped();
  assert.deepStrictEqual(v.list({ project: [OTHER_ROOT, OTHER_DEV] }), []);
});

test('a string project still works exactly as before', () => {
  const { v } = twoScoped();
  assert.deepStrictEqual(v.list({ project: DEV }).map(e => e.label), ['dev-scoped']);
  assert.deepStrictEqual(v.list({ project: ROOT }).map(e => e.label), ['root-scoped']);
});

test('get honours an array of projects', () => {
  const { v, root, dev } = twoScoped();
  const id = (x) => (typeof x === 'string' ? x : x.id);
  assert.strictEqual(v.get(id(root), { project: [ROOT, DEV] }), 's-root');
  assert.strictEqual(v.get(id(dev), { project: [ROOT, DEV] }), 's-dev');
  assert.strictEqual(v.get(id(root), { project: [OTHER_ROOT, OTHER_DEV] }), null);
  assert.strictEqual(v.get(id(dev), { project: [OTHER_ROOT] }), null);
});

test('remove honours an array of projects', () => {
  const { v, root, dev } = twoScoped();
  const id = (x) => (typeof x === 'string' ? x : x.id);
  assert.strictEqual(v.remove(id(root), { project: [OTHER_ROOT, OTHER_DEV] }), false);
  assert.strictEqual(v.remove(id(root), { project: [ROOT, DEV] }), true);
  assert.strictEqual(v.remove(id(dev), { project: [ROOT, DEV] }), true);
  assert.deepStrictEqual(v.list({ project: [ROOT, DEV] }), []);
});

test('a shared entry is visible from an array, and unusable list members grant nothing', () => {
  const v = vault();
  v.add({ label: 'shared', secret: 's', shared: true });
  v.add({ label: 'scoped', secret: 's', project: ROOT });
  assert.deepStrictEqual(v.list({ project: [OTHER_ROOT, OTHER_DEV] }).map(e => e.label), ['shared']);
  assert.deepStrictEqual(v.list({ project: [null, undefined, '', 42] }).map(e => e.label), ['shared']);
  assert.deepStrictEqual(v.list({ project: [] }).map(e => e.label), ['shared']);
});

test('a non-array, non-string project still denies everything scoped', () => {
  const { v } = twoScoped();
  for (const p of [42, {}, true, null, undefined]) {
    assert.deepStrictEqual(v.list({ project: p }), [], `${JSON.stringify(p)} must see nothing scoped`);
  }
});

test('PROPERTY: root/dev scoped entries are visible from their own pair and never from another project', () => {
  const fc = require('fast-check');
  const seg = fc.stringMatching(/^[a-z0-9]{1,8}$/);
  fc.assert(fc.property(seg, seg, (p, q) => {
    fc.pre(p !== q);
    const P = { root: `C:/work/${p}`, dev: `C:/work/${p}/dev` };
    const Q = { root: `C:/work/${q}`, dev: `C:/work/${q}/dev` };
    const v = unboundVault({ file: tmp(), crypto: fakeCrypto() });
    v.add({ label: 'p-root', secret: 'x', project: P.root });
    v.add({ label: 'p-dev', secret: 'x', project: P.dev });
    v.add({ label: 'shared', secret: 'x', shared: true });
    const own = v.list({ project: [P.root, P.dev] }).map(e => e.label).sort();
    const other = v.list({ project: [Q.root, Q.dev] }).map(e => e.label).sort();
    assert.deepStrictEqual(own, ['p-dev', 'p-root', 'shared']);
    assert.deepStrictEqual(other, ['shared']);
  }), { numRuns: 60 });
});
