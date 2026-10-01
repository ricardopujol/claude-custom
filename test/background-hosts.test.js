'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { listBackgroundHosts, filetimeToMs } = require('../host/background-hosts');

const OWN = 'C:\\cc\\feat-a';
const OTHER = 'C:\\cc\\dev';
// A FILETIME (100 ns ticks since 1601) for a given epoch ms.
const ft = ms => String((BigInt(ms) + 11644473600000n) * 10000n);

// A world: install -> { port: identity-as-parsed }, live processes pid -> OS
// start time, and the OS window counts.
function world(over = {}) {
  const w = {
    files: {
      [OWN]: { 7701: { port: 7701, cwd: 'C:\\proj', pid: 101, startedAt: 5000 } },
      [OTHER]: { 7702: { port: 7702, cwd: 'C:\\other', pid: 202, startedAt: 9000 } },
    },
    procs: new Map([[101, ft(4800)], [202, ft(8700)]]),
    windows: new Map([[101, 0], [202, 2]]),
    ...over,
  };
  const calls = { startTimes: [], windowCounts: [] };
  const deps = {
    installs: () => Object.keys(w.files),
    identities: install => Object.entries(w.files[install] || {}).map(([port, parsed]) => ({ port: Number(port), parsed })),
    startTimes: async (pids) => {
      calls.startTimes.push(pids);
      if (w.procs === null) return null;
      return new Map(pids.filter(p => w.procs.has(p)).map(p => [p, w.procs.get(p)]));
    },
    windowCounts: async (targets) => {
      calls.windowCounts.push(targets);
      if (w.windows === null) return null;
      return new Map(targets.filter(t => w.windows.has(t.pid)).map(t => [t.pid, w.windows.get(t.pid)]));
    },
  };
  return { w, deps, calls };
}

const list = deps => listBackgroundHosts({ ownInstall: OWN }, deps);

test('filetimeToMs converts a FILETIME string to epoch ms', () => {
  assert.strictEqual(filetimeToMs(ft(1790000000123)), 1790000000123);
  assert.strictEqual(filetimeToMs('116444736000000000'), 0);
  for (const bad of [null, undefined, '', 'abc', '12.5', '-1', 5]) assert.strictEqual(filetimeToMs(bad), null, String(bad));
});

test('lists a proven host from every install, own first, with build and windows', async () => {
  const { deps } = world();
  const r = await list(deps);
  assert.strictEqual(r.verified, true);
  assert.deepStrictEqual(r.rows, [
    { install: OWN, build: 'feat-a', own: true, port: 7701, pid: 101, cwd: 'C:\\proj', startedAt: 5000, processStartedAt: ft(4800), windows: 0 },
    { install: OTHER, build: 'dev', own: false, port: 7702, pid: 202, cwd: 'C:\\other', startedAt: 9000, processStartedAt: ft(8700), windows: 2 },
  ]);
});

test('a dead pid is never displayed, and the list stays verified', async () => {
  const { w, deps } = world();
  w.procs.delete(202);
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.pid), [101]);
  assert.strictEqual(r.verified, true);
});

test('a pid that started AFTER its identity was written is a reused pid: never displayed', async () => {
  const { w, deps } = world();
  w.procs.set(202, ft(9001));
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.pid), [101]);
  assert.strictEqual(r.verified, true);
});

test('a start time equal to the identity write still proves the host', async () => {
  const { w, deps } = world();
  w.procs.set(202, ft(9000));
  assert.deepStrictEqual((await list(deps)).rows.map(x => x.pid), [101, 202]);
});

test('the OS could not be asked: nothing is displayed, and it says so', async () => {
  const { w, deps } = world({ procs: null });
  void w;
  assert.deepStrictEqual(await list(deps), { rows: [], verified: false });
});

test('a live pid whose start time is unreadable is dropped, and the list is not verified', async () => {
  const { w, deps } = world();
  w.procs.set(202, null);
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.pid), [101]);
  assert.strictEqual(r.verified, false);
});

