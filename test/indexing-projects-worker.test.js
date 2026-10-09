'use strict';
/**
 * Kill tests for Mortimer's release-gate survivors S21/S25 (2026-10-09), host/indexing-projects.js (46.6%): the
 * worker-thread path of readRecentsOffThread (`eval: true`, `workerData`, the `limit: 20`, the `null`-on-failure rule)
 * and projectChoices' remaining guards. The worker is a thread, not a process, and runs the real host/recent.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const { readRecentsOffThread, projectChoices, MAX_CHOICES } = require('../host/indexing-projects');
const { projectDirName } = require('../host/project-dir');

function projectsDirWith(cwds) {
  const root = tmpDir('cc-ip-worker-');
  cwds.forEach((cwd, i) => {
    const dir = path.join(root, projectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `s${i}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ cwd, message: { usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
    const t = (Date.now() - i * 1000) / 1000;
    fs.utimesSync(file, t, t);
  });
  return root;
}

test('S21 projects: the worker reads the recent projects of the given projects folder and answers them as a list', async () => {
  const root = projectsDirWith(['C:\\code\\alpha', 'C:\\code\\beta']);
  const recents = await readRecentsOffThread({ projectsDir: root });
  assert.ok(Array.isArray(recents));
  assert.deepStrictEqual(recents.map(r => r.path).sort(), ['C:\\code\\alpha', 'C:\\code\\beta']);
  assert.ok(recents.every(r => r.approximate === false && typeof r.lastUsed === 'number'));
});

test('S21 projects: an empty projects folder is "no projects" ([]), which is not the failure answer (null)', async () => {
  const recents = await readRecentsOffThread({ projectsDir: tmpDir('cc-ip-empty-') });
  assert.deepStrictEqual(recents, []);
});

test('S21 projects: at most 20 recent projects come back', async () => {
  const cwds = Array.from({ length: 25 }, (_, i) => `C:\\code\\p${String(i).padStart(2, '0')}`);
  const recents = await readRecentsOffThread({ projectsDir: projectsDirWith(cwds) });
  assert.strictEqual(recents.length, 20);
});

test('S21 projects: with no projectsDir given the worker uses the default folder (CLAUDE_CONFIG_DIR\'s projects), not an empty one', async () => {
  const cfg = tmpDir('cc-ip-cfg-');
  const dir = path.join(cfg, 'projects', projectDirName('C:\\code\\fromdefault'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify({ cwd: 'C:\\code\\fromdefault', message: { usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    for (const arg of [undefined, {}, { projectsDir: '' }, { projectsDir: null }]) {
      const recents = await readRecentsOffThread(arg);
      assert.deepStrictEqual((recents || []).map(r => r.path), ['C:\\code\\fromdefault'], JSON.stringify(arg));
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('S21 projects: a read that fails in the worker is null ("could not read"), never an empty list', async () => {
  const notAFolder = path.join(tmpDir('cc-ip-file-'), 'file.txt');
  fs.writeFileSync(notAFolder, 'x');
  const recents = await readRecentsOffThread({ projectsDir: notAFolder });
  assert.ok(recents === null || (Array.isArray(recents) && recents.length === 0), 'null on failure, or [] when the reader treats it as nothing');
  const real = require('../host/recent');
  let direct;
  try { direct = real.listRecentProjects({ projectsDir: notAFolder }); } catch { direct = null; }
  assert.deepStrictEqual(recents, direct, 'the worker answers exactly what the reader does');
});

// ---- projectChoices guards --------------------------------------------------------------------------------------------------

const labelOf = (root) => root.split('\\').pop();
const projectOf = (p) => ({ root: p, dev: p });

test('S21 projects: the current project is first and marked current; a recent without a string path, or null, or that is guessed, is skipped', () => {
  const out = projectChoices({
    current: 'C:\\code\\alpha',
    recents: [null, undefined, 5, 'x', {}, { path: 5 }, { path: 'C:\\code\\guess', approximate: true }, { path: 'C:\\code\\beta', approximate: false }, { path: 'C:\\code\\gamma' }],
    projectOf, labelOf, hasBacklog: () => true,
  });
  assert.deepStrictEqual(out, [
    { root: 'C:\\code\\alpha', label: 'alpha', current: true },
    { root: 'C:\\code\\beta', label: 'beta', current: false },
    { root: 'C:\\code\\gamma', label: 'gamma', current: false },
  ]);
});

test('S21 projects: a current project that cannot be normalised is not offered, and recents still are; recents that are not a list are none', () => {
  const out = projectChoices({ current: null, recents: [{ path: 'C:\\code\\beta' }], projectOf, labelOf, hasBacklog: () => true });
  assert.deepStrictEqual(out, [{ root: 'C:\\code\\beta', label: 'beta', current: false }]);
  for (const recents of [undefined, null, 'x', {}, 5]) {
    assert.strictEqual(projectChoices({ current: 'C:\\code\\alpha', recents, projectOf, labelOf, hasBacklog: () => true }).length, 1);
  }
});

test('S21 projects: a project with no root, a non-string root, or that has no backlog is not offered; the backlog test sees the project', () => {
  const seen = [];
  const out = projectChoices({
    current: 'C:\\code\\alpha',
    recents: [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }],
    projectOf: (p) => ({ a: null, b: { root: 5 }, c: { root: 'C:\\code\\nobacklog' }, d: { root: 'C:\\code\\ok' } })[p],
    labelOf, hasBacklog: (p) => { seen.push(p.root); return p.root === 'C:\\code\\ok'; },
  });
  assert.deepStrictEqual(out.map(o => o.root), ['C:\\code\\alpha', 'C:\\code\\ok']);
  assert.deepStrictEqual(seen, ['C:\\code\\nobacklog', 'C:\\code\\ok']);
});

test('S21 projects: exactly MAX_CHOICES are offered when there are more, and the current one is never the one dropped', () => {
  const recents = Array.from({ length: MAX_CHOICES + 5 }, (_, i) => ({ path: `C:\\code\\p${String.fromCharCode(97 + i)}` }));
  const out = projectChoices({ current: 'C:\\code\\alpha', recents, projectOf, labelOf, hasBacklog: () => true });
  assert.strictEqual(out.length, MAX_CHOICES);
  assert.strictEqual(out[0].current, true);
  assert.strictEqual(out.filter(o => o.current).length, 1);
  const nine = projectChoices({ current: 'C:\\code\\alpha', recents: recents.slice(0, MAX_CHOICES - 2), projectOf, labelOf, hasBacklog: () => true });
  assert.strictEqual(nine.length, MAX_CHOICES - 1);
});

test('S21 projects: the label comes from labelOf for each root', () => {
  const out = projectChoices({ current: 'C:\\code\\alpha', recents: [{ path: 'C:\\code\\beta' }], projectOf, labelOf: (r) => `L:${r}`, hasBacklog: () => true });
  assert.deepStrictEqual(out.map(o => o.label), ['L:C:\\code\\alpha', 'L:C:\\code\\beta']);
});
