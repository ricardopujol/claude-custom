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
    { install: OWN, build: 'feat-a', own: true, port: 7701, pid: 101, cwd: 'C:\\proj', claudePid: null, startedAt: 5000, processStartedAt: ft(4800), exact: false, windows: 0 },
    { install: OTHER, build: 'dev', own: false, port: 7702, pid: 202, cwd: 'C:\\other', claudePid: null, startedAt: 9000, processStartedAt: ft(8700), exact: false, windows: 2 },
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
  assert.deepStrictEqual(await list(deps), { rows: [], verified: false,
    doubts: [{ install: OWN, cwd: 'C:\\proj' }, { install: OTHER, cwd: 'C:\\other' }] });
});

test('a live pid whose start time is unreadable is dropped, and the list is not verified', async () => {
  const { w, deps } = world();
  w.procs.set(202, null);
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.pid), [101]);
  assert.strictEqual(r.verified, false);
  // PR 3: what it is unsure of, so a caller asking about ONE folder can tell.
  assert.deepStrictEqual(r.doubts, [{ install: OTHER, cwd: 'C:\\other' }]);
});

test('a row carries its claude pid from the identity, and null for anything but a real pid (PR #83 F1)', async () => {
  const { w, deps } = world();
  w.files[OWN][7701].claudePid = 4300;
  w.files[OTHER][7702].claudePid = '4300';
  const r = await list(deps);
  assert.strictEqual(r.rows.find(x => x.pid === 101).claudePid, 4300);
  assert.strictEqual(r.rows.find(x => x.pid === 202).claudePid, null);
});

test('a verified list has no doubts', async () => {
  const { deps } = world();
  assert.deepStrictEqual((await list(deps)).doubts, []);
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
  assert.deepStrictEqual(r.doubts, [{ install: OTHER, cwd: null }], 'an unlistable install could serve any folder');
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
  assert.deepStrictEqual(await list(deps), { rows: [], verified: true, doubts: [] });
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
    const provenFiles = entries
      .map((e, i) => ({ e, port: 7000 + i }))
      .filter(({ e }) => procs.has(e.pid) && procs.get(e.pid) !== null && filetimeToMs(procs.get(e.pid)) <= e.startedAt);
    // One row per proven pid (Miguel Y3), on a port one of its proven files names.
    const pids = [...new Set(provenFiles.map(({ e }) => e.pid))].sort();
    assert.deepStrictEqual(r.rows.map(x => x.pid).sort(), pids);
    for (const row of r.rows) {
      assert.ok(provenFiles.some(({ e, port }) => e.pid === row.pid && port === row.port), `row ${row.pid}:${row.port}`);
    }
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

// Dexter, PR #83 F3: falling back to this build alone hid every sibling's host
// with the list still "verified". Now it throws, and the list says so.
test('installsBeside: a parent it cannot read throws, rather than quietly listing this build alone', () => {
  const own = path.join(os.tmpdir(), 'bg-hosts-missing-' + process.pid, 'x');
  assert.throws(() => installsBeside(own));
});

test('a list whose builds could not all be found still lists this build, and doubts every folder', async () => {
  const { deps } = world();
  deps.installs = () => { throw new Error('EACCES'); };
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.pid), [101]);
  assert.strictEqual(r.verified, false);
  assert.deepStrictEqual(r.doubts, [{ install: null, cwd: null }]);
});

test('an identity it cannot READ (locked, denied) is a doubt about any folder, naming the file (PR #83 F3, R2-2)', async () => {
  const { deps } = world();
  const real = deps.identities;
  deps.identities = install => (install === OTHER ? [{ port: 7709, parsed: null, unreadable: true }] : real(install));
  const r = await list(deps);
  assert.deepStrictEqual(r.doubts, [{ install: OTHER, cwd: null, file: path.join(OTHER, '.harness', 'hosts', '7709.json') }]);
});

// Dexter, PR #83 R2-2: identities are written atomically (tmp + rename), so a
// file that won't parse, or names no pid, is never a host mid-write -- it's
// junk, and junk that never goes away must not block every --stop forever.
test('junk is no doubt: a file that will not parse, or names no pid', async () => {
  const { w, deps } = world();
  w.files[OTHER] = { 7709: null, 7710: { port: 7710, cwd: 'C:\\odd' } };
  const r = await list(deps);
  assert.deepStrictEqual(r.doubts, []);
  assert.strictEqual(r.verified, true);
});

