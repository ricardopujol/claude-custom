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
const { readMainSession, recordMainSession, resumeIdFor } = require('../host/main-session');
const { projectDirName } = require('../host/project-dir');

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
  // The worktree skill's layout: a lane's .venv is a junction into dev's.
  fs.mkdirSync(path.join(real, 'proj', 'dev', '.venv', 'Lib'), { recursive: true });
  fs.writeFileSync(path.join(real, 'proj', 'dev', '.venv', 'Lib', 'x.py'), '');
  fs.symlinkSync(path.join(real, 'proj', 'dev', '.venv'), path.join(real, 'proj', 'feat-a', '.venv'), 'junction');
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

// A junction BELOW a worktree root is not followed out of it (Dexter 2, PR #257).
test('isInside: a file under a lane\'s .venv junction stays in the lane, and is not inside dev', { skip }, () => {
  const file = viaReal('proj', 'feat-a', '.venv', 'Lib', 'x.py');
  assert.ok(layout.isInside(file, viaReal('proj', 'feat-a')));
  assert.ok(!layout.isInside(file, viaReal('proj', 'dev')));
  // ...also when the lane is spelled through the junction above it.
  assert.ok(layout.isInside(viaLink('proj', 'feat-a', '.venv', 'Lib', 'x.py'), viaReal('proj', 'feat-a')));
  assert.ok(!layout.isInside(viaLink('proj', 'feat-a', '.venv', 'Lib', 'x.py'), viaReal('proj', 'dev')));
});

test('occupancy: an Edit in a lane\'s own .venv is not a touch on dev', { skip }, () => {
  const { touchOf } = require('../host/agent-occupancy');
  const roots = [gitSpelling(viaReal('proj', 'dev')), gitSpelling(viaReal('proj', 'feat-a'))].map(p => path.resolve(p));
  const own = path.resolve(viaReal('proj', 'feat-a'));
  assert.strictEqual(touchOf('Edit', { file_path: viaReal('proj', 'feat-a', '.venv', 'Lib', 'x.py') }, roots, own), null);
  assert.strictEqual(touchOf('Edit', { file_path: viaLink('proj', 'feat-a', '.venv', 'Lib', 'x.py') }, roots, own), null);
  // The real dev file, spelled through the junction above it, is still a touch on dev.
  assert.strictEqual(touchOf('Edit', { file_path: viaLink('proj', 'dev', '.venv', 'Lib', 'x.py') }, roots, own), roots[0]);
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

// Container tabs start in git's real spelling, so the usual caller after the upgrade is the REAL one (Dexter 3 / Miguel 2).
test('port-blocks: a REAL-spelled caller finds the block an older build saved under the junction spelling', { skip }, () => {
  const { allocate, lookup } = require('../host/port-blocks');
  const file = path.join(tmp, 'worktree-ports-real.json');
  const legacyKey = path.resolve(viaLink('proj', 'dev')).toLowerCase();
  fs.writeFileSync(file, JSON.stringify({ version: 1, blocks: { [legacyKey]: 20300 } }));
  assert.strictEqual(lookup(viaReal('proj', 'dev'), { file }), 20300);
  assert.strictEqual(allocate(viaReal('proj', 'dev'), { file, excluded: [] }), 20300);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).blocks;
  assert.deepStrictEqual(Object.values(saved), [20300], 'held once, under the real key');
  assert.strictEqual(lookup(viaLink('proj', 'dev'), { file }), 20300);
});

// Two old keys for one folder, each with its own block: the one under the real key is used, and the other stays HELD,
// because a dev server may still run on it; a new worktree never gets it (Dexter 5).
test('port-blocks: of two old blocks for one folder, neither is handed to another worktree', { skip }, () => {
  const { allocate } = require('../host/port-blocks');
  const file = path.join(tmp, 'worktree-ports-two.json');
  const realKey = layout.normPath(viaReal('proj', 'dev'));   // not path.resolve: %TEMP% may be an 8.3 spelling
  const linkKey = path.resolve(viaLink('proj', 'dev')).toLowerCase();
  fs.writeFileSync(file, JSON.stringify({ version: 1, blocks: { [linkKey]: 20000, [realKey]: 20100 } }));
  assert.strictEqual(allocate(viaLink('proj', 'dev'), { file, excluded: [] }), 20100);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).blocks;
  assert.deepStrictEqual(Object.values(saved).sort(), [20000, 20100]);
  assert.strictEqual(allocate(viaReal('proj', 'feat-a'), { file, excluded: [] }), 20200);
});

// The resume id points INTO a transcript folder, and Claude names that folder from the cwd AS SPELLED
// (host/project-dir.js). So each spelling keeps its own record (Dexter 1 / Miguel 1, PR #257).
test('main-session: each spelling of one folder resumes its own conversation, and neither overwrites the other', { skip }, () => {
  const file = path.join(tmp, 'main-sessions-two.json');
  const projectsDir = path.join(tmp, 'claude-projects');
  const A = 'aaaaaaaa-0b0a-4908-8706-050403020100';   // the real spelling's conversation
  const B = 'bbbbbbbb-0b0a-4908-8706-050403020100';   // the junction spelling's conversation
  const realCwd = viaReal('proj', 'dev');
  const linkCwd = viaLink('proj', 'dev');
  for (const [cwd, id] of [[realCwd, A], [linkCwd, B]]) {
    const dir = path.join(projectsDir, projectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"type":"user","message":"hi"}\n');
  }
  // What a build before the fix wrote, one key per spelling (path.resolve + lowercase).
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: {
    [path.resolve(realCwd).toLowerCase()]: { id: A, at: 1 },
    [path.resolve(linkCwd).toLowerCase()]: { id: B, at: 2 },
  } }));
  const store = { projectsDir };
  assert.strictEqual(resumeIdFor({ file, cwd: linkCwd, store }), B);
  assert.strictEqual(resumeIdFor({ file, cwd: realCwd, store }), A);

  // A new main session in one spelling leaves the other spelling's record alone.
  const C = 'cccccccc-0b0a-4908-8706-050403020100';
  assert.deepStrictEqual(recordMainSession({ file, cwd: realCwd, sessionId: C, now: () => 3 }), { ok: true });
  assert.strictEqual(readMainSession(file, linkCwd), B);
  assert.strictEqual(readMainSession(file, realCwd), C);
  const D = 'dddddddd-0b0a-4908-8706-050403020100';
  assert.deepStrictEqual(recordMainSession({ file, cwd: linkCwd, sessionId: D, now: () => 4 }), { ok: true });
  assert.strictEqual(readMainSession(file, realCwd), C);
  assert.strictEqual(readMainSession(file, linkCwd), D);
});
