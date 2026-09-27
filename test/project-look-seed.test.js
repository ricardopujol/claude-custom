'use strict';
/**
 * Backlog #15: a NEW project gets a random look, once; the Style tab can
 * re-roll it. "New" is two facts at once -- no look.json of its own AND no
 * Claude history for the folder -- and only a missing look may be written.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { seedLookIfNew, rerollLook, readLook, setLook, LOOK_DIR_NAME } = require('../host/style');
const { hasClaudeHistory } = require('../host/recent');
const { projectDirName } = require('../host/project-dir');
const { lookFailures, SAFE_LOOK } = require('../host/palette-gen');
const { DEFAULT_LOOK } = require('../host/look');
const { tmpDir } = require('./tmp-dir');

const lookFile = (cwd) => path.join(cwd, LOOK_DIR_NAME, 'look.json');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A projects root holding a transcript folder for `cwd`, as Claude Code names it.
function historyFor(cwd, { name = projectDirName(cwd), withTranscript = true } = {}) {
  const root = tmpDir('cc-seed-projects-');
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  if (withTranscript) fs.writeFileSync(path.join(dir, 'abc.jsonl'), '{}\n');
  return root;
}

// --- hasClaudeHistory ------------------------------------------------------------

test('hasClaudeHistory: a transcript in the folder Claude Code names for this cwd is history', () => {
  const cwd = 'C:\\Users\\x\\My Project.v2';
  assert.strictEqual(hasClaudeHistory(cwd, { projectsDir: historyFor(cwd) }), true);
});

test('hasClaudeHistory: another project\'s transcripts are not this one\'s history', () => {
  const root = historyFor('C:\\Users\\x\\other');
  assert.strictEqual(hasClaudeHistory('C:\\Users\\x\\fresh', { projectsDir: root }), false);
});

test('hasClaudeHistory: a folder with no transcript in it is not history', () => {
  const cwd = 'C:\\Users\\x\\empty';
  assert.strictEqual(hasClaudeHistory(cwd, { projectsDir: historyFor(cwd, { withTranscript: false }) }), false);
});

test('hasClaudeHistory: the drive letter\'s case does not hide history (c-- vs C--)', () => {
  const cwd = 'C:\\Users\\x\\proj';
  const root = historyFor(cwd, { name: projectDirName(cwd).toLowerCase() });
  assert.strictEqual(hasClaudeHistory(cwd, { projectsDir: root }), true);
});

test('hasClaudeHistory: no projects folder at all is "no history" (Claude never ran)', () => {
  const root = path.join(tmpDir('cc-seed-none-'), 'does-not-exist');
  assert.strictEqual(hasClaudeHistory('C:\\a', { projectsDir: root }), false);
});

test('hasClaudeHistory: a projects folder that cannot be read counts AS history -- never write on doubt', () => {
  const file = path.join(tmpDir('cc-seed-file-'), 'projects');
  fs.writeFileSync(file, 'not a directory');
  assert.strictEqual(hasClaudeHistory('C:\\a', { projectsDir: file }), true);
});

test('hasClaudeHistory: no cwd is no answer to write on', () => {
  assert.strictEqual(hasClaudeHistory('', { projectsDir: tmpDir('cc-seed-x-') }), true);
});

// --- seedLookIfNew: the gate ---------------------------------------------------------

test('missing look + no history -> a generated look is written, and it passes every contrast check', () => {
  const cwd = tmpDir('cc-seed-new-');
  const r = seedLookIfNew({ cwd, hasHistory: () => false, rng: mulberry32(5) });
  assert.strictEqual(r.seeded, true);
  const look = readLook(cwd);
  assert.deepStrictEqual(lookFailures(look), []);
  assert.strictEqual(look.appColor, r.look.appColor);
  assert.notStrictEqual(look.appColor, null);
});

test('missing look + history -> nothing written, not even the folder', () => {
  const cwd = tmpDir('cc-seed-old-');
  const r = seedLookIfNew({ cwd, hasHistory: () => true, rng: mulberry32(5) });
  assert.strictEqual(r.seeded, false);
  assert.strictEqual(fs.existsSync(path.join(cwd, LOOK_DIR_NAME)), false);
});

test('an existing look is never replaced, and history is not even asked about', () => {
  const cwd = tmpDir('cc-seed-ok-');
  setLook({ cwd, patch: { appColor: '#102030' } });
  const before = fs.readFileSync(lookFile(cwd), 'utf8');
  let asked = false;
  const r = seedLookIfNew({ cwd, hasHistory: () => { asked = true; return false; } });
  assert.strictEqual(r.seeded, false);
  assert.strictEqual(asked, false);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), before);
});

test('a corrupt look.json is never overwritten by a seed', () => {
  const cwd = tmpDir('cc-seed-corrupt-');
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  const corrupt = '{"appColor": "#102030",}';
  fs.writeFileSync(lookFile(cwd), corrupt);
  const r = seedLookIfNew({ cwd, hasHistory: () => false });
  assert.strictEqual(r.seeded, false);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), corrupt);
});

test('a foreign (linked) look folder is never written through by a seed', () => {
  const cwd = tmpDir('cc-seed-foreign-');
  const elsewhere = tmpDir('cc-seed-elsewhere-');
  fs.symlinkSync(elsewhere, path.join(cwd, LOOK_DIR_NAME), 'junction');
  const r = seedLookIfNew({ cwd, hasHistory: () => false });
  assert.strictEqual(r.seeded, false);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('seedLookIfNew hands the terminal foreground to the generator', () => {
  // No dark background carries black CLI text, so the generator falls back.
  const cwd = tmpDir('cc-seed-fg-');
  const r = seedLookIfNew({ cwd, hasHistory: () => false, rng: mulberry32(1), terminalForeground: '#000000' });
  assert.strictEqual(r.seeded, true);
  assert.strictEqual(readLook(cwd).appColor, SAFE_LOOK.appColor);
});

test('seedLookIfNew with no project open writes nothing', () => {
  assert.strictEqual(seedLookIfNew({ cwd: '', hasHistory: () => false }).seeded, false);
});

// --- rerollLook: the Style tab's button -------------------------------------------------

test('rerollLook replaces the colours with a fresh, readable look', () => {
  const cwd = tmpDir('cc-reroll-');
  setLook({ cwd, patch: { appColor: '#102030', textColor: '#f0f0f0' } });
  const r = rerollLook({ cwd, rng: mulberry32(9) });
  assert.strictEqual(r.ok, true);
  const look = readLook(cwd);
  assert.notStrictEqual(look.appColor, '#102030');
  assert.deepStrictEqual(lookFailures(look), []);
});

test('rerollLook works on a project with no look yet (it is an explicit ask)', () => {
  const cwd = tmpDir('cc-reroll-new-');
  assert.strictEqual(rerollLook({ cwd, rng: mulberry32(2) }).ok, true);
  assert.deepStrictEqual(lookFailures(readLook(cwd)), []);
});

test('rerollLook keeps the background image', () => {
  const cwd = tmpDir('cc-reroll-bg-');
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  fs.writeFileSync(path.join(cwd, LOOK_DIR_NAME, 'background.png'), 'x');
  fs.writeFileSync(lookFile(cwd), JSON.stringify({ background: { file: 'background.png', setAt: null } }));
  assert.strictEqual(rerollLook({ cwd, rng: mulberry32(3) }).ok, true);
  assert.deepStrictEqual(readLook(cwd).background, { file: 'background.png', setAt: null });
});

test('rerollLook keeps the darkness a person set for their image (Dexter F2)', () => {
  const cwd = tmpDir('cc-reroll-dark-');
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  fs.writeFileSync(path.join(cwd, LOOK_DIR_NAME, 'background.png'), 'x');
  fs.writeFileSync(lookFile(cwd), JSON.stringify({ darkness: 0.9, background: { file: 'background.png', setAt: null } }));
  for (let seed = 0; seed < 20; seed++) {
    assert.strictEqual(rerollLook({ cwd, rng: mulberry32(seed) }).ok, true);
    assert.strictEqual(readLook(cwd).darkness, 0.9, `seed ${seed}`);
  }
});

test('a seeded look keeps the default darkness -- there is no image to veil yet', () => {
  for (let seed = 0; seed < 20; seed++) {
    const cwd = tmpDir('cc-seed-dark-');
    seedLookIfNew({ cwd, hasHistory: () => false, rng: mulberry32(seed) });
    assert.strictEqual(readLook(cwd).darkness, DEFAULT_LOOK.darkness, `seed ${seed}`);
  }
});

test('rerollLook refuses a corrupt look.json, like every other write', () => {
  const cwd = tmpDir('cc-reroll-corrupt-');
  fs.mkdirSync(path.join(cwd, LOOK_DIR_NAME));
  fs.writeFileSync(lookFile(cwd), '{oops');
  const r = rerollLook({ cwd });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /can't be read/);
  assert.strictEqual(fs.readFileSync(lookFile(cwd), 'utf8'), '{oops');
});

test('rerollLook hands the terminal foreground to the generator', () => {
  const cwd = tmpDir('cc-reroll-fg-');
  rerollLook({ cwd, rng: mulberry32(1), terminalForeground: '#000000' });
  assert.strictEqual(readLook(cwd).appColor, SAFE_LOOK.appColor);
});