test('an identity it cannot use is a doubt about its folder, while its pid runs (PR #83 F3)', async () => {
  const { w, deps } = world();
  w.files[OTHER] = { 7709: { port: 7709, cwd: 'C:\\odd', pid: 909, startedAt: 'yesterday' } };
  w.procs.set(909, ft(1));
  assert.deepStrictEqual((await list(deps)).doubts, [{ install: OTHER, cwd: 'C:\\odd', file: path.join(OTHER, '.harness', 'hosts', '7709.json') }]);
  w.procs.delete(909);                                   // a dead stale file is no doubt
  assert.deepStrictEqual((await list(deps)).doubts, []);
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

test('identitiesIn: a file it cannot read at all is marked unreadable, unlike junk that reads (R2-2)', () => {
  const { build } = tree();
  const dir = build('dev');
  fs.mkdirSync(path.join(dir, '.harness', 'hosts', '7704.json'));    // EISDIR: a read error, not a parse error
  assert.deepStrictEqual(identitiesIn(dir), [{ port: 7704, parsed: null, unreadable: true }]);
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

// --- Dexter, PR 2 F1 (High): an exact proof, where the identity carries one ---
// `startedAt` is wall clock: set the clock back an hour and an unrelated process
// that took a dead host's pid "started before the write". The OS start time in
// the identity file can't be fooled that way.
test('an identity with an OS start time is proven only by that exact time', async () => {
  const exact = ft(4800);
  const { w, deps } = world();
  w.files[OWN][7701].processStartedAt = exact;
  let r = await list(deps);
  assert.deepStrictEqual(r.rows.find(x => x.pid === 101).exact, true);
  // An impostor that "started before the write" by the wall clock: not proven.
  w.procs.set(101, ft(4000));
  r = await list(deps);
  assert.strictEqual(r.rows.find(x => x.pid === 101), undefined);
  assert.strictEqual(r.verified, true);
});

test('an older identity, with no start time, is proven by the wall clock and marked not exact', async () => {
  const { deps } = world();
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => [x.pid, x.exact]), [[101, false], [202, false]]);
});

test('a start time that is not a FILETIME string is no proof: the row is dropped', async () => {
  for (const bad of ['', 'abc', 4800, null]) {
    const { w, deps } = world();
    w.files[OWN][7701].processStartedAt = bad;
    const r = await list(deps);
    assert.strictEqual(r.rows.find(x => x.pid === 101), undefined, String(bad));
  }
});

// --- Miguel Y3, Dexter F3 (Low): one pid, several files -------------------------
// A copied build folder carries the live host's identity file too. Which build
// wrote it can't be told, so it shows once, and is never offered Open.
test('a pid claimed by files in two builds shows once, and not as this build\'s own', async () => {
  const { w, deps } = world();
  w.files['C:\cc\dev - Copy'] = { 7701: { port: 7701, cwd: 'C:\proj', pid: 101, startedAt: 5000 } };
  const r = await list(deps);
  const mine = r.rows.filter(x => x.pid === 101);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].own, false);
});

test('a pid claimed twice in this build alone is still this build\'s', async () => {
  const { w, deps } = world();
  w.files[OWN][7799] = { port: 7799, cwd: 'C:\proj', pid: 101, startedAt: 5000 };
  const r = await list(deps);
  const mine = r.rows.filter(x => x.pid === 101);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].own, true);
});

test('property: an exact identity is shown iff the OS start equals it, whatever the wall clock says', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1000, max: 2000 }), fc.integer({ min: 1000, max: 2000 }), fc.integer({ min: 0, max: 3000 }),
    async (recorded, osStart, writtenAt) => {
      const files = { [OWN]: { 7001: { port: 7001, cwd: 'C:\p', pid: 9, startedAt: writtenAt, processStartedAt: ft(recorded) } } };
      const { deps } = world({ files, procs: new Map([[9, ft(osStart)]]), windows: new Map() });
      const r = await list(deps);
      assert.strictEqual(r.rows.length, recorded === osStart ? 1 : 0);
      if (r.rows.length) assert.strictEqual(r.rows[0].exact, true);
    }), { numRuns: 300 });
});

