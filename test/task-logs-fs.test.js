'use strict';
/**
 * host/task-logs-fs.js: the scan (stat only), the session registry read, and the one guarded delete. Everything runs in
 * the test's own temp dir; nothing here may ever touch the real %TEMP%\claude.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const { tmpDir } = require('./tmp-dir');
const path = require('path');

const FS = require('../host/task-logs-fs');
const T = require('../host/task-logs');

// no 3 s wait between the two looks, and no volume free-space check (the temp dir's volume is shared with the whole machine)
const FAST = { settleMs: 0, fsp: Object.assign(Object.create(fs.promises), { statfs: async () => { throw new Error('no statfs'); } }) };
const OLD = new Date(Date.now() - 60 * 60_000);

function tmp() { return tmpDir('cc-tasklogs-'); }
function put(root, project, session, name, bytes, when = OLD) {
  const dir = path.join(root, project, session, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(bytes, 97));
  fs.utimesSync(f, when, when);
  return f;
}
const rowFor = async (root, minBytes = 10) => {
  const files = await FS.scanTaskFiles(root);
  return T.classify({ files, registry: { ok: true, entries: [{ pid: 1, sessionId: 'x' }] }, listedPids: new Set([1]), seen: new Set(files.map(f => f.session)), minBytes });
};

test('scan: lists task output files with size, mtime and inode; never reads them; ignores everything else', async () => {
  const root = tmp();
  const f = put(root, 'p', 's', 'a.output', 50);
  put(root, 'p', 's', 'notes.txt', 50);
  fs.mkdirSync(path.join(root, 'p', 's', 'tasks', 'deep'));
  fs.writeFileSync(path.join(root, 'p', 's', 'tasks', 'deep', 'b.output'), 'x');
  fs.writeFileSync(path.join(root, 'p', 'loose.output'), 'x');
  fs.mkdirSync(path.join(root, 'bash-edit-diff', 'z'), { recursive: true });
  const files = await FS.scanTaskFiles(root);
  assert.deepStrictEqual(files.map(x => x.path), [f]);
  assert.strictEqual(files[0].bytes, 50);
  assert.strictEqual(files[0].session, 's');
  assert.strictEqual(files[0].project, 'p');
  assert.strictEqual(files[0].name, 'a.output');
  assert.ok(Math.abs(files[0].mtimeMs - OLD.getTime()) < 2000);
  assert.strictEqual(files[0].nlink, 1);
});

test('scan: a missing root is no files; a hard link shows as one inode with its nlink', async () => {
  assert.deepStrictEqual(await FS.scanTaskFiles(path.join(tmp(), 'nope')), []);
  const root = tmp();
  const a = put(root, 'p', 's1', 'a.output', 50);
  fs.mkdirSync(path.join(root, 'p', 's2', 'tasks'), { recursive: true });
  fs.linkSync(a, path.join(root, 'p', 's2', 'tasks', 'a.output'));
  const rows = await rowFor(root);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].sessions.sort(), ['s1', 's2']);
});

test('scan: a symlinked task file is skipped (never followed)', async (t) => {
  const root = tmp();
  const outside = path.join(tmp(), 'big.bin');
  fs.writeFileSync(outside, Buffer.alloc(50));
  fs.mkdirSync(path.join(root, 'p', 's', 'tasks'), { recursive: true });
  try { fs.symlinkSync(outside, path.join(root, 'p', 's', 'tasks', 'l.output')); } catch { t.skip('no symlink permission'); return; }
  assert.deepStrictEqual(await FS.scanTaskFiles(root), []);
});

test('registry: entries from <pid>.json; ok only when every json parsed and carried a pid and sessionId; .key files never opened', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '10.json'), JSON.stringify({ pid: 10, sessionId: 'aa', procStart: '134359628682213309' }));
  fs.writeFileSync(path.join(dir, '10.abc.key'), 'secret');
  let r = await FS.readRegistry(dir);
  assert.deepStrictEqual(r, { ok: true, entries: [{ pid: 10, sessionId: 'aa', procStart: '134359628682213309' }] });
  fs.writeFileSync(path.join(dir, '12.json'), JSON.stringify({ pid: 12, sessionId: 'bb', procStart: 5 }));
  assert.deepStrictEqual((await FS.readRegistry(dir)).entries[1], { pid: 12, sessionId: 'bb', procStart: null }, 'a procStart that is not a string is kept as null (doubt keeps)');
  fs.unlinkSync(path.join(dir, '12.json'));
  fs.writeFileSync(path.join(dir, '11.json'), '{ half');
  assert.strictEqual((await FS.readRegistry(dir)).ok, false);
  fs.writeFileSync(path.join(dir, '11.json'), JSON.stringify({ pid: 11 }));
  assert.strictEqual((await FS.readRegistry(dir)).ok, false);
  assert.strictEqual((await FS.readRegistry(path.join(dir, 'missing'))).ok, false);
  assert.strictEqual(r.entries.length, 1);
});

test('delete: removes every link of an idle row and reports the bytes freed', async () => {
  const root = tmp();
  const a = put(root, 'p', 's1', 'a.output', 50);
  fs.mkdirSync(path.join(root, 'p', 's2', 'tasks'), { recursive: true });
  const b = path.join(root, 'p', 's2', 'tasks', 'a.output');
  fs.linkSync(a, b);
  const [row] = await rowFor(root);
  const res = await FS.deleteTaskLog(root, row, FAST);
  assert.deepStrictEqual({ deleted: res.deleted, failed: res.failed, freed: res.freed }, { deleted: 2, failed: 0, freed: 50 });
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
});

test('delete: a file written since the scan is kept (re-checked at the moment of deleting)', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50);
  const [row] = await rowFor(root);
  fs.appendFileSync(a, 'more');
  const res = await FS.deleteTaskLog(root, row, FAST);
  assert.strictEqual(res.deleted, 0);
  assert.ok(fs.existsSync(a));
});

test('delete: a file written within 15 minutes is kept even if the row said deletable', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50, new Date());
  const [row] = await rowFor(root);
  assert.strictEqual((await FS.deleteTaskLog(root, { ...row, deletable: true }, FAST)).deleted, 0);
  assert.ok(fs.existsSync(a));
});

test('delete: a row that is not deletable is never touched', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50);
  const [row] = await rowFor(root);
  assert.strictEqual((await FS.deleteTaskLog(root, { ...row, deletable: false, manualDelete: false }, FAST)).deleted, 0);
  assert.ok(fs.existsSync(a));
});

test('delete: a path outside the exact shape, or outside the root, is refused', async () => {
  const root = tmp();
  const outside = path.join(tmp(), 'p', 's', 'tasks', 'a.output');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'x');
  const bad = path.join(root, 'p', 's', 'a.txt');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, 'x');
  const row = { deletable: true, paths: [outside, bad, root], dev: '1', ino: '1', bytes: 1, mtimeMs: OLD.getTime() };
  const res = await FS.deleteTaskLog(root, row, FAST);
  assert.strictEqual(res.deleted, 0);
  assert.ok(fs.existsSync(outside) && fs.existsSync(bad));
});

test('delete: a different file at the path (another inode than the scanned one) is kept', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50);
  const [row] = await rowFor(root);
  fs.unlinkSync(a);
  put(root, 'p', 's', 'a.output', 50);
  assert.strictEqual((await FS.deleteTaskLog(root, row, FAST)).deleted, 0);
  assert.ok(fs.existsSync(a));
});

test('delete: a folder swapped for a junction/symlink that leads outside the root is refused', async (t) => {
  const root = tmp();
  const elsewhere = tmp();
  const real = path.join(elsewhere, 'tasks');
  fs.mkdirSync(real);
  const victim = path.join(real, 'a.output');
  fs.writeFileSync(victim, Buffer.alloc(50));
  fs.utimesSync(victim, OLD, OLD);
  fs.mkdirSync(path.join(root, 'p', 's'), { recursive: true });
  try { fs.symlinkSync(real, path.join(root, 'p', 's', 'tasks'), 'junction'); } catch { t.skip('no junction permission'); return; }
  const st = fs.statSync(victim, { bigint: true });
  const row = { deletable: true, paths: [path.join(root, 'p', 's', 'tasks', 'a.output')], dev: String(st.dev), ino: String(st.ino), bytes: 50, mtimeMs: OLD.getTime() };
  assert.strictEqual((await FS.deleteTaskLog(root, row, FAST)).deleted, 0);
  assert.ok(fs.existsSync(victim));
});

test('registries: several config dirs merge; one that cannot be read makes the whole answer not ok', async () => {
  const a = tmp();
  const b = tmp();
  fs.writeFileSync(path.join(a, '1.json'), JSON.stringify({ pid: 1, sessionId: 'aa' }));
  fs.writeFileSync(path.join(b, '2.json'), JSON.stringify({ pid: 2, sessionId: 'bb' }));
  const both = await FS.readRegistries([a, b, a]);
  assert.deepStrictEqual(both, { ok: true, entries: [{ pid: 1, sessionId: 'aa', procStart: null }, { pid: 2, sessionId: 'bb', procStart: null }] });
  assert.strictEqual((await FS.readRegistries([a, path.join(b, 'missing')])).ok, false);
  assert.strictEqual((await FS.readRegistries([])).ok, false);
});

test('registryDirs: the main config dir plus one per tab, a relative dir anchored on each tab folder, unique', () => {
  const cfg = (opts = {}) => (opts.cwd ? path.join(opts.cwd, '.cc') : path.join('main', '.cc'));
  assert.deepStrictEqual(FS.registryDirs(['a', 'b', 'a'], cfg), [path.join('main', '.cc', 'sessions'), path.join('a', '.cc', 'sessions'), path.join('b', '.cc', 'sessions')]);
  const fixed = () => path.join('home', '.claude');
  assert.deepStrictEqual(FS.registryDirs(['a', 'b'], fixed), [path.join('home', '.claude', 'sessions')]);
  assert.deepStrictEqual(FS.registryDirs(null, fixed), [path.join('home', '.claude', 'sessions')]);
  assert.strictEqual(FS.registryDirs(['', 5], fixed).length, 1);
});

test('delete: a row the person chose to delete (manualDelete) is deleted by the same guarded function; one that is neither is not', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50);
  const [row] = await rowFor(root);
  assert.strictEqual((await FS.deleteTaskLog(root, { ...row, deletable: false, manualDelete: false }, FAST)).deleted, 0);
  assert.ok(fs.existsSync(a));
  assert.strictEqual((await FS.deleteTaskLog(root, { ...row, deletable: false, manualDelete: true }, FAST)).deleted, 1);
  assert.ok(!fs.existsSync(a));
});

// ---- the guard against a fake fs: always runs (the real symlink and junction tests skip without that permission) ----------------

const FROOT = path.join(path.parse(os.tmpdir()).root, 'fakeroot', 'claude');
const fpath = (session, name = 'a.output') => path.join(FROOT, 'p', session, 'tasks', name);
const BIG = 500 * 1024 * 1024;
const T0 = 1_700_000_000_000;
const stat = (o = {}) => ({ isFile: () => true, dev: 1n, ino: 77n, mtimeMs: BigInt(T0), size: BigInt(BIG), nlink: 1n, ...o });
// a fake `fsp`: `lstats[path]` is a list of results, one per lstat call (the last repeats); an Error in it is thrown
function fakeFsp({ lstats = {}, realpaths = {}, unlinkErr = {}, free = [1000n * 1024n * 1024n, 1000n * 1024n * 1024n + BigInt(BIG)] } = {}) {
  const calls = { unlink: [], lstat: {} };
  let statfsN = 0;
  return {
    calls,
    realpath: async (p) => (realpaths[p] !== undefined ? realpaths[p] : p),
    lstat: async (p) => {
      const list = lstats[p] || [stat()];
      const i = calls.lstat[p] = (calls.lstat[p] || 0) + 1;
      const r = list[Math.min(i, list.length) - 1];
      if (r instanceof Error) throw r;
      return r;
    },
    unlink: async (p) => { calls.unlink.push(p); if (unlinkErr[p]) throw unlinkErr[p]; },
    statfs: async () => { const n = free[Math.min(statfsN++, free.length - 1)]; return { bavail: n, bsize: 1n }; },
  };
}
const errno = code => Object.assign(new Error(code), { code });
const frow = (paths, o = {}) => ({ deletable: true, paths, dev: '1', ino: '77', mtimeMs: T0, bytes: BIG, ...o });
const NOWF = () => T0 + 60 * 60_000;
const F0 = { settleMs: 0, now: NOWF };

test('fake fs (guard, always runs): a folder that resolves outside the root, or to another place than its path says, is refused and nothing is unlinked', async () => {
  const p = fpath('s1');
  for (const real of [path.join(path.parse(os.tmpdir()).root, 'elsewhere', 'tasks'), path.join(FROOT, 'p', 'other', 'tasks')]) {
    const fsp = fakeFsp({ realpaths: { [FROOT]: FROOT, [path.dirname(p)]: real } });
    const res = await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp });
    assert.deepStrictEqual([res.deleted, res.kept, fsp.calls.unlink], [0, 1, []], real);
  }
});

test('fake fs: a file that grew between the two looks (size changed, mtime did not) is kept: a live writer', async () => {
  const p = fpath('s1');
  const fsp = fakeFsp({ lstats: { [p]: [stat(), stat({ size: BigInt(BIG + 4096) })] } });
  const res = await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp });
  assert.deepStrictEqual([res.deleted, res.kept, fsp.calls.unlink], [0, 1, []]);
  const grew = fakeFsp({ lstats: { [p]: [stat({ size: BigInt(BIG + 1) })] } });
  assert.strictEqual((await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp: grew })).kept, 1, 'bigger than the scan already at the first look');
});

test('fake fs: the two looks are settleMs apart, and the delete waits for the second', async () => {
  const p = fpath('s1');
  const order = [];
  const fsp = fakeFsp();
  const lstat = fsp.lstat;
  fsp.lstat = async (...a) => { order.push('lstat'); return lstat(...a); };
  const unlink = fsp.unlink;
  fsp.unlink = async (...a) => { order.push('unlink'); return unlink(...a); };
  await FS.deleteTaskLog(FROOT, frow([p]), { settleMs: 3000, now: NOWF, fsp, sleep: async (ms) => { order.push(`sleep ${ms}`); } });
  assert.deepStrictEqual(order, ['lstat', 'sleep 3000', 'lstat', 'unlink']);
});

test('fake fs: EBUSY, EPERM and EACCES on unlink are "locked", never "deleted" or "failed", and free nothing', async () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const p = fpath('s1');
    const res = await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp: fakeFsp({ unlinkErr: { [p]: errno(code) } }) });
    assert.deepStrictEqual([res.deleted, res.locked, res.failed, res.freed], [0, 1, 0, 0], code);
  }
  const p = fpath('s1');
  const other = await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp: fakeFsp({ unlinkErr: { [p]: errno('EIO') } }) });
  assert.deepStrictEqual([other.locked, other.failed], [0, 1]);
});

test('fake fs (Dexter #5): a link that is already gone (another window won the race) counts as gone, not as a failure', async () => {
  const [a, b] = [fpath('s1'), fpath('s2')];
  const fsp = fakeFsp({ lstats: { [b]: [errno('ENOENT')] } });
  const res = await FS.deleteTaskLog(FROOT, frow([a, b]), { ...F0, fsp });
  assert.deepStrictEqual([res.deleted, res.gone, res.failed, res.kept], [1, 1, 0, 0]);
  const unlinkRace = fakeFsp({ unlinkErr: { [a]: errno('ENOENT') } });
  const r2 = await FS.deleteTaskLog(FROOT, frow([a]), { ...F0, fsp: unlinkRace });
  assert.deepStrictEqual([r2.deleted, r2.gone, r2.failed], [0, 1, 0]);
});

test('fake fs (Miguel I6): a partial hard-link delete reports exactly what happened, claims no space freed, and lists what it removed', async () => {
  const [a, b, c] = [fpath('s1'), fpath('s2'), fpath('s3')];
  const fsp = fakeFsp({ unlinkErr: { [c]: errno('EPERM') } });
  const res = await FS.deleteTaskLog(FROOT, frow([a, b, c]), { ...F0, fsp });
  assert.deepStrictEqual([res.deleted, res.locked, res.freed, res.deletedPaths.sort()], [2, 1, 0, [a, b].sort()]);
});

test('fake fs (Dexter #3): space is claimed freed only when the volume grew by at least half the file; otherwise it is "held"; unverifiable claims it', async () => {
  const p = fpath('s1');
  const GB = 1000n * 1024n * 1024n;
  const freed = await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp: fakeFsp({ free: [GB, GB + BigInt(BIG)] }) });
  assert.deepStrictEqual([freed.freed, freed.held], [BIG, false]);
  const held = await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp: fakeFsp({ free: [GB, GB + 1000n] }) });
  assert.deepStrictEqual([held.deleted, held.freed, held.held], [1, 0, true]);
  const noStat = fakeFsp();
  noStat.statfs = async () => { throw new Error('unsupported'); };
  const un = await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp: noStat });
  assert.deepStrictEqual([un.freed, un.held], [BIG, false]);
});

test('fake fs: the scanned size must match too, and a row without a size is never deleted', async () => {
  const p = fpath('s1');
  const fsp = fakeFsp({ lstats: { [p]: [stat({ size: BigInt(BIG - 1) })] } });
  assert.strictEqual((await FS.deleteTaskLog(FROOT, frow([p]), { ...F0, fsp })).kept, 1);
  assert.strictEqual((await FS.deleteTaskLog(FROOT, frow([p], { bytes: undefined }), { ...F0, fsp: fakeFsp() })).kept, 1);
});

// --- account profiles (BACKLOG #119 A1): a session under a profile registers in THAT profile's folder ---------------------------
test('registryDirs: every profile folder is read too, so a live session under another account keeps its task logs', () => {
  const fixed = () => path.join('home', '.claude');
  const prof = [path.join('p', 'work'), path.join('p', 'play'), path.join('p', 'work'), null, '', 5];
  assert.deepStrictEqual(FS.registryDirs(['a'], fixed, prof),
    [path.join('home', '.claude', 'sessions'), path.join('p', 'work', 'sessions'), path.join('p', 'play', 'sessions')]);
  assert.deepStrictEqual(FS.registryDirs(['a'], fixed, undefined), [path.join('home', '.claude', 'sessions')]);
  assert.deepStrictEqual(FS.registryDirs(['a'], fixed, 'nope'), [path.join('home', '.claude', 'sessions')]);
});
