'use strict';
/**
 * FORMAT 2 -- items 4 and 5 of VAULT_HARDENING_FOLLOWUP.md.
 *
 * WHAT FORMAT 2 IS. Two changes to the on-disk shape, bundled under one
 * version number because they were found together and fix together:
 *
 *   ITEM 4 -- label and note are sealed, per entry, not per file. When the
 *   vault holds a key, `add` wraps `label` and `note` under it exactly like
 *   `secret` (same `wrap`/`unwrap`), and the entry carries a marker,
 *   `sealed: true`. With no key, they stay plain and `sealed` is absent.
 *   PER ENTRY rather than a file-level flag because `rewrapAll` is per-entry
 *   TOLERANT by design (Dexter F3): a corrupt entry is carried through
 *   UNCHANGED rather than aborting the whole rekey, so a vault can
 *   legitimately hold N sealed entries and one that stayed plain after a
 *   `setKey` that could not touch it. Only a per-entry marker can tell a
 *   reader which is which.
 *
 *   ITEM 5 -- `FORMAT` is 2, and any lock record that is PRESENT must carry
 *   `fp` once the file is on format 2. This is the more correct answer to
 *   G2 (test/secret-vault-lock-pass2.test.js): a lock record with no `fp` is
 *   ambiguous on its own -- a vault written before the checksum existed
 *   (format 1: fine, `unlock` migrates it), or one where the field was
 *   deleted (format 2: damaged, do not melt). Before this branch a missing
 *   `fp` always read as the first case, which is exactly how
 *   `delete j.lock.fp` reopened F1 in full on every vault already on disk.
 *
 * Fixture-construction note that cost real time while writing these: since
 * `persistLocked` now stamps `format: FORMAT` on EVERY write unconditionally,
 * any test that wants a genuine "vault written before format 2 existed"
 * fixture must write `format: 1` onto it BY HAND after the real vault calls
 * that produced it -- the same trap the two G2 tests in
 * test/secret-vault-lock-pass2.test.js and the SCRYPT-migration test in
 * test/secret-vault-lock-findings.test.js hit, and were fixed for, on this
 * branch.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { createVault } = require('../app/secret-vault');
const { createSecretService } = require('../app/secret-service');

const tmp = () => path.join(tmpDir('cc-fmt2-'), 'secrets.enc');

const fakeCrypto = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => {
    const raw = Buffer.from(b).toString('utf8');
    if (!raw.startsWith('ENC:')) throw new Error('not encrypted by this cipher');
    return Buffer.from(raw.slice(4), 'base64').toString('utf8');
  },
});

// Cheap derivation. The real cost is ~200ms per call by design; the real
// parameters are pinned by their own test in the sibling suite.
const FAST = { N: 1024, r: 8, p: 1, keylen: 32, maxmem: 32 * 1024 * 1024 };
const open = (file) => createVault({ file, crypto: fakeCrypto(), scrypt: FAST });
const KEY = 'correct horse battery staple';
const ANY = { project: 'C:/any' };

const readVault = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeVault = (f, j) => fs.writeFileSync(f, JSON.stringify(j));

// ---------------------------------------------------------------------------
// add(): sealed at creation, plaintext on the way out
// ---------------------------------------------------------------------------

test('add() WHILE A KEY IS HELD seals label and note, and returns them plaintext', () => {
  const file = tmp();
  const v = open(file);
  v.setKey(KEY);
  const e = v.add({ label: 'client-x prod db', secret: 's', note: 'renewal in March', shared: true });

  // Plaintext on the way out: the caller just typed this in. Checked as an
  // exact shape, not merely that the two fields happen to be right, so a
  // stray wrapped byte string hiding under an extra key would still be caught.
  assert.deepStrictEqual(Object.keys(e).sort(), ['createdAt', 'id', 'label', 'note']);
  assert.strictEqual(e.label, 'client-x prod db');
  assert.strictEqual(e.note, 'renewal in March');
  assert.strictEqual(typeof e.id, 'string');
  assert.strictEqual(typeof e.createdAt, 'number');

  const onDisk = readVault(file).entries.find(x => x.id === e.id);
  assert.strictEqual(onDisk.sealed, true);
  assert.notStrictEqual(onDisk.label, 'client-x prod db', 'the label on disk must not be plaintext');
  assert.notStrictEqual(onDisk.note, 'renewal in March', 'same for the note');

  // And unseals correctly for a caller that holds the key.
  const row = v.list(ANY)[0];
  assert.strictEqual(row.label, 'client-x prod db');
  assert.strictEqual(row.note, 'renewal in March');
  assert.strictEqual(row.unreadable, undefined);
});

test('add() WITH NO KEY HELD stores label and note plain, and carries no marker', () => {
  const file = tmp();
  const v = open(file);
  const e = v.add({ label: 'no key yet', secret: 's', shared: true });

  const onDisk = readVault(file).entries.find(x => x.id === e.id);
  assert.strictEqual('sealed' in onDisk, false);
  assert.strictEqual(onDisk.label, 'no key yet');
});

// ---------------------------------------------------------------------------
// rewrapAll (via setKey/removeKey): the corrupt state, and label recovery
// ---------------------------------------------------------------------------

test('CORRUPT STATE: sealed:true with no key ever held goes to failed, carried unchanged', () => {
  // `sealed: true` only exists because a key was held at write time. A hand
  // edit, a merged schema, or a torn migration can land the marker without
  // the key -- exactly the shape F3 already treats every other unreadable
  // entry as: reported, carried through, never silently dropped.
  const file = tmp();
  const v0 = open(file);
  const e = v0.add({ label: 'orphaned', secret: 'x', shared: true });   // unsealed: no key yet

  const j = readVault(file);
  j.entries.find(x => x.id === e.id).sealed = true;
  writeVault(file, j);

  const v = open(file);
  const res = v.setKey(KEY);   // sessionKey is `undefined` here -> rewrapAll's `from` is null
  assert.strictEqual(res.ok, true, 'setKey must still succeed for the vault as a whole');
  assert.strictEqual(res.failed.length, 1);
  assert.strictEqual(res.failed[0].id, e.id);
  assert.strictEqual(res.failed[0].label, e.id,
    'a sealed entry with no key to unseal it cannot recover a label, so it falls back to the id');
  assert.match(res.failed[0].why, /no key was supplied/i);

  // Carried UNCHANGED: still there, still marked sealed, plaintext label
  // untouched -- exactly as bad as it was, not worse.
  const onDisk = readVault(file).entries.find(x => x.id === e.id);
  assert.strictEqual(onDisk.sealed, true);
  assert.strictEqual(onDisk.label, 'orphaned');
});

test('a corrupted SECRET with an intact label reports the plaintext label in `failed`', () => {
  // The other half of the recovery rule: `failed[].label` is the plaintext
  // name whenever it CAN be had, even when the reason for failure is the
  // secret rather than the label itself.
  const file = tmp();
  const v0 = open(file);
  const good = v0.add({ label: 'good', secret: 'sensitive', shared: true });
  const bad = v0.add({ label: 'broken', secret: 'other', shared: true });
  v0.setKey(KEY);

  const j = readVault(file);
  const target = j.entries.find(e => e.id === bad.id);
  target.secret = target.secret.slice(0, -8);          // a torn write, secret only
  writeVault(file, j);

  const v = open(file);
  assert.strictEqual(v.unlock(KEY).ok, true);
  const res = v.setKey('a new key');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.failed.length, 1);
  assert.strictEqual(res.failed[0].label, 'broken', 'the label unwraps fine, so it is reported, not the id');

  const reopened = open(file);
  assert.strictEqual(reopened.unlock('a new key').ok, true);
  assert.strictEqual(reopened.get(good.id, ANY), 'sensitive', 'the good secret survived the rekey');
});

// ---------------------------------------------------------------------------
// list(): unseals for a caller with the key; one unreadable label survives
// alongside the rest
// ---------------------------------------------------------------------------

test('list() marks an unreadable sealed label without losing the rest', () => {
  const file = tmp();
  const v0 = open(file);
  const good = v0.add({ label: 'good-one', secret: 'sensitive', shared: true });
  const bad = v0.add({ label: 'will-be-garbage', secret: 'other', shared: true });
  v0.setKey(KEY);

  const j = readVault(file);
  // Too short to decode into a wrapped value once base64'd -- deliberate, so
  // `unwrap` throws rather than silently returning garbage bytes.
  j.entries.find(e => e.id === bad.id).label = 'x';
  writeVault(file, j);

  const v = open(file);
  assert.strictEqual(v.unlock(KEY).ok, true);
  const rows = v.list(ANY);
  const goodRow = rows.find(r => r.id === good.id);
  const badRow = rows.find(r => r.id === bad.id);

  assert.strictEqual(goodRow.label, 'good-one', 'the healthy entry must be unaffected');
  assert.strictEqual(goodRow.unreadable, undefined);
  assert.strictEqual(badRow.unreadable, true);
  assert.match(badRow.label, new RegExp(`unreadable entry ${bad.id.slice(0, 8)}`));

  // remove(id) stays reachable from the panel -- F3's "there is a way out
  // that does not cost the other secrets", applied to the inventory.
  assert.strictEqual(v.remove(bad.id, ANY), true);
  assert.strictEqual(v.list(ANY).length, 1);
  assert.strictEqual(v.get(good.id, ANY), 'sensitive');
});

test('deleting the `lock` field no longer leaks a sealed inventory -- it makes it unreadable instead', () => {
  // The other half of Miguel's original finding, closed as a side effect
  // rather than a separate fix (see validLockRecord's header comment).
  const file = tmp();
  const v0 = open(file);
  const e = v0.add({ label: 'client-x prod db', secret: 'sensitive', shared: true });
  v0.setKey(KEY);

  const j = readVault(file);
  delete j.lock;
  writeVault(file, j);

  const v = open(file);
  assert.strictEqual(v.lockState().hasKey, false, 'deleting `lock` still reopens the vault as keyless');
  const row = v.list(ANY)[0];
  assert.strictEqual(row.unreadable, true, 'but the previously-sealed label must not come back as plaintext');
  assert.notStrictEqual(row.label, 'client-x prod db');
  assert.strictEqual(v.remove(e.id, ANY), true, 'and it must still be possible to clean it up');
});

// ---------------------------------------------------------------------------
// Half-migrated files: both shapes the brief names
// ---------------------------------------------------------------------------

test('HALF-MIGRATED (a): one sealed entry and one plain entry both list correctly, and setKey re-seals both', () => {
  const file = tmp();
  const v0 = open(file);
  const sealedOne = v0.add({ label: 'sealed-one', secret: 's1', note: 'kept', shared: true });
  v0.setKey(KEY);
  const other = v0.add({ label: 'to-be-plain', secret: 's2', shared: true });   // sealed at creation

  // Revert `other` to look exactly like what F3's carry-through produces: a
  // format-2 file where one entry never got sealed.
  const j = readVault(file);
  const target = j.entries.find(e => e.id === other.id);
  delete target.sealed;
  target.label = 'to-be-plain';
  target.note = '';
  writeVault(file, j);

  const v = open(file);
  assert.strictEqual(v.unlock(KEY).ok, true);
  const rows = v.list(ANY);
  assert.strictEqual(rows.find(r => r.id === sealedOne.id).label, 'sealed-one');
  assert.strictEqual(rows.find(r => r.id === sealedOne.id).note, 'kept');
  assert.strictEqual(rows.find(r => r.id === other.id).label, 'to-be-plain');
  assert.strictEqual(rows.find(r => r.id === other.id).unreadable, undefined);

  const res = v.setKey('a new key');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.failed.length, 0, 'both entries must survive the reseal');
  assert.ok(readVault(file).entries.every(e => e.sealed === true),
    'setKey must re-seal both, including the one that was plain');

  const reopened = open(file);
  assert.strictEqual(reopened.unlock('a new key').ok, true);
  assert.deepStrictEqual(reopened.list(ANY).map(r => r.label).sort(), ['sealed-one', 'to-be-plain']);
});

test('HALF-MIGRATED (b): a sealed entry with garbage label lists as unreadable; the other and get()/remove() are unaffected', () => {
  const file = tmp();
  const v0 = open(file);
  const good = v0.add({ label: 'fine', secret: 'sensitive', shared: true });
  const bad = v0.add({ label: 'will-be-garbage', secret: 'other', shared: true });
  v0.setKey(KEY);

  const j = readVault(file);
  j.entries.find(e => e.id === bad.id).label = 'x';   // sealed:true stays, content is not actually wrapped
  writeVault(file, j);

  const v = open(file);
  assert.strictEqual(v.unlock(KEY).ok, true);
  const rows = v.list(ANY);
  assert.strictEqual(rows.find(r => r.id === good.id).label, 'fine');
  assert.strictEqual(rows.find(r => r.id === bad.id).unreadable, true);
  assert.strictEqual(v.get(good.id, ANY), 'sensitive');
  assert.strictEqual(v.remove(bad.id, ANY), true);
  assert.deepStrictEqual(v.list(ANY).map(r => r.id), [good.id]);
});

// ---------------------------------------------------------------------------
// Migration: locked FORMAT 1 vault
// ---------------------------------------------------------------------------

test('MIGRATION, locked FORMAT 1: the first successful unlock seals every entry and gains a checksum in one write', () => {
  const file = tmp();
  const v0 = open(file);
  const a = v0.add({ label: 'alpha', secret: 'sensitive-a', note: 'first', shared: true });
  const b = v0.add({ label: 'beta', secret: 'sensitive-b', shared: true });
  v0.setKey(KEY);   // real, working lock header -- then reverted below to look like FORMAT 1

  const j = readVault(file);
  for (const e of j.entries) delete e.sealed;
  j.entries.find(e => e.id === a.id).label = 'alpha';
  j.entries.find(e => e.id === a.id).note = 'first';
  j.entries.find(e => e.id === b.id).label = 'beta';
  j.entries.find(e => e.id === b.id).note = '';
  delete j.lock.fp;
  j.format = 1;
  writeVault(file, j);

  const v = open(file);
  assert.strictEqual(v.lockState().locked, true, 'precondition: locked, holding no key yet');
  assert.strictEqual(v.unlock(KEY).ok, true);

  const onDisk = readVault(file);
  assert.strictEqual(onDisk.format, 2, 'format bumped to 2');
  assert.ok(onDisk.lock.fp, 'checksum gained');
  assert.ok(onDisk.entries.every(e => e.sealed === true), 'every entry sealed');

  const rows = v.list(ANY).map(r => ({ label: r.label, note: r.note })).sort((x, y) => x.label.localeCompare(y.label));
  assert.deepStrictEqual(rows, [{ label: 'alpha', note: 'first' }, { label: 'beta', note: '' }]);

  // Reopen from disk and unlock again -- no further write.
  const gen1 = onDisk.gen;
  const reopened = open(file);
  assert.strictEqual(reopened.unlock(KEY).ok, true);
  assert.strictEqual(readVault(file).gen, gen1, 'no further write: the gen token must not move');
});

// ---------------------------------------------------------------------------
// Migration: keyless FORMAT 1 vault
// ---------------------------------------------------------------------------

test('MIGRATION, keyless FORMAT 1: nothing to seal; stamped FORMAT 2 on its NEXT write, not at construct', () => {
  const file = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const enc = (s) => fakeCrypto().encryptString(s).toString('base64');
  fs.writeFileSync(file, JSON.stringify({
    format: 1,
    entries: [{ id: 'legacy-id', label: 'legacy', secret: enc('old'), createdAt: 1 }],
  }));

  // `createVault` MUST stay read-only. Spy on the actual write call so this
  // is a measurement, not an assumption.
  const originalWrite = fs.writeFileSync;
  let wroteAtConstruct = false;
  fs.writeFileSync = (...args) => { wroteAtConstruct = true; return originalWrite.apply(fs, args); };
  let v;
  try {
    v = open(file);
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.strictEqual(wroteAtConstruct, false, 'construct must not write');
  assert.strictEqual(readVault(file).format, 1, 'the file on disk is untouched, still format 1');

  assert.strictEqual(v.get('legacy-id', ANY), 'old', 'read paths still work on the unmigrated file');

  const e = v.add({ label: 'fresh', secret: 'new', shared: true });   // the next write
  assert.strictEqual(readVault(file).format, 2, 'the write stamps the current format');
  assert.strictEqual(v.get(e.id, ANY), 'new');
});

// ---------------------------------------------------------------------------
// G2 split: format decides whether a missing checksum is legacy or damage
// ---------------------------------------------------------------------------

test('G2 split: FORMAT 2 with no checksum is DAMAGE, not a legacy read', () => {
  // The counterpart to test/secret-vault-lock-pass2.test.js's G2 tests, which
  // cover the FORMAT 1 (legacy, opens and migrates) side. This is the other
  // half item 5 adds: the exact same missing field means something different
  // once `format` says 2.
  const file = tmp();
  const v0 = open(file);
  v0.add({ label: 'k', secret: 'sensitive', shared: true });
  v0.setKey(KEY);   // real lock + format:2, stamped by persistLocked

  const j = readVault(file);
  delete j.lock.fp;   // format is ALREADY 2 -- unlike the sibling legacy tests, left alone
  writeVault(file, j);
  assert.strictEqual(readVault(file).format, 2, 'precondition: this really is format 2');

  const v = open(file);
  const st = v.lockState();
  assert.ok(st.damaged, 'a format-2 vault missing its checksum is damaged, not legacy');

  const res = v.unlock(KEY);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.damaged, true);
  assert.match(res.error, /checksum/i, 'the message must name what is missing');

  // And the file is never written.
  const before = fs.readFileSync(file, 'utf8');
  v.unlock(KEY);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

// ---------------------------------------------------------------------------
// FORMAT stamped wherever the brief names it
// ---------------------------------------------------------------------------

test('melt\'s rebuilt vault and a brand-new vault both stamp the current FORMAT', () => {
  const file = tmp();
  const v0 = open(file);
  v0.add({ label: 'k', secret: 's', shared: true });
  v0.setKey(KEY);
  open(file).melt();
  assert.strictEqual(readVault(file).format, 2, "melt's rebuilt vault must be on the current format");

  const fresh = tmp();
  const fv = open(fresh);
  fv.add({ label: 'first', secret: 's', shared: true });
  assert.strictEqual(readVault(fresh).format, 2, 'a brand-new vault stamps the current format on its first write');
});

// ---------------------------------------------------------------------------
// Round-trip property: label, note and secret survive null -> k1 -> k2 -> null
// ---------------------------------------------------------------------------

// A seeded PRNG rather than `fast-check` (not a devDependency in this repo --
// checked before writing this file). Deterministic so a failure is
// reproducible without recording a seed by hand.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Spans plain ASCII, Latin-1 supplement and a CJK block, so this is not an
// ASCII round-trip wearing a costume -- UTF-8/UTF-16 boundary bugs live at
// exactly these edges.
function randomUnicodeString(rand, maxLen) {
  const len = Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < len; i++) {
    const bucket = rand();
    let code;
    if (bucket < 0.5) code = 0x20 + Math.floor(rand() * (0x7e - 0x20));
    else if (bucket < 0.8) code = 0xa0 + Math.floor(rand() * (0x24f - 0xa0));
    else code = 0x4e00 + Math.floor(rand() * (0x9fff - 0x4e00));
    s += String.fromCodePoint(code);
  }
  return s;
}

test('ROUND-TRIP PROPERTY: label, note and secret survive null -> k1 -> k2 -> null across 200 generated entries', () => {
  const rand = mulberry32(0xC0FFEE);
  const N = 200;
  const originals = [];
  const file = tmp();
  const v = open(file);

  for (let i = 0; i < N; i++) {
    // add() refuses an empty label or secret; note MAY be empty, deliberately
    // (the brief calls this out by name). Pre-trimmed here, matching add()'s
    // own normalisation (secret-vault.test.js: "notes are normalised: ...
    // padded is trimmed") -- add() trims label/note itself, so a generated
    // string with leading/trailing whitespace would round-trip to something
    // shorter than what this test recorded as the original. Trimming before
    // the call makes add()'s trim idempotent, so `originals` and what comes
    // back agree by construction. `secret` is NOT trimmed by add(), and is
    // deliberately left untouched here to prove that.
    const label = randomUnicodeString(rand, 24).trim() || `entry-${i}`;
    const note = randomUnicodeString(rand, 24).trim();
    const secret = randomUnicodeString(rand, 40) || `s${i}`;
    const e = v.add({ label, note, secret, shared: true });
    originals.push({ id: e.id, label, note, secret });
  }

  v.setKey('key one');   // rewrapAll(null, k1)
  v.setKey('key two');   // rewrapAll(k1, k2)

  // (null -> k) followed by list() under k equals the input labels/notes.
  const afterK2 = v.list(ANY);
  assert.strictEqual(afterK2.length, N);
  for (const o of originals) {
    const row = afterK2.find(r => r.id === o.id);
    assert.ok(row, `entry ${o.id} missing from list()`);
    assert.strictEqual(row.unreadable, undefined, `entry ${o.id} must not be unreadable`);
    assert.strictEqual(row.label, o.label);
    assert.strictEqual(row.note, o.note);
    assert.strictEqual(v.get(o.id, ANY), o.secret);
  }

  v.removeKey();   // rewrapAll(k2, null)

  const onDisk = readVault(file);
  assert.strictEqual(onDisk.entries.length, N);
  assert.ok(onDisk.entries.every(e => !('sealed' in e)), 'no entry may carry the marker once the key is gone');

  const afterRemove = v.list(ANY);
  for (const o of originals) {
    const row = afterRemove.find(r => r.id === o.id);
    assert.strictEqual(row.label, o.label);
    assert.strictEqual(row.note, o.note);
    assert.strictEqual(v.get(o.id, ANY), o.secret);
  }
});

// ---------------------------------------------------------------------------
// Consumer tolerance: list()'s extra field must not break its callers
// ---------------------------------------------------------------------------

test('CONSUMER TOLERANCE: secret-service.list() does not choke on an unreadable entry', () => {
  const file = tmp();
  const v = open(file);
  const good = v.add({ label: 'good-one', secret: 'sensitive', project: 'C:/proj' });
  const bad = v.add({ label: 'will-be-garbage', secret: 'other', project: 'C:/proj' });
  v.setKey(KEY);

  const j = readVault(file);
  j.entries.find(e => e.id === bad.id).label = 'x';
  writeVault(file, j);

  const reopened = open(file);
  reopened.unlock(KEY);
  const service = createSecretService({
    vault: reopened,
    clipboard: { writeText() {}, readText() { return ''; }, clear() {} },
    project: 'C:/proj',
  });

  const rows = service.list({});
  assert.strictEqual(rows.length, 2);
  const badRow = rows.find(r => r.id === bad.id);
  assert.strictEqual(badRow.unreadable, true);

  // Searching by label must not throw on the unreadable placeholder, and
  // must still find the readable one.
  assert.doesNotThrow(() => service.list({ query: 'good' }));
  assert.deepStrictEqual(service.list({ query: 'good' }).map(r => r.id), [good.id]);

  // app/renderer.js was checked by hand (grep) for this branch: the secrets
  // panel reads only `e.id`, `e.label` and `e.shared` off each row (see the
  // `.map(e => ...)` around the `#vault-list` render), so the extra
  // `unreadable` field this branch adds is simply ignored there -- an absent
  // field, never a `false` one, being what "nothing changed here" has always
  // looked like on this object (see list()'s own comment).
});

// ---------------------------------------------------------------------------
// Sealing x multi-path projects (develop e73a663, landed after this branch)
// ---------------------------------------------------------------------------

test('a SEALED entry is visible from a list of paths and unseals there; scope itself stays plain', () => {
  // `visibleFrom` reads `entry.project`, which item 4 deliberately does NOT
  // seal -- so a window that passes [dev, container] still finds an entry
  // scoped to the container root, and only THEN unwraps its label and note.
  // Written on the rebase onto develop, where the two features first met.
  const ROOT = 'C:/work/proj', DEV = 'C:/work/proj/dev', OTHER = 'C:/work/other';
  const file = tmp();
  const v0 = open(file);
  v0.setKey(KEY);
  const e = v0.add({ label: 'root-scoped', secret: 's-root', note: 'old layout', project: ROOT });

  const onDisk = readVault(file).entries.find(x => x.id === e.id);
  assert.strictEqual(onDisk.sealed, true);
  assert.notStrictEqual(onDisk.label, 'root-scoped', 'the label must be sealed on disk');
  // Stored normalised (lower-cased drive), but readable -- not a wrapped blob.
  assert.strictEqual(onDisk.project, ROOT.toLowerCase(), 'the scope must stay plain, or visibility cannot read it');

  const v = open(file);
  assert.strictEqual(v.unlock(KEY).ok, true);
  const rows = v.list({ project: [DEV, ROOT] });
  assert.deepStrictEqual(rows.map(r => [r.label, r.note, r.unreadable]), [['root-scoped', 'old layout', undefined]]);
  assert.strictEqual(v.get(e.id, { project: [DEV, ROOT] }), 's-root');
  assert.deepStrictEqual(v.list({ project: [OTHER, DEV] }), []);
});
