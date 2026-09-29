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

const {
  incrementalScan, readCacheFile, writeCacheFile, readCacheSummary, readCacheSeed,
  lifetimeAgentTokens, CACHE_VERSION,
} = require('../host/agent-stats-cache');
const { scanProjects } = require('../host/roster-index');
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

// --- Dexter F1 (High): a per-file read failure must never abort the scan -----

test('incrementalScan counts a thrown read failure rather than rejecting the whole scan', async () => {
  const dir = tmpDir('cc-cache-');
  const good = path.join(dir, 'good.jsonl');
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(good, 'hello');
  fs.writeFileSync(bad, 'hello');

  const readFile = async (file) => {
    if (file === bad) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return { total: 7 };
  };

  const { entries, failures, failedFiles } = await incrementalScan([good, bad], readFile, {});
  assert.strictEqual(failures, 1);
  assert.deepStrictEqual(failedFiles, [bad]);
  assert.strictEqual(entries[good].value.total, 7);
  assert.strictEqual(entries[bad], undefined, 'a failed read must not be cached under a fabricated value');
});

// --- Dexter N4 (Low), PR #59 R2: a failure is logged, not swallowed silently --

test('incrementalScan logs the failing path and error code rather than swallowing it silently', async () => {
  const dir = tmpDir('cc-cache-');
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, 'hello');

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const readFile = async () => { throw new TypeError('unexpected line shape'); };
    await incrementalScan([bad], readFile, {});
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(warnings.length, 1, 'exactly one warning must be logged for the one failure');
  assert.ok(warnings[0].includes(bad), 'the warning must name the file');
  assert.ok(/TypeError|unexpected line shape/.test(warnings[0]), 'the warning must name the error');
});

test('a file whose read fails is retried on the next scan, not cached as permanently unreadable', async () => {
  const dir = tmpDir('cc-cache-');
  const file = path.join(dir, 'flaky.jsonl');
  fs.writeFileSync(file, 'hello');

  let attempt = 0;
  const readFile = async () => {
    attempt++;
    if (attempt === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return { total: 9 };
  };

  const first = await incrementalScan([file], readFile, {});
  assert.strictEqual(first.failures, 1);
  assert.deepStrictEqual(first.entries, {});

  const second = await incrementalScan([file], readFile, first.entries);
  assert.strictEqual(second.failures, 0);
  assert.strictEqual(second.entries[file].value.total, 9);
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

test('writeCacheFile writes via a PER-PID temp file and rename, leaving no debris behind', async () => {
  // Dexter F7: two host processes sharing this install-wide cache file
  // (host.js: HARNESS_DIR is install-wide) both writing a FIXED `.tmp` name
  // could interleave -- B's write landing mid-A's-write, then A's rename
  // committing a file that is neither snapshot. A tmp name keyed on
  // `process.pid` keeps concurrent writers from two different processes from
  // colliding with EACH OTHER.
  const dir = tmpDir('cc-cache-');
  const cacheFile = path.join(dir, 'cache.json');
  await writeCacheFile(cacheFile, { x: { stat: { size: 1, mtimeMs: 1 }, value: 1 } });
  assert.ok(fs.existsSync(cacheFile));
  assert.ok(!fs.existsSync(cacheFile + `.${process.pid}.tmp`),
    'the per-pid temp file must be cleaned up by the rename');
  // No OTHER leftover file beside the real cache either -- catches a
  // regression back to a shared fixed name just as well as the exact check
  // above.
  const leftovers = fs.readdirSync(dir).filter(f => f !== 'cache.json');
  assert.deepStrictEqual(leftovers, []);
});

// --- Dexter F6 (Low, fixed as cheap): a schema version, and no NaN from a --
// --- cache entry that predates a shape change -----------------------------

test('a cache file written by this module carries a version', async () => {
  const dir = tmpDir('cc-cache-');
  const cacheFile = path.join(dir, 'cache.json');
  await writeCacheFile(cacheFile, { x: { stat: { size: 1, mtimeMs: 1 }, value: 1 } });
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.strictEqual(raw.version, CACHE_VERSION);
});

test('readCacheFile treats a cache from a DIFFERENT version as empty, not as trusted stale data', async () => {
  const dir = tmpDir('cc-cache-');
  const cacheFile = path.join(dir, 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: CACHE_VERSION + 1,
    entries: { '/a/b.jsonl': { stat: { size: 1, mtimeMs: 1 }, value: { total: 999 } } },
  }));
  const entries = await readCacheFile(cacheFile);
  assert.deepStrictEqual(entries, {});
});

test('readCacheSummary round-trips a per-agent lifetime summary written alongside the entries', async () => {
  const dir = tmpDir('cc-cache-');
  const cacheFile = path.join(dir, 'cache.json');
  await writeCacheFile(cacheFile, {}, { agents: { paris: { tokens: 42, ms: 100 } } });
  const summary = await readCacheSummary(cacheFile);
  assert.deepStrictEqual(summary, { paris: { tokens: 42, ms: 100 } });
});

test('readCacheSummary tolerates a missing cache file or a stale version', async () => {
  const dir = tmpDir('cc-cache-');
  assert.deepStrictEqual(await readCacheSummary(path.join(dir, 'nope.json')), {});

  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ version: CACHE_VERSION + 1, agents: { x: { tokens: 1 } } }));
  assert.deepStrictEqual(await readCacheSummary(stale), {});
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

