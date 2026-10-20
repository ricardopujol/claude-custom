'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { tabStatus, afterSelected, sameStatus, pendingAfter } = require('../app/tab-status');

// A stand-in with the real marker's contract ({ text } or null). The renderer
// injects worktreeStatus.healthMarker; requiring it here would put a mutated
// module under this test (test/stryker-config.test.js).
const healthMarker = (h) => {
  if (h && h.kind === 'tab' && h.behindDevelop > 0) return { text: `↓${h.behindDevelop}` };
  if (h && h.kind === 'dev' && h.developAheadOfMain > 0) return { text: `+${h.developAheadOfMain}` };
  return null;
};

const ts = (inputs) => tabStatus(inputs, { healthMarker });

test('working is exactly mainMood === working', () => {
  assert.strictEqual(ts({ mainMood: 'working' }).working, true);
  for (const mood of ['idle', 'thinking', undefined, null, 'WORKING']) {
    assert.strictEqual(ts({ mainMood: mood }).working, false);
  }
});

test('needsInput is exactly pendingUrgent === true', () => {
  assert.strictEqual(ts({ pendingUrgent: true }).needsInput, true);
  for (const v of [false, undefined, null, 1, 'true']) {
    assert.strictEqual(ts({ pendingUrgent: v }).needsInput, false);
  }
});

test('finished is exactly pendingFinished === true (#31)', () => {
  assert.strictEqual(ts({ pendingFinished: true }).finished, true);
  for (const v of [false, undefined, null, 1, 'true']) {
    assert.strictEqual(ts({ pendingFinished: v }).finished, false);
  }
});

test('afterSelected clears needsInput and finished, and leaves the rest', () => {
  const s = ts({ mainMood: 'working', pendingUrgent: true, pendingFinished: true, lock: { state: 'held' }, health: { kind: 'tab', behindDevelop: 2 } });
  assert.strictEqual(s.needsInput, true);
  assert.strictEqual(s.finished, true);
  const cleared = afterSelected(s);
  assert.deepStrictEqual(cleared, { ...s, needsInput: false, finished: false });
  assert.strictEqual(s.needsInput, true, 'does not mutate');
  assert.strictEqual(s.finished, true, 'does not mutate');
});

test('lock is the message state when known, else null (never held)', () => {
  for (const st of ['held', 'unlocked', 'blocked', 'override', 'pending']) {
    assert.strictEqual(ts({ lock: { state: st } }).lock, st);
  }
  for (const bad of [{ state: 'weird' }, { state: 5 }, {}, null, undefined, 'held']) {
    assert.strictEqual(ts({ lock: bad }).lock, null);
  }
});

test('health is the marker text or null', () => {
  assert.strictEqual(ts({ health: { kind: 'tab', behindDevelop: 3 } }).health, '↓3');
  assert.strictEqual(ts({ health: { kind: 'dev', developAheadOfMain: 12 } }).health, '+12');
  assert.strictEqual(ts({ health: { kind: 'tab', behindDevelop: 0 } }).health, null);
  assert.strictEqual(ts({ health: null }).health, null);
});

test('without an injected healthMarker, health is null rather than a throw', () => {
  assert.strictEqual(tabStatus({ health: { kind: 'tab', behindDevelop: 3 } }).health, null);
  assert.strictEqual(tabStatus({ health: 1 }, { healthMarker: () => ({}) }).health, null);
});

test('no inputs at all is a quiet status', () => {
  assert.deepStrictEqual(ts(undefined), { working: false, needsInput: false, finished: false, lock: null, health: null, turn: null, night: false, summary: null, summaryNote: null, program: null });
  assert.deepStrictEqual(ts({}), { working: false, needsInput: false, finished: false, lock: null, health: null, turn: null, night: false, summary: null, summaryNote: null, program: null });
});

// Backlog #52: the host's word that a /bedtime night is on (host/bedtime-state.js), for the strip's night tab.
test('night is true only for a real true: absence is never a night', () => {
  assert.strictEqual(ts({ night: true }).night, true);
  for (const bad of [undefined, null, false, 'true', 1, {}, []]) assert.strictEqual(ts({ night: bad }).night, false, String(bad));
});

test('a look never clears the night (it is the run\'s, not something waiting for you)', () => {
  assert.strictEqual(afterSelected(ts({ pendingUrgent: true, night: true })).night, true);
});

// PR #93 Dexter F1/F2: the host's own word on the MAIN session, from the CLI's hooks (host/turn-state.js).
test("turn is the host's idle / turn / prompt, or null when it hasn't said: never a guessed idle", () => {
  for (const t of ['idle', 'turn', 'prompt']) assert.strictEqual(ts({ turn: t }).turn, t);
  for (const bad of [undefined, null, 'busy', '', 1, true, {}]) assert.strictEqual(ts({ turn: bad }).turn, null);
});