test('an unusable identity is skipped without being trusted', async () => {
  const bad = [
    null, 'x', [],
    { port: 7703, cwd: '', pid: 303, startedAt: 9000 },
    { port: 7703, cwd: '  ', pid: 303, startedAt: 9000 },
    { port: 7703, cwd: 'C:\\x', pid: 0, startedAt: 9000 },
    { port: 7703, cwd: 'C:\\x', pid: -1, startedAt: 9000 },
    { port: 7703, cwd: 'C:\\x', pid: 1.5, startedAt: 9000 },
    { port: 7703, cwd: 'C:\\x', pid: '303', startedAt: 9000 },
    { port: 7799, cwd: 'C:\\x', pid: 303, startedAt: 9000 },      // file says another port
    { port: 7703, cwd: 'C:\\x', pid: 303 },                        // no write time: unprovable
    { port: 7703, cwd: 'C:\\x', pid: 303, startedAt: null },
    { port: 7703, cwd: 'C:\\x', pid: 303, startedAt: '9000' },
  ];
  for (const parsed of bad) {
    const { w, deps } = world();
    w.files[OTHER] = { 7703: parsed };
    w.procs.set(303, ft(1));
    const r = await list(deps);
    assert.deepStrictEqual(r.rows.map(x => x.pid), [101], JSON.stringify(parsed));
  }
});

test('the port comes from the file name, and must be a real port', async () => {
  const { w, deps } = world();
  deps.identities = () => [{ port: 0, parsed: { port: 0, cwd: 'C:\\x', pid: 303, startedAt: 9000 } }];
  w.procs.set(303, ft(1));
  assert.deepStrictEqual((await list(deps)).rows, []);
});

test('one bad install does not hide the others', async () => {
  const { deps } = world();
  const real = deps.identities;
  deps.identities = (install) => { if (install === OTHER) throw new Error('EACCES'); return real(install); };
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.pid), [101]);
  assert.strictEqual(r.verified, false);
});

test('window counts are asked once for every proven host, never for the unproven', async () => {
  const { w, deps, calls } = world();
  w.procs.set(202, ft(9500));                 // reused
  await list(deps);
  assert.strictEqual(calls.startTimes.length, 1);
  assert.deepStrictEqual(calls.windowCounts, [[{ pid: 101, port: 7701 }]]);
});

test('no proven host: the window count is never asked', async () => {
  const { deps, calls } = world({ procs: new Map() });
  assert.deepStrictEqual(await list(deps), { rows: [], verified: true });
  assert.strictEqual(calls.windowCounts.length, 0);
});

test("windows the OS couldn't count are null, never 0", async () => {
  for (const windows of [null, new Map(), new Map([[101, null], [202, -1]]), new Map([[101, 1.5], [202, '2']])]) {
    const { deps } = world({ windows });
    const r = await list(deps);
    assert.deepStrictEqual(r.rows.map(x => x.windows), [null, null], String(windows));
  }
});

test('the same pid claimed by two files: only a file that proves it is shown', async () => {
  const { w, deps } = world();
  // An old leftover in another install names pid 101 too, written long before it started.
  w.files['C:\\cc\\old'] = { 7790: { port: 7790, cwd: 'C:\\stale', pid: 101, startedAt: 100 } };
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => [x.pid, x.port]), [[101, 7701], [202, 7702]]);
});

