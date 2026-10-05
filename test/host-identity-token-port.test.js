'use strict';
// host/host-identity.js readTokenFile: the port must be a real port, because `${null}.token` is a real file name.
// readIdentity: a corrupt or null file reads as no identity. writeIdentity: the file it publishes is private on POSIX.
// Release #117 Mortimer survivor 10.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../host/host-identity');

const { tmpDir: mk } = require('./tmp-dir');
const tmpDir = () => mk('hid-');
function withTokens(names, body) {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, 'hosts', `${n}.token`), `secret-${n}\n`);
    body(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('readTokenFile: ports 1 and 65535 are accepted; 0, 65536, negatives, fractions and non-numbers are refused', () => {
  withTokens([0, 1, 65535, 65536, 'null', 'undefined', '80', 'NaN'], (dir) => {
    assert.strictEqual(H.readTokenFile({ dir, port: 1 }), 'secret-1');
    assert.strictEqual(H.readTokenFile({ dir, port: 65535 }), 'secret-65535');
    for (const port of [0, 65536, -1, 1.5, '80', null, undefined, NaN]) assert.strictEqual(H.readTokenFile({ dir, port }), null, String(port));
  });
});

test('readTokenFile: a missing or empty token is null', () => {
  withTokens([], (dir) => {
    assert.strictEqual(H.readTokenFile({ dir, port: 7000 }), null);
    fs.writeFileSync(path.join(dir, 'hosts', '7000.token'), '  \n');
    assert.strictEqual(H.readTokenFile({ dir, port: 7000 }), null);
  });
});

test('readIdentity: a file that is not JSON, is JSON null, or is not an object reads as no identity (never throws)', () => {
  const dir = tmpDir();
  try {
    const file = H.fileFor(dir, 7001);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const text of ['not json', 'null', '5', '"x"', '']) {
      fs.writeFileSync(file, text);
      assert.strictEqual(H.readIdentity({ dir, port: 7001, isAlive: () => true }), null, JSON.stringify(text));
    }
    fs.writeFileSync(file, JSON.stringify({ port: 7001, cwd: 'C:\\x', pid: 42, startedAt: 1 }));
    assert.deepStrictEqual(H.readIdentity({ dir, port: 7001, isAlive: () => true }), { port: 7001, cwd: 'C:\\x', pid: 42, startedAt: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeIdentity: the published file is private to its owner on POSIX', { skip: process.platform === 'win32' && 'file mode bits are not meaningful on Windows (Node honours only the read-only bit)' }, () => {
  const dir = tmpDir();
  try {
    const file = H.writeIdentity({ dir, port: 7002, cwd: 'C:\\x', pid: 42 });
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
