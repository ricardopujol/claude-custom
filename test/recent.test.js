'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listRecentProjects } = require('../host/recent');
const { tmpDir } = require('./tmp-dir');

function projects(tree) {
  const root = tmpDir('cc-recent-');
  for (const [dirName, sessions] of Object.entries(tree)) {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [session, spec] of Object.entries(sessions)) {
      const lines = (spec.lines || []).map(l => JSON.stringify(l)).join('\n') + '\n';
      const file = path.join(dir, `${session}.jsonl`);
      fs.writeFileSync(file, lines);
      if (spec.mtime) fs.utimesSync(file, spec.mtime / 1000, spec.mtime / 1000);
    }
  }
  return root;
}

const entry = (cwd, input = 0, output = 0) => ({
  cwd,
  message: { usage: { input_tokens: input, output_tokens: output } },
});

test('an empty projects directory yields nothing', () => {
  assert.deepStrictEqual(listRecentProjects({ projectsDir: tmpDir('cc-') }), []);
});

test('a missing projects directory yields nothing rather than throwing', () => {
  assert.deepStrictEqual(
    listRecentProjects({ projectsDir: path.join(os.tmpdir(), 'cc-absent-' + Date.now()) }),
    []
  );
});

test('reads the real cwd from the transcript, not the folder name', () => {
  // The folder name is a LOSSY encoding: "claude-custom" contains a real dash,
  // indistinguishable from the separator dashes. Decoding it would guess
  // "claude/custom". The transcript records the actual cwd, so read that.
  const root = projects({
    'C--Users-ricar-VibeCode-claude-custom': {
      s1: { lines: [entry('C:\\Users\\ricar\\VibeCode\\claude-custom', 10, 5)] },
    },
  });
  const [p] = listRecentProjects({ projectsDir: root });
  assert.strictEqual(p.path, 'C:\\Users\\ricar\\VibeCode\\claude-custom');
  assert.strictEqual(p.name, 'claude-custom');
});

test('falls back to the folder name when no cwd is recorded', () => {
  // Old or truncated transcripts may carry none; showing a best guess beats
  // dropping the project from the list entirely.
  const root = projects({ 'C--tmp-thing': { s1: { lines: [{ type: 'user' }] } } });
  const [p] = listRecentProjects({ projectsDir: root });
  assert.ok(p.name);
  assert.strictEqual(p.approximate, true);
});

test('sums tokens across every session in the project', () => {
  const root = projects({
    'C--a': {
      s1: { lines: [entry('C:/a', 10, 20)] },
      s2: { lines: [entry('C:/a', 1, 2)] },
    },
  });
  const [p] = listRecentProjects({ projectsDir: root });
  assert.strictEqual(p.tokens, 33);
  assert.strictEqual(p.sessions, 2);
});

test('orders by most recently used', () => {
  const now = Date.now();
  const root = projects({
    'C--old': { s1: { lines: [entry('C:/old')], mtime: now - 900_000 } },
    'C--new': { s1: { lines: [entry('C:/new')], mtime: now } },
    'C--mid': { s1: { lines: [entry('C:/mid')], mtime: now - 300_000 } },
  });
  assert.deepStrictEqual(
    listRecentProjects({ projectsDir: root }).map(p => p.name),
    ['new', 'mid', 'old']
  );
});

test('lastUsed is the newest session, not the oldest', () => {
  const now = Date.now();
  const root = projects({
    'C--a': {
      old: { lines: [entry('C:/a')], mtime: now - 900_000 },
      fresh: { lines: [entry('C:/a')], mtime: now },
    },
  });
  const [p] = listRecentProjects({ projectsDir: root });
  assert.ok(Math.abs(p.lastUsed - now) < 5000, `${p.lastUsed} vs ${now}`);
});

test('honours a limit', () => {
  const root = projects(Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`C--p${i}`, { s1: { lines: [entry(`C:/p${i}`)] } }])
  ));
  assert.strictEqual(listRecentProjects({ projectsDir: root, limit: 3 }).length, 3);
});

test('a project with no transcripts is skipped', () => {
  const root = tmpDir('cc-recent-');
  fs.mkdirSync(path.join(root, 'C--empty'), { recursive: true });
  assert.deepStrictEqual(listRecentProjects({ projectsDir: root }), []);
});

test('a corrupt transcript does not drop the whole project', () => {
  // The newest file is appended to live, so a partial final line is normal.
  const root = projects({ 'C--a': { s1: { lines: [entry('C:/a', 5, 5)] } } });
  fs.appendFileSync(path.join(root, 'C--a', 's1.jsonl'), '{"broken');
  const [p] = listRecentProjects({ projectsDir: root });
  assert.strictEqual(p.tokens, 10);
});

test('a file that is not a transcript is ignored', () => {
  const root = projects({ 'C--a': { s1: { lines: [entry('C:/a', 1, 1)] } } });
  fs.writeFileSync(path.join(root, 'C--a', 'notes.md'), 'hello');
  fs.mkdirSync(path.join(root, 'C--a', 'memory'), { recursive: true });
  assert.strictEqual(listRecentProjects({ projectsDir: root })[0].sessions, 1);
});

test('only scans the projects it will actually show', () => {
  // Sorting needs mtime, which is a cheap stat. Token totals need a full read,
  // which on a real machine meant 3s across 71 projects -- far too slow for a
  // launcher. Rank by stat first, then read only the visible rows.
  const root = projects(Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`C--p${i}`, {
      s1: { lines: [entry(`C:/p${i}`, 1, 1)], mtime: Date.now() - i * 60_000 },
    }])
  ));
  let reads = 0;
  const list = listRecentProjects({ projectsDir: root, limit: 3, onRead: () => reads++ });
  assert.strictEqual(list.length, 3);
  assert.ok(reads <= 3, `read ${reads} transcripts to show 3 projects`);
});

test('reuses a cached total when the file has not changed', () => {
  const root = projects({ 'C--a': { s1: { lines: [entry('C:/a', 10, 10)] } } });
  const cache = {};
  let reads = 0;
  const opts = { projectsDir: root, cache, onRead: () => reads++ };

  const first = listRecentProjects(opts)[0];
  const afterFirst = reads;
  const second = listRecentProjects(opts)[0];

  assert.strictEqual(second.tokens, first.tokens);
  assert.strictEqual(reads, afterFirst, 're-read an unchanged transcript');
});

test('a changed file invalidates its cache entry', () => {
  const root = projects({ 'C--a': { s1: { lines: [entry('C:/a', 10, 10)] } } });
  const cache = {};
  listRecentProjects({ projectsDir: root, cache });

  fs.appendFileSync(path.join(root, 'C--a', 's1.jsonl'),
    JSON.stringify(entry('C:/a', 5, 5)) + '\n');

  const after = listRecentProjects({ projectsDir: root, cache })[0];
  assert.strictEqual(after.tokens, 30);
});
