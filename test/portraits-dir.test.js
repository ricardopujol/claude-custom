'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePortraitsDir, FLAT_DIR, DEV_DIR, MARKER } = require('../host/portraits-dir');

const none = () => false;
const devHolds = (p) => p === path.join(DEV_DIR, MARKER);

test('env override wins over everything', () => {
  assert.equal(resolvePortraitsDir({ CLAUDE_CUSTOM_PORTRAITS: 'X:\p' }, () => true), 'X:\p');
});

test('an empty env override is ignored', () => {
  assert.equal(resolvePortraitsDir({ CLAUDE_CUSTOM_PORTRAITS: '' }, none), FLAT_DIR);
});

test('dev path wins when it holds the portraits', () => {
  assert.equal(resolvePortraitsDir({}, devHolds), DEV_DIR);
});

test('both layouts present: dev wins', () => {
  assert.equal(resolvePortraitsDir({}, () => true), DEV_DIR);
});

test('flat path is the fallback when the dev path is absent', () => {
  assert.equal(resolvePortraitsDir({}, none), FLAT_DIR);
});

test('a dev folder without the marker (empty, or a plain file) never wins', () => {
  assert.equal(resolvePortraitsDir({}, (p) => p === DEV_DIR), FLAT_DIR);
});

test('the default existence check is real: an empty dev dir loses, a marked one wins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
  try {
    const dev = path.join(root, 'dev');
    fs.mkdirSync(dev);
    const exists = (p) => fs.existsSync(p.replace(DEV_DIR, dev));
    assert.equal(resolvePortraitsDir({}, exists), FLAT_DIR);
    fs.writeFileSync(path.join(dev, MARKER), '');
    assert.equal(resolvePortraitsDir({}, exists), DEV_DIR);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolves on every call: a dev folder that appears later is picked up', () => {
  let there = false;
  const exists = (p) => there && devHolds(p);
  assert.equal(resolvePortraitsDir({}, exists), FLAT_DIR);
  there = true;
  assert.equal(resolvePortraitsDir({}, exists), DEV_DIR);
});

test('the defaults hang off the home folder, not a literal user', () => {
  const home = os.homedir();
  assert.equal(FLAT_DIR, path.join(home, 'VibeCode', 'agent-creator', 'portraits'));
  assert.equal(DEV_DIR, path.join(home, 'VibeCode', 'agent-creator', 'dev', 'portraits'));
});

test('JS, Python and sh name the same paths and the same marker', () => {
  const forge = path.join(__dirname, '..', 'forge');
  const sh = fs.readFileSync(path.join(forge, 'run-states.sh'), 'utf8');
  const py = fs.readFileSync(path.join(forge, 'portraits_dir.py'), 'utf8');
  assert.ok(sh.includes('$HOME/VibeCode/agent-creator/dev/portraits'));
  assert.ok(sh.includes('$HOME/VibeCode/agent-creator/portraits'));
  assert.ok(sh.includes(`/${MARKER}`));
  assert.ok(py.includes(`"${MARKER}"`));
  assert.ok(py.includes('Path.home() / "VibeCode" / "agent-creator"'));
  assert.ok(py.includes('_ROOT / "dev" / "portraits"'));
  assert.ok(py.includes('_ROOT / "portraits"'));
});
