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
