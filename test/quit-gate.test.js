'use strict';
/**
 * app/quit-gate.js (single-instance PR 3 step 11): quit asks ONCE for every window's unsaved reader text, in before-quit, before any claim
 * stops, so Cancel has nothing to undo. Pure: the windows, the question and the quit are handed in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const load = () => require('../app/quit-gate');

function rig({ answer = 'discard', clears = true, probe = false } = {}) {
  const calls = [];
  const win = (label, files) => ({
    label, files: [...files],
    unsaved() { return this.files; },
    saveAll() { calls.push(['save', label]); if (clears) this.files = []; },
    allowClose() { calls.push(['allow', label]); },
  });
  const wins = [win('alpha', ['a.md']), win('beta', ['b.js', 'c.js']), win('gamma', [])];
  let answers = Array.isArray(answer) ? [...answer] : null;
  const gate = load().createQuitGate({
    windows: () => wins,
    ask: async (dirty) => { calls.push(['ask', dirty.map((w) => [w.label, w.files])]); return answers ? answers.shift() : answer; },
    notify: (detail) => calls.push(['notify', detail]),
    waitCleared: async (w) => w.unsaved().length === 0,
    quit: () => calls.push(['quit']),
    probe,
    record: (entry) => calls.push(['record', entry]),
    log: () => {},
  });
  const event = () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; return e; };
  return { gate, calls, wins, event };
}
const settle = () => new Promise((r) => setImmediate(r));

test('no unsaved text: the quit is not held', () => {
  const { gate, calls, wins, event } = rig();
  for (const w of wins) w.files = [];
  const e = event();
  assert.strictEqual(gate.onBeforeQuit(e), false);
  assert.strictEqual(e.prevented, false);
  assert.deepStrictEqual(calls, []);
});

test('unsaved text in two windows: held once, and ask is called once with both windows and their files', async () => {
  const { gate, calls, event } = rig({ answer: 'cancel' });
  const e = event();
  assert.strictEqual(gate.onBeforeQuit(e), true);
  assert.strictEqual(e.prevented, true);
  await settle();
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'ask'), [['ask', [['alpha', ['a.md']], ['beta', ['b.js', 'c.js']]]]]);
});

test('Discard: allowClose() on each dirty window, then quit() once; the quit that follows passes the gate', async () => {
  const { gate, calls, event } = rig({ answer: 'discard' });
  gate.onBeforeQuit(event());
  await settle();
  assert.deepStrictEqual(calls.filter((c) => c[0] !== 'ask'), [['allow', 'alpha'], ['allow', 'beta'], ['quit']]);
  const again = event();
  assert.strictEqual(gate.onBeforeQuit(again), false, 'the approved quit goes through');
  assert.strictEqual(again.prevented, false);
});

test('Save: saveAll() on each dirty window; all cleared -> allowed and quit', async () => {
  const { gate, calls, event } = rig({ answer: 'save' });
  gate.onBeforeQuit(event());
  await settle(); await settle();
  assert.deepStrictEqual(calls.filter((c) => c[0] !== 'ask'), [['save', 'alpha'], ['save', 'beta'], ['allow', 'alpha'], ['allow', 'beta'], ['quit']]);
});

test('Save where one window does not clear: notify, no quit, nothing allowed', async () => {
  const { gate, calls, event } = rig({ answer: 'save', clears: false });
  gate.onBeforeQuit(event());
  await settle(); await settle();
  assert.ok(calls.some((c) => c[0] === 'notify'));
  assert.ok(!calls.some((c) => c[0] === 'quit' || c[0] === 'allow'));
});

test('Cancel: no quit, nothing allowed, and the next quit asks again', async () => {
  const { gate, calls, event } = rig({ answer: ['cancel', 'cancel'] });
  gate.onBeforeQuit(event());
  await settle();
  assert.ok(!calls.some((c) => c[0] === 'quit' || c[0] === 'allow'));
  assert.strictEqual(gate.onBeforeQuit(event()), true, 'held again');
  await settle();
  assert.strictEqual(calls.filter((c) => c[0] === 'ask').length, 2);
});

test('a second quit while the question is up is held and stacks no second question', async () => {
  let release;
  const { calls, wins } = rig();
  const gate = load().createQuitGate({
    windows: () => wins, ask: () => new Promise((r) => { calls.push(['ask']); release = r; }), notify() {}, waitCleared: async () => true,
    quit: () => calls.push(['quit']), probe: false, record() {}, log() {},
  });
  const e1 = { preventDefault() { this.p = true; } };
  const e2 = { preventDefault() { this.p = true; } };
  assert.strictEqual(gate.onBeforeQuit(e1), true);
  assert.strictEqual(gate.onBeforeQuit(e2), true);
  assert.strictEqual(e2.p, true, 'the second is held too');
  await settle();
  assert.strictEqual(calls.filter((c) => c[0] === 'ask').length, 1);
  release('discard');
  await settle();
  assert.strictEqual(calls.filter((c) => c[0] === 'quit').length, 1);
});

test('under the probe driver the answer is discard, with nobody asked, and one { label: "quit" } entry is recorded naming both windows', async () => {
  const { gate, calls, event } = rig({ probe: true, answer: 'cancel' });
  gate.onBeforeQuit(event());
  await settle();
  assert.ok(!calls.some((c) => c[0] === 'ask'));
  const recs = calls.filter((c) => c[0] === 'record');
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0][1].label, 'quit');
  assert.deepStrictEqual(recs[0][1].unsaved, [{ window: 'alpha', files: ['a.md'] }, { window: 'beta', files: ['b.js', 'c.js'] }]);
  assert.ok(calls.some((c) => c[0] === 'quit'));
});

test('reset() (a quit cancelled by a window\'s own prompt): the next quit asks again', async () => {
  const { gate, calls, event } = rig({ answer: 'discard' });
  gate.onBeforeQuit(event());
  await settle();
  assert.strictEqual(gate.onBeforeQuit(event()), false);
  gate.reset();
  assert.strictEqual(gate.onBeforeQuit(event()), true);
  await settle();
  assert.strictEqual(calls.filter((c) => c[0] === 'ask').length, 2);
});

test('questionText: the Q3 default wording, one line per window', () => {
  const { questionText } = load();
  assert.deepStrictEqual(questionText([{ label: 'alpha', files: ['a.md'] }, { label: 'beta', files: ['b.js', 'c.js'] }]), {
    message: 'Quit Jiandu with unsaved changes?',
    detail: 'alpha: a.md\nbeta: b.js, c.js',
    buttons: ['Save all and quit', 'Discard and quit', 'Cancel'],
  });
});

test('P-G1: for any sequence of quit requests and answers, at most one question is up, quit() runs at most once per approval, and a Cancel allows no close', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.oneof(fc.constant('quit'), fc.constant('reset'), fc.constantFrom('save', 'discard', 'cancel')), { maxLength: 20 }),
    async (steps) => {
      let up = 0; let maxUp = 0; let pending = null; let quits = 0; let approvals = 0; let cancelAllowed = false; let lastAnswer = null;
      const wins = [{ label: 'a', files: ['x'], unsaved() { return this.files; }, saveAll() {}, allowClose() { if (lastAnswer === 'cancel') cancelAllowed = true; } }];
      const gate = load().createQuitGate({
        windows: () => wins,
        ask: () => { up++; maxUp = Math.max(maxUp, up); return new Promise((r) => { pending = (a) => { up--; lastAnswer = a; pending = null; r(a); }; }); },
        notify() {}, waitCleared: async () => true, quit: () => { quits++; }, probe: false, record() {}, log() {},
      });
      for (const s of steps) {
        if (s === 'quit') gate.onBeforeQuit({ preventDefault() {} });
        else if (s === 'reset') { if (!pending) gate.reset(); }
        else if (pending) { if (s !== 'cancel') approvals++; pending(s); }
        await settle(); await settle();
      }
      assert.ok(maxUp <= 1, 'one question at a time');
      assert.ok(quits <= approvals, `quit ran ${quits} times for ${approvals} approvals`);
      assert.strictEqual(cancelAllowed, false);
    }), { numRuns: 100 });
});

test('PR #258 Dexter 13: asking() is true exactly while the question is up', async () => {
  let release;
  const { wins } = rig();
  const gate = load().createQuitGate({ windows: () => wins, ask: () => new Promise((r) => { release = r; }), notify() {}, waitCleared: async () => true,
    quit() {}, probe: false, record() {}, log() {} });
  assert.strictEqual(gate.asking(), false);
  gate.onBeforeQuit({ preventDefault() {} });
  await settle();
  assert.strictEqual(gate.asking(), true);
  release('cancel');
  await settle(); await settle();
  assert.strictEqual(gate.asking(), false);
});
