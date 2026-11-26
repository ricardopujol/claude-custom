'use strict';
/**
 * Path identity through a Windows directory junction (lane fix/junction-paths).
 *
 * On Raider `C:\Users\ricar` is a junction to `C:\Users\Ricardo Pujol`. git
 * follows it and prints the REAL path in `git worktree list`, so a project
 * opened through the junction matched none of its own worktrees and the strip
 * said "No worktrees yet." These tests build a real junction in a temp folder
 * (no admin needed for a junction) and are skipped off Windows.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const layout = require('../host/project-layout');
const projectPath = require('../host/project-path');
const { parsePorcelain, tabWorktrees, isSibling } = require('../host/worktree-list');
const { readMainSession, recordMainSession } = require('../host/main-session');

const WIN = process.platform === 'win32';
const skip = WIN ? false : 'junctions are a Windows feature';

// One fixture for the file: <tmp>\real\proj\{dev,feat-a} and <tmp>\link -> <tmp>\real.
let tmp; let real; let link;
test.before(() => {
  if (!WIN) return;
  tmp = tmpDir('cc-junction-');   // removed when the process exits; the junction is unlinked, never walked
  real = path.join(tmp, 'Real Folder');
  link = path.join(tmp, 'link');
  fs.mkdirSync(path.join(real, 'proj', 'dev', '.git'), { recursive: true });
  fs.writeFileSync(path.join(real, 'proj', 'dev', '.git', 'HEAD'), 'ref: refs/heads/develop\n');
  fs.mkdirSync(path.join(real, 'proj', 'feat-a'), { recursive: true });
  fs.writeFileSync(path.join(real, 'proj', 'feat-a', '.git'), 'gitdir: x\n');
  fs.symlinkSync(real, link, 'junction');
});

const viaLink = (...p) => path.join(link, ...p);
const viaReal = (...p) => path.join(real, ...p);
const gitSpelling = (p) => p.replace(/\\/g, '/');

test('normPath: a folder through a junction is the folder itself', { skip }, () => {
  assert.strictEqual(layout.normPath(viaLink('proj', 'dev')), layout.normPath(viaReal('proj', 'dev')));
  assert.ok(layout.samePath(viaLink('proj', 'dev'), gitSpelling(viaReal('proj', 'dev'))));
});

test('normPath: a path that does not exist yet still resolves through the junction above it', { skip }, () => {
  assert.ok(layout.samePath(viaLink('proj', 'not-made', 'deeper'), viaReal('proj', 'not-made', 'deeper')));
  // ...and keeps the old answer for different folders.
  assert.ok(!layout.samePath(viaLink('proj', 'not-made'), viaReal('proj', 'not-made-2')));
});

test('isInside and isSibling see through a junction', { skip }, () => {
  assert.ok(layout.isInside(viaReal('proj', 'dev', 'src'), viaLink('proj', 'dev')));
  assert.ok(layout.isInside(viaLink('proj', 'dev', 'src'), viaReal('proj', 'dev')));
  assert.ok(!layout.isInside(viaLink('proj', 'dev'), viaReal('proj', 'dev')));   // equal is never inside
  assert.ok(isSibling(viaLink('proj'), gitSpelling(viaReal('proj', 'feat-a'))));
});

test('tabWorktrees: a container given through a junction finds dev and its siblings (the "No worktrees yet." bug)', { skip }, () => {
  const porcelain = [
    `worktree ${gitSpelling(viaReal('proj', 'dev'))}`, 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/develop', '',
    `worktree ${gitSpelling(viaReal('proj', 'feat-a'))}`, 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feat/a', '',
  ].join('\n');
  const tabs = tabWorktrees(parsePorcelain(porcelain), viaLink('proj'));
  assert.deepStrictEqual(tabs.map(t => [t.branch, t.isDev]), [['develop', true], ['feat/a', false]]);
});

test('project-path agrees: one folder, one identity, one port key', { skip }, () => {
  assert.ok(projectPath.samePath(viaLink('proj', 'dev'), viaReal('proj', 'dev')));
  assert.strictEqual(projectPath.normalizeProjectPath(viaLink('proj', 'dev')), projectPath.normalizeProjectPath(viaReal('proj', 'dev')));
});

test('display spelling is untouched: projectOf keeps the folder as it was given', { skip }, () => {
  const p = layout.projectOf(viaLink('proj', 'feat-a'));
  assert.strictEqual(p.kind, 'container');
  assert.strictEqual(p.root, viaLink('proj'));
  assert.strictEqual(p.dev, viaLink('proj', 'dev'));
});

test('hidden-agents: a list saved under the old junction-spelled key is still read, and saved under the real key', { skip }, () => {
  const { createHiddenAgents, storeKey } = require('../host/hidden-agents');
  const data = new Map();
  const store = { read: (k, d) => (data.has(k) ? data.get(k) : d), write: (k, v) => { data.set(k, v); } };
  const legacyKey = storeKey(viaLink('proj', 'dev'), projectPath.legacyNormalizeProjectPath);
  assert.notStrictEqual(legacyKey, storeKey(viaLink('proj', 'dev')));
  data.set(legacyKey, { project: viaLink('proj', 'dev'), hidden: ['old-agent'] });
  const h = createHiddenAgents({ store, project: viaLink('proj', 'dev') });
  assert.deepStrictEqual(h.list(), ['old-agent']);
  h.unhide('old-agent');
  assert.deepStrictEqual(data.get(storeKey(viaReal('proj', 'dev'))).hidden, []);
});

test('port-blocks: a block saved under the old junction-spelled key stays with the worktree', { skip }, () => {
  const { allocate, lookup } = require('../host/port-blocks');
  const file = path.join(tmp, 'worktree-ports.json');
  const legacyKey = path.resolve(viaLink('proj', 'dev')).toLowerCase();
  fs.writeFileSync(file, JSON.stringify({ version: 1, blocks: { [legacyKey]: 20300 } }));
  assert.strictEqual(lookup(viaLink('proj', 'dev'), { file }), 20300);
  assert.strictEqual(allocate(viaLink('proj', 'dev'), { file, excluded: [] }), 20300);
  // Re-keyed to the real folder: either spelling finds it, and it is held once.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).blocks;
  assert.deepStrictEqual(Object.values(saved), [20300]);
  assert.strictEqual(lookup(viaReal('proj', 'dev'), { file }), 20300);
});

test('main-session: an id recorded under the old junction-spelled key is still found', { skip }, () => {
  const file = path.join(tmp, 'main-sessions.json');
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  // What a build before this fix wrote: path.resolve + lowercase, junction not followed.
  const legacyKey = path.resolve(viaLink('proj', 'dev')).toLowerCase();
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { [legacyKey]: { id, at: 1 } } }));
  assert.strictEqual(readMainSession(file, viaLink('proj', 'dev')), id);
  // And a new record is found from either spelling.
  const id2 = '1f0e0d0c-0b0a-4908-8706-050403020100';
  assert.deepStrictEqual(recordMainSession({ file, cwd: viaReal('proj', 'dev'), sessionId: id2, now: () => 2 }), { ok: true });
  assert.strictEqual(readMainSession(file, viaLink('proj', 'dev')), id2);
});