// --- Dexter F1 (High), integrated: one unreadable transcript must not empty --
// --- the whole roster --------------------------------------------------------

test('lifetimeAgentTokens resolves and reports unreadable when one of two transcripts throws EBUSY', async () => {
  const root = tmpDir('cc-lifetime-');
  const dirA = project(root, 'C:/w/proj-a');
  session(dirA, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dirA, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const dirB = project(root, 'C:/w/proj-b');
  session(dirB, 's1', [{ id: 'toolu_1', type: 'dexter' }]);
  subagent(dirB, 's1', 'agent-a', { agentType: 'dexter', toolUseId: 'toolu_1' }, [turn(0, U(5, 0))]);
  const busyFile = path.join(dirB, 's1', 'subagents', 'agent-a.jsonl');

  const cacheDir = tmpDir('cc-lifetime-cache-');
  const cacheFile = path.join(cacheDir, 'roster-lifetime.json');
  const flakyReader = async (file) => {
    if (file === busyFile) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return require('../host/agent-stats').readTranscript(file);
  };

  const r = await lifetimeAgentTokens({ projectsDir: root, cacheFile, readFile: flakyReader });
  assert.strictEqual(r.agents.get('paris'), 10, 'the OTHER project\'s total must still resolve');
  assert.ok(r.unreadable >= 1, 'the EBUSY transcript must count as unreadable, never silently dropped');
  assert.ok(fs.existsSync(cacheFile), 'the cache must still be written for what DID succeed');
});

// --- Dexter N2 (Medium), PR #59 R2: "ran, unreadable" must not be "never used" -

test('an agent whose ONLY transcript fails to read is NOT drawn like a never-used definition', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'bar' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'bar', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);
  const busyFile = path.join(dir, 's1', 'subagents', 'agent-a.jsonl');

  const flakyReader = async (file) => {
    if (file === busyFile) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return require('../host/agent-stats').readTranscript(file);
  };

  const r = await lifetimeAgentTokens({ projectsDir: root, readFile: flakyReader });
  assert.strictEqual(r.agents.has('bar'), false, 'no total can be claimed for an unreadable-only agent');
  assert.ok(r.unreadableAgents.has('bar'),
    'but it must be flagged as "ran, unreadable" -- the never-used shape (agents.has === false, ' +
    'unreadableAgents.has === false) is reserved for a definition that has genuinely never run');
});

test('an agent with one readable and one unreadable transcript keeps the readable total AND the flag', async () => {
  const root = tmpDir('cc-lifetime-');
  const dirA = project(root, 'C:/w/proj-a');
  session(dirA, 's1', [{ id: 'toolu_1', type: 'bar' }]);
  subagent(dirA, 's1', 'agent-a', { agentType: 'bar', toolUseId: 'toolu_1' }, [turn(0, U(30, 0))]);

  const dirB = project(root, 'C:/w/proj-b');
  session(dirB, 's1', [{ id: 'toolu_1', type: 'bar' }]);
  subagent(dirB, 's1', 'agent-a', { agentType: 'bar', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);
  const busyFile = path.join(dirB, 's1', 'subagents', 'agent-a.jsonl');

  const flakyReader = async (file) => {
    if (file === busyFile) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return require('../host/agent-stats').readTranscript(file);
  };

  const r = await lifetimeAgentTokens({ projectsDir: root, readFile: flakyReader });
  assert.strictEqual(r.agents.get('bar'), 30, 'the readable project must still contribute');
  assert.ok(r.unreadableAgents.has('bar'), 'the total is a lower bound, not the whole truth');
});

// --- Dexter F4, integrated: a corrupt meta.json must count, not vanish -------

test('lifetimeAgentTokens counts a corrupt meta.json as unreadable rather than dropping the run', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  const sd = path.join(dir, 's1', 'subagents');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'agent-a.meta.json'), '{"agentType":'); // truncated
  fs.writeFileSync(path.join(sd, 'agent-a.jsonl'), JSON.stringify(turn(0, U(10, 0))) + NL);

  const r = await lifetimeAgentTokens({ projectsDir: root });
  assert.strictEqual(r.unreadable, 1);
});

// --- Dexter F3 / Miguel L1, integrated -----------------------------------------

test('lifetimeAgentTokens marks an unresolved label rather than treating it as a confirmed type', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  // No parent session at all -- the name can never be resolved.
  subagent(dir, 's1', 'agent-a', { agentType: 'miguel-usage', requestShape: 'background' },
    [turn(0, U(10, 0))]);

  const r = await lifetimeAgentTokens({ projectsDir: root });
  assert.strictEqual(r.agents.get('miguel-usage'), 10, 'the tokens are still real and still counted');
  assert.ok(r.unresolvedAgents.has('miguel-usage'), 'but it must be flagged, not drawn as a confirmed type');
});

