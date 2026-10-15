'use strict';
/**
 * Terminal sessions in a worktree (Extension X1: warn, never block). Read off
 * the CLI's own registry, `~/.claude/sessions/<pid>.json`, whose format
 * verify/probe-session-registry.js pins. A session counts when it is in the
 * same worktree (same git-dir, so a subfolder counts and a sibling doesn't),
 * and its pid is alive with the start time the CLI recorded -- the registry
 * can hold files for sessions that are gone.
 *
 * `<pid>.<hash>.key` beside each file holds a peer token and is never opened.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { liveSessionsIn, defaultRegistryDir } = require('../host/session-registry');
const { tmpDir } = require('./tmp-dir');

function makeContainer() {
  const base = tmpDir('registry-layout-');
  const devGit = path.join(base, 'dev', '.git');
  fs.mkdirSync(devGit, { recursive: true });
  fs.writeFileSync(path.join(devGit, 'HEAD'), 'ref: refs/heads/develop\n');
  const wtGit = path.join(devGit, 'worktrees', 'feat-x');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feat/x\n');
  const wt = path.join(base, 'feat-x');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  return { base, dev: path.join(base, 'dev'), wt };
}

function registry(entries) {
  const dir = tmpDir('registry-');
  for (const e of entries) {
    const name = e.file || `${e.pid}.json`;
    fs.writeFileSync(path.join(dir, name), typeof e.doc === 'string' ? e.doc : JSON.stringify(e.doc));
  }
  return dir;
}

const entry = (pid, cwd, extra = {}) => ({
  pid, doc: { pid, sessionId: `s-${pid}`, cwd, procStart: `ft-${pid}`, status: 'idle', startedAt: 1790000000000, kind: 'interactive', ...extra },
});

// Every pid in `alive` is running with the start time the registry recorded,
// unless `alive` maps it to something else.
function osWith(alive) {
  const calls = [];
  return {
    calls,
    startTimes: async pids => {
      calls.push(pids);
      const m = new Map();
      for (const pid of pids) if (pid in alive) m.set(pid, alive[pid] === true ? `ft-${pid}` : alive[pid]);
      return m;
    },
  };
}

test('a live session in the worktree is found, however its cwd is spelled', async () => {
  const { wt } = makeContainer();
  const spelled = wt.toUpperCase().replace(/\\/g, '/') + '/';
  const dir = registry([entry(11, spelled)]);
  const r = await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) });
  assert.deepStrictEqual(r, {
    format: 'ok', verified: true,
    sessions: [{ pid: 11, sessionId: 's-11', status: 'idle', startedAt: 1790000000000 }],
  });
});

test('a session in a subfolder of the worktree counts', async () => {
  const { wt } = makeContainer();
  const dir = registry([entry(11, path.join(wt, 'sub'))]);
  const r = await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) });
  assert.deepStrictEqual(r.sessions.map(s => s.pid), [11]);
});

test('a session in another worktree of the same project does not', async () => {
  const { wt, dev } = makeContainer();
  const dir = registry([entry(11, dev), entry(12, wt)]);
  assert.deepStrictEqual((await liveSessionsIn(wt, { dir, ...osWith({ 11: true, 12: true }) })).sessions.map(s => s.pid), [12]);
  assert.deepStrictEqual((await liveSessionsIn(dev, { dir, ...osWith({ 11: true, 12: true }) })).sessions.map(s => s.pid), [11]);
});

test('a dead pid, a reused pid and an unreadable start time are not sessions', async () => {
  const { wt } = makeContainer();
  const dir = registry([entry(11, wt), entry(12, wt), entry(13, wt), entry(14, wt)]);
  const r = await liveSessionsIn(wt, { dir, ...osWith({ 12: 'ft-other', 13: null, 14: true }) });
  assert.deepStrictEqual(r.sessions.map(s => s.pid), [14]);
});

test('this host\'s own session is excluded by pid and by session id', async () => {
  const { wt } = makeContainer();
  const dir = registry([entry(11, wt), entry(12, wt), entry(13, wt)]);
  const r = await liveSessionsIn(wt, {
    dir, ...osWith({ 11: true, 12: true, 13: true }), exclude: { pids: [11], sessionIds: ['s-12'] },
  });
  assert.deepStrictEqual(r.sessions.map(s => s.pid), [13]);
});

test('the OS is asked once, for every candidate pid together', async () => {
  const { wt, dev } = makeContainer();
  const dir = registry([entry(11, wt), entry(12, wt), entry(13, dev)]);
  const os = osWith({ 11: true, 12: true });
  await liveSessionsIn(wt, { dir, ...os });
  assert.deepStrictEqual(os.calls.map(c => [...c].sort()), [[11, 12]]);
});

test('no candidates, no OS query', async () => {
  const { wt, dev } = makeContainer();
  const os = osWith({});
  const r = await liveSessionsIn(wt, { dir: registry([entry(13, dev)]), ...os });
  assert.deepStrictEqual(r, { format: 'ok', verified: true, sessions: [] });
  assert.strictEqual(os.calls.length, 0);
});

test('when the OS cannot be asked, nothing is shown and the result says so', async () => {
  const { wt } = makeContainer();
  const dir = registry([entry(11, wt)]);
  const r = await liveSessionsIn(wt, { dir, startTimes: async () => null });
  assert.deepStrictEqual(r, { format: 'ok', verified: false, sessions: [] });
});

test('.key files are never opened', async () => {
  const { wt } = makeContainer();
  const dir = registry([entry(11, wt), { file: '11.abc123.key', doc: 'SECRET' }]);
  const real = fs.readFileSync;
  const opened = [];
  fs.readFileSync = (p, ...rest) => { opened.push(String(p)); return real.call(fs, p, ...rest); };
  try {
    await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) });
  } finally {
    fs.readFileSync = real;
  }
  assert.ok(opened.length > 0, 'the registry was not read at all');
  assert.deepStrictEqual(opened.filter(p => !p.endsWith('.json') && p.startsWith(dir)), []);
});

test('an unparseable file is skipped and the rest still count', async () => {
  const { wt } = makeContainer();
  const dir = registry([{ file: '10.json', doc: '{not json' }, entry(11, wt)]);
  const r = await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) });
  assert.strictEqual(r.format, 'ok');
  assert.deepStrictEqual(r.sessions.map(s => s.pid), [11]);
});

test('a registry whose files have lost the fields we read is an unknown format', async () => {
  const { wt } = makeContainer();
  const dir = registry([{ file: '11.json', doc: { id: 11, dir: wt } }, { file: '12.json', doc: { pid: '12', cwd: wt, procStart: 5 } }]);
  assert.deepStrictEqual(await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) }),
    { format: 'unknown', verified: false, sessions: [] });
});

test('no registry folder is an unknown format; an empty one is simply no sessions', async () => {
  const { wt } = makeContainer();
  const missing = path.join(tmpDir('registry-'), 'nope');
  assert.deepStrictEqual(await liveSessionsIn(wt, { dir: missing, ...osWith({}) }),
    { format: 'unknown', verified: false, sessions: [] });
  assert.deepStrictEqual(await liveSessionsIn(wt, { dir: tmpDir('registry-empty-'), ...osWith({}) }),
    { format: 'ok', verified: true, sessions: [] });
});

test('fields of the wrong type come back as null', async () => {
  const { wt } = makeContainer();
  const dir = registry([entry(11, wt, { sessionId: 4, status: null, startedAt: '1790' })]);
  const r = await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) });
  assert.deepStrictEqual(r.sessions, [{ pid: 11, sessionId: null, status: null, startedAt: null }]);
});

test('a pid that is not a positive integer is never a candidate', async () => {
  const { wt } = makeContainer();
  const dir = registry([
    { file: 'a.json', doc: { pid: 0, cwd: wt, procStart: 'x' } },
    { file: 'b.json', doc: { pid: -3, cwd: wt, procStart: 'x' } },
    { file: 'c.json', doc: { pid: 1.5, cwd: wt, procStart: 'x' } },
    entry(11, wt),
  ]);
  const os = osWith({ 11: true });
  await liveSessionsIn(wt, { dir, ...os });
  assert.deepStrictEqual(os.calls, [[11]]);
});

test('a folder outside any repo has no worktree, so nothing is in it', async () => {
  const plain = tmpDir('registry-plain-');
  const dir = registry([entry(11, plain)]);
  assert.deepStrictEqual((await liveSessionsIn(plain, { dir, ...osWith({ 11: true }) })).sessions, []);
});

test('the registry lives under CLAUDE_CONFIG_DIR when it is set', () => {
  const was = process.env.CLAUDE_CONFIG_DIR;
  try {
    const cfg = path.join(path.parse(process.cwd()).root, 'cfg');
    process.env.CLAUDE_CONFIG_DIR = cfg;
    assert.strictEqual(defaultRegistryDir(), path.join(cfg, 'sessions'));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.strictEqual(defaultRegistryDir(), path.join(require('os').homedir(), '.claude', 'sessions'));
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
  }
});

// Dexter, PR #71 F7: `verified: true` must mean "every live session here is
// accounted for". A file we could not read, or one that has lost the fields
// we read, may be a session we cannot see; a live session whose start time
// the OS will not give is one we cannot confirm. Either way: not verified,
// so the banner never claims "1 other session" when there may be two.

test('an unreadable session file among good ones means the answer is not verified', async () => {
  const { wt } = makeContainer();
  const dir = registry([{ file: '10.json', doc: '{not json' }, entry(11, wt)]);
  const r = await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) });
  assert.strictEqual(r.format, 'ok');
  assert.strictEqual(r.verified, false);
});

test('a file in an old or new format beside good ones means not verified either', async () => {
  const { wt } = makeContainer();
  const dir = registry([{ file: '10.json', doc: { id: 10, dir: wt } }, entry(11, wt)]);
  assert.strictEqual((await liveSessionsIn(wt, { dir, ...osWith({ 11: true }) })).verified, false);
});

test('a live candidate whose start time the OS will not give means not verified', async () => {
  const { wt } = makeContainer();
  const dir = registry([entry(11, wt), entry(12, wt)]);
  const r = await liveSessionsIn(wt, { dir, ...osWith({ 11: true, 12: null }) });
  assert.strictEqual(r.verified, false);
  assert.deepStrictEqual(r.sessions.map(s => s.pid), [11], 'what it could confirm is still listed');
});
