'use strict';
/**
 * One window per project (DESIGN_TABS_SESSIONS.md 3.3): the decision table, the owner file's proof, and the claim that publishes it.
 * The module is loaded inside each test so a missing module fails every test, not one load error for the file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { tmpDir } = require('./tmp-dir');

const load = () => require('../host/window-owner');

const START_A = '133800000000000001';
const START_B = '133800000000000002';
const live = (pid, start) => async () => new Map([[pid, start]]);

function project() {
  const root = tmpDir('cc-window-owner-');
  return root;
}
const ownerFileOf = (root) => path.join(root, '.claude-custom', 'window.json');
const writeOwner = (root, doc) => {
  fs.mkdirSync(path.join(root, '.claude-custom'), { recursive: true });
  fs.writeFileSync(ownerFileOf(root), typeof doc === 'string' ? doc : JSON.stringify(doc));
};

// ---- the decision table -------------------------------------------------------------------------------------------

test('decide: a live owner other than this process means focus it and do not open a window', () => {
  const { decide } = load();
  const r = decide({ owner: { pid: 10, start: START_A }, proof: 'live', selfPid: 20 });
  assert.strictEqual(r.action, 'focus');
});

test('decide: no file means proceed', () => {
  const { decide } = load();
  const r = decide({ owner: null, proof: null, selfPid: 20 });
  assert.deepStrictEqual(r, { action: 'proceed', reason: 'no-owner' });
});

test('decide: a dead owner means proceed (and overwrite)', () => {
  const { decide } = load();
  assert.deepStrictEqual(decide({ owner: { pid: 10, start: START_A }, proof: 'dead', selfPid: 20 }),
    { action: 'proceed', reason: 'dead-owner' });
});

test('decide: an owner that could not be proved means proceed: a second window is the old behaviour, not a crash', () => {
  const { decide } = load();
  assert.deepStrictEqual(decide({ owner: { pid: 10, start: START_A }, proof: 'unknown', selfPid: 20 }),
    { action: 'proceed', reason: 'unproven-owner' });
});

test('decide: an owner file naming this very process is not another window', () => {
  const { decide } = load();
  assert.deepStrictEqual(decide({ owner: { pid: 20, start: START_A }, proof: 'live', selfPid: 20 }),
    { action: 'proceed', reason: 'self' });
});

test('decide: an unrecognised proof word never focuses', () => {
  const { decide } = load();
  for (const proof of [undefined, null, 'LIVE', true, 1, '']) {
    assert.strictEqual(decide({ owner: { pid: 10, start: START_A }, proof, selfPid: 20 }).action, 'proceed');
  }
});

// ---- the file's shape --------------------------------------------------------------------------------------------

test('parseOwner: a pid, a start and a time, and nothing else (the record never carried a port)', () => {
  const { parseOwner } = load();
  assert.deepStrictEqual(parseOwner(JSON.stringify({ pid: 7, start: START_A, at: 5, port: 9000, extra: 1 })),
    { pid: 7, start: START_A, at: 5 });
  assert.deepStrictEqual(parseOwner(JSON.stringify({ pid: 7, start: START_A })), { pid: 7, start: START_A, at: null });
});

test('parseOwner: refuses what is not a proof (no pid, bad pid, no start, not an object, half-written)', () => {
  const { parseOwner } = load();
  const bad = [
    '', '{', 'null', '[]', '7',
    JSON.stringify({ start: START_A }),
    JSON.stringify({ pid: 0, start: START_A }),
    JSON.stringify({ pid: -1, start: START_A }),
    JSON.stringify({ pid: 1.5, start: START_A }),
    JSON.stringify({ pid: '7', start: START_A }),
    JSON.stringify({ pid: 7 }),
    JSON.stringify({ pid: 7, start: '' }),
    JSON.stringify({ pid: 7, start: 12345 }),
  ];
  for (const text of bad) assert.strictEqual(parseOwner(text), null, text);
});

// ---- proving the owner: pid AND start time ----------------------------------------------------------------------------

test('proveOwner: the pid running with the same start time is live', async () => {
  const { proveOwner } = load();
  assert.strictEqual(await proveOwner({ pid: 10, start: START_A }, { startTimes: live(10, START_A) }), 'live');
});

test('proveOwner: the pid running with ANOTHER start time is a reused pid, so dead', async () => {
  const { proveOwner } = load();
  assert.strictEqual(await proveOwner({ pid: 10, start: START_A }, { startTimes: live(10, START_B) }), 'dead');
});

test('proveOwner: the pid not running is dead', async () => {
  const { proveOwner } = load();
  assert.strictEqual(await proveOwner({ pid: 10, start: START_A }, { startTimes: async () => new Map() }), 'dead');
});

test('proveOwner: a query that failed, a start that could not be read, or a throw is unknown, never dead', async () => {
  const { proveOwner } = load();
  assert.strictEqual(await proveOwner({ pid: 10, start: START_A }, { startTimes: async () => null }), 'unknown');
  assert.strictEqual(await proveOwner({ pid: 10, start: START_A }, { startTimes: async () => new Map([[10, null]]) }), 'unknown');
  assert.strictEqual(await proveOwner({ pid: 10, start: START_A }, { startTimes: async () => { throw new Error('boom'); } }), 'unknown');
});

// ---- the claim ---------------------------------------------------------------------------------------------------

test('claim: no file -> proceed, and the file now names this process', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => new Map(), now: () => 1234 });
  assert.strictEqual(r.action, 'proceed');
  assert.deepStrictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')), { pid: 20, start: START_B, at: 1234 });
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.claude-custom')).filter(f => f.endsWith('.tmp')), [], 'no temp file left');
});

test('claim: a live owner -> focus, and the file is left exactly as it was', async () => {
  const { claim } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const before = fs.readFileSync(ownerFileOf(root), 'utf8');
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: live(10, START_A) });
  assert.strictEqual(r.action, 'focus');
  assert.strictEqual(r.owner.pid, 10);
  assert.strictEqual(fs.readFileSync(ownerFileOf(root), 'utf8'), before);
});

test('claim: a stale file with a dead pid -> proceed, and the file is replaced', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => new Map() });
  assert.strictEqual(r.action, 'proceed');
  assert.strictEqual(r.reason, 'dead-owner');
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 20);
});

test('claim: a reused pid (same pid, different start time) is a dead owner', async () => {
  const { claim } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: live(10, START_B) });
  assert.strictEqual(r.action, 'proceed');
});

test('claim: a half-written or garbage file is no owner: proceed and replace it', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  writeOwner(root, '{"pid": 1');
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => new Map() });
  assert.strictEqual(r.action, 'proceed');
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 20);
});

test('claim: a proof that cannot be made -> proceed (a window opens) but the file of the owner it could not disprove is left alone', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const before = fs.readFileSync(ownerFileOf(root), 'utf8');
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => null });
  assert.strictEqual(r.action, 'proceed');
  assert.strictEqual(r.reason, 'unproven-owner');
  assert.strictEqual(r.published, false);
  assert.strictEqual(fs.readFileSync(ownerFileOf(root), 'utf8'), before, 'a slow PowerShell must not cut a live window off from the rule');
  assert.strictEqual(parseOwner(before).pid, 10);
});

test('claim: an unproven owner whose file is garbage is still replaced (it names nobody)', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  writeOwner(root, 'not json');
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => null });
  assert.strictEqual(r.action, 'proceed');
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 20);
});

test('claim: this process\'s own start time unknown -> proceed, publishes nothing (it could never be proved)', async () => {
  const { claim } = load();
  const root = project();
  const r = await claim({ stateRoot: root, self: { pid: 20, start: null }, startTimes: async () => new Map() });
  assert.strictEqual(r.action, 'proceed');
  assert.strictEqual(fs.existsSync(ownerFileOf(root)), false);
});

test('claim: a .claude-custom that is a link to somewhere else is never written through', async () => {
  const { claim } = load();
  const root = project();
  const elsewhere = tmpDir('cc-window-owner-else-');
  try { fs.symlinkSync(elsewhere, path.join(root, '.claude-custom'), 'junction'); } catch (e) { return; }   // no link rights: nothing to assert
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => new Map() });
  assert.strictEqual(r.action, 'proceed');
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('claim: a launch that comes second (sequentially) reads the winner\'s file and focuses it without ever reaching publish', async () => {
  const { claim } = load();
  const root = project();
  // Both read "no file". The winner lands its file between the loser's read and the loser's publish.
  let raced = false;
  const startTimes = async (pids) => new Map(pids.map(p => [p, START_A]));
  const win = await claim({ stateRoot: root, self: { pid: 10, start: START_A }, startTimes });
  assert.strictEqual(win.action, 'proceed');
  const hooks = { beforePublish: () => { raced = true; } };
  const lose = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes, hooks });
  assert.strictEqual(lose.action, 'focus');
  assert.strictEqual(lose.owner.pid, 10);
  assert.strictEqual(raced, false, 'a loser that reads the winner never reaches publish');
});

test('claim: two launches REALLY interleaved -- B runs its whole claim inside A\'s read-to-publish gap: exactly one publishes', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  const startTimes = async (pids) => new Map(pids.map(p => [p, p === 30 ? START_B : START_A]));
  let b = null;
  const hooks = {
    beforePublish: () => {
      hooks.beforePublish = () => {};
      // B's claim runs synchronously up to its publish (no owner yet, so nothing to await): it publishes first
      b = claim({ stateRoot: root, self: { pid: 30, start: START_B }, startTimes });
    },
  };
  const a = await claim({ stateRoot: root, self: { pid: 20, start: START_A }, startTimes, hooks });
  const bResult = await b;
  assert.strictEqual(bResult.action, 'proceed');
  assert.strictEqual(bResult.published, true);
  assert.strictEqual(a.action, 'focus', 'A lost the exclusive publish, re-read, and focused B');
  assert.strictEqual(a.owner.pid, 30);
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 30);
});

test('claim: the winner appearing between the loser\'s read and its publish -> the exclusive publish refuses, the retry focuses', async () => {
  const { claim } = load();
  const root = project();
  const startTimes = async (pids) => new Map(pids.map(p => [p, START_A]));
  const hooks = {
    beforePublish: () => { writeOwner(root, { pid: 10, start: START_A, at: 1 }); hooks.beforePublish = () => {}; },
  };
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes, hooks });
  assert.strictEqual(r.action, 'focus');
  assert.strictEqual(r.owner.pid, 10);
});

test('claim: a takeover of a dead owner never removes a file somebody else rewrote meanwhile', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });          // dead
  const startTimes = async (pids) => new Map(pids.filter(p => p !== 10).map(p => [p, START_A]));
  const hooks = {
    // between "it is dead" and our takeover, a third launch took over first
    beforePublish: () => { writeOwner(root, { pid: 30, start: START_A, at: 2 }); hooks.beforePublish = () => {}; },
  };
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes, hooks });
  assert.strictEqual(r.action, 'focus');
  assert.strictEqual(r.owner.pid, 30);
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 30);
});

test('claim: a filesystem that refuses hard links still publishes (rename, last writer wins)', async () => {
  const { claim, parseOwner } = load();
  const root = project();
  const link = () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; };
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => new Map(), link });
  assert.strictEqual(r.action, 'proceed');
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 20);
});

// ---- taking over an owner that was proven live but can't be reached ----------------------------------------------------------

test('takeOver: replaces a live-looking file (an owner mid-shutdown, or from a build without the pipe) so the new window is the owner', () => {
  const { takeOver, parseOwner } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const judgedText = fs.readFileSync(ownerFileOf(root), 'utf8');
  assert.strictEqual(takeOver({ stateRoot: root, self: { pid: 20, start: START_B }, judgedText, now: () => 77 }), true);
  assert.deepStrictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')), { pid: 20, start: START_B, at: 77 });
});

test('takeOver (M3): only the bytes that were judged are replaced; a file that names someone else now is left alone and says false', () => {
  const { takeOver, parseOwner } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const judgedText = fs.readFileSync(ownerFileOf(root), 'utf8');
  writeOwner(root, { pid: 11, start: START_A, at: 2 });          // L1 took over after the judgement
  assert.strictEqual(takeOver({ stateRoot: root, self: { pid: 20, start: START_B }, judgedText }), false);
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 11);
  assert.strictEqual(takeOver({ stateRoot: root, self: { pid: 20, start: START_B } }), false, 'with nothing judged it removes nothing');
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 11);
});

test('claim (M3): a focus result carries the file\'s bytes it judged', async () => {
  const { claim } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const text = fs.readFileSync(ownerFileOf(root), 'utf8');
  const r = await claim({ stateRoot: root, self: { pid: 20, start: START_B }, startTimes: async () => new Map([[10, START_A]]) });
  assert.strictEqual(r.action, 'focus');
  assert.strictEqual(r.text, text);
});

test('takeOver: with no start time for this process, or a foreign look folder, it changes nothing and says false', () => {
  const { takeOver } = load();
  const root = project();
  writeOwner(root, { pid: 10, start: START_A, at: 1 });
  const before = fs.readFileSync(ownerFileOf(root), 'utf8');
  assert.strictEqual(takeOver({ stateRoot: root, self: { pid: 20, start: null } }), false);
  assert.strictEqual(fs.readFileSync(ownerFileOf(root), 'utf8'), before);
});

// ---- release -----------------------------------------------------------------------------------------------------

test('release: removes the file only when it still names this process, by pid AND start time', () => {
  const { release } = load();
  const root = project();
  writeOwner(root, { pid: 20, start: START_B, at: 1 });
  assert.strictEqual(release({ stateRoot: root, selfPid: 99, selfStart: START_B }), false);
  assert.strictEqual(release({ stateRoot: root, selfPid: 20, selfStart: START_A }), false, 'same pid, another start: a reused pid\'s file');
  assert.strictEqual(release({ stateRoot: root, selfPid: 20 }), false, 'no start to prove: nothing is removed');
  assert.strictEqual(fs.existsSync(ownerFileOf(root)), true, 'another process\'s file stays');
  assert.strictEqual(release({ stateRoot: root, selfPid: 20, selfStart: START_B }), true);
  assert.strictEqual(fs.existsSync(ownerFileOf(root)), false);
  assert.strictEqual(release({ stateRoot: root, selfPid: 20, selfStart: START_B }), false, 'nothing to remove is not an error');
});

test('release: a dying owner W that read its own file does not delete the file L took over with in between', () => {
  const { release, parseOwner } = load();
  const root = project();
  writeOwner(root, { pid: 20, start: START_B, at: 1 });              // W's file
  const hooks = { afterRead: () => { writeOwner(root, { pid: 30, start: START_A, at: 2 }); hooks.afterRead = () => {}; } };   // L takes over
  assert.strictEqual(release({ stateRoot: root, selfPid: 20, selfStart: START_B, hooks }), false);
  assert.strictEqual(parseOwner(fs.readFileSync(ownerFileOf(root), 'utf8')).pid, 30, 'L\'s file is still there');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.claude-custom')).filter(n => n.endsWith('.gone')), [], 'no aside file left behind');
});

// ---- which lane to select ----------------------------------------------------------------------------------------

test('pickLane: the tab whose folder is the launch folder; a worktree folder picks that lane', () => {
  const { pickLane } = load();
  const tabs = [{ key: 'a', cwd: 'C:\\p\\dev' }, { key: 'b', cwd: 'C:\\p\\feat-x', port: 7002 }];
  assert.strictEqual(pickLane(tabs, { cwd: 'c:/p/feat-x/' }), 'b');
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\dev' }), 'a');
});

test('pickLane: a launch from a folder INSIDE a lane selects that lane; a sibling with the same prefix does not', () => {
  const { pickLane } = load();
  const tabs = [{ key: 'a', cwd: 'C:\\p\\dev' }, { key: 'b', cwd: 'C:\\p\\feat-x' }, { key: 'c', cwd: 'C:\\p\\feat-xy' }];
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\feat-x\\app' }), 'b');
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\feat-xy\\app\\src' }), 'c');
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\feat-xz\\app' }), null);
});

test('pickLane: nested lanes: the deepest tab that contains the folder wins; an exact match beats a containing one', () => {
  const { pickLane } = load();
  const tabs = [{ key: 'outer', cwd: 'C:\\p\\dev' }, { key: 'inner', cwd: 'C:\\p\\dev\\sub' }];
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\dev\\sub\\x' }), 'inner');
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\dev\\sub' }), 'inner');
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\dev\\other' }), 'outer');
});

test('pickLane: a port wins over a folder; nothing matching is null (focus only)', () => {
  const { pickLane } = load();
  const tabs = [{ key: 'a', cwd: 'C:\\p\\dev', port: 7001 }, { key: 'b', cwd: 'C:\\p\\feat-x', port: 7002 }];
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\p\\dev', port: 7002 }), 'b');
  assert.strictEqual(pickLane(tabs, { cwd: 'C:\\elsewhere' }), null);
  assert.strictEqual(pickLane([], { cwd: 'C:\\p\\dev' }), null);
  assert.strictEqual(pickLane(tabs, {}), null);
  assert.strictEqual(pickLane(null, { cwd: 'C:\\p\\dev' }), null);
});

test('forwardedCwd: only a lane\'s own folder is forwarded; the project\'s dev folder or root is a plain focus', () => {
  const { forwardedCwd } = load();
  const project = { kind: 'container', root: 'C:\\p', dev: 'C:\\p\\dev' };
  assert.strictEqual(forwardedCwd('C:\\p\\feat-x', project), 'C:\\p\\feat-x');
  assert.strictEqual(forwardedCwd('c:/p/dev/', project), undefined);
  assert.strictEqual(forwardedCwd('C:\\p', project), undefined);
  assert.strictEqual(forwardedCwd('', project), undefined);
  assert.strictEqual(forwardedCwd('C:\\p\\feat-x', null), undefined, 'a folder in no project has no lanes');
});

// ---- the property: never a second window while a proven live owner exists ----------------------------------------

test('property: decide never proceeds past a proven live owner that is not this process', () => {
  const { decide } = load();
  fc.assert(fc.property(
    fc.record({ pid: fc.integer({ min: 1, max: 99999 }), start: fc.string({ minLength: 1 }) }),
    fc.integer({ min: 1, max: 99999 }),
    (owner, selfPid) => {
      const r = decide({ owner, proof: 'live', selfPid });
      return selfPid === owner.pid ? r.action === 'proceed' : r.action === 'focus';
    }));
});

test('property: decide only ever focuses on the word "live"', () => {
  const { decide } = load();
  fc.assert(fc.property(fc.anything(), (proof) => {
    const r = decide({ owner: { pid: 1, start: 'x' }, proof, selfPid: 2 });
    return proof === 'live' ? r.action === 'focus' : r.action === 'proceed';
  }));
});

test('property: N launches on one project, the first one live -> exactly one proceeds, every later one focuses it', async () => {
  const { claim } = load();
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (n) => {
    const root = project();
    const pids = Array.from({ length: n }, (_, i) => 100 + i);
    // everyone launched is alive for the whole run, each with its own start time
    const startTimes = async (asked) => new Map(asked.map(p => [p, `S${p}`]));
    const results = [];
    for (const pid of pids) results.push(await claim({ stateRoot: root, self: { pid, start: `S${pid}` }, startTimes }));
    const proceeded = results.filter(r => r.action === 'proceed');
    return proceeded.length === 1 && results[0].action === 'proceed'
      && results.slice(1).every(r => r.action === 'focus' && r.owner.pid === pids[0]);
  }), { numRuns: 25 });
});

test('property: after any history of launches and exits, a launch proceeds exactly when no live owner is on file', async () => {
  const { claim, release } = load();
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('launch', 'exit', 'crash'), { minLength: 1, maxLength: 12 }), async (steps) => {
    const root = project();
    const alive = new Set();
    let next = 100;
    let owner = null;                               // the model: the live pid that owns the file, if any
    const startTimes = async (asked) => new Map(asked.filter(p => alive.has(p)).map(p => [p, `S${p}`]));
    for (const step of steps) {
      if (step === 'launch') {
        const pid = next++;
        alive.add(pid);
        const r = await claim({ stateRoot: root, self: { pid, start: `S${pid}` }, startTimes });
        if (owner !== null && alive.has(owner)) { if (r.action !== 'focus' || r.owner.pid !== owner) return false; }
        else { if (r.action !== 'proceed') return false; owner = pid; }
        if (r.action === 'focus') alive.delete(pid);   // it exits without a window
      } else if (owner !== null) {
        if (step === 'exit') release({ stateRoot: root, selfPid: owner });
        alive.delete(owner);                           // a crash leaves the file behind
        owner = null;
      }
    }
    return true;
  }), { numRuns: 40 });
});
