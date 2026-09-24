'use strict';
/**
 * Dexter's third and fourth falsification passes. I1, H3, H4, H5.
 *
 * Every one of these is a defect in a FIX rather than in the original feature,
 * and I1 is a defect in the fix for H1, which was itself a defect in the fix for
 * G3. That chain is the point: each round's fixes are the next round's richest
 * target, and the damaged path is the newest surface on this branch.
 *
 * I1 is the one that mattered. It made a damaged vault unusable AGAIN -- zero
 * working actions -- which is exactly the harm G3 was raised to fix, arriving
 * one layer up.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVault } = require('../app/secret-vault');
const { vaultLockDisplay } = require('../app/vault-lock-display');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-p3-')), 'secrets.enc');

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
const open = (file) => createVault({ file, crypto: fakeCrypto(), scrypt: FAST, lockDeadlineMs: 120 });
const KEY = 'correct horse battery staple';
const ANY = { project: 'C:/any' };

function damagedVault() {
  const file = tmp();
  const v = open(file);
  v.add({ label: 'client-x prod db', secret: 'sensitive', shared: true });
  v.setKey(KEY);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const healthy = JSON.parse(JSON.stringify(j));
  j.lock.scrypt = { ...j.lock.scrypt, keylen: 16 };
  fs.writeFileSync(file, JSON.stringify(j));
  return { file, healthy };
}

// ---------------------------------------------------------------------------
// I1 -- the confirmation collapse, as a RULE over every state
// ---------------------------------------------------------------------------

test('I1: arming a confirmation NEVER changes the stamp, for any state', () => {
  // Dexter's instruction, and the reason is that a sixth state will reappear
  // here. The renderer resets an armed melt confirmation when the drawn state
  // changes (F8), so if arming a confirmation LOOKS like a state change, the
  // reset disarms it in the same tick and the button appears to do nothing.
  //
  // That is exactly what H1's fifth state did: `'confirm-melt-damaged'` stamped
  // as itself, so a damaged vault could never reach its confirmation and had NO
  // WORKING ACTION AT ALL -- the harm G3 exists to prevent, one layer up.
  //
  // Asserted as a rule over every reachable state rather than by restating the
  // pairs, because restating the pairs is what broke.
  const inputs = [
    { hasKey: false, locked: false, count: 0 },
    { hasKey: true, locked: false, count: 3 },
    { hasKey: true, locked: true, count: 3 },
    { hasKey: false, locked: true, count: 0 },
    { hasKey: true, locked: true, damaged: 'lock record is malformed', count: null },
  ];
  const seen = new Set();
  for (const st of inputs) {
    const off = vaultLockDisplay(st, { confirmingMelt: false });
    const on = vaultLockDisplay(st, { confirmingMelt: true });
    seen.add(off.stamp);
    assert.ok(off.stamp, `every state must carry a stamp: ${JSON.stringify(st)}`);
    assert.strictEqual(on.stamp, off.stamp,
      `arming melt changed the stamp for ${JSON.stringify(st)} -- the F8 reset will `
      + 'disarm it in the same tick and the button will do nothing');
  }
  // And the stamps must still DISTINGUISH the settled states, or the reset stops
  // firing when it should.
  assert.strictEqual(seen.size, 4,
    'the four settled states must have four distinct stamps');
});

test('I1: the renderer takes the stamp FROM the display, not from its own list', () => {
  // The coupling is what broke: the renderer knew the display's state vocabulary
  // and was not updated when the vocabulary grew. Source-asserted because
  // renderer.js needs a real DOM.
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
  assert.match(renderer, /const stamp = d\.stamp/,
    'the renderer must read the stamp the display computed');
  assert.doesNotMatch(renderer, /d\.state === 'confirm-melt' \?/,
    'and must not re-derive it from a hardcoded state name');
});

test('I1: a damaged vault can actually reach its melt confirmation', () => {
  // The case test, after the rule. This is the sequence a user performs: open a
  // damaged vault, click the one button, and arrive somewhere that offers to act.
  const { file } = damagedVault();
  const st = open(file).lockState();

  const first = vaultLockDisplay(st, { confirmingMelt: false });
  assert.strictEqual(first.state, 'damaged');

  const armed = vaultLockDisplay(st, { confirmingMelt: true });
  assert.strictEqual(armed.state, 'confirm-melt-damaged');
  assert.strictEqual(armed.stamp, first.stamp,
    'the stamp must not move, or the reset cancels the click that armed it');
  assert.strictEqual(armed.canMelt, true);
});

// ---------------------------------------------------------------------------
// H3 -- a repaired file must be noticed
// ---------------------------------------------------------------------------

test('H3: a damaged vault SELF-HEALS when the file is repaired', () => {
  // Every vault written before the `gen` field has none, and a damaged load
  // produces none either -- so `refreshIfMoved` compared `undefined` to
  // `undefined` and took its early return, forever. A user who reads the damage
  // message, opens secrets.enc and repairs the lock record by hand -- which is
  // exactly what that message steers them toward -- would see the panel report
  // damaged for the rest of the window's life, with melt still the only offer.
  const { file, healthy } = damagedVault();

  const v = open(file);
  assert.ok(v.lockState().damaged, 'precondition: reports damaged');

  // The user repairs it by hand, the way the message suggests.
  fs.writeFileSync(file, JSON.stringify(healthy));

  const after = v.lockState();               // SAME handle, no restart
  assert.strictEqual(after.damaged, undefined,
    'the same window must notice the repair -- that is the whole point of refreshing');
  assert.strictEqual(after.hasKey, true);
  assert.strictEqual(after.locked, true, 'and be locked, since this window has no key');
  assert.strictEqual(v.unlock(KEY).ok, true, 'and the real key must now work');
});

test('H3: a pre-gen vault with no damage is not re-read into confusion', () => {
  // The fix hands a damaged load a Symbol so it always mismatches. That must not
  // bleed into the healthy pre-`gen` case, where `undefined === undefined` is the
  // correct answer and means "nothing changed".
  const file = tmp();
  const v = open(file);
  const e = v.add({ label: 'k', secret: 'sensitive', shared: true });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete j.gen;                              // what every pre-facd4ee vault is
  fs.writeFileSync(file, JSON.stringify(j));

  const reopened = open(file);
  assert.strictEqual(reopened.get(e.id, ANY), 'sensitive');
  assert.strictEqual(reopened.lockState().count, 1);
  reopened.add({ label: 'second', secret: 'v2', shared: true });
  assert.strictEqual(reopened.list(ANY).length, 2, 'and writes still work');
});

// ---------------------------------------------------------------------------
// H4 -- damaged implies locked, structurally
// ---------------------------------------------------------------------------

test('H4: a damaged vault is locked BY RULE, not because its entries happen to be empty', () => {
  // Dexter was explicit that he could not turn this into a leak: `list`/`get`
  // passed the `isLocked()` check and then read `state.entries`, which a damaged
  // load sets to `[]` -- so they returned nothing BY LUCK. "Damaged implies
  // locked" was a property of five separate call sites, and the sixth one added
  // would not know to check.
  //
  // THE ONLY WAY TO TELL THE RULE FROM THE COINCIDENCE, which is his recommended
  // test: give the damaged state non-empty entries. A vault whose file parses,
  // whose entries are readable, and whose LOCK RECORD is malformed is exactly
  // that -- the entries are right there in `parsed.entries`.
  const { file } = damagedVault();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.entries.length > 0,
    'precondition: the file really does carry entries the damaged load discards');

  const v = open(file);
  assert.strictEqual(v.lockState().locked, true);
  assert.deepStrictEqual(v.list(ANY), [], 'no labels');
  assert.strictEqual(v.get(parsed.entries[0].id, ANY), null, 'no values');
  // And the write guards agree with the read ones.
  assert.throws(() => v.add({ label: 'x', secret: 'y', shared: true }), /damaged/i);
  assert.throws(() => v.setKey('anything'), /damaged/i);
  assert.throws(() => v.removeKey(), /damaged/i);
});

// ---------------------------------------------------------------------------
// H5 -- the sweep must not race another window's temp
// ---------------------------------------------------------------------------

test('H5: melt still reports leftovers correctly with the sweep inside the lock', () => {
  // The race itself is not deterministically testable, which Dexter said plainly,
  // so the honest test is that moving the sweep under the lock did not break what
  // it does. The interaction disappears rather than being documented: an unlocked
  // sweep could unlink a concurrent window's temp between its `writeFileSync` and
  // its `renameWithRetry`, and the victim got `ENOENT: rename` -- which
  // host/atomic-write.js documents as "a caller bug", steering the next reader
  // into the wrong file.
  const file = tmp();
  const dir = path.dirname(file);
  const v0 = open(file);
  v0.add({ label: 'k', secret: 'PLAINTEXT-MARKER', shared: true });
  v0.setKey(KEY);

  // An abandoned temp of the shape persist leaves behind.
  fs.copyFileSync(file, path.join(dir, '.secrets-9999-1700000000000.tmp'));

  const res = open(file).melt();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.leftovers, []);
  for (const name of fs.readdirSync(dir)) {
    assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes('PLAINTEXT-MARKER'),
      `${name} survived a melt that promised nothing would`);
  }
  assert.strictEqual(fs.existsSync(`${file}.lock`), false, 'and the lock is released');
});

test('H5: an undeletable leftover is still reported from inside the lock', () => {
  const file = tmp();
  const dir = path.dirname(file);
  const v0 = open(file);
  v0.add({ label: 'k', secret: 's', shared: true });
  v0.setKey(KEY);
  fs.mkdirSync(path.join(dir, '.secrets-1-1.tmp'));

  const res = open(file).melt();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.leftovers.length, 1);
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
});

// ---------------------------------------------------------------------------
// J1 -- the sweep must never make a successful melt look like a failure
// ---------------------------------------------------------------------------

// J1's SOURCE assertion lives in test/source-contracts.test.js, not here.
//
// Mortimer, PR #42 run 2: it read `app/secret-vault.js` as text and asserted on
// its CODE SHAPE -- and Stryker's instrumentation rewrites that text, so the
// assertion was red on the UNMUTATED BASELINE inside the sandbox and ABORTED THE
// WHOLE DRY RUN. 574 of 575 passing, one failure, no mutation number at all.
//
// That is this project's documented worst failure mode: the gate does not fail
// loudly, it simply never produces a number, and a branch can reach merge with
// item 3 nominally satisfied and actually unmeasured. Caused by a test I wrote to
// close J1.
//
// Any assertion about a mutated module's SOURCE TEXT belongs behind the
// repo-scanning exemption, for the same reason the shared-scope allow-list does:
// its subject is the repository, not a function, so it kills no mutant and cannot
// survive instrumentation of the thing it reads.

test('J1: melt still reports genuine leftovers, and still reports preserved', () => {
  // The regression half: the try/catch must not swallow the normal path. Both
  // fields have to survive, because `preserved` is how a damaged vault's owner
  // learns where their possibly-recoverable file went.
  const { file } = damagedVault();
  const dir = path.dirname(file);
  fs.mkdirSync(path.join(dir, '.secrets-1-1.tmp'));      // an undeletable leftover

  const res = open(file).melt();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.leftovers.length, 1, 'a real leftover is still reported');
  assert.ok(res.preserved, 'and preserved survives alongside it');
  assert.ok(fs.existsSync(res.preserved));
});
