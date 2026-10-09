'use strict';
/**
 * The host's side of the repo browser (#45 / #32): one control type, `repo`, with an action each for
 * the listing, the overlay, a read, a stat and a diff. Every path goes through the guard; every reply
 * echoes the request's `seq`; every failure says why.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir } = require('./tmp-dir');

const { createRepoService } = require('../host/repo-service');

// A real fs.watch would hold the test process open; the watching tests inject their own.
const make = (o) => createRepoService({ watch: () => ({ close() {} }), announce: () => {}, ...o });
const { CONTROL_TYPES } = require('../host/control');

function repo() {
  const root = tmpDir('cc-svc-');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.invalid', ...a], { cwd: root, stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, git };
}
const noFog = async () => ({ files: [], status: { transcriptsFound: 0, transcriptErrors: 0, transcriptsMissing: true } });

test('`repo` is on the control allow-list: off it, the frame would be TYPED into the pty as JSON', () => {
  assert.ok(CONTROL_TYPES.has('repo'));
});

test('list answers the folder, listing git on first use', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  const r = await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 7 });
  assert.strictEqual(r.type, 'repo');
  assert.strictEqual(r.action, 'list');
  assert.strictEqual(r.seq, 7);
  assert.strictEqual(r.dir, '');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.entries.map(e => `${e.kind}:${e.name}`), ['dir:src', 'file:blob.bin', 'file:README.md']);
  const sub = await svc.handle({ type: 'repo', action: 'list', dir: 'src', seq: 8 });
  assert.deepStrictEqual(sub.entries.map(e => e.path), ['src/a.js']);
});

test('list in a folder that is not a repository says so (never an empty tree)', async () => {
  const svc = make({ root: tmpDir('cc-svc-norepo-'), readFog: noFog });
  const r = await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not a git repository/i);
});

test('list refuses a dir that is not a string', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  for (const dir of [5, null, {}, 'x'.repeat(5000)]) {
    const r = await svc.handle({ type: 'repo', action: 'list', dir, seq: 1 });
    assert.strictEqual(r.ok, false);
  }
});

test('overlay is fog\'s files rolled up, plus the status that says whether there were transcripts', async () => {
  const { root } = repo();
  const readFog = async ({ cwd }) => {
    assert.strictEqual(cwd, root);
    return {
      files: [{ path: 'src/a.js', tier: 'edited', edits: 2 }, { path: 'README.md', tier: 'read', edits: 0 }],
      status: { transcriptsFound: 3, transcriptErrors: 1, transcriptsMissing: false },
    };
  };
  const svc = make({ root, readFog });
  const r = await svc.handle({ type: 'repo', action: 'overlay', seq: 3 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.map(f => f.path).sort(), ['README.md', 'src/a.js']);
  assert.strictEqual(r.dirs.find(d => d.path === '').edits, 2);
  assert.deepStrictEqual(r.status, { transcriptsFound: 3, transcriptErrors: 1, transcriptsMissing: false });
});

test('overlay passes the probe seam\'s projects dir to fog, and reads no dark files', async () => {
  let seen;
  const svc = make({ root: 'C:\\r', projectsDir: 'C:\\fixtures', readFog: async (o) => { seen = o; return { files: [], status: {} }; } });
  await svc.handle({ type: 'repo', action: 'overlay', seq: 1 });
  assert.strictEqual(seen.projectsDir, 'C:\\fixtures');
  assert.ok(!seen.tracked || seen.tracked.length === 0, 'dark files are not the overlay\'s business');
});

test('a fog that throws is an error reply, not a hang', async () => {
  const svc = make({ root: 'C:\\r', readFog: async () => { throw new Error('transcripts exploded'); } });
  const r = await svc.handle({ type: 'repo', action: 'overlay', seq: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /exploded/);
  assert.strictEqual(r.seq, 1);
});

test('overlapping overlay asks share one fog read', async () => {
  let reads = 0;
  const svc = make({ root: 'C:\\r', readFog: async () => { reads++; await new Promise(r => setTimeout(r, 20)); return { files: [], status: {} }; } });
  await Promise.all([1, 2, 3].map(seq => svc.handle({ type: 'repo', action: 'overlay', seq })));
  assert.strictEqual(reads, 1);
});

test('read answers the text, the size and the mtime, and the path as the guard resolved it', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  const r = await svc.handle({ type: 'repo', action: 'read', path: 'src\\a.js', seq: 4 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.path, 'src/a.js');
  assert.strictEqual(r.text, 'const a = 1;\n');
  assert.strictEqual(r.size, 13);
  assert.strictEqual(typeof r.mtimeMs, 'number');
});

test('read refuses a path outside the worktree, however it is spelled, and says why', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  for (const p of ['../outside.txt', '..\\..\\Windows\\win.ini', 'C:\\Windows\\win.ini', '\\\\srv\\share\\x', 'src/../../x']) {
    const r = await svc.handle({ type: 'repo', action: 'read', path: p, seq: 1 });
    assert.strictEqual(r.ok, false, p);
    assert.ok(r.why, p);
    assert.ok(!('text' in r), p);
  }
});

test('read refuses a junction that leads out of the worktree', async () => {
  const { root } = repo();
  const outside = tmpDir('cc-svc-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(root, 'jn'), 'junction');
  const svc = make({ root, readFog: noFog });
  const r = await svc.handle({ type: 'repo', action: 'read', path: 'jn/secret.txt', seq: 1 });
  assert.strictEqual(r.ok, false);
  assert.ok(!JSON.stringify(r).includes('top secret'));
});

test('read of a binary, a missing file and a folder say binary / gone / not-a-file', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'read', path: 'blob.bin', seq: 1 })).why, 'binary');
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'read', path: 'nope.js', seq: 1 })).why, 'gone');
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'read', path: 'src', seq: 1 })).why, 'not-a-file');
});

test('stat is the Reload bar\'s question: size and mtime of the file, or why not', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  const r = await svc.handle({ type: 'repo', action: 'stat', path: 'README.md', seq: 5 });
  assert.deepStrictEqual({ ok: r.ok, size: r.size, path: r.path, seq: r.seq }, { ok: true, size: 5, path: 'README.md', seq: 5 });
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'stat', path: 'nope.md', seq: 6 })).why, 'gone');
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'stat', path: '../x', seq: 6 })).ok, false);
});

test('diff goes through the lexical guard and answers the source and text', async () => {
  const { root } = repo();
  const calls = [];
  const svc = make({ root, readFog: noFog, diff: async (o) => { calls.push(o); return { ok: true, source: 'claude', text: '@@ Edit @@\n-a\n+b', count: 1 }; } });
  const r = await svc.handle({ type: 'repo', action: 'diff', path: 'src\\a.js', seq: 9 });
  assert.deepStrictEqual({ ok: r.ok, source: r.source, path: r.path, seq: r.seq }, { ok: true, source: 'claude', path: 'src/a.js', seq: 9 });
  assert.strictEqual(calls[0].rel, 'src/a.js');
  assert.strictEqual(calls[0].root, root);
  const bad = await svc.handle({ type: 'repo', action: 'diff', path: '../x', seq: 10 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(calls.length, 1, 'a refused path never reaches the diff');
});

test('an unknown action, a missing path, and a non-object are refused with a reason, never thrown', async () => {
  const svc = make({ root: 'C:\\r', readFog: noFog });
  for (const msg of [{ type: 'repo', action: 'delete', seq: 1 }, { type: 'repo', action: 'read', seq: 1 }, { type: 'repo', action: 'read', path: 5, seq: 1 }, { type: 'repo', seq: 1 }]) {
    const r = await svc.handle(msg);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error || r.why);
    assert.strictEqual(r.seq, 1);
  }
  const r = await svc.handle(null);
  assert.strictEqual(r.ok, false);
});

test('the seq echoed is only a small integer or string; anything else is dropped', async () => {
  const svc = make({ root: 'C:\\r', readFog: noFog });
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'nope', seq: 12 })).seq, 12);
  const weird = await svc.handle({ type: 'repo', action: 'nope', seq: { a: 1 } });
  assert.ok(!('seq' in weird) || weird.seq === undefined);
});

test('watching: started once, a change refreshes the index and announces `changed`', async () => {
  const { root } = repo();
  let handler = null;
  let watches = 0;
  const announced = [];
  const svc = make({
    root, readFog: noFog,
    watch: (dir, onChange) => { watches++; handler = onChange; return { close() {} }; },
    announce: (m) => announced.push(m),
  });
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });
  await svc.handle({ type: 'repo', action: 'list', dir: 'src', seq: 2 });
  assert.strictEqual(watches, 1, 'one watch however many asks');
  fs.writeFileSync(path.join(root, 'src', 'new.js'), 'x');
  await handler();
  assert.deepStrictEqual(announced, [{ type: 'repo', action: 'changed' }]);
  const r = await svc.handle({ type: 'repo', action: 'list', dir: 'src', seq: 3 });
  assert.ok(r.entries.some(e => e.name === 'new.js'), 'the new, untracked file is listed');
});

test('close stops the watch', async () => {
  const { root } = repo();
  let closed = 0;
  const svc = make({ root, readFog: noFog, watch: () => ({ close() { closed++; } }), announce: () => {} });
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });
  svc.close();
  assert.strictEqual(closed, 1);
});

test('D3: the overlay is spelled the way the listing spells the file (case variants in the transcript are one row)', async () => {
  const { root } = repo();
  const readFog = async () => ({
    files: [{ path: 'SRC/A.JS', tier: 'edited', edits: 2 }, { path: 'src/a.js', tier: 'edited', edits: 1 }],
    status: { transcriptsFound: 1, transcriptErrors: 0, transcriptsMissing: false },
  });
  const svc = make({ root, readFog });
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });
  const r = await svc.handle({ type: 'repo', action: 'overlay', seq: 2 });
  assert.deepStrictEqual(r.files.map(f => [f.path, f.edits]), [['src/a.js', 3]]);
  assert.deepStrictEqual(r.dirs.map(d => [d.path, d.edits]), [['', 3], ['src', 3]]);
});

// ---- PR #95 Dexter D4: an overlay ask that arrives after a change is not answered from a read begun before it ----

test('D4: a change while an overlay read is in flight makes the next ask read again, and it sees the change', async () => {
  const { root } = repo();
  let handler = null;
  const gates = [];
  let truth = ['a.js'];
  const readFog = () => new Promise((resolve) => {
    const snapshot = [...truth];                       // what this read saw when it began
    gates.push(() => resolve({ files: snapshot.map(p => ({ path: p, tier: 'edited', edits: 1 })), status: {} }));
  });
  const svc = make({ root, readFog, watch: (d, onChange) => { handler = onChange; return { close() {} }; } });
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });      // starts the watch
  const first = svc.handle({ type: 'repo', action: 'overlay', seq: 2 });
  await new Promise(r => setTimeout(r, 20));
  truth = ['a.js', 'b.js'];                           // Claude edits b.js while the read is running
  await handler();
  const second = svc.handle({ type: 'repo', action: 'overlay', seq: 3 });
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(gates.length, 1, 'the second ask waits for the first, then reads again');
  gates[0]();
  await first;
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(gates.length, 2, 'a second read was started after the change');
  gates[1]();
  const r2 = await second;
  assert.deepStrictEqual(r2.files.map(f => f.path).sort(), ['a.js', 'b.js']);
});

test('D4: with no change in between, overlapping asks still share one read', async () => {
  const { root } = repo();
  let reads = 0;
  const svc = make({ root, readFog: async () => { reads++; await new Promise(r => setTimeout(r, 20)); return { files: [], status: {} }; } });
  await Promise.all([1, 2, 3].map(seq => svc.handle({ type: 'repo', action: 'overlay', seq })));
  assert.strictEqual(reads, 1);
});

// ---- PR #95 Dexter D5: a failed first listing is not cached for the life of the host ----

test('D5: a first ls-files that failed is asked again by the next list (no watch event needed)', async () => {
  const { createIndex } = require('../host/repo-index');
  let n = 0;
  const NUL = String.fromCharCode(0);
  const index = createIndex('C:\r', { execFile: (f, a, o, cb) => (n++ === 0 ? cb(new Error('boom'), '', 'fatal: timed out') : cb(null, `a.js${NUL}`, '')) });
  const svc = make({ root: 'C:\r', readFog: noFog, index });
  const first = await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });
  assert.strictEqual(first.ok, false);
  const second = await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 2 });
  assert.strictEqual(second.ok, true);
  assert.deepStrictEqual(second.entries.map(e => e.name), ['a.js']);
  assert.strictEqual(n, 2);
});

test('D5: a listing that worked is still asked once, not on every list', async () => {
  const { createIndex } = require('../host/repo-index');
  let n = 0;
  const index = createIndex('C:\r', { execFile: (f, a, o, cb) => { n++; cb(null, '', ''); } });
  const svc = make({ root: 'C:\r', readFog: noFog, index });
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 2 });
  assert.strictEqual(n, 1);
});

// ---- PR #95 Dexter D2: the Diff's reach and rule need the file's time and whether git calls it modified ----

test('D2: a read says whether git calls the file modified, so Bash and hand changes get the Diff toggle', async () => {
  const { root } = repo();
  const asked = [];
  const svc = make({ root, readFog: noFog, modified: async (r, rel) => { asked.push([r, rel]); return rel === 'src/a.js'; } });
  const yes = await svc.handle({ type: 'repo', action: 'read', path: 'src/a.js', seq: 1 });
  const no = await svc.handle({ type: 'repo', action: 'read', path: 'README.md', seq: 2 });
  assert.strictEqual(yes.modified, true);
  assert.strictEqual(no.modified, false);
  assert.deepStrictEqual(asked, [[root, 'src/a.js'], [root, 'README.md']]);
});

test('D2: modified is null when git can\'t say, and absent on a refusal (nothing was read)', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog, modified: async () => null });
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'read', path: 'src/a.js', seq: 1 })).modified, null);
  const bin = await svc.handle({ type: 'repo', action: 'read', path: 'blob.bin', seq: 2 });
  assert.ok(!('modified' in bin));
  assert.ok(!('modified' in await svc.handle({ type: 'repo', action: 'read', path: '../x', seq: 3 })));
});

test('D2: a diff is asked with the file\'s own mtime, so the rule can tell the file moved on', async () => {
  const { root } = repo();
  const seen = [];
  const svc = make({ root, readFog: noFog, diff: async (o) => { seen.push(o); return { ok: true, source: 'git', text: 'x' }; } });
  await svc.handle({ type: 'repo', action: 'diff', path: 'src/a.js', seq: 1 });
  assert.strictEqual(seen[0].fileMtimeMs, fs.statSync(path.join(root, 'src', 'a.js')).mtimeMs);
  await svc.handle({ type: 'repo', action: 'diff', path: 'src/deleted.js', seq: 2 });
  assert.strictEqual(seen[1].fileMtimeMs, undefined, 'no file, no time: the rule falls back to the calls');
});

// ---- PR #95 Dexter D10: the check and the use were separated by awaits ----

test('D10: a path that resolves OUT of the worktree between the check and the read is refused, and no text leaves', async () => {
  const { root } = repo();
  const real = path.join(root, 'src', 'a.js');
  let calls = 0;
  // first look: inside. By the time the read is done, a junction swap makes it resolve outside.
  const guard = async () => (++calls === 1
    ? { ok: true, abs: real, real, rel: 'src/a.js' }
    : { ok: false, why: 'outside the worktree (a link leads out)' });
  const svc = make({ root, readFog: noFog, guard });
  const r = await svc.handle({ type: 'repo', action: 'read', path: 'src/a.js', seq: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /changed while|outside/);
  assert.ok(!('text' in r));
});

test('D10: a path that now resolves to a DIFFERENT file inside the worktree is refused too (not the file that was checked)', async () => {
  const { root } = repo();
  const a = path.join(root, 'src', 'a.js');
  let calls = 0;
  const guard = async () => ({ ok: true, abs: a, real: calls++ === 0 ? a : path.join(root, 'README.md'), rel: 'src/a.js' });
  const svc = make({ root, readFog: noFog, guard });
  const r = await svc.handle({ type: 'repo', action: 'read', path: 'src/a.js', seq: 1 });
  assert.strictEqual(r.ok, false);
  assert.ok(!('text' in r));
});

test('D10: an unchanged path is read as before (the second look agrees, case aside)', async () => {
  const { root } = repo();
  const a = path.join(root, 'src', 'a.js');
  let calls = 0;
  const guard = async () => ({ ok: true, abs: a, real: calls++ === 0 ? a : a.toUpperCase(), rel: 'src/a.js' });
  const svc = make({ root, readFog: noFog, guard });
  const r = await svc.handle({ type: 'repo', action: 'read', path: 'src/a.js', seq: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'const a = 1;\n');
});

// ---- PR #95 Miguel M6: a folder's reply is capped on the host, and says how many were left out ----

test('M6: a folder with more entries than the cap answers the first ones and how many it left out', async () => {
  const { MAX_LIST_ENTRIES } = require('../host/repo-service');
  assert.ok(MAX_LIST_ENTRIES >= 1000 && MAX_LIST_ENTRIES <= 10000);
  const entries = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}.js`, path: `f${i}.js`, kind: 'file' }));
  const index = { refresh: async () => ({ ok: true }), list: () => ({ ok: true, entries }), resolve: () => undefined };
  const svc = make({ root: 'C:\r', readFog: noFog, index, listCap: 3 });
  const r = await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.entries.map(e => e.name), ['f0.js', 'f1.js', 'f2.js']);
  assert.strictEqual(r.omitted, 4);
});

test('M6: a folder within the cap says nothing is omitted (0, a number), and an error reply carries no count', async () => {
  const index = { refresh: async () => ({ ok: true }), list: () => ({ ok: true, entries: [{ name: 'a', path: 'a', kind: 'file' }] }), resolve: () => undefined };
  const svc = make({ root: 'C:\r', readFog: noFog, index, listCap: 3 });
  assert.strictEqual((await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 1 })).omitted, 0);
  const bad = make({ root: 'C:\r', readFog: noFog, index: { refresh: async () => ({ ok: false }), list: () => ({ ok: false, error: 'x' }), resolve: () => undefined }, listCap: 3 });
  assert.ok(!('omitted' in await bad.handle({ type: 'repo', action: 'list', dir: '', seq: 2 })));
});

// ---- #50: the reader's save ----

const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');

test('write saves through the guard: the new text lands, the reply carries the new stamp and hash, and seq is echoed', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  const read = await svc.handle({ type: 'repo', action: 'read', path: 'src/a.js', seq: 1 });
  const r = await svc.handle({ type: 'repo', action: 'write', path: 'src/a.js', text: 'const a = 2;\n', eol: read.eol, bom: read.bom, expectHash: read.hash, seq: 9 });
  assert.strictEqual(r.type, 'repo');
  assert.strictEqual(r.action, 'write');
  assert.strictEqual(r.seq, 9);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.path, 'src/a.js');
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'const a = 2;\n');
  assert.strictEqual(r.hash, sha256(Buffer.from('const a = 2;\n')));
  assert.strictEqual(r.size, 13);
});

test('write refuses a stale hash and says so, leaving the disk version alone', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  const read = await svc.handle({ type: 'repo', action: 'read', path: 'README.md', seq: 1 });
  fs.writeFileSync(path.join(root, 'README.md'), '# changed by Claude\n');
  const r = await svc.handle({ type: 'repo', action: 'write', path: 'README.md', text: '# mine\n', expectHash: read.hash, seq: 2 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.why, 'stale');
  assert.strictEqual(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# changed by Claude\n');
});

test('write is re-guarded: a path outside the worktree, a non-string path and a missing hash are refused and nothing is written', async () => {
  const { root } = repo();
  const outside = path.join(path.dirname(root), `cc-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'outside');
  try {
    const svc = make({ root, readFog: noFog });
    const h = sha256(Buffer.from('outside'));
    for (const p of ['../' + path.basename(outside), outside, '..\\' + path.basename(outside)]) {
      const r = await svc.handle({ type: 'repo', action: 'write', path: p, text: 'pwned', expectHash: h, seq: 1 });
      assert.strictEqual(r.ok, false, p);
    }
    assert.strictEqual((await svc.handle({ type: 'repo', action: 'write', path: 5, text: 'x', expectHash: h, seq: 1 })).ok, false);
    const noHash = await svc.handle({ type: 'repo', action: 'write', path: 'README.md', text: 'x', seq: 1 });
    assert.deepStrictEqual({ ok: noHash.ok, why: noHash.why }, { ok: false, why: 'bad request' });
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside');
    assert.strictEqual(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# hi\n');
  } finally { fs.rmSync(outside, { force: true }); }
});

test('write never touches git\'s own folder or the .git pointer file', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  const head = fs.readFileSync(path.join(root, '.git', 'HEAD'));
  for (const p of ['.git/HEAD', '.git\\HEAD', '.GIT/HEAD', '.git']) {
    const r = await svc.handle({ type: 'repo', action: 'write', path: p, text: 'x', expectHash: sha256(head), seq: 1 });
    assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'protected' }, p);
  }
  assert.deepStrictEqual(fs.readFileSync(path.join(root, '.git', 'HEAD')), head);
});

test('write goes through the injected writer with the resolved path', async () => {
  const { root } = repo();
  const calls = [];
  const svc = make({ root, readFog: noFog, write: async (abs, opts) => { calls.push([path.relative(root, abs), opts.expectHash]); return { ok: true, size: 1, mtimeMs: 2, hash: 'h' }; } });
  const r = await svc.handle({ type: 'repo', action: 'write', path: 'src/a.js', text: 'x', expectHash: 'abc', seq: 3 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls, [[path.join('src', 'a.js'), 'abc']]);
});

// PR #155 fixes: the save's guard, end to end through the service.
test('write: a deleted file is stale+gone with its old hash, and RECREATED with expectHash null (Keep mine after a delete)', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  const read = await svc.handle({ type: 'repo', action: 'read', path: 'src/a.js', seq: 1 });
  fs.unlinkSync(path.join(root, 'src', 'a.js'));
  const stale = await svc.handle({ type: 'repo', action: 'write', path: 'src/a.js', text: 'mine\n', expectHash: read.hash, seq: 2 });
  assert.deepStrictEqual({ ok: stale.ok, why: stale.why, gone: stale.gone }, { ok: false, why: 'stale', gone: true });
  assert.ok(!fs.existsSync(path.join(root, 'src', 'a.js')));
  const made = await svc.handle({ type: 'repo', action: 'write', path: 'src/a.js', text: 'mine\n', expectHash: null, seq: 3 });
  assert.strictEqual(made.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'mine\n');
});

test('write: when the folder is gone too, the save is refused as gone (and nothing is created)', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  fs.rmSync(path.join(root, 'src'), { recursive: true });
  const r = await svc.handle({ type: 'repo', action: 'write', path: 'src/a.js', text: 'x', expectHash: null, seq: 1 });
  assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'gone' });
  assert.ok(!fs.existsSync(path.join(root, 'src')));
});

test('write: a junction to .git/hooks, a nested .git and a junction out are all refused and nothing is written', async () => {
  const { root } = repo();
  const svc = make({ root, readFog: noFog });
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'hook');
  fs.symlinkSync(path.join(root, '.git', 'hooks'), path.join(root, 'link'), 'junction');
  fs.mkdirSync(path.join(root, 'vendor', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vendor', '.git', 'config'), 'c');
  const h = sha256(Buffer.from('hook'));
  for (const [p, hash] of [['link/pre-commit', h], ['link/new-hook', null], ['vendor/.git/config', sha256(Buffer.from('c'))]]) {
    const r = await svc.handle({ type: 'repo', action: 'write', path: p, text: 'pwned', expectHash: hash, seq: 1 });
    assert.deepStrictEqual({ ok: r.ok, why: r.why }, { ok: false, why: 'protected' }, p);
  }
  assert.strictEqual(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), 'hook');
  assert.ok(!fs.existsSync(path.join(root, '.git', 'hooks', 'new-hook')));
  assert.strictEqual(fs.readFileSync(path.join(root, 'vendor', '.git', 'config'), 'utf8'), 'c');
});
