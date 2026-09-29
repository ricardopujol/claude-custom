'use strict';
/**
 * Dexter F4 / Miguel I3 (PR #64): the `_global` reservation was an exact string
 * match, but the filesystem it guards folds case and trims trailing dots and
 * spaces on Windows. `_GLOBAL`, `_Global`, `_global.` and `_global ` are the
 * same directory, so they read the global picture as tier 'uploaded' and
 * uploaded into `_global/`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const { portraitFor, isReservedAgent } = require('../host/portraits');
const { handlePortraitMessage, planPortraitUpload } = require('../host/portrait-upload');

const ALIASES = ['_global', '_GLOBAL', '_Global', '_global.', '_global ', '_global. .', '_gLoBaL...'];

test('isReservedAgent matches the name and every alias the filesystem folds onto it', () => {
  for (const n of ALIASES) assert.strictEqual(isReservedAgent(n), true, JSON.stringify(n));
});

test('isReservedAgent does not match real agents or non-strings', () => {
  for (const n of ['global', '_globals', 'x_global', '__global', 'code-reviewer', '', ' _global x', null, undefined, 5, {}]) {
    assert.strictEqual(isReservedAgent(n), false, JSON.stringify(n));
  }
});

test('an alias of _global with only the global picture on disk is NOT tier "uploaded"', () => {
  const uploadsDir = tmpDir('cc-res-');
  fs.mkdirSync(path.join(uploadsDir, '_global'), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, '_global', 'default.png'), 'x');
  for (const n of ALIASES) {
    const p = portraitFor(n, 'sleeping', { uploadsDir });
    assert.notStrictEqual(p.tier, 'uploaded', JSON.stringify(n));
    assert.strictEqual(p.kind, 'placeholder', JSON.stringify(n));
  }
});

test('an upload for any alias of _global is refused and writes nothing', () => {
  const uploadsDir = tmpDir('cc-res-');
  const src = path.join(tmpDir('cc-res-src-'), 'a.png');
  fs.writeFileSync(src, 'x');
  for (const agent of ALIASES) {
    const out = handlePortraitMessage({ action: 'set', agent, state: 'working', path: src }, {
      uploadsDir, stat: (p) => fs.statSync(p), resolve: () => null, liveState: () => 'working',
    });
    assert.strictEqual(out.reply.ok, false, JSON.stringify(agent));
    assert.match(out.reply.reason, /reserved/);
  }
  assert.strictEqual(fs.existsSync(path.join(uploadsDir, '_global')), false);
});

test('planPortraitUpload itself refuses a reserved agent unless the caller is the global handler', () => {
  const uploadsDir = tmpDir('cc-res-');
  const base = { source: 'C:\\a.png', state: 'default', uploadsDir, size: 10 };
  assert.strictEqual(planPortraitUpload({ ...base, agent: '_GLOBAL' }).ok, false);
  assert.match(planPortraitUpload({ ...base, agent: '_global' }).reason, /reserved/);
  assert.strictEqual(planPortraitUpload({ ...base, agent: '_global', allowReserved: true }).ok, true);
});

test('PROPERTY: adding case changes and trailing dots/spaces to _global always stays reserved', () => {
  const arb = fc.tuple(
    fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }),
    fc.stringMatching(/^[. ]{0,4}$/),
  );
  fc.assert(fc.property(arb, ([flips, tail]) => {
    const name = [...'_global'].map((c, i) => (flips[i] ? c.toUpperCase() : c)).join('') + tail;
    assert.strictEqual(isReservedAgent(name), true, JSON.stringify(name));
  }));
});
