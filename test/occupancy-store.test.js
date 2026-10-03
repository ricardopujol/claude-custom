'use strict';
/**
 * host/occupancy-store.js: the claim files themselves (backlog #44 + #47). One file per agent in
 * `<state>\.claude-custom\occupancy\<agent_id>.json`, written atomically, `lastAt` rewritten at most every
 * 30 s, deleted on SubagentStop, and swept by the next PRODUCER -- never by a reader.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./tmp-dir');

const S = require('../host/occupancy-store');
const O = require('../host/agent-occupancy');

const DEV = path.resolve('/occ-store/dev');
const FEAT = path.resolve('/occ-store/feat-x');
const FEAT2 = path.resolve('/occ-store/feat-y');

const record = (over = {}) => ({
  agentId: 'ag1', agent: 'electron-pro', worktree: FEAT, also: [], fromBranch: 'develop', fromRoot: DEV,
  hostPid: 4242, hostStartedAt: '1000', firstAt: 100, lastAt: 200, count: 1, ...over,
});
const files = dir => fs.readdirSync(dir).sort();

function rig(over = {}) {
  const state = tmpDir('occ-store-');
  const clock = { t: 1_000_000 };
  const dir = S.occupancyDir(state);
  const logs = [];
  const writer = S.createClaimWriter({ stateRoot: state, now: () => clock.t, log: (...a) => logs.push(a.join(' ')), ...over });
  return { state, clock, dir, writer, logs };
}

test('the folder is <state>\\.claude-custom\\occupancy', () => {
  assert.strictEqual(S.occupancyDir('/p/dev'), path.join('/p/dev', '.claude-custom', 'occupancy'));
});

test('a claim is written whole, as a file named for its agent, and reads back', () => {
  const r = rig();
  assert.strictEqual(r.writer.write(record()).ok, true);
  assert.deepStrictEqual(files(r.dir), ['ag1.json']);
  const back = O.parseClaim(fs.readFileSync(path.join(r.dir, 'ag1.json'), 'utf8'));
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.claim.worktree, FEAT);
});

test('the look folder gets its .gitignore first, so a claim never shows in git status', () => {
  const r = rig();
  r.writer.write(record());
  assert.ok(fs.existsSync(path.join(r.state, '.claude-custom', '.gitignore')));
});

test('no temp file is left behind', () => {
  const r = rig();
  r.writer.write(record());
  r.writer.write(record({ worktree: FEAT2 }));
  assert.deepStrictEqual(files(r.dir), ['ag1.json']);
});

test('lastAt is rewritten at most every 30 s: the same claim inside the window is not written again', () => {
  const r = rig();
  assert.strictEqual(r.writer.write(record({ lastAt: 1 })).wrote, true);
  r.clock.t += S.REWRITE_MS - 1;
  const again = r.writer.write(record({ lastAt: 2, count: 9 }));
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.wrote, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'ag1.json'), 'utf8')).lastAt, 1);
  r.clock.t += 1;
  assert.strictEqual(r.writer.write(record({ lastAt: 3 })).wrote, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'ag1.json'), 'utf8')).lastAt, 3);
});

test('a CHANGE is never throttled: a new worktree, or a new `also`, is written at once', () => {
  const r = rig();
  r.writer.write(record());
  assert.strictEqual(r.writer.write(record({ worktree: FEAT2, also: [FEAT] })).wrote, true);
  assert.strictEqual(r.writer.write(record({ worktree: FEAT2, also: [FEAT] })).wrote, false);
  assert.strictEqual(r.writer.write(record({ worktree: FEAT2, also: [FEAT, DEV] })).wrote, true);
});

test('two agents are throttled independently', () => {
  const r = rig();
  r.writer.write(record({ agentId: 'a' }));
  assert.strictEqual(r.writer.write(record({ agentId: 'b' })).wrote, true);
  assert.deepStrictEqual(files(r.dir), ['a.json', 'b.json']);
});

test('remove deletes the agent\'s file, forgets it, and a removal of nothing is not an error', () => {
  const r = rig();
  r.writer.write(record());
  assert.strictEqual(r.writer.remove('ag1').ok, true);
  assert.deepStrictEqual(files(r.dir), []);
  assert.strictEqual(r.writer.remove('ag1').ok, true);
  assert.strictEqual(r.writer.remove('never-seen').ok, true);
  assert.strictEqual(r.writer.write(record()).wrote, true, 'a removed claim is written fresh, not throttled');
});

test('remove refuses an id that is not a safe name, and touches nothing', () => {
  const r = rig();
  r.writer.write(record());
  assert.strictEqual(r.writer.remove('../ag1').ok, false);
  assert.deepStrictEqual(files(r.dir), ['ag1.json']);
});

test('removeAll deletes exactly the claims THIS writer made', () => {
  const r = rig();
  r.writer.write(record({ agentId: 'mine' }));
  fs.writeFileSync(path.join(r.dir, 'theirs.json'), O.serializeClaim(record({ agentId: 'theirs' })));
  r.writer.removeAll();
  assert.deepStrictEqual(files(r.dir), ['theirs.json']);
});

test('a write that fails is reported, not thrown, and leaves no temp file', () => {
  const r = rig({ fsImpl: { ...fs, renameSync: () => { const e = new Error('nope'); e.code = 'EINVAL'; throw e; } } });
  const out = r.writer.write(record());
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /nope/);
  assert.deepStrictEqual(fs.existsSync(r.dir) ? files(r.dir) : [], []);
});

test('a failed write is retried at once next time (a failure must not start the 30 s window)', () => {
  let fail = true;
  const r = rig({ fsImpl: { ...fs, renameSync: (a, b) => { if (fail) throw Object.assign(new Error('x'), { code: 'EINVAL' }); return fs.renameSync(a, b); } } });
  assert.strictEqual(r.writer.write(record()).ok, false);
  fail = false;
  assert.strictEqual(r.writer.write(record()).wrote, true);
});

test('a .claude-custom that is a link elsewhere is never written through', () => {
  const state = tmpDir('occ-store-link-');
  const elsewhere = tmpDir('occ-store-elsewhere-');
  try { fs.symlinkSync(elsewhere, path.join(state, '.claude-custom'), 'junction'); } catch { return; }   // can't link here: nothing to test
  const writer = S.createClaimWriter({ stateRoot: state, now: () => 1, log: () => {} });
  const out = writer.write(record());
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /link/);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('a record that is not a valid claim is refused before anything is written', () => {
  const r = rig();
  assert.strictEqual(r.writer.write(record({ agentId: '../x' })).ok, false);
  assert.strictEqual(r.writer.write(null).ok, false);
  assert.ok(!fs.existsSync(r.dir) || files(r.dir).length === 0);
});

// --- reading ------------------------------------------------------------------------------------

test('readAll: good claims come back; the folder missing is "missing", not an error', () => {
  const r = rig();
  assert.deepStrictEqual(S.readAll(r.dir), { state: 'missing', claims: [], skipped: [] });
  r.writer.write(record({ agentId: 'a' }));
  r.writer.write(record({ agentId: 'b', worktree: FEAT2 }));
  const out = S.readAll(r.dir);
  assert.strictEqual(out.state, 'ok');
  assert.deepStrictEqual(out.claims.map(c => c.agentId).sort(), ['a', 'b']);
});

test('readAll: a malformed file is skipped, named, and never shown', () => {
  const r = rig();
  r.writer.write(record({ agentId: 'good' }));
  fs.writeFileSync(path.join(r.dir, 'bad.json'), '{ not json');
  fs.writeFileSync(path.join(r.dir, 'worse.json'), JSON.stringify({ agentId: 'worse' }));
  const out = S.readAll(r.dir);
  assert.deepStrictEqual(out.claims.map(c => c.agentId), ['good']);
  assert.deepStrictEqual(out.skipped.map(s => s.file).sort(), ['bad.json', 'worse.json']);
  assert.ok(out.skipped.every(s => typeof s.reason === 'string' && s.reason));
});

test('readAll: a file that names a different agent than its own name is skipped (an id is its file name)', () => {
  const r = rig();
  fs.mkdirSync(r.dir, { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'other.json'), O.serializeClaim(record({ agentId: 'ag1' })));
  const out = S.readAll(r.dir);
  assert.deepStrictEqual(out.claims, []);
  assert.strictEqual(out.skipped.length, 1);
});

test('readAll: only <safe id>.json is opened -- never a temp, a subfolder, or a stray', () => {
  const r = rig();
  fs.mkdirSync(path.join(r.dir, 'sub.json'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'ag1.json.tmp123'), 'x');
  fs.writeFileSync(path.join(r.dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(r.dir, 'has space.json'), 'x');
  const out = S.readAll(r.dir);
  assert.deepStrictEqual(out, { state: 'ok', claims: [], skipped: [] });
});

test('readAll: an oversize file is skipped without being parsed', () => {
  const r = rig();
  fs.mkdirSync(r.dir, { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'big.json'), ' '.repeat(S.MAX_CLAIM_BYTES + 1));
  const out = S.readAll(r.dir);
  assert.deepStrictEqual(out.claims, []);
  assert.match(out.skipped[0].reason, /large/);
});

test('readAll: a folder that can\'t be listed is "unreadable" -- never a quiet empty "free"', () => {
  const out = S.readAll('/x', { fsImpl: { readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
  assert.strictEqual(out.state, 'unreadable');
  assert.deepStrictEqual(out.claims, []);
  assert.match(out.error, /denied/);
});

test('readAll: a file that can\'t be READ is skipped with its reason, the others still come back', () => {
  const r = rig();
  r.writer.write(record({ agentId: 'good' }));
  r.writer.write(record({ agentId: 'locked' }));
  const out = S.readAll(r.dir, { fsImpl: { ...fs, readFileSync: (f, ...a) => { if (String(f).endsWith('locked.json')) throw new Error('EBUSY'); return fs.readFileSync(f, ...a); } } });
  assert.deepStrictEqual(out.claims.map(c => c.agentId), ['good']);
  assert.strictEqual(out.skipped[0].file, 'locked.json');
});

// --- sweeping -----------------------------------------------------------------------------------

test('sweepDead deletes the claims judged dead, and ONLY those', async () => {
  const r = rig();
  for (const id of ['dead', 'live', 'unknown', 'unproven']) r.writer.write(record({ agentId: id }));
  const verdicts = { dead: 'dead', live: 'live', unknown: 'unknown', unproven: 'unproven' };
  const out = await S.sweepDead(r.dir, { judge: async cs => cs.map(c => ({ claim: c, verdict: verdicts[c.agentId] })) });
  assert.deepStrictEqual(out.removed, ['dead']);
  assert.deepStrictEqual(files(r.dir), ['live.json', 'unknown.json', 'unproven.json']);
});

test('sweepDead leaves malformed files alone (they may be somebody\'s data) and survives a failing judge', async () => {
  const r = rig();
  r.writer.write(record({ agentId: 'a' }));
  fs.writeFileSync(path.join(r.dir, 'bad.json'), 'nope');
  const out = await S.sweepDead(r.dir, { judge: async () => { throw new Error('boom'); } });
  assert.deepStrictEqual(out.removed, []);
  assert.deepStrictEqual(files(r.dir), ['a.json', 'bad.json']);
});

test('sweepDead on a missing or unreadable folder does nothing and says so', async () => {
  const r = rig();
  assert.deepStrictEqual((await S.sweepDead(r.dir, { judge: async () => [] })).removed, []);
});

test('sweepDead never deletes a claim that came back live between the read and the delete', async () => {
  const r = rig();
  r.writer.write(record({ agentId: 'a' }));
  // the claim file is REWRITTEN (a new worktree) while the verdict is being worked out
  const out = await S.sweepDead(r.dir, {
    judge: async (cs) => {
      r.writer.write(record({ agentId: 'a', worktree: FEAT2 }));
      return cs.map(c => ({ claim: c, verdict: 'dead' }));
    },
  });
  assert.deepStrictEqual(out.removed, [], 'the file no longer says what was judged');
  assert.deepStrictEqual(files(r.dir), ['a.json']);
});
