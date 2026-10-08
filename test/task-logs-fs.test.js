'use strict';
/**
 * host/task-logs-fs.js: the scan (stat only), the session registry read, and the one guarded delete. Everything runs in
 * the test's own temp dir; nothing here may ever touch the real %TEMP%\claude.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { tmpDir } = require('./tmp-dir');
const path = require('path');

const FS = require('../host/task-logs-fs');
const T = require('../host/task-logs');

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
  return T.classify({ files, registry: { ok: true, entries: [{ pid: 1, sessionId: 'x' }] }, listedPids: new Set([1]), minBytes });
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
  fs.writeFileSync(path.join(dir, '10.json'), JSON.stringify({ pid: 10, sessionId: 'aa' }));
  fs.writeFileSync(path.join(dir, '10.abc.key'), 'secret');
  let r = await FS.readRegistry(dir);
  assert.deepStrictEqual(r, { ok: true, entries: [{ pid: 10, sessionId: 'aa' }] });
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
  const res = await FS.deleteTaskLog(root, row);
  assert.deepStrictEqual({ deleted: res.deleted, failed: res.failed, freed: res.freed }, { deleted: 2, failed: 0, freed: 50 });
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
});

test('delete: a file written since the scan is kept (re-checked at the moment of deleting)', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50);
  const [row] = await rowFor(root);
  fs.appendFileSync(a, 'more');
  const res = await FS.deleteTaskLog(root, row);
  assert.strictEqual(res.deleted, 0);
  assert.ok(fs.existsSync(a));
});

test('delete: a file written within 15 minutes is kept even if the row said deletable', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50, new Date());
  const [row] = await rowFor(root);
  assert.strictEqual((await FS.deleteTaskLog(root, { ...row, deletable: true })).deleted, 0);
  assert.ok(fs.existsSync(a));
});

test('delete: a row that is not deletable is never touched', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50);
  const [row] = await rowFor(root);
  assert.strictEqual((await FS.deleteTaskLog(root, { ...row, deletable: false })).deleted, 0);
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
  const res = await FS.deleteTaskLog(root, row);
  assert.strictEqual(res.deleted, 0);
  assert.ok(fs.existsSync(outside) && fs.existsSync(bad));
});

test('delete: a different file at the path (another inode than the scanned one) is kept', async () => {
  const root = tmp();
  const a = put(root, 'p', 's', 'a.output', 50);
  const [row] = await rowFor(root);
  fs.unlinkSync(a);
  put(root, 'p', 's', 'a.output', 50);
  assert.strictEqual((await FS.deleteTaskLog(root, row)).deleted, 0);
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
  assert.strictEqual((await FS.deleteTaskLog(root, row)).deleted, 0);
  assert.ok(fs.existsSync(victim));
});

test('registries: several config dirs merge; one that cannot be read makes the whole answer not ok', async () => {
  const a = tmp();
  const b = tmp();
  fs.writeFileSync(path.join(a, '1.json'), JSON.stringify({ pid: 1, sessionId: 'aa' }));
  fs.writeFileSync(path.join(b, '2.json'), JSON.stringify({ pid: 2, sessionId: 'bb' }));
  const both = await FS.readRegistries([a, b, a]);
  assert.deepStrictEqual(both, { ok: true, entries: [{ pid: 1, sessionId: 'aa' }, { pid: 2, sessionId: 'bb' }] });
  assert.strictEqual((await FS.readRegistries([a, path.join(b, 'missing')])).ok, false);
  assert.strictEqual((await FS.readRegistries([])).ok, false);
});