// Property: a row is shown iff its pid is alive with an OS start no later than
// its identity's write time -- and every shown row carries that OS start.
test('property: shown exactly when proven', async () => {
  const entry = fc.record({
    pid: fc.integer({ min: 1, max: 6 }),
    startedAt: fc.integer({ min: 1000, max: 2000 }),
    os: fc.option(fc.option(fc.integer({ min: 900, max: 2100 }), { nil: null }), { nil: undefined }),
  });
  await fc.assert(fc.asyncProperty(fc.array(entry, { maxLength: 6 }), async (entries) => {
    const files = { [OWN]: {} };
    const procs = new Map();
    entries.forEach((e, i) => {
      files[OWN][7000 + i] = { port: 7000 + i, cwd: 'C:\\p', pid: e.pid, startedAt: e.startedAt };
      if (e.os !== undefined) procs.set(e.pid, e.os === null ? null : ft(e.os));
    });
    const { deps } = world({ files, procs, windows: new Map() });
    const r = await list(deps);
    const expected = entries
      .map((e, i) => ({ e, port: 7000 + i }))
      .filter(({ e }) => procs.has(e.pid) && procs.get(e.pid) !== null && filetimeToMs(procs.get(e.pid)) <= e.startedAt)
      .map(({ port }) => port);
    assert.deepStrictEqual(r.rows.map(x => x.port).sort(), expected.sort());
    for (const row of r.rows) assert.strictEqual(row.processStartedAt, procs.get(row.pid));
    const unreadable = entries.some(e => procs.get(e.pid) === null);
    assert.strictEqual(r.verified, !unreadable);
  }), { numRuns: 300 });
});

// --- the real readers: which builds, and their identity files ---------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installsBeside, identitiesIn } = require('../host/background-hosts');
const { tmpDir } = require('./tmp-dir');

function tree() {
  const root = tmpDir('bg-hosts-');
  const build = (name, { hostJs = true, hosts = true } = {}) => {
    const dir = path.join(root, name);
    if (hostJs) { fs.mkdirSync(path.join(dir, 'host'), { recursive: true }); fs.writeFileSync(path.join(dir, 'host', 'host.js'), ''); }
    if (hosts) fs.mkdirSync(path.join(dir, '.harness', 'hosts'), { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { root, build };
}

test('installsBeside: this build and every sibling claude-custom build with a hosts dir', () => {
  const { root, build } = tree();
  const own = build('feat-a');
  const dev = build('dev');
  build('not-a-build', { hostJs: false });   // a hosts dir alone is not a build
  build('never-ran', { hosts: false });      // a build that never ran a host
  fs.writeFileSync(path.join(root, 'a-file.txt'), '');
  assert.deepStrictEqual(installsBeside(own).sort(), [dev, own].sort());
});

test('installsBeside: this build is listed even when its parent cannot be read', () => {
  const own = path.join(os.tmpdir(), 'bg-hosts-missing-' + process.pid, 'x');
  assert.deepStrictEqual(installsBeside(own), [own]);
});

test('identitiesIn: every <port>.json, parsed or null; never a token; port from the name', () => {
  const { build } = tree();
  const dir = build('dev');
  const hosts = path.join(dir, '.harness', 'hosts');
  fs.writeFileSync(path.join(hosts, '7701.json'), JSON.stringify({ port: 7701, cwd: 'C:/p', pid: 1, startedAt: 2 }));
  fs.writeFileSync(path.join(hosts, '7701.token'), 'secret');
  fs.writeFileSync(path.join(hosts, '7702.json'), '{half');
  fs.writeFileSync(path.join(hosts, '7703.json.tmp99'), '{}');
  fs.writeFileSync(path.join(hosts, 'abc.json'), '{}');
  const got = identitiesIn(dir).sort((a, b) => a.port - b.port);
  assert.deepStrictEqual(got, [
    { port: 7701, parsed: { port: 7701, cwd: 'C:/p', pid: 1, startedAt: 2 } },
    { port: 7702, parsed: null },
  ]);
});

test('identitiesIn: an install that never ran a host has none -- not an error', () => {
  const { build } = tree();
  assert.deepStrictEqual(identitiesIn(build('x', { hosts: false })), []);
});

test('identitiesIn: a hosts dir that cannot be listed throws (so the list says unverified)', () => {
  const { build } = tree();
  const dir = build('x', { hosts: false });
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, '.harness', 'hosts'), 'not a dir');
  assert.throws(() => identitiesIn(dir), { code: 'ENOTDIR' });
});
