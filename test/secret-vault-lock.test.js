'use strict';
/**
 * Locking the vault with a key.
 *
 * Ricardo's threat model, in his words: "in case he has to leave his computer
 * and someone could enter the vault."
 *
 * THE LOCK IS REAL CRYPTOGRAPHY, NOT A UI GATE, and his own "melt" requirement
 * is what settles that. Melt only makes sense when there is genuinely no way
 * back; a UI gate would always be recoverable by editing a file, and there
 * would be nothing to melt.
 *
 * So the password DERIVES the encryption key (scrypt), and that key wraps the
 * ciphertext safeStorage has already produced. Two layers, both required: the
 * OS keyring binds the file to this user account, the password binds it to
 * this person. Someone who copies `secrets.enc` gets neither.
 *
 * The derived key lives in memory only, for as long as the vault is open. It
 * is never written, never recoverable from anything stored, and never crosses
 * to the renderer. "Relocks on restart" is therefore a CONSEQUENCE rather than
 * a policy -- there is nowhere for it to survive. Ricardo chose that over a
 * vault that stays open across launches, knowing the trade.
 *
 * Open by default. The user closes it for the first time by setting a key, and
 * it stays open after each unlock until they lock it again, replace the key,
 * or destroy the key and leave it permanently open.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVault } = require('../app/secret-vault');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lock-')), 'secrets.enc');

// Stands in for Electron safeStorage. Reversible and obviously not real crypto:
// these tests care about what the vault DOES with it. Its reversibility is
// load-bearing in one test below, which checks that the safeStorage layer alone
// cannot recover a secret once the key layer is on top.
const fakeCrypto = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b) => {
    const raw = Buffer.from(b).toString('utf8');
    if (!raw.startsWith('ENC:')) throw new Error('not encrypted by this cipher');
    return Buffer.from(raw.slice(4), 'base64').toString('utf8');
  },
});

const open = (file) => createVault({ file, crypto: fakeCrypto() });
const KEY = 'correct horse battery staple';
const ANY = { project: 'C:/any' };

test('a new vault is OPEN and has no key', () => {
  assert.deepStrictEqual(open(tmp()).lockState(), { hasKey: false, locked: false });
});

test('setting a key for the first time closes the vault to anyone without it', () => {
  const file = tmp();
  const v = open(file);
  v.add({ label: 'k', secret: 'sensitive', shared: true });
  v.setKey(KEY);
  assert.deepStrictEqual(v.lockState(), { hasKey: true, locked: false },
    'setting a key leaves it open -- you just set it, you are still here');

  // A fresh handle is what a restart looks like: the derived key is gone.
  assert.deepStrictEqual(open(file).lockState(), { hasKey: true, locked: true });
});

test('while locked, nothing is readable -- not even the labels', () => {
  // A label IS a secret. "client-x prod database" tells a passerby who the
  // client is and that there is a production database, without revealing one
  // character of the value.
  const file = tmp();
  const v0 = open(file);
  const e = v0.add({ label: 'client-x prod db', secret: 's', shared: true });
  v0.setKey(KEY);

  const v = open(file);
  assert.deepStrictEqual(v.list(ANY), []);
  assert.strictEqual(v.get(e.id, ANY), null);
});

test('the ciphertext on disk is unreadable without the key', () => {
  // The property the whole feature rests on. If the stored value could still
  // be recovered by the OS keyring alone, the password would be decoration.
  const file = tmp();
  const v = open(file);
  v.add({ label: 'k', secret: 'PLAINTEXT-MARKER', shared: true });
  v.setKey(KEY);

  const raw = fs.readFileSync(file, 'utf8');
  assert.strictEqual(raw.includes('PLAINTEXT-MARKER'), false);
  // And not merely base64'd away: the fake cipher is reversible, so an
  // unwrapped entry would decode straight back to the marker.
  const onDisk = JSON.parse(raw).entries[0].secret;
  assert.strictEqual(
    Buffer.from(onDisk, 'base64').toString('utf8').includes('PLAINTEXT-MARKER'), false,
    'the safeStorage layer alone must not be enough to recover it');
});

test('the right key opens it, and it stays open', () => {
  const file = tmp();
  const v0 = open(file);
  const e = v0.add({ label: 'k', secret: 'sensitive', shared: true });
  v0.setKey(KEY);

  const v = open(file);
  assert.strictEqual(v.unlock(KEY), true);
  assert.deepStrictEqual(v.lockState(), { hasKey: true, locked: false });
  assert.strictEqual(v.get(e.id, ANY), 'sensitive');
  assert.strictEqual(v.list(ANY).length, 1, 'and stays open');
});

test('a wrong key opens nothing, and does not damage the vault', () => {
  // Fail closed, and fail HARMLESSLY. A wrong guess must not become a way to
  // destroy what it could not read.
  const file = tmp();
  const v0 = open(file);
  v0.add({ label: 'k', secret: 'sensitive', shared: true });
  v0.setKey(KEY);

  const v = open(file);
  assert.strictEqual(v.unlock('wrong'), false);
  assert.strictEqual(v.lockState().locked, true);
  assert.strictEqual(v.unlock(KEY), true, 'the real key still works afterwards');
});

test('locking again closes it WITHOUT needing the key', () => {
  // Stepping away is the entire use case. It must not require re-typing the
  // thing you are protecting.
  const file = tmp();
  const v = open(file);
  v.add({ label: 'k', secret: 's', shared: true });
  v.setKey(KEY);
  v.lock();
  assert.strictEqual(v.lockState().locked, true);
  assert.deepStrictEqual(v.list(ANY), []);
});

test('writing is refused while locked, rather than silently dropped', () => {
  const file = tmp();
  open(file).setKey(KEY);
  const v = open(file);
  assert.throws(() => v.add({ label: 'k', secret: 's', shared: true }), /locked/i);
  assert.strictEqual(v.remove('anything', ANY), false);
});

test('destroying the key leaves the vault permanently open, secrets intact', () => {
  // The third exit Ricardo named. Everything is re-wrapped back to
  // safeStorage-only, so the secrets survive and no password is asked again.
  const file = tmp();
  const v = open(file);
  const e = v.add({ label: 'k', secret: 'sensitive', shared: true });
  v.setKey(KEY);
  v.removeKey();
  assert.deepStrictEqual(v.lockState(), { hasKey: false, locked: false });
  assert.strictEqual(v.get(e.id, ANY), 'sensitive');

  const reopened = open(file);
  assert.strictEqual(reopened.lockState().locked, false, 'and a restart no longer asks');
  assert.strictEqual(reopened.get(e.id, ANY), 'sensitive');
});

test('replacing the key re-wraps the secrets under the new one', () => {
  const file = tmp();
  const v = open(file);
  const e = v.add({ label: 'k', secret: 'sensitive', shared: true });
  v.setKey(KEY);
  v.setKey('a different key');

  const reopened = open(file);
  assert.strictEqual(reopened.unlock(KEY), false, 'the old key must stop working');
  assert.strictEqual(reopened.unlock('a different key'), true);
  assert.strictEqual(reopened.get(e.id, ANY), 'sensitive');
});

test('the key cannot be changed or destroyed while the vault is LOCKED', () => {
  // Otherwise the lock is a formality: anyone at the machine could replace a
  // key they do not know with one they do, and read everything.
  const file = tmp();
  const v0 = open(file);
  v0.add({ label: 'k', secret: 's', shared: true });
  v0.setKey(KEY);

  const v = open(file);
  assert.throws(() => v.setKey('attacker key'), /locked/i);
  assert.throws(() => v.removeKey(), /locked/i);
});

test('melt destroys everything and leaves a working, open vault', () => {
  // The only way back from a forgotten key, and it must be honest about the
  // cost: the secrets are gone, not recoverable, not archived somewhere.
  const file = tmp();
  const v0 = open(file);
  v0.add({ label: 'k', secret: 'sensitive', shared: true });
  v0.setKey(KEY);

  const v = open(file);
  assert.strictEqual(v.lockState().locked, true, 'precondition: locked out');
  v.melt();
  assert.deepStrictEqual(v.lockState(), { hasKey: false, locked: false });
  assert.deepStrictEqual(v.list(ANY), []);

  const e = v.add({ label: 'fresh', secret: 'new', shared: true });
  assert.strictEqual(v.get(e.id, ANY), 'new');
  assert.strictEqual(fs.readFileSync(file, 'utf8').includes('sensitive'), false,
    'and the old ciphertext must not be left lying in the file');
});

test('two different keys derive two different wrappings of one secret', () => {
  // Guards against a derivation that ignores the password -- which would pass
  // every test above, because every one of them uses a single key at a time.
  const a = tmp();
  const b = tmp();
  for (const [file, key] of [[a, 'key-one'], [b, 'key-two']]) {
    const v = open(file);
    v.add({ label: 'k', secret: 'identical', shared: true });
    v.setKey(key);
  }
  const ca = JSON.parse(fs.readFileSync(a, 'utf8')).entries[0].secret;
  const cb = JSON.parse(fs.readFileSync(b, 'utf8')).entries[0].secret;
  assert.notStrictEqual(ca, cb, 'the password must actually participate');
});
