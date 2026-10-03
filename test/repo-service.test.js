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
