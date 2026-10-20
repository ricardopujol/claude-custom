'use strict';
/**
 * When the Changes panel is told to look again (BACKLOG #119 A3): after a hook event that says a file may have changed (a changing
 * tool's PreToolUse AND PostToolUse, and the end of a turn or a subagent), once things have been quiet for the debounce, and at
 * least every MAX_WAIT_MS while events keep coming. Nothing else wakes git.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createChangesNotifier, isChangingTool, isChangesOnly, DEBOUNCE_MS, MAX_WAIT_MS, CHANGING_TOOLS, POST_ONLY_TOOLS } = require('../host/changes-notifier');

// A virtual clock with a timer queue, so a test can say "Pre at t=0, Post at t=10 s" and look at what was announced and when.
function world() {
  let now = 0;
  const timers = [];
  const sent = [];
  const n = createChangesNotifier({
    announce: (m) => sent.push({ at: now, m }),
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  });
  const advanceTo = (ms) => {
    for (;;) {
      const next = timers.filter(t => t.live && t.at <= ms).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at; next.live = false; next.fn();
    }
    now = ms;
  };
  return { n, sent, advanceTo, at: (ms) => advanceTo(ms), timers, clock: () => now };
}
const ev = (event, tool) => ({ event, payload: tool === undefined ? {} : { tool_name: tool } });

test('the debounce is two seconds and the longest a busy turn can go unannounced is ten', () => {
  assert.strictEqual(DEBOUNCE_MS, 2000);
  assert.strictEqual(MAX_WAIT_MS, 10000);
});

test('the tools that can change files count, the readers do not', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.strictEqual(isChangingTool(t), true, t);
  for (const t of ['Read', 'Grep', 'Glob', 'Task', 'Agent', '', undefined, null, 5]) assert.strictEqual(isChangingTool(t), false, String(t));
  assert.deepStrictEqual([...CHANGING_TOOLS].sort(), ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'Write']);
});

test('a changing tool event announces `changed` once, two seconds after, not before', () => {
  const w = world();
  assert.strictEqual(w.n.handle(ev('PreToolUse', 'Edit')), true);
  w.at(1999);
  assert.deepStrictEqual(w.sent, []);
  w.at(2000);
  assert.deepStrictEqual(w.sent, [{ at: 2000, m: { type: 'changes', action: 'changed' } }]);
});

test('DEXTER 2, pinned verbatim: PreToolUse at t=0, the permission waits, PostToolUse at t=10 s: a `changed` AFTER t=10 s', () => {
  const w = world();
  w.n.handle(ev('PreToolUse', 'Edit'));
  w.at(10000);
  assert.deepStrictEqual(w.sent.map(s => s.at), [2000], 'the Pre alone fired early, before the edit landed');
  w.n.handle(ev('PostToolUse', 'Edit'));
  w.at(13000);
  assert.deepStrictEqual(w.sent.map(s => s.at), [2000, 12000], 'and the Post, which is when the edit landed, is announced after t=10 s');
});

test('a Stop or SubagentStop (the end of a turn or of a subagent) arms it too, so a turn whose last edit was approved late still ends on a fresh list', () => {
  const w = world();
  w.n.handle(ev('PreToolUse', 'Write'));
  w.at(5000);
  w.n.handle(ev('Stop'));
  w.at(8000);
  assert.deepStrictEqual(w.sent.map(s => s.at), [2000, 7000]);
  w.n.handle(ev('SubagentStop'));
  w.at(11000);
  assert.strictEqual(w.sent.length, 3);
});

test('PostToolUseFailure of a changing tool arms it (a failed Bash may still have written half)', () => {
  const w = world();
  assert.strictEqual(w.n.handle(ev('PostToolUseFailure', 'Bash')), true);
  w.at(2000);
  assert.strictEqual(w.sent.length, 1);
});

test('DEXTER 5: events every 1.5 s for a minute: an announcement goes out at least every ten seconds, not only when it all stops', () => {
  const w = world();
  for (let t = 0; t <= 60000; t += 1500) { w.at(t); w.n.handle(ev('PreToolUse', 'Edit')); }
  assert.ok(w.sent.length >= 5, `announced ${w.sent.length} times in a minute`);
  const gaps = w.sent.map((s, i) => s.at - (i === 0 ? 0 : w.sent[i - 1].at));
  assert.ok(gaps.every(g => g <= MAX_WAIT_MS + 1500), `gaps ${gaps.join(', ')}`);
});

test('a burst is ONE announcement while it stays under the max wait: each event pushes the timer back', () => {
  const w = world();
  w.n.handle(ev('PreToolUse', 'Edit'));
  w.at(1000); w.n.handle(ev('PreToolUse', 'Write'));
  w.at(2000); w.n.handle(ev('PostToolUse', 'Bash'));
  w.at(20000);
  assert.deepStrictEqual(w.sent.map(s => s.at), [4000]);
});

test('events that cannot change a file wake nothing', () => {
  const w = world();
  for (const e of [ev('PreToolUse', 'Read'), ev('PreToolUse', 'Grep'), { event: 'PreToolUse' }, { event: 'Status', payload: {} }, null, undefined, 'x', { event: 'Notification', payload: {} }]) {
    assert.strictEqual(w.n.handle(e), false);
  }
  assert.strictEqual(w.timers.length, 0);
});

test('isChangesOnly: the PostToolUse of the tools only the Changes panel hooks never reaches the mood engine or the Running panel', () => {
  for (const t of POST_ONLY_TOOLS) assert.strictEqual(isChangesOnly(ev('PostToolUse', t)), true, t);
  assert.deepStrictEqual([...POST_ONLY_TOOLS].sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell', 'Write']);
  // Bash's Post is hooked for the mood engine already: it is theirs, not ours
  for (const e of [ev('PostToolUse', 'Bash'), ev('PreToolUse', 'Edit'), ev('PostToolUse', 'Read'), ev('Stop'), null, {}]) assert.strictEqual(isChangesOnly(e), false);
});

test('a later burst announces again; close() drops a pending announcement', () => {
  const w = world();
  w.n.handle(ev('PostToolUse', 'Bash')); w.at(3000);
  w.n.handle(ev('PostToolUse', 'Bash')); w.at(6000);
  assert.strictEqual(w.sent.length, 2);
  w.n.handle(ev('PostToolUse', 'Bash'));
  w.n.close();
  w.at(20000);
  assert.strictEqual(w.sent.length, 2);
});

test('an announce that throws does not escape the timer', () => {
  const timers = [];
  const n = createChangesNotifier({ announce: () => { throw new Error('socket gone'); }, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  n.handle(ev('PreToolUse', 'Edit'));
  assert.doesNotThrow(() => timers[0]());
});

test('PROPERTY: any event stream leaves at most one live timer, never throws, and never goes MAX_WAIT_MS without announcing while events keep coming', () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 4000 }), fc.oneof(fc.constantFrom('Edit', 'Bash', 'Read', 'Write'), fc.anything())), { maxLength: 40 }), (steps) => {
    const w = world();
    let t = 0;
    for (const [dt, tool] of steps) { t += dt; w.at(t); w.n.handle(ev('PreToolUse', tool)); assert.ok(w.timers.filter(x => x.live).length <= 1); }
    w.at(t + MAX_WAIT_MS + DEBOUNCE_MS);
    assert.strictEqual(w.timers.filter(x => x.live).length, 0, 'everything armed has fired');
    for (let i = 1; i < w.sent.length; i += 1) assert.ok(w.sent[i].at - w.sent[i - 1].at > 0);
  }));
});