// --- Dexter F5 / Miguel M1: a shared scan is accepted rather than re-walked --

test('lifetimeAgentTokens accepts a pre-computed scan instead of walking the tree again', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const scan = await scanProjects(root);
  const r = await lifetimeAgentTokens({ scan });
  assert.strictEqual(r.agents.get('paris'), 10);
});

// --- Dexter F6, integrated: a schema-drifted cache entry sums as 0, not NaN --

test('a cache entry with no usable value sums as 0 rather than poisoning the agent total with NaN', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);
  const file = path.join(dir, 's1', 'subagents', 'agent-a.jsonl');
  const stat = fs.statSync(file);

  // A cache entry whose stat still matches but whose value predates today's
  // shape (as if written by an older version) -- must not survive `readCacheFile`
  // at all once a version is enforced, but `incrementalScan`'s own summing must
  // also not trust a malformed `value` blindly.
  const poisoned = { [file]: { stat: { size: stat.size, mtimeMs: stat.mtimeMs }, value: {} } };

  const r = await lifetimeAgentTokens({ projectsDir: root, prevEntries: poisoned });
  assert.strictEqual(r.agents.get('paris'), 0);
  assert.ok(!Number.isNaN(r.agents.get('paris')));
});

// --- Dexter F5: the "≥ until the first full pass" lower bound must be reachable

test('readCacheSummary lets a caller seed a lower-bound roster before the pass resolves', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const cacheDir = tmpDir('cc-lifetime-cache-');
  const cacheFile = path.join(cacheDir, 'roster-lifetime.json');
  await lifetimeAgentTokens({ projectsDir: root, cacheFile });

  // A LATER launch, before its own scan has resolved, can read the cache
  // file's summary directly and have SOMETHING to show immediately.
  const summary = await readCacheSummary(cacheFile);
  assert.strictEqual(summary.paris.tokens, 10);
});

// --- Dexter N1 (Medium), PR #59 R2: the seed must be a GENUINE lower bound ----

test('readCacheSeed drops a vanished file\'s contribution rather than overstating the seed (Dexter N1)', async () => {
  // The exact counterexample from the review: agent "foo" has two transcripts
  // (60k and 40k). One is deleted (Claude Code's own retention cleanup, for
  // instance) before the next launch's seed is read. The seed must show 40k,
  // never the stale 100k the raw summary alone would carry.
  const root = tmpDir('cc-lifetime-');
  const dirA = project(root, 'C:/w/proj-a');
  session(dirA, 's1', [{ id: 'toolu_1', type: 'foo' }]);
  subagent(dirA, 's1', 'agent-a', { agentType: 'foo', toolUseId: 'toolu_1' }, [turn(0, U(60000, 0))]);
  const fileA = path.join(dirA, 's1', 'subagents', 'agent-a.jsonl');

  const dirB = project(root, 'C:/w/proj-b');
  session(dirB, 's1', [{ id: 'toolu_1', type: 'foo' }]);
  subagent(dirB, 's1', 'agent-a', { agentType: 'foo', toolUseId: 'toolu_1' }, [turn(0, U(40000, 0))]);

  const cacheDir = tmpDir('cc-lifetime-cache-');
  const cacheFile = path.join(cacheDir, 'roster-lifetime.json');
  const first = await lifetimeAgentTokens({ projectsDir: root, cacheFile });
  assert.strictEqual(first.agents.get('foo'), 100000, 'precondition: both transcripts are counted');

  // Simulate the CLI's own cleanup removing the older (60k) transcript before
  // the next host launch reads the seed.
  fs.unlinkSync(fileA);

  const seed = await readCacheSeed(cacheFile);
  assert.strictEqual(seed.foo.tokens, 40000,
    'the seed must never claim more than the files that still exist actually total');
});

test('readCacheSeed matches readCacheSummary when nothing has been deleted', async () => {
  const root = tmpDir('cc-lifetime-');
  const dir = project(root, 'C:/w/proj-a');
  session(dir, 's1', [{ id: 'toolu_1', type: 'paris' }]);
  subagent(dir, 's1', 'agent-a', { agentType: 'paris', toolUseId: 'toolu_1' }, [turn(0, U(10, 0))]);

  const cacheDir = tmpDir('cc-lifetime-cache-');
  const cacheFile = path.join(cacheDir, 'roster-lifetime.json');
  await lifetimeAgentTokens({ projectsDir: root, cacheFile });

  const seed = await readCacheSeed(cacheFile);
  assert.strictEqual(seed.paris.tokens, 10);
});

test('readCacheSeed tolerates a missing cache file or a stale version', async () => {
  const dir = tmpDir('cc-cache-');
  assert.deepStrictEqual(await readCacheSeed(path.join(dir, 'nope.json')), {});

  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ version: CACHE_VERSION + 1, files: { x: { agent: 'a', total: 1 } } }));
  assert.deepStrictEqual(await readCacheSeed(stale), {});
});
