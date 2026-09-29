'use strict';
/**
 * The damaged path, end to end. Dexter, PR #42, H1 and H2.
 *
 * Both findings are defects my OWN G3 fix created. G3 made a damaged vault load
 * and report itself instead of taking the whole window down -- and then:
 *
 *   H1  `vaultLockDisplay` dropped the `damaged` field entirely, so the panel
 *       drew the ordinary locked state: a password field, an Open button, and
 *       "Forgot the key...". The user is invited to guess at a file where no
 *       password can work, and the only other button destroys it.
 *   H2  melt on a damaged vault overwrote the file -- the same file the app had
 *       just told the user "may still be recoverable", while refusing every
 *       other action with "melting is the only action that can proceed". The
 *       advice and the only available action contradicted each other.
 *
 * THE INPUT IS BUILT FROM THE VAULT, never by hand. That is Dexter's
 * instruction and the reason is H1 itself: the display test suite was full of
 * hand-built state objects, and not one of them had a `damaged` field, so
 * nothing noticed the field being dropped. A test that constructs its own input
 * cannot detect the producer growing a field the consumer ignores.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVault } = require('../app/secret-vault');
const { vaultLockDisplay } = require('../app/vault-lock-display');
const { tmpDir } = require('./tmp-dir');

const tmp = () => path.join(tmpDir('cc-dmg-'), 'secrets.enc');

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

// A vault whose entries are intact and whose LOCK HEADER is malformed -- the
// case where the data really is recoverable, which is what makes H2 sharp.
function damagedVault() {
  const file = tmp();
  const v = open(file);
  v.add({ label: 'client-x prod db', secret: 'PLAINTEXT-MARKER', shared: true });
  v.setKey(KEY);

  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The RECOVERABLE bytes, captured before we damage the header: the wrapped
  // ciphertext and the cleartext label. Note the secret VALUE never appears in
  // the file -- it is safeStorage-encrypted and then key-wrapped, which is the
  // point of the feature. My first version of these tests looked for the
  // plaintext marker and failed, correctly.
  const wrapped = j.entries[0].secret;
  j.lock.scrypt = { ...j.lock.scrypt, keylen: 16 };     // fails validLockRecord
  fs.writeFileSync(file, JSON.stringify(j));
  return { file, wrapped, label: 'client-x prod db' };
}

// ---------------------------------------------------------------------------
// H1 -- the panel must say the file is damaged, not invite a guess
// ---------------------------------------------------------------------------

test('H1: a damaged vault gets its OWN panel state, from the vault\'s own output', () => {
  const { file } = damagedVault();

  // THE LITERAL OBJECT THE PRODUCER EMITS. Not a hand-built approximation --
  // that is exactly how H1 hid.
  const st = open(file).lockState();
  assert.ok(st.damaged, 'precondition: the vault reports damage');

  const d = vaultLockDisplay(st);
  assert.strictEqual(d.state, 'damaged',
    'a damaged file is not merely "locked" -- no password can open it');
  assert.notStrictEqual(d.canUnlock, true,
    'offering a password field says a password would help, and it would not');
  assert.strictEqual(d.canMelt, true, 'and the way out must stay available');
  assert.strictEqual(d.showList, false);
  assert.match(d.note, /cannot be read/i);
  assert.match(d.note, /no password will open it/i,
    'the note must say WHY, or the user just tries harder');
});

test('H1: the damaged melt warning says the data may be RECOVERABLE', () => {
  // The ordinary locked warning says "there is no backup and no recovery", which
  // is true when the user knows the key exists and has lost it -- and false, and
  // harmful, on a file whose entries are intact.
  const { file } = damagedVault();
  const st = open(file).lockState();

  const plain = vaultLockDisplay(st);
  const asked = vaultLockDisplay(st, { confirmingMelt: true });
  assert.strictEqual(asked.state, 'confirm-melt-damaged',
    'the confirmation must be distinguishable from the ordinary one');
  assert.match(asked.meltWarning, /RECOVERABLE/,
    'the one case where melting destroys something retrievable must say so');
  assert.match(asked.meltWarning, /aside/i, 'and must say the file is kept, not deleted');
  assert.doesNotMatch(asked.meltWarning, /no backup and no recovery/,
    'the ordinary wording is false here');

  // And no invented count: the file could not be parsed, so there is no number.
  assert.strictEqual(st.count, null);
  assert.doesNotMatch(plain.meltWarning || '', /All 0 secrets/,
    'absence must never render as zero -- this project\'s signature defect');
});

test('H1: an UNDAMAGED locked vault keeps the original wording', () => {
  // The fifth state must not swallow the fourth. A warning that always says
  // "may be recoverable" would make the honest no-recovery case a lie.
  const file = tmp();
  const v = open(file);
  v.add({ label: 'k', secret: 's', shared: true });
  v.setKey(KEY);

  const st = open(file).lockState();
  assert.strictEqual(st.damaged, undefined, 'precondition: not damaged');
  const d = vaultLockDisplay(st, { confirmingMelt: true });
  assert.strictEqual(d.state, 'confirm-melt');
  assert.match(d.meltWarning, /no backup and no recovery/);
  assert.doesNotMatch(d.meltWarning, /RECOVERABLE/);
});

// ---------------------------------------------------------------------------
// H2 -- melt must move a damaged file aside, not destroy it
// ---------------------------------------------------------------------------

test('H2: melting a DAMAGED vault moves the file aside and names where it went', () => {
  const { file, wrapped, label } = damagedVault();
  const dir = path.dirname(file);

  const res = open(file).melt();
  assert.strictEqual(res.ok, true);
  assert.ok(res.preserved, 'melt must report where the damaged file went');
  assert.match(res.preserved, /\.damaged-\d+$/);

  // The vault itself is a working empty one.
  assert.deepStrictEqual(open(file).lockState(), { hasKey: false, locked: false, count: 0 });
  const fresh = open(file);
  const e = fresh.add({ label: 'new', secret: 'v', shared: true });
  assert.strictEqual(fresh.get(e.id, ANY), 'v');

  // AND THE POSSIBLY-RECOVERABLE BYTES SURVIVE, at the path we named.
  assert.ok(fs.existsSync(res.preserved), 'the preserved file must exist');
  const kept = fs.readFileSync(res.preserved, 'utf8');
  assert.ok(kept.includes(wrapped),
    'the WRAPPED CIPHERTEXT must survive -- that is the recoverable part, and '
    + 'the thing the app told the user it might still have');
  assert.ok(kept.includes(label), 'and the label with it, so they can tell what it was');

  // And the sweep cannot eat it: it anchors on the temp prefix/suffix, which
  // this name matches neither of. Asserted rather than assumed, because these
  // two behaviours are one directory apart.
  assert.ok(fs.readdirSync(dir).some(n => n.endsWith(path.basename(res.preserved))));
});

test('H2: melting an UNDAMAGED vault still destroys everything -- F2 is not regressed', () => {
  // The two behaviours are deliberately opposite, so they are pinned opposite.
  // F2's premise is a vault the user COULD read and CHOSE to destroy: leaving a
  // copy there makes "no backup and no recovery" a lie. The damaged premise is
  // that the user was told the data may survive and given no alternative.
  const file = tmp();
  const dir = path.dirname(file);
  const v = open(file);
  v.add({ label: 'k', secret: 'DESTROY-ME', shared: true });
  v.setKey(KEY);

  const locked = open(file);
  assert.strictEqual(locked.lockState().locked, true);
  const res = locked.melt();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.preserved, null, 'nothing is preserved for a readable vault');

  for (const name of fs.readdirSync(dir)) {
    assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes('DESTROY-ME'),
      `${name} still holds the secret after an ordinary melt`);
  }
});

test('H2: if the damaged file cannot be moved, it is LEFT ALONE rather than overwritten', () => {
  // The failure path matters more than the happy one here: the whole finding is
  // that we must not destroy data we called recoverable. If we cannot preserve
  // it, the honest answer is to refuse and say so -- not to proceed and destroy.
  const { file, wrapped } = damagedVault();

  // Make the rename fail by occupying every name it would choose. `Date.now()`
  // is the only variable part, so a directory at that exact path blocks it.
  const v = open(file);
  const realNow = Date.now;
  const frozen = realNow.call(Date);
  Date.now = () => frozen;
  fs.mkdirSync(`${file}.damaged-${frozen}`);
  // A directory with content cannot be replaced by a rename on Windows or POSIX.
  fs.writeFileSync(path.join(`${file}.damaged-${frozen}`, 'occupied'), 'x');

  try {
    const res = v.melt();
    assert.strictEqual(res.ok, false, 'melt must refuse rather than destroy');
    assert.match(res.error, /left untouched/i);
    assert.ok(fs.readFileSync(file, 'utf8').includes(wrapped),
      'THE PROPERTY: the possibly-recoverable ciphertext is still in place');
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// The wiring, so the fifth state is actually reachable in the product
// ---------------------------------------------------------------------------

test('the damaged state reaches the renderer, and draws no password field', () => {
  // H1's defect was one layer dropping a field. Source-asserted because
  // renderer.js needs a real DOM, and pinned by NAME so a rename cannot make the
  // panel silently unreachable -- this repo's recurring failure.
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');

  const at = renderer.indexOf("d.state === 'damaged'");
  assert.ok(at > 0, 'renderer.js must draw the damaged state');

  const panel = renderer.slice(at, renderer.indexOf("d.state === 'locked'", at));
  assert.ok(!panel.includes('type="password"'),
    'the damaged panel must NOT offer a password field -- that is the whole finding');
  assert.ok(panel.includes('melt-ask') || panel.includes('melt-confirm'),
    'and must still offer the way out');

  assert.ok(renderer.includes('res.preserved'),
    'the renderer must tell the user where the preserved file went');
});

// ---------------------------------------------------------------------------
// The invariant itself, rather than one example of it
// ---------------------------------------------------------------------------

test('createVault CONSTRUCTS for any bytes on disk, and says healthy or damaged', () => {
  // Miguel, PR #40 re-read, the residual he called gate item 5 -- and he is right
  // that this was asserted BY EXAMPLE, for the single input 'this is not json'.
  //
  // The invariant moved when G3 moved it: `app/main.js` still does not wrap
  // `createVault`, so the guarantee that a window always opens now lives inside
  // `load()`. That makes "constructs for any bytes" a RULE the launch path
  // depends on, and `load()` has several places it can throw from. Dexter's
  // `delete j.lock.fp` was one more shape; there will be others.
  //
  // The UTF-8 BOM is his suggestion and the sharpest of them: it is the same
  // character class as the control-character guard in renderer-scope.test.js, on
  // the other side of the boundary -- source there, DATA here.
  const BOM = String.fromCharCode(0xfeff);
  const shapes = [
    ['empty file', ''],
    ['whitespace only', '   \n\t '],
    ['not JSON', 'this is not json'],
    ['JSON null', 'null'],
    ['JSON true', 'true'],
    ['JSON number', '42'],
    ['JSON string', '"a string"'],
    ['JSON array', '[]'],
    ['object with no entries', '{}'],
    ['entries not an array', '{"entries":"nope"}'],
    ['entries null', '{"entries":null}'],
    ['truncated JSON', '{"format":1,"entries":[{"id":"a"'],
    ['lock present but zero', '{"entries":[],"lock":0}'],
    ['lock missing salt', '{"entries":[],"lock":{"check":"AAAA"}}'],
    ['BOM before valid JSON', BOM + '{"format":1,"entries":[]}'],
    ['BOM before garbage', BOM + 'not json either'],
    ['binary garbage', Buffer.from([0, 1, 2, 255, 254, 13, 10, 0]).toString('binary')],
    ['deeply nested', '{"entries":[],"lock":' + '['.repeat(200) + ']'.repeat(200) + '}'],
  ];

  for (const [name, bytes] of shapes) {
    const file = tmp();
    // Written and compared as BUFFERS. My first version wrote with the default
    // utf8 encoding and read back with 'binary', so the BOM went out as three
    // bytes and came back as three characters -- the assertion failed on the
    // encoding round-trip, not on the file being touched. A test that reports a
    // product defect it did not find is as bad as one that misses a real one.
    const raw = Buffer.from(bytes, 'binary');
    fs.writeFileSync(file, raw);

    let v;
    assert.doesNotThrow(() => { v = open(file); },
      `createVault must construct for ${name} -- main.js does not wrap it, so a `
      + 'throw here means no window opens at all');

    const st = v.lockState();
    // Healthy or damaged, never a third thing, and never a silent empty vault
    // over bytes we could not read.
    const healthy = st.damaged === undefined;
    if (healthy) {
      // Only a genuinely readable vault may report healthy. The BOM case is the
      // interesting one: if JSON.parse accepts it, an empty vault is the right
      // answer; if it does not, damaged is.
      assert.deepStrictEqual(st, { hasKey: false, locked: false, count: 0 },
        `${name} reported healthy, so it must be a readable empty vault`);
    } else {
      assert.strictEqual(st.locked, true, `${name}: damaged must fail closed`);
      assert.strictEqual(st.count, null, `${name}: an unknown count is null, never 0`);
      assert.throws(() => v.add({ label: 'k', secret: 's', shared: true }), /damaged/i,
        `${name}: writes must be refused`);
      assert.ok(fs.readFileSync(file).equals(raw),
        `${name}: THE PROPERTY -- the bytes on disk are untouched`);
    }
  }
});