// --- kill tests for the release-176 survivors (BACKLOG #94) ----------------------


const idFile = (port, pid, extra = {}) => ({ port, cwd: 'C:\\proj', pid, startedAt: 5000, ...extra });
const only = (files, procs = new Map([[101, ft(4800)], [102, ft(4800)], [103, ft(4800)]])) => world({ files, procs, windows: new Map() });

test('M12: ports 1 and 65535 are ports; 0 and 65536 are not', async () => {
  const { deps } = only({ [OWN]: {
    0: idFile(0, 101), 1: idFile(1, 102), 65535: idFile(65535, 103), 65536: idFile(65536, 101),
  } });
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.port).sort((a, b) => a - b), [1, 65535]);
});

test('M12: a claim with a bad cwd, pid, port, start time or OS start time is not a row, and never throws', async () => {
  const bad = [
    idFile(7701, 101, { cwd: 5 }), idFile(7701, 101, { cwd: '   ' }), idFile(7701, 101, { cwd: null }),
    idFile(7701, 0), idFile(7701, -3), idFile(7701, 1.5), idFile(7701, '101'),
    idFile(7701, 101, { port: 7702 }), idFile(7701, 101, { port: '7701' }),
    idFile(7701, 101, { startedAt: '5000' }), idFile(7701, 101, { startedAt: NaN }), idFile(7701, 101, { startedAt: Infinity }),
    idFile(7701, 101, { startedAt: null }),
    idFile(7701, 101, { processStartedAt: 123 }), idFile(7701, 101, { processStartedAt: 'abc' }),
    [], 'x', 7, null,
  ];
  for (const parsed of bad) {
    const { deps } = only({ [OWN]: { 7701: parsed } });
    const r = await list(deps);
    assert.deepStrictEqual(r.rows, [], JSON.stringify(parsed));
  }
});

test('M12: only valid pids are asked about', async () => {
  const { deps, calls } = only({ [OWN]: {
    7701: idFile(7701, 'x'), 7702: idFile(7702, 0), 7703: idFile(7703, 101), 7704: idFile(7704, 102, { cwd: 3 }),
  } });
  await list(deps);
  assert.deepStrictEqual(calls.startTimes, [[101, 102]]);
});

test('M12: a start time that is present but not a FILETIME makes the file unusable, which is a doubt while its pid runs', async () => {
  const { deps } = only({ [OWN]: { 7701: idFile(7701, 101, { processStartedAt: 'garbage' }) } });
  const r = await list(deps);
  assert.deepStrictEqual(r.rows, []);
  assert.strictEqual(r.verified, false);
  assert.deepStrictEqual(r.doubts, [{ install: OWN, cwd: 'C:\\proj', file: path.join(OWN, '.harness', 'hosts', '7701.json') }]);
});

test('M12: an unusable file\'s doubt names its cwd when it has a real one, and null for a blank or non-string one', async () => {
  const doubtFor = async (extra) => (await list(only({ [OWN]: { 7701: idFile(7701, 101, { port: 9, ...extra }) } }).deps)).doubts;
  const file = path.join(OWN, '.harness', 'hosts', '7701.json');
  assert.deepStrictEqual(await doubtFor({}), [{ install: OWN, cwd: 'C:\\proj', file }]);
  assert.deepStrictEqual(await doubtFor({ cwd: '   ' }), [{ install: OWN, cwd: null, file }]);
  assert.deepStrictEqual(await doubtFor({ cwd: 5 }), [{ install: OWN, cwd: null, file }]);
  assert.deepStrictEqual(await doubtFor({ cwd: '  C:\\sp ' }), [{ install: OWN, cwd: '  C:\\sp ', file }], 'kept as written');
});

