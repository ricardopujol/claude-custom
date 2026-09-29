'use strict';
/**
 * Dexter N3 (PR #64 round 2): a failed utimes after the rename silently brought
 * the same-mtime cache bug back while the reply said ok. The stamp is retried;
 * if it never lands AND the version did not move, the reply hedges.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { applyPortraitUpload, handlePortraitMessage, handleGlobalPortraitMessage } = require('../host/portrait-upload');

const ZIP = new Date('2001-01-01T00:00:00Z');
function pictures() {
  const dir = tmpDir('cc-stamp-');
  const a = path.join(dir, 'A.png'); const b = path.join(dir, 'B.png');
  fs.writeFileSync(a, 'A'); fs.writeFileSync(b, 'BB');
  fs.utimesSync(a, ZIP, ZIP); fs.utimesSync(b, ZIP, ZIP);
  return { dir, a, b };
}
const failing = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };

test('N3: a transient utimes failure is retried and the version moves', () => {
  const { dir, a } = pictures();
  const dest = path.join(dir, 'up', 'x.png');
  let n = 0;
  const out = applyPortraitUpload({ source: a, dest }, {
    utimesSync: (...args) => { n += 1; if (n < 3) failing(); return fs.utimesSync(...args); },
  });
  assert.strictEqual(n, 3);
  assert.strictEqual(out.versionStale, false);
  assert.ok(fs.statSync(dest).mtimeMs > ZIP.getTime());
});

test('N3: a stamp that never lands over an equal-mtime predecessor reports versionStale', () => {
  const { dir, a, b } = pictures();
  const dest = path.join(dir, 'up', 'x.png');
  applyPortraitUpload({ source: a, dest }, { utimesSync: failing });          // predecessor keeps ZIP mtime
  assert.strictEqual(fs.statSync(dest).mtimeMs, ZIP.getTime());
  const out = applyPortraitUpload({ source: b, dest }, { utimesSync: failing });
  assert.strictEqual(out.versionStale, true);
});

test('N3: a stamp that fails but whose version moved anyway is not stale', () => {
  const { dir, a } = pictures();
  const dest = path.join(dir, 'up', 'x.png');       // first upload: no predecessor, mtime is new to the URL
  const out = applyPortraitUpload({ source: a, dest }, { utimesSync: failing, statSync: (p) => (p === dest && fs.existsSync(dest) ? { mtimeMs: ZIP.getTime() + 5 } : fs.statSync(p)) });
  assert.strictEqual(out.versionStale, false);
});

function upload(handler, msg, apply) {
  const uploadsDir = tmpDir('cc-stamp-up-');
  return handler(msg, {
    uploadsDir, stat: (p) => fs.statSync(p), apply,
    resolve: (...a) => (handler === handlePortraitMessage ? path.join(uploadsDir, 'coder', 'happy.png') : path.join(uploadsDir, '_global', 'default.png')),
    liveState: () => 'happy',
  });
}

test('N3: the per-agent reply hedges (ok:false with a reason) when the version is stale', () => {
  const { a } = pictures();
  const out = upload(handlePortraitMessage, { action: 'set', agent: 'coder', state: 'happy', path: a },
    () => ({ leftovers: [], versionStale: true }));
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /previous picture may still be shown/);
  assert.ok(out.mood, 'the repaint still goes out: the file did change');
});

test('N3: the global reply hedges the same way, and still reports changed', () => {
  const { a } = pictures();
  const out = upload(handleGlobalPortraitMessage, { action: 'set-global', path: a },
    () => ({ leftovers: [], versionStale: true }));
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /previous picture may still be shown/);
  assert.strictEqual(out.changed, true);
});

test('N3: a clean upload is still ok with no reason', () => {
  const { a } = pictures();
  const out = upload(handleGlobalPortraitMessage, { action: 'set-global', path: a }, () => ({ leftovers: [], versionStale: false }));
  assert.strictEqual(out.reply.ok, true);
  assert.strictEqual(out.reply.reason, null);
});
