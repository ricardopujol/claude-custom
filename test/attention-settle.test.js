'use strict';
/**
 * PR #201 round 2 (Dexter N1, N3, N4): a 7501 `done` waits out a settle window and is never released by one event alone; a background
 * agent's prompt still raises with 7501 live. Fake clock and timers, so the order of events is the test's to choose.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createAttention } = require('../host/attention');

const rec = (state, extra = {}) => ({ id: '', state, kind: null, progress: null, app: null, title: null, msg: null, ...extra });
const snap = (state, children = []) => ({ live: true, root: state === null ? null : rec(state), children });
const kid = (id, state) => rec(state, { id });

function th() {
  let t = 1_000_000;
  const timers = [];
  const sent = [];
  const a = createAttention({
    now: () => t, project: 'claude-custom', settleMs: 1500, shellStartedAt: () => null,
    setTimer: (fn, ms) => { const timer = { at: t + ms, fn, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.live = false; },
  });
  a.on('attention', e => sent.push(e));
  return {
    a, sent,
    fire(event, payload = {}) { a.handle({ event, payload }); },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter(x => x.live && x.at <= end).sort((p, q) => p.at - q.at)[0];
        if (!due) break;
        due.live = false; t = Math.max(t, due.at); due.fn();
      }
      t = end;
    },
  };
}
const RUNNING_X = { background_tasks: [{ id: 'x', type: 'subagent', status: 'running' }] };

test('7501: done is a finished turn, not urgent, raised after the settle window', () => {
  const h = th();
  h.a.programStatus(snap('done'));
  assert.deepStrictEqual(h.sent, [], 'not at once');
  h.tick(1499);
  assert.deepStrictEqual(h.sent, []);
  h.tick(2);
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'finished');
  assert.strictEqual(h.sent[0].urgent, false);
});

test('N1: Stop{x running} -> done -> SubagentStop x -> working -> done is ONE finished, after the last done', () => {
  const h = th();
  h.a.programStatus(snap('working'));
  h.fire('Stop', RUNNING_X);
  h.a.programStatus(snap('done'));
  h.tick(400);
  h.fire('SubagentStop', { agent_id: 'x' });
  h.tick(300);                                   // its result is about to start the next turn
  h.a.programStatus(snap('working'));
  h.tick(5000);
  assert.deepStrictEqual(h.sent, [], 'nothing mid-work');
  h.a.programStatus(snap('done'));
  h.tick(2000);
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'finished');
});

test('SubagentStop alone never releases a held done; the window after it does, if nothing is running', () => {
  const h = th();
  h.a.programStatus(snap('working'));
  h.fire('Stop', RUNNING_X);
  h.a.programStatus(snap('done'));
  h.tick(5000);
  assert.deepStrictEqual(h.sent, [], 'a running subagent holds it however long the window');
  h.fire('SubagentStop', { agent_id: 'x' });
  assert.deepStrictEqual(h.sent, [], 'not at the SubagentStop itself');
  h.tick(1600);
  assert.strictEqual(h.sent.length, 1);
});

test('a child record in state working holds a done; it is raised once the child stops', () => {
  const h = th();
  h.a.programStatus(snap('working', [kid('t1', 'working')]));
  h.a.programStatus(snap('done', [kid('t1', 'working')]));
  h.tick(10_000);
  assert.deepStrictEqual(h.sent, []);
  h.a.programStatus(snap('done', [kid('t1', 'done')]));
  h.tick(1600);
  assert.strictEqual(h.sent.length, 1);
});

test('N3: the report before the Stop pipe message: a Stop listing a running subagent still holds it', () => {
  const h = th();
  h.a.programStatus(snap('working'));
  h.a.programStatus(snap('done'));                 // parsed first
  h.fire('Stop', RUNNING_X);                       // the hook lands within the window
  h.tick(5000);
  assert.deepStrictEqual(h.sent, []);
  h.fire('SubagentStop', { agent_id: 'x' });
  h.tick(1600);
  assert.strictEqual(h.sent.length, 1);
});

test('N3: a done held by an earlier Stop, then a Stop listing nothing: raised once, not stuck', () => {
  const h = th();
  h.a.programStatus(snap('working'));
  h.fire('Stop', RUNNING_X);
  h.a.programStatus(snap('done'));
  h.fire('Stop', {});                              // the next turn's Stop lists nothing running
  h.tick(1600);
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'finished');
});

test('a working report inside the window cancels the done; idle after done keeps it', () => {
  const a = th();
  a.a.programStatus(snap('done'));
  a.tick(1000);
  a.a.programStatus(snap('working'));
  a.tick(5000);
  assert.deepStrictEqual(a.sent, []);
  const b = th();
  b.a.programStatus(snap('done'));
  b.a.programStatus(snap('idle'));
  b.tick(1600);
  assert.strictEqual(b.sent.length, 1);
});

test('a blocked report cancels a pending done (it needs you now, not finished)', () => {
  const h = th();
  h.a.programStatus(snap('done'));
  h.a.programStatus(snap('blocked'));
  h.tick(5000);
  assert.deepStrictEqual(h.sent.map(e => e.kind), ['input-needed']);
});

test('7501 live, no done ever said: a released hook hold raises nothing (7501 owns the main cue)', () => {
  const h = th();
  h.a.programStatus(snap('working'));
  h.fire('Stop', RUNNING_X);
  h.fire('SubagentStop', { agent_id: 'x' });
  h.fire('Notification', { notification_type: 'idle_prompt' });
  h.tick(10_000);
  assert.deepStrictEqual(h.sent, []);
});

test('7501 done held by a young shell is raised after the shell times out and the window passes', () => {
  const h = th();
  h.a.programStatus(snap('working'));
  h.fire('Stop', { background_tasks: [{ id: 's1', type: 'shell', status: 'running' }] });
  h.a.programStatus(snap('done'));
  h.tick(60_000);
  assert.deepStrictEqual(h.sent, []);
  h.tick(11 * 60 * 1000);
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].kind, 'finished');
});

test('SessionEnd drops a pending done', () => {
  const h = th();
  h.a.programStatus(snap('done'));
  h.fire('SessionEnd', {});
  h.tick(5000);
  assert.deepStrictEqual(h.sent, []);
});

test('N4: a background agent PermissionRequest raises with 7501 live and the root idle; the main session own does not', () => {
  const h = th();
  h.a.programStatus(snap('idle'));
  h.fire('PermissionRequest', { agent_id: 'a1', agent_type: 'reviewer', tool_name: 'Edit' });
  assert.strictEqual(h.sent.length, 1);
  assert.strictEqual(h.sent[0].urgent, true);
  h.fire('Notification', { notification_type: 'permission_prompt' });
  assert.strictEqual(h.sent.length, 1, 'the CLI Notification for the same prompt is the same cue');
  const m = th();
  m.a.programStatus(snap('idle'));
  m.fire('PermissionRequest', { tool_name: 'Edit' });
  assert.deepStrictEqual(m.sent, []);
});

test('N4: an MCP form (elicitation_dialog) still raises with 7501 live: it may be a background agent one', () => {
  const h = th();
  h.a.programStatus(snap('idle'));
  h.fire('Notification', { notification_type: 'elicitation_dialog' });
  assert.strictEqual(h.sent.length, 1);
});

test('without 7501 a PermissionRequest raises nothing new: the hooks path is as it was', () => {
  const h = th();
  h.fire('PermissionRequest', { tool_name: 'Edit' });
  assert.deepStrictEqual(h.sent, []);
});
