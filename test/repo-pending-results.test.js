'use strict';
/**
 * PR #95 Dexter r2 R2-1: since D1 an edit counts only once its tool_result is in the transcript. The overlay read
 * is triggered by the worktree watch ~0.3s after the write, and the result line lands ~0.6s after it (once the
 * PostToolUse hooks finish), in a transcript OUTSIDE the watched worktree: nothing re-read afterwards, so a turn's
 * last Edit never got its badge. A read that sees RECENT unanswered calls on files of this worktree now schedules
 * a re-read after a short settle, and tells the page when the overlay changed. An unanswered call is still never
 * counted.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir } = require('./tmp-dir');
const { createRepoService } = require('../host/repo-service');

const ROOT = 'C:/Users/ricar/VibeCode/proj';

function rig({ now = () => Date.now() } = {}) {
  const dir = tmpDir('cc-pending-');
  const proj = path.join(dir, 'C--Users-ricar-VibeCode-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's.jsonl');
  const timers = [];
  const announced = [];
  let handler = null;
  const svc = createRepoService({
    root: ROOT, projectsDir: dir,
    index: { refresh: async () => ({ ok: true }), list: () => ({ ok: true, entries: [] }), resolve: () => undefined },
    watch: (d, onChange) => { handler = onChange; return { close() {} }; },
    announce: (m) => announced.push(m),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    now,
  });
  const line = (o) => fs.appendFileSync(file, JSON.stringify(o) + '\n');
  const fire = async () => { const t = timers.find(x => !x.cleared && !x.fired); if (!t) return false; t.fired = true; await t.fn(); return true; };
  return { svc, line, timers, announced, fire, change: () => handler(), ask: () => svc.handle({ type: 'repo', action: 'overlay', seq: 1 }) };
}
const ts = (ms) => new Date(ms).toISOString();
const use = (id, name, input, at) => ({ type: 'assistant', timestamp: ts(at), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, at, content = 'ok', is_error) => ({ type: 'user', timestamp: ts(at), message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error } : {}) }] } });

test('R2-1: the result lands AFTER the read and no worktree event follows: the file is eventually marked', async () => {
  const t0 = Date.now();
  const { svc, line, announced, fire, change, ask } = rig();
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 0 });          // starts the watch
  line(use('t1', 'Edit', { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' }, t0));
  await change();                                                                // the worktree event (the write)
  const first = await ask();
  assert.deepStrictEqual(first.files, [], 'an unanswered call is never counted');
  line(result('t1', t0 + 600));                                                  // the result, 0.6s later: no worktree event
  assert.strictEqual(await fire(), true, 'a re-read was scheduled because the read saw an unanswered call');
  const again = await ask();
  assert.deepStrictEqual(again.files.map(f => [f.path, f.edits]), [['a.js', 1]]);
  assert.ok(announced.some(m => m.type === 'repo' && m.action === 'overlay-ready'), 'and the page was told the overlay changed');
});

test('R2-1: a new untracked Write whose result lands later is marked edited too (so its Diff toggle appears)', async () => {
  const t0 = Date.now();
  const { svc, line, fire, ask } = rig();
  line(use('w1', 'Write', { file_path: `${ROOT}/new.js`, content: 'x\n' }, t0));
  assert.deepStrictEqual((await ask()).files, []);
  line(result('w1', t0 + 600));
  assert.strictEqual(await fire(), true, 'the re-read that marks it (and tells the page, so its Diff toggle appears)');
  assert.deepStrictEqual((await ask()).files.map(f => [f.path, f.tier, f.edits]), [['new.js', 'edited', 1]]);
});

test('R2-1: an unanswered call is NEVER counted, however many re-reads: a refused or failed one stays out', async () => {
  const t0 = Date.now();
  const { svc, line, fire, ask } = rig();
  line(use('t1', 'Edit', { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' }, t0));
  await ask();
  line(result('t1', t0 + 400, 'Found 2 matches', true));
  await fire();
  assert.deepStrictEqual((await ask()).files, []);
});

test('R2-1: nothing is re-read when there is nothing pending (no timer, no push)', async () => {
  const t0 = Date.now();
  const { svc, line, timers, announced, ask } = rig();
  line(use('t1', 'Edit', { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' }, t0));
  line(result('t1', t0 + 300));
  await ask();
  assert.strictEqual(timers.filter(t => !t.cleared).length, 0);
  assert.deepStrictEqual(announced, []);
});

test('R2-1: a call for a file OUTSIDE this worktree does not keep the host re-reading', async () => {
  const t0 = Date.now();
  const { svc, line, timers, ask } = rig();
  line(use('t1', 'Edit', { file_path: 'C:/elsewhere/a.js', old_string: 'x', new_string: 'y' }, t0));
  await ask();
  assert.strictEqual(timers.filter(t => !t.cleared).length, 0);
});

test('R2-1: an OLD unanswered call (the process died mid-edit) is not chased: the re-reads are for what is happening now', async () => {
  const t0 = Date.now();
  const { svc, line, timers, ask } = rig();
  line(use('t1', 'Edit', { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' }, t0 - 10 * 60 * 1000));
  await ask();
  assert.strictEqual(timers.filter(t => !t.cleared).length, 0);
});

test('R2-1: a result that never comes stops being chased: a bounded number of re-reads, then quiet', async () => {
  const t0 = Date.now();
  const { svc, line, timers, fire, ask } = rig();
  line(use('t1', 'Edit', { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' }, t0));
  await ask();
  let fired = 0;
  while (await fire()) { fired += 1; if (fired > 50) break; }
  assert.ok(fired >= 2 && fired <= 10, `re-reads: ${fired}`);
  assert.strictEqual(timers.filter(t => !t.cleared && !t.fired).length, 0);
});

test('R2-1: a worktree change starts a fresh episode, so a later edit gets its re-reads again', async () => {
  const t0 = Date.now();
  const { svc, line, fire, change, ask } = rig();
  await svc.handle({ type: 'repo', action: 'list', dir: '', seq: 0 });
  line(use('t1', 'Edit', { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' }, t0));
  await ask();
  while (await fire()) { /* exhaust */ }
  line(use('t2', 'Edit', { file_path: `${ROOT}/b.js`, old_string: 'x', new_string: 'y' }, Date.now()));
  await change();
  await ask();
  line(result('t2', Date.now() + 500));
  assert.strictEqual(await fire(), true);
  assert.ok((await ask()).files.some(f => f.path === 'b.js'));
});

test('R2-1: close() cancels a pending re-read', async () => {
  const t0 = Date.now();
  const { svc, line, timers, ask } = rig();
  line(use('t1', 'Edit', { file_path: `${ROOT}/a.js`, old_string: 'x', new_string: 'y' }, t0));
  await ask();
  svc.close();
  assert.ok(timers.every(t => t.cleared || t.fired));
});