test('M12: nothing to ask the OS about: it is not asked, and an unreadable file alone still makes the list unverified', async () => {
  const w = only({ [OWN]: {} });
  const r1 = await list(w.deps);
  assert.deepStrictEqual([r1.rows, r1.verified, r1.doubts], [[], true, []]);
  assert.deepStrictEqual(w.calls.startTimes, []);
  const deps2 = { ...w.deps, identities: () => [{ port: 7701, parsed: null, unreadable: true }] };
  const r2 = await list(deps2);
  assert.deepStrictEqual([r2.rows, r2.verified], [[], false]);
  assert.strictEqual(r2.doubts.length, 1);
  assert.deepStrictEqual(w.calls.startTimes, [], 'still not asked');
});

test('M12: only an unusable file whose pid runs: asked once, and it is a doubt (a dead one is not)', async () => {
  const w = only({ [OWN]: { 7701: idFile(7701, 101, { port: 9 }), 7702: idFile(7702, 999, { port: 9 }) } });
  const r = await list(w.deps);
  assert.deepStrictEqual(w.calls.startTimes, [[101, 999]]);
  assert.deepStrictEqual(r.doubts.map(d => d.file), [path.join(OWN, '.harness', 'hosts', '7701.json')]);
  assert.strictEqual(r.verified, false);
});

test('M12: the OS could not be asked: every claim and every unusable file becomes a doubt, with its own fields', async () => {
  const w = only({ [OWN]: { 7701: idFile(7701, 101), 7702: idFile(7702, 102, { port: 9, cwd: 'C:\\two' }) } });
  w.w.procs = null;
  const r = await list(w.deps);
  assert.strictEqual(r.verified, false);
  assert.deepStrictEqual(r.doubts, [
    { install: OWN, cwd: 'C:\\proj' },
    { install: OWN, cwd: 'C:\\two', file: path.join(OWN, '.harness', 'hosts', '7702.json') },
  ]);
});

test('M12: one pid named by two builds: the NEWER file speaks for it, and on equal times the first one does', async () => {
  const hosts = (ownAt, otherAt) => only({
    [OWN]: { 7701: idFile(7701, 101, { cwd: 'C:\\own', startedAt: ownAt }) },
    [OTHER]: { 7702: idFile(7702, 101, { cwd: 'C:\\other', startedAt: otherAt }) },
  });
  assert.deepStrictEqual((await list(hosts(5000, 6000).deps)).rows.map(x => [x.cwd, x.startedAt, x.own]), [['C:\\other', 6000, false]]);
  assert.deepStrictEqual((await list(hosts(6000, 5000).deps)).rows.map(x => [x.cwd, x.startedAt, x.own]), [['C:\\own', 6000, false]]);
  assert.deepStrictEqual((await list(hosts(5000, 5000).deps)).rows.map(x => [x.cwd, x.startedAt, x.own]), [['C:\\own', 5000, false]]);
});

test('M12: rows are this build\'s first, then newest first within each', async () => {
  const procs = new Map([[101, ft(100)], [102, ft(100)], [103, ft(100)], [104, ft(100)]]);
  const { deps } = only({
    [OWN]: { 7701: idFile(7701, 101, { startedAt: 1000 }), 7702: idFile(7702, 102, { startedAt: 3000 }) },
    [OTHER]: { 7703: idFile(7703, 103, { startedAt: 9000 }), 7704: idFile(7704, 104, { startedAt: 2000 }) },
  }, procs);
  const r = await list(deps);
  assert.deepStrictEqual(r.rows.map(x => x.pid), [102, 101, 103, 104]);
});

test('M12: identitiesIn opens only <digits>.json, and reads the port from the name even when it is one digit', () => {
  const install = tmpDir('cc-bh-ids-');
  const dir = path.join(install, '.harness', 'hosts');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['5.json', '123.json', '7701.json', 'x1.json', '12.json.bak', '1.jsonx', 'a12.json', '7701.json.tmp', '.json', 'token', '77 01.json']) {
    fs.writeFileSync(path.join(dir, n), JSON.stringify({ name: n }));
  }
  const got = identitiesIn(install);
  assert.deepStrictEqual(got.map(x => x.port).sort((a, b) => a - b), [5, 123, 7701]);
  assert.deepStrictEqual(got.find(x => x.port === 5).parsed, { name: '5.json' });
});
