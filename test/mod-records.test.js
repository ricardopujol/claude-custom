'use strict';
/**
 * host/mod-records.js: what the host does with each record the claude-custom mod posts (BACKLOG #119 A2), with its collaborators injected.
 * It was inline in host.js, where only source-text assertions could reach it (PR #197 Miguel Y10).
 */
const test = require('node:test');
const assert = require('node:assert');
const { createModRecordHandler } = require('../host/mod-records');
const { createContextSource } = require('../host/context-source');

const SID = 'sess-1';
const usage = (extra = {}, sessionId = SID) => ({ v: 1, kind: 'usage', sessionId, at: 1000, usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-20T05:10:00.000Z' }], ...extra } });

function rig(over = {}) {
  let t = 0;
  const calls = { written: [], broadcasts: [], contexts: [], observed: [], asks: [], logs: [] };
  const contextSource = createContextSource({ now: () => ++t });
  let lastWindows = null;
  const deps = {
    getSessionId: () => SID,
    writeWindows: (w) => { calls.written.push(w); return true; },
    readQuota: () => ({ ok: true, windows: calls.written.length ? calls.written[calls.written.length - 1] : [] }),
    lastWindowsKey: () => lastWindows,
    broadcastQuota: (q) => { calls.broadcasts.push(q); lastWindows = JSON.stringify(q.windows); },
    contextSource,
    setContext: (c) => calls.contexts.push(c),
    mood: { observeAgents: (list, at) => calls.observed.push([list, at]) },
    attention: { ask: (a) => calls.asks.push(a) },
    log: (m) => calls.logs.push(m),
    ...over,
  };
  return { handle: createModRecordHandler(deps), calls, contextSource, deps };
}

test('a usage record writes its windows, reads the file back with no poll and broadcasts when they changed', () => {
  const r = rig();
  r.handle(usage());
  assert.strictEqual(r.calls.written.length, 1);
  assert.strictEqual(r.calls.written[0][0].key, 'session');
  assert.strictEqual(r.calls.broadcasts.length, 1);
  r.handle(usage());
  assert.strictEqual(r.calls.broadcasts.length, 1, 'the same windows again are not news');
});

test('a usage record with no rate limits writes and broadcasts nothing', () => {
  const r = rig({ writeWindows: () => false });
  r.handle(usage({ rateLimits: [] }));
  assert.deepStrictEqual(r.calls.broadcasts, []);
});

test('a read that is not a good figure is not broadcast', () => {
  const r = rig({ readQuota: () => ({ ok: false, windows: [] }) });
  r.handle(usage());
  assert.deepStrictEqual(r.calls.broadcasts, []);
});

test('a usage record with a context sets the circle', () => {
  const r = rig();
  r.handle(usage({ context: { tokens: 50, window: 200 } }));
  assert.deepStrictEqual(r.calls.contexts, [{ used: 50, size: 200 }]);
});

test('PR 197 Miguel Y5: a usage record with NO context never replaces the relay\'s figure: relay figure, mod record without context, the circle stays', () => {
  const r = rig();
  r.calls.contexts.push(r.contextSource.fromRelay({ used: 80, size: 200 }));       // the relay speaks
  r.handle(usage());                                                                // session.start before a turn: no context
  r.handle(usage({ context: { window: 200 } }));                                    // a window but no fill: still nothing to say
  assert.deepStrictEqual(r.calls.contexts, [{ used: 80, size: 200 }], 'setContext was never called by the mod');
  assert.deepStrictEqual(r.contextSource.current(), { used: 80, size: 200 });
});

test('PR 197 Dexter 7: a record for another session is dropped whole', () => {
  const r = rig();
  r.handle(usage({ context: { tokens: 5000, window: 200000 } }, 'other'));
  r.handle({ v: 1, kind: 'agents', sessionId: 'other', at: 1, agents: [{ id: 'a', status: 'waiting' }] });
  r.handle({ v: 1, kind: 'ask', sessionId: 'other', at: 1, ask: { tool: 'Bash' } });
  assert.deepStrictEqual(r.calls, { written: [], broadcasts: [], contexts: [], observed: [], asks: [], logs: [] });
  assert.strictEqual(r.contextSource.current(), null);
});

test('PR 197 Dexter 7: before the host knows its session id (no SessionStart yet) a record is taken', () => {
  const r = rig({ getSessionId: () => null });
  r.handle(usage({ context: { tokens: 5, window: 10 } }, 'whoever'));
  assert.strictEqual(r.calls.contexts.length, 1);
});

test('PR 197 Dexter 7: after a /clear the host\'s new session id applies at once', () => {
  let id = SID;
  const r = rig({ getSessionId: () => id });
  r.handle(usage({ context: { tokens: 5, window: 10 } }));
  id = 'sess-2';
  r.handle(usage({ context: { tokens: 6, window: 10 } }));
  assert.strictEqual(r.calls.contexts.length, 1, 'the old session\'s record is now foreign');
  r.handle(usage({ context: { tokens: 7, window: 10 } }, 'sess-2'));
  assert.strictEqual(r.calls.contexts.length, 2);
});

test('an agents record reaches the mood machine with the time the mod took it (Dexter 8)', () => {
  const r = rig();
  r.handle({ v: 1, kind: 'agents', sessionId: SID, at: 1234, agents: [{ id: 'a', status: 'waiting' }] });
  assert.deepStrictEqual(r.calls.observed, [[[{ id: 'a', status: 'waiting' }], 1234]]);
});

test('an ask record reaches attention', () => {
  const r = rig();
  r.handle({ v: 1, kind: 'ask', sessionId: SID, at: 1, ask: { tool: 'Write', agentId: 'a' } });
  assert.deepStrictEqual(r.calls.asks, [{ tool: 'Write', agentId: 'a' }]);
});

test('PR 197 Miguel Y8: an end record means nothing is waiting any more', () => {
  const r = rig();
  r.handle({ v: 1, kind: 'end', sessionId: SID, at: 77, reason: 'other' });
  assert.deepStrictEqual(r.calls.observed, [[[], 77]]);
});

test('a collaborator that throws is logged, never raised, and the next record still works', () => {
  let boom = true;
  const r = rig({ attention: { ask: () => { if (boom) throw new Error('boom'); } } });
  assert.doesNotThrow(() => r.handle({ v: 1, kind: 'ask', sessionId: SID, at: 1, ask: { tool: 'Bash' } }));
  assert.match(r.calls.logs[0], /boom/);
  boom = false;
  assert.doesNotThrow(() => r.handle({ v: 1, kind: 'ask', sessionId: SID, at: 2, ask: { tool: 'Bash' } }));
});

test('an unknown kind does nothing', () => {
  const r = rig();
  r.handle({ v: 1, kind: 'other', sessionId: SID, at: 1 });
  assert.deepStrictEqual(r.calls.observed, []);
});
