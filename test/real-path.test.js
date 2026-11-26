'use strict';
/**
 * host/real-path.js through its `realpath` seam: no disk, no network. The cases are the ones the PR #257 review
 * named: the TTL edge, the clock going back, the CACHE_MAX clear, UNC and network drives, the climb and its exits.
 * Drive-letter paths need Windows `path` semantics, so those tests are skipped elsewhere.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createRealPath, CACHE_MS, CACHE_MAX } = require('../host/real-path');

const skip = process.platform === 'win32' ? false : 'drive-letter paths need win32 path semantics';

function err(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

// A fake disk: `answers` maps a path to its real path, or to an Error to throw. Anything else is ENOENT.
function fakeDisk(answers) {
  const calls = [];
  const realpath = (p) => {
    calls.push(p);
    const a = Object.prototype.hasOwnProperty.call(answers, p) ? answers[p] : err('ENOENT');
    if (a instanceof Error) throw a;
    return a;
  };
  return { realpath, calls };
}

test('a path that exists comes back as the disk spells it', { skip }, () => {
  const disk = fakeDisk({ 'C:\\': 'C:\\', 'C:\\link\\p': 'C:\\Real Folder\\p' });
  const r = createRealPath({ realpath: disk.realpath });
  assert.strictEqual(r.realPathLoose('C:\\link\\p', 0), 'C:\\Real Folder\\p');
});

test('a missing path climbs to the deepest folder that answers and keeps the rest as given', { skip }, () => {
  const disk = fakeDisk({ 'C:\\': 'C:\\', 'C:\\link': 'C:\\Real Folder' });
  const r = createRealPath({ realpath: disk.realpath });
  assert.strictEqual(r.realPathLoose('C:\\link\\new\\Deeper', 0), 'C:\\Real Folder\\new\\Deeper');
  assert.deepStrictEqual(disk.calls, ['C:\\', 'C:\\link\\new\\Deeper', 'C:\\link\\new', 'C:\\link']);
});

test('ENOTDIR climbs like ENOENT', { skip }, () => {
  const disk = fakeDisk({ 'C:\\': 'C:\\', 'C:\\a\\file.txt\\x': err('ENOTDIR'), 'C:\\a\\file.txt': 'C:\\A\\file.txt' });
  const r = createRealPath({ realpath: disk.realpath });
  assert.strictEqual(r.realPathLoose('C:\\a\\file.txt\\x', 0), 'C:\\A\\file.txt\\x');
});

test('the climb stops at the drive root: when nothing answers, the input comes back as given', { skip }, () => {
  // The root answers the drive check once, then the disk says "not there" for everything (a drive being removed).
  let first = true;
  const calls = [];
  const realpath = (p) => {
    calls.push(p);
    if (first) { first = false; return 'C:\\'; }
    throw err('ENOENT');
  };
  const r = createRealPath({ realpath });
  assert.strictEqual(r.realPathLoose('C:\\a\\b', 0), 'C:\\a\\b');
  assert.deepStrictEqual(calls, ['C:\\', 'C:\\a\\b', 'C:\\a', 'C:\\']);
});

test('any error other than "not there" returns the input at once: one call, no climb', { skip }, () => {
  for (const code of ['ETIMEDOUT', 'EACCES', 'EPERM', 'EBUSY', 'EHOSTUNREACH', undefined]) {
    const disk = fakeDisk({ 'C:\\': 'C:\\', 'C:\\a\\b\\c': err(code) });
    const r = createRealPath({ realpath: disk.realpath });
    assert.strictEqual(r.realPathLoose('C:\\a\\b\\c', 0), 'C:\\a\\b\\c', String(code));
    assert.deepStrictEqual(disk.calls, ['C:\\', 'C:\\a\\b\\c'], String(code));
  }
});

test('UNC and \\\\?\\ paths are returned as given with no disk call', () => {
  const disk = fakeDisk({});
  const r = createRealPath({ realpath: disk.realpath });
  for (const p of ['\\\\srv\\share\\proj', '//srv/share/proj', '\\\\?\\C:\\proj']) {
    assert.strictEqual(r.realPathLoose(p, 0), p);
  }
  assert.deepStrictEqual(disk.calls, []);
});

test('a mapped network drive is returned as given, online or offline: one key, and its root is asked once per process', { skip }, () => {
  const online = fakeDisk({ 'Z:\\': '\\\\srv\\share\\', 'Z:\\proj': '\\\\srv\\share\\proj' });
  const a = createRealPath({ realpath: online.realpath });
  const offline = fakeDisk({ 'Z:\\': err('EHOSTUNREACH') });
  const b = createRealPath({ realpath: offline.realpath });
  assert.strictEqual(a.realPathLoose('Z:\\proj', 0), 'Z:\\proj');
  assert.strictEqual(b.realPathLoose('Z:\\proj', 0), 'Z:\\proj');
  // Other paths on the same drive, and the same path after the cache has expired: no new call.
  a.realPathLoose('Z:\\other\\x', 0);
  b.realPathLoose('Z:\\other\\x', 0);
  b.realPathLoose('Z:\\proj', CACHE_MS * 10);
  assert.deepStrictEqual(online.calls, ['Z:\\']);
  assert.deepStrictEqual(offline.calls, ['Z:\\']);
});

test('a drive letter that is not there is not climbed either', { skip }, () => {
  const disk = fakeDisk({});                         // even Q:\ says ENOENT
  const r = createRealPath({ realpath: disk.realpath });
  assert.strictEqual(r.realPathLoose('Q:\\a\\b\\c', 0), 'Q:\\a\\b\\c');
  assert.deepStrictEqual(disk.calls, ['Q:\\']);
});

test('a cached answer lives CACHE_MS, and no longer', { skip }, () => {
  const answers = { 'C:\\': 'C:\\', 'C:\\link\\p': 'C:\\One\\p' };
  const disk = fakeDisk(answers);
  const r = createRealPath({ realpath: disk.realpath });
  const t0 = 1_000_000;
  assert.strictEqual(r.realPathLoose('C:\\link\\p', t0), 'C:\\One\\p');
  answers['C:\\link\\p'] = 'C:\\Two\\p';               // the junction is pointed somewhere else
  assert.strictEqual(r.realPathLoose('C:\\link\\p', t0 + CACHE_MS - 1), 'C:\\One\\p');
  assert.strictEqual(r.realPathLoose('C:\\link\\p', t0 + CACHE_MS), 'C:\\Two\\p');
  assert.strictEqual(CACHE_MS, 30_000);
});

test('a clock that went back makes an entry a miss, never a longer life', { skip }, () => {
  const answers = { 'C:\\': 'C:\\', 'C:\\link\\p': 'C:\\One\\p' };
  const disk = fakeDisk(answers);
  const r = createRealPath({ realpath: disk.realpath });
  const t0 = 10_000_000;
  r.realPathLoose('C:\\link\\p', t0);
  answers['C:\\link\\p'] = 'C:\\Two\\p';
  assert.strictEqual(r.realPathLoose('C:\\link\\p', t0 - 3_600_000), 'C:\\Two\\p');
  assert.strictEqual(r.realPathLoose('C:\\link\\p', t0 - 1), 'C:\\Two\\p', 'the entry re-made at t0-1h is fresh at t0-1');
});

test('the cache is cleared whole when it reaches CACHE_MAX entries', () => {
  const r = createRealPath({ realpath: (p) => p });
  for (let i = 0; i < CACHE_MAX; i++) r.realPathLoose(`/x/${i}`, 0);
  assert.strictEqual(r.cacheSize(), CACHE_MAX);
  r.realPathLoose('/x/one-more', 0);
  assert.strictEqual(r.cacheSize(), 1);
  assert.strictEqual(CACHE_MAX, 4000);
});

test('clear() forgets the drive answers too', { skip }, () => {
  const disk = fakeDisk({ 'C:\\': 'C:\\', 'C:\\a': 'C:\\A' });
  const r = createRealPath({ realpath: disk.realpath });
  r.realPathLoose('C:\\a', 0);
  r.clear();
  r.realPathLoose('C:\\a', 0);
  assert.strictEqual(disk.calls.filter(c => c === 'C:\\').length, 2);
});

test('not a path: returned as it came, no disk call', () => {
  const disk = fakeDisk({});
  const r = createRealPath({ realpath: disk.realpath });
  for (const v of [undefined, null, '', 42]) assert.strictEqual(r.realPathLoose(v, 0), v);
  assert.deepStrictEqual(disk.calls, []);
});

test('a disk that answers nothing usable leaves the path as given', { skip }, () => {
  const disk = fakeDisk({ 'C:\\': 'C:\\', 'C:\\a': '' });
  const r = createRealPath({ realpath: disk.realpath });
  assert.strictEqual(r.realPathLoose('C:\\a', 0), 'C:\\a');
});
