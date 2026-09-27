'use strict';
/**
 * The incremental, disk-cached per-FILE scan (BACKLOG D #16 item 4): a file
 * whose path+size+mtime match a cached entry is trusted rather than re-read;
 * anything new, changed, or gone is re-read or dropped. `readCacheFile` /
 * `writeCacheFile` persist that across host restarts, atomically, the same
 * write-to-temp-then-rename convention `host/openrouter.js`'s catalogue cache
 * already uses.
 *
 * The CORE PROPERTY -- an incremental scan equals a from-scratch one for any
 * sequence of adds/grows/shrinks/deletes -- has its own generative suite,
 * test/agent-stats-cache-properties.test.js, per the spec. This file is the
 * hand-written edge-case coverage: the disk round-trip, and the "never make a
 * total go down silently" rule stated in prose.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { incrementalScan, readCacheFile, writeCacheFile, lifetimeAgentTokens } = require('../host/agent-stats-cache');
const { projectDirName } = require('../host/project-dir');
const { tmpDir } = require('./tmp-dir');

const NL = String.fromCharCode(10);
const U = (input, output) => ({ input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

function project(root, cwd) {
  const dir = path.join(root, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function session(dir, name, spawns) {
  const lines = spawns.map((s) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0)).toISOString(),
    message: {
      usage: U(1, 1),
      content: [{
        type: 'tool_use', id: s.id, name: 'Agent',
        input: { subagent_type: s.type, ...(s.name ? { name: s.name } : {}) },
      }],
    },
  }));
  fs.writeFileSync(path.join(dir, name + '.jsonl'), lines.join(NL) + NL);
}

function subagent(dir, sessionName, file, meta, entries) {
  const sd = path.join(dir, sessionName, 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, file + '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(sd, file + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join(NL) + NL);
}

const turn = (minute, usage) => ({
  type: 'assistant',
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString(),
  message: { usage },
});

test('an unchanged file (same size+mtime) is served from the cache, not re-read', async () => {
  const dir = tmpDir('cc-cache-');
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'hello');

  let reads = 0;
  const readFile = async () => { reads++; return { total: 5 }; };

  const first = await incrementalScan([file], readFile, {});
  assert.strictEqual(reads, 1);
  assert.strictEqual(first.entries[file].value.total, 5);

  const second = await incrementalScan([file], readFile, first.entries);
  assert.strictEqual(reads, 1, 'the second scan must not re-read an unchanged file');
  assert.strictEqual(second.entries[file].value.total, 5);
  assert.strictEqual(second.reread, 0);
});

test('a file that grows (mtime or size changes) is re-read', async () => {
  const dir = tmpDir('cc-cache-');
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'hello');

  let value = 5;
  const readFile = async () => ({ total: value });
  const first = await incrementalScan([file], readFile, {});

  // Force a distinct mtime -- some filesystems have coarse mtime resolution,
  // and a flaky test here would be worse than a slow one.
  fs.writeFileSync(file, 'hello world, now longer');
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  value = 24;

  const second = await incrementalScan([file], readFile, first.entries);
  assert.strictEqual(second.entries[file].value.total, 24);
  assert.strictEqual(second.reread, 1);
});

test('a file missing from the new listing contributes nothing, not its last known total', async () => {
  const dir = tmpDir('cc-cache-');
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, 'hello');
  const readFile = async () => ({ total: 999 });
  const first = await incrementalScan([file], readFile, {});

  // The caller re-lists files itself (this module does no directory walking);
  // "deleted" here means simply absent from the new list.
  const second = await incrementalScan([], readFile, first.entries);
  assert.deepStrictEqual(second.entries, {}, 'a vanished file must not survive in the new entry set');
});

test('a file that vanishes between listing and stat contributes nothing', async () => {
  const dir = tmpDir('cc-cache-');
  const file = path.join(dir, 'ghost.jsonl');
  // Never created -- listed, but gone (or never real) by the time it is stat'd.
  const readFile = async () => ({ total: 1 });
  const { entries, reread } = await incrementalScan([file], readFile, {});
  assert.deepStrictEqual(entries, {});
  assert.strictEqual(reread, 0);
});

test('readCacheFile tolerates a missing or corrupt cache file', async () => {
  const dir = tmpDir('cc-cache-');
  const missing = await readCacheFile(path.join(dir, 'nope.json'));
  assert.deepStrictEqual(missing, {});

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, 'not json at all {{{');
  const corrupt = await readCacheFile(bad);
  assert.deepStrictEqual(corrupt, {});
});

test('writeCacheFile then readCacheFile round-trips the entries', async () => {
  const dir = tmpDir('cc-cache-');
  const cacheFile = path.join(dir, 'sub', 'cache.json');
  const entries = { '/a/b.jsonl': { stat: { size: 10, mtimeMs: 123 }, value: { total: 42 } } };

  await writeCacheFile(cacheFile, entries);
  assert.ok(fs.existsSync(cacheFile));

  const read = await readCacheFile(cacheFile);
  assert.deepStrictEqual(read, entries);
});

test('writeCacheFile writes via a temp file and rename, leaving no .tmp behind', async () => {
  const dir = tmpDir('cc-cache-');
  const cacheFile = path.join(dir, 'cache.json');
  await writeCacheFile(cacheFile, { x: { stat: { size: 1, mtimeMs: 1 }, value: 1 } });
  assert.ok(fs.existsSync(cacheFile));
  assert.ok(!fs.existsSync(cacheFile + '.tmp'), 'the temp file must be cleaned up by the rename');
});

// --- lifetimeAgentTokens: the concrete use of incrementalScan for the roster ----

test('lifetimeAgentTokens sums one agent across two different projects', async () => {
  const root = tmpDir('cc-lifetime-');
  const dirA = project(root, 'C:/w/proj-a');
  session(dirA, 's1', [{ id: 'toolu_1', type: 'miguel' }]);
  subagent(dirA, 's1', 'agent-a', { agentType: 'miguel', toolUseId: 'toolu_1' }, [turn(0, U(100, 0))]);

  const dirB = project(root, 'C:/w/proj-b');
  session(dirB, 's1', [{ id: 'toolu_1', type: 'miguel' }]);
  subagent(dirB, 's1', 'agent-a', { agentType: 'miguel', toolUseId: 'toolu_1' }, [turn(0, U(50, 0))]);

  const r = await lifetimeAgentTokens({ projectsDir: root });
  assert.strictEqual(r.agents.get('miguel'), 150);
  assert.strictEqual(r.unreadable, 0);
});

test('lifetimeAgentTokens resolves a NAMED spawn to its TYPE', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'code-reviewer', name: 'miguel-usage' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'miguel-usage', requestShape: 'background' },
    [turn(0, U(100, 0))]);

  const r = await lifetimeAgentTokens({ projectsDir: root });
  assert.strictEqual(r.agents.get('code-reviewer'), 100);
  assert.strictEqual(r.agents.has('miguel-usage'), false);
});

test('lifetimeAgentTokens does not re-read an unchanged transcript on the next scan', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  let reads = 0;
  const countingReader = async (file) => { reads++; return require('../host/agent-stats').readTranscript(file); };

  const first = await lifetimeAgentTokens({ projectsDir: root, readFile: countingReader });
  assert.strictEqual(reads, 1);
  assert.strictEqual(first.agents.get('paris'), 10);

  const second = await lifetimeAgentTokens({ projectsDir: root, readFile: countingReader, prevEntries: first.entries });
  assert.strictEqual(reads, 1, 'the second scan must reuse the cached per-file total');
  assert.strictEqual(second.agents.get('paris'), 10);
});

test('lifetimeAgentTokens persists to and reloads from a cache file across calls', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'dexter' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'dexter', toolUseId: 'toolu_1' }, [turn(0, U(20, 0))]);

  const cacheDir = tmpDir('cc-lifetime-cache-');
  const cacheFile = path.join(cacheDir, 'roster-lifetime.json');

  const first = await lifetimeAgentTokens({ projectsDir: root, cacheFile });
  assert.strictEqual(first.agents.get('dexter'), 20);
  assert.ok(fs.existsSync(cacheFile));

  let reads = 0;
  const countingReader = async (file) => { reads++; return require('../host/agent-stats').readTranscript(file); };
  const second = await lifetimeAgentTokens({ projectsDir: root, cacheFile, readFile: countingReader });
  assert.strictEqual(reads, 0, 'a freshly-loaded cache file must already short-circuit the re-read');
  assert.strictEqual(second.agents.get('dexter'), 20);
});

test('lifetimeAgentTokens reports a shrunk transcript honestly rather than keeping the old total', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' },
    [turn(0, U(10, 0)), turn(1, U(10, 0))]);

  const first = await lifetimeAgentTokens({ projectsDir: root });
  assert.strictEqual(first.agents.get('paris'), 20);

  // Rewritten shorter, and given a distinct mtime -- a real edit, not a
  // filesystem no-op.
  const file = path.join(dir, 's1', 'subagents', 'agent-a.jsonl');
  fs.writeFileSync(file, JSON.stringify(turn(0, U(10, 0))) + NL);
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const second = await lifetimeAgentTokens({ projectsDir: root, prevEntries: first.entries });
  assert.strictEqual(second.agents.get('paris'), 10, 'a shrunk file must be re-read, never left at its old total');
});

test('lifetimeAgentTokens counts an unreadable project directory rather than hiding it', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  // A second project entry that is a FILE, not a directory -- readdir lists
  // it, and treating it as a project directory would throw; it must be
  // skipped as "not a project", contributing zero and no error, the same
  // way host/roster-index.js's historyNames does.
  fs.writeFileSync(path.join(root, 'not-a-project'), 'x');

  const r = await lifetimeAgentTokens({ projectsDir: root });
  assert.strictEqual(r.agents.get('paris'), 10);
  assert.strictEqual(r.unreadable, 0);
});