test('Dexter F2: a look clears "needs you" but never the turn: an open dialog is still open after a glance', () => {
  const s = ts({ pendingUrgent: true, turn: 'prompt' });
  assert.strictEqual(afterSelected(s).needsInput, false);
  assert.strictEqual(afterSelected(s).turn, 'prompt');
});

test('sameStatus: field by field, and null handling', () => {
  const base = { working: true, needsInput: false, finished: false, lock: 'held', health: '↓3', turn: 'turn', night: false };
  assert.strictEqual(sameStatus(base, { ...base }), true);
  for (const [k, v] of [['working', false], ['needsInput', true], ['finished', true], ['lock', null], ['health', null], ['turn', 'idle'], ['night', true]]) {
    assert.strictEqual(sameStatus(base, { ...base, [k]: v }), false, k);
  }
  assert.strictEqual(sameStatus(null, null), true);
  assert.strictEqual(sameStatus(undefined, null), false);
  assert.strictEqual(sameStatus(base, null), false);
  assert.strictEqual(sameStatus(null, base), false);
  assert.strictEqual(sameStatus(undefined, undefined), true);
});

test('pendingAfter: a finished turn answers a pending urgent need; a new turn ends a finished one (#31)', () => {
  const none = { urgent: false, finished: false };
  assert.deepStrictEqual(pendingAfter(none, 'urgent'), { urgent: true, finished: false });
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: false }, 'finished'), { urgent: false, finished: true },
    'the prompt was answered somewhere (Remote Control): finished shows, not the urgent look');
  assert.deepStrictEqual(pendingAfter({ urgent: false, finished: true }, 'working'), { urgent: false, finished: false },
    'a new turn: "done, come look" is no longer true');
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: true }, 'working'), { urgent: true, finished: false },
    'working says nothing about a prompt that is waiting');
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: true }, 'looked'), none);
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: false }, 'nonsense'), { urgent: true, finished: false });
  for (const bad of [null, undefined, 5, 'x', { urgent: 1, finished: 'yes' }]) {
    assert.deepStrictEqual(pendingAfter(bad, 'nonsense'), none, 'only a real true counts');
  }
});

test('PROPERTY: after a finished turn nothing urgent is pending, whatever came before', () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom('urgent', 'finished', 'working', 'looked'), { maxLength: 12 }),
    (events) => {
      let p = { urgent: false, finished: false };
      for (const e of events) {
        p = pendingAfter(p, e);
        if (e === 'finished') assert.deepStrictEqual(p, { urgent: false, finished: true });
        if (e === 'looked') assert.deepStrictEqual(p, { urgent: false, finished: false });
      }
    }));
});

// Backlog #39: the tab's "where are we" summary, for the strip's hover card. Only a usable one; the page decides the words.
const SUM = { text: 'Working on: x\nNext: y', model: 'llama3.2:3b', at: 1000, stale: false, note: null };
const { cleanSummary } = require('../app/tab-status');

test('summary: a usable summary rides on the status; anything else is null, never a half-summary', () => {
  assert.deepStrictEqual(ts({ summary: SUM }).summary, SUM);
  for (const bad of [null, undefined, {}, 'x', 5, [], { ...SUM, text: '' }, { ...SUM, text: 5 }, { ...SUM, model: '' }, { ...SUM, at: null }, { ...SUM, at: '5' }, { ...SUM, at: NaN }]) {
    assert.strictEqual(ts({ summary: bad }).summary, null, JSON.stringify(bad));
  }
});

test('summary: stale is a real true only, the note a non-empty string only, extra fields are dropped, long words are cut', () => {
  assert.strictEqual(cleanSummary({ ...SUM, stale: 'yes' }).stale, false);
  assert.strictEqual(cleanSummary({ ...SUM, stale: true }).stale, true);
  assert.strictEqual(cleanSummary({ ...SUM, note: '' }).note, null);
  assert.strictEqual(cleanSummary({ ...SUM, note: 5 }).note, null);
  assert.strictEqual(cleanSummary({ ...SUM, note: 'Local summary off' }).note, 'Local summary off');
  assert.deepStrictEqual(Object.keys(cleanSummary({ ...SUM, secret: 'x', newestKey: 'k' })).sort(), ['at', 'model', 'note', 'stale', 'text']);
  assert.strictEqual(cleanSummary({ ...SUM, text: 'x'.repeat(5000) }), null, 'a summary that long was never written by us');
});

