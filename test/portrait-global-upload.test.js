'use strict';
/**
 * BACKLOG C #3: setting and resetting the global default picture through the
 * host's portrait control messages.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { handleGlobalPortraitMessage, handlePortraitMessage } = require('../host/portrait-upload');
const { globalPortrait } = require('../host/portraits');

function fixture() {
  const uploadsDir = tmpDir('cc-gup-');
  const srcDir = tmpDir('cc-gup-src-');
  const src = (name, body = 'pixels') => {
    const p = path.join(srcDir, name);
    fs.writeFileSync(p, body);
    return p;
  };
  const deps = {
    uploadsDir,
    stat: (p) => fs.statSync(p),
    resolve: () => (globalPortrait(uploadsDir) || {}).path || null,
  };
  return { uploadsDir, src, deps };
}

test('set-global copies the file to _global/default.<ext> and reads it back', () => {
  const { uploadsDir, src, deps } = fixture();
  const out = handleGlobalPortraitMessage({ type: 'portrait', action: 'set-global', path: src('me.png') }, deps);
  assert.strictEqual(out.reply.ok, true);
  assert.strictEqual(out.reply.global, true);
  assert.strictEqual(out.changed, true);
  assert.ok(fs.existsSync(path.join(uploadsDir, '_global', 'default.png')));
});

test('a new global picture replaces every other format of the global default', () => {
  const { uploadsDir, src, deps } = fixture();
  handleGlobalPortraitMessage({ action: 'set-global', path: src('a.png') }, deps);
  const out = handleGlobalPortraitMessage({ action: 'set-global', path: src('b.webm') }, deps);
  assert.strictEqual(out.reply.ok, true);
  assert.deepStrictEqual(fs.readdirSync(path.join(uploadsDir, '_global')), ['default.webm']);
});

test('set-global refuses an unsupported type with a sentence, and leaves the old default alone', () => {
  const { uploadsDir, src, deps } = fixture();
  handleGlobalPortraitMessage({ action: 'set-global', path: src('a.png') }, deps);
  const out = handleGlobalPortraitMessage({ action: 'set-global', path: src('notes.txt') }, deps);
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /not a supported portrait type/);
  assert.strictEqual(out.changed, false);
  assert.ok(fs.existsSync(path.join(uploadsDir, '_global', 'default.png')));
});

test('set-global refuses a missing source and a directory', () => {
  const { uploadsDir, deps } = fixture();
  assert.strictEqual(handleGlobalPortraitMessage({ action: 'set-global', path: path.join(uploadsDir, 'nope.png') }, deps).reply.ok, false);
  assert.strictEqual(handleGlobalPortraitMessage({ action: 'set-global', path: uploadsDir }, deps).reply.ok, false);
});

test('reset-global removes every _global default and reports ok', () => {
  const { uploadsDir, src, deps } = fixture();
  handleGlobalPortraitMessage({ action: 'set-global', path: src('a.png') }, deps);
  fs.writeFileSync(path.join(uploadsDir, '_global', 'default.gif'), 'x');
  const out = handleGlobalPortraitMessage({ action: 'reset-global' }, deps);
  assert.strictEqual(out.reply.ok, true);
  assert.strictEqual(out.changed, true);
  assert.strictEqual(globalPortrait(uploadsDir), null);
});

test('reset-global with nothing set is ok and changes nothing', () => {
  const { deps } = fixture();
  const out = handleGlobalPortraitMessage({ action: 'reset-global' }, deps);
  assert.strictEqual(out.reply.ok, true);
  assert.strictEqual(out.changed, false);
});

test('reset-global reports a file it could not remove, instead of claiming success', () => {
  const { uploadsDir, src, deps } = fixture();
  handleGlobalPortraitMessage({ action: 'set-global', path: src('a.png') }, deps);
  const out = handleGlobalPortraitMessage({ action: 'reset-global' }, {
    ...deps,
    unlink: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
  });
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /default\.png/);
  assert.ok(globalPortrait(uploadsDir));
});

test('an unknown global action is refused, never silently ignored', () => {
  const { deps } = fixture();
  const out = handleGlobalPortraitMessage({ action: 'explode-global' }, deps);
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /unsupported/);
});

test('a per-agent set for an agent named _global is refused with the reserved-name reason', () => {
  const { uploadsDir, src } = fixture();
  const out = handlePortraitMessage(
    { action: 'set', agent: '_global', state: 'working', path: src('a.png') },
    { uploadsDir, stat: (p) => fs.statSync(p), resolve: () => null, liveState: () => 'working' });
  assert.strictEqual(out.reply.ok, false);
  assert.match(out.reply.reason, /reserved/);
  assert.strictEqual(fs.existsSync(path.join(uploadsDir, '_global')), false);
});