test('sameStatus: a new summary is a change, the same one is not (so the strip hears about it, and only once)', () => {
  const a = ts({ summary: SUM });
  assert.strictEqual(sameStatus(a, ts({ summary: { ...SUM } })), true);
  for (const change of [{ text: 'Working on: z' }, { model: 'other' }, { at: 2000 }, { stale: true }, { note: 'Local summary off' }]) {
    assert.strictEqual(sameStatus(a, ts({ summary: { ...SUM, ...change } })), false, JSON.stringify(change));
  }
  assert.strictEqual(sameStatus(a, ts({})), false);
  assert.strictEqual(sameStatus(ts({}), ts({})), true);
});

test('summary survives a look: afterSelected only clears the pending flags', () => {
  assert.deepStrictEqual(afterSelected(ts({ summary: SUM })).summary, SUM);
});

// Miguel I1: with no summary yet, why there is none rides on its own field for the hover card.
test('summaryNote: a non-empty string only, else null; and a change is a change', () => {
  assert.strictEqual(ts({ summaryNote: "Local summary off: Ollama isn't running" }).summaryNote, "Local summary off: Ollama isn't running");
  for (const bad of [undefined, null, '', 5, {}, 'x'.repeat(301)]) assert.strictEqual(ts({ summaryNote: bad }).summaryNote, null, JSON.stringify(bad));
  assert.strictEqual(sameStatus(ts({}), ts({ summaryNote: 'x' })), false);
  assert.strictEqual(sameStatus(ts({ summaryNote: 'x' }), ts({ summaryNote: 'x' })), true);
});

// --- OSC 7501 (BACKLOG #116): the CLI's own state rides on the status --------------------------------------------

const cleanProgram = require('../app/program-status-display').clean;
const tsp = (inputs) => tabStatus(inputs, { healthMarker, cleanProgram });

test('program is the cleaned root record, or null when there is none or nothing to clean it with', () => {
  assert.deepStrictEqual(tsp({ program: { state: 'blocked', kind: 'permission', msg: 'Allow?', id: '', title: 'x' } }).program,
    { state: 'blocked', kind: 'permission', msg: 'Allow?', progress: null });
  assert.strictEqual(tsp({ program: null }).program, null);
  assert.strictEqual(tsp({ program: { state: 'nonsense' } }).program, null);
  assert.strictEqual(ts({ program: { state: 'working' } }).program, null, 'no cleaner injected: never trust a raw record');
});

test('working: the CLI saying working counts, and it never makes a working roster look idle', () => {
  assert.strictEqual(tsp({ mainMood: null, program: { state: 'working' } }).working, true);
  assert.strictEqual(tsp({ mainMood: 'working', program: { state: 'done' } }).working, true);
  assert.strictEqual(tsp({ mainMood: null, program: { state: 'done' } }).working, false);
});

test('sameStatus sees a change of program state, kind, message and progress', () => {
  const base = tsp({ program: { state: 'blocked', kind: 'permission', msg: 'a' } });
  assert.strictEqual(sameStatus(base, tsp({ program: { state: 'blocked', kind: 'permission', msg: 'a' } })), true);
  for (const p of [{ state: 'blocked', kind: 'question', msg: 'a' }, { state: 'blocked', kind: 'permission', msg: 'b' }, { state: 'working' }, { state: 'blocked', kind: 'permission', msg: 'a', progress: 3 }, null]) {
    assert.strictEqual(sameStatus(base, tsp({ program: p })), false, JSON.stringify(p));
  }
  assert.strictEqual(sameStatus({ ...base, program: undefined }, tsp({})), true, 'an older status without the field is no program');
});

test('pendingAfter answered: the need is answered, a finished turn is kept', () => {
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: false }, 'answered'), { urgent: false, finished: false });
  assert.deepStrictEqual(pendingAfter({ urgent: true, finished: true }, 'answered'), { urgent: false, finished: true });
});

test('afterSelected keeps the program state: a look clears the cue, not what the CLI is doing', () => {
  const s = tsp({ pendingUrgent: true, program: { state: 'blocked', kind: 'auth' } });
  assert.deepStrictEqual(afterSelected(s).program, s.program);
});

test('PR #201 Dexter 1: once the program state is cleared (exit, closed socket) the status is not working and carries program null', () => {
  const working = tsp({ program: { state: 'working' } });
  assert.strictEqual(working.working, true);
  const cleared = tsp({ program: null });
  assert.strictEqual(cleared.working, false);
  assert.strictEqual(cleared.program, null);
  assert.strictEqual(sameStatus(working, cleared), false);
});
