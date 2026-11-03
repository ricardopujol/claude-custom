'use strict';
/**
 * BACKLOG #156 (agent cues, part 2): the pure half of the held-message cue (app/peer-cue.js) -- what the toast says, when the knock
 * sounds, the knock itself, the mute switch and the tab's count. The CLI's own signal that a message is held is host/attention.js;
 * this reads the dialog the CLI draws only to NAME the sender and the first line, and never decides anything from it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { peerCue: P } = require('../app/peer-cue');

const DIALOG = [
  'some earlier output',
  '╭──────────────────────────────────────────╮',
  '│ Held message from another session        │',
  '│                                          │',
  '│ Another Claude session sent a message: from dexter-220.',
  '│ Message body (this is what will be delivered):',
  '│                                          │',
  '│ Please run /merged in your lane.         │',
  '│ Then reply when done.                    │',
  '│ Deliver this message to Claude           │',
  '╰──────────────────────────────────────────╯',
];

test('the dialog the CLI draws names the sender and the first line of the body', () => {
  assert.deepStrictEqual(P.scanHeldMessage(DIALOG), { from: 'dexter-220', first: 'Please run /merged in your lane.' });
});

test('no dialog on screen is null; a dialog with parts missing gives nulls, never a guess', () => {
  assert.strictEqual(P.scanHeldMessage(['just output', 'more']), null);
  assert.strictEqual(P.scanHeldMessage([]), null);
  assert.strictEqual(P.scanHeldMessage(undefined), null);
  assert.deepStrictEqual(P.scanHeldMessage(['Held message from another session']), { from: null, first: null });
  assert.deepStrictEqual(P.scanHeldMessage(['Held message from another session', 'Message body (this is what will be delivered):']), { from: null, first: null });
});

test('the newest dialog wins, and an older message above it is not mixed in', () => {
  const old = ['Held message from another session', 'Another Claude session sent a message: from old-one.', 'Message body (this is what will be delivered):', 'old text'];
  const now = ['Held message from another session', 'Another Claude session sent a message: from new-one.', 'Message body (this is what will be delivered):', 'new text'];
  assert.deepStrictEqual(P.scanHeldMessage([...old, ...now]), { from: 'new-one', first: 'new text' });
});

test('what the scan returns is cut for a toast: a long sender or line is capped, control characters go', () => {
  const lines = ['Held message from another session', 'Another Claude session sent a message: from ' + 'x'.repeat(200) + '.',
    'Message body (this is what will be delivered):', 'a\u0007b\u001b[31m ' + 'y'.repeat(500)];
  const r = P.scanHeldMessage(lines);
  assert.ok(r.from.length <= P.FROM_MAX);
  assert.ok(r.first.length <= P.FIRST_MAX);
  assert.ok(!/[\u0000-\u001f]/.test(r.first));
});

test('the toast: sender and first line when known, the CLI\'s own words when not', () => {
  assert.deepStrictEqual(P.toastFor('claude-custom', { from: 'dexter-220', first: 'Please run /merged' }),
    { title: 'claude-custom: message from dexter-220', body: 'Please run /merged' });
  assert.deepStrictEqual(P.toastFor('claude-custom', { from: null, first: 'Hello' }),
    { title: 'claude-custom has a message for you', body: 'Hello' });
  assert.deepStrictEqual(P.toastFor('', null),
    { title: 'A message for you', body: 'A message from another session needs your approval' });
});

test('the knock sounds unless you are looking at that tab, or it is muted', () => {
  assert.strictEqual(P.shouldKnock({ looking: false, muted: false }), true);
  assert.strictEqual(P.shouldKnock({ looking: true, muted: false }), false, 'the tab is selected in a focused window');
  assert.strictEqual(P.shouldKnock({ looking: false, muted: true }), false);
  assert.strictEqual(P.shouldKnock({ looking: true, muted: true }), false);
  assert.strictEqual(P.shouldKnock({ muted: false }), true, 'unknown focus is not "looking"');
  assert.strictEqual(P.shouldKnock({ looking: false }), true, 'unknown mute is not muted');
  assert.strictEqual(P.shouldKnock({ looking: false, muted: 'yes' }), true, 'only a real true mutes');
});

test('the knock is two short low square-wave notes, 220 then 196 Hz, 90 ms each, 120 ms apart', () => {
  assert.deepStrictEqual(P.KNOCK, [{ freq: 220, at: 0, dur: 0.09 }, { freq: 196, at: 0.12, dur: 0.09 }]);
});

function fakeCtx() {
  const made = [];
  const ctx = {
    currentTime: 10, destination: { name: 'out' },
    createOscillator() { const o = { type: '', frequency: { value: 0 }, connected: null, started: null, stopped: null, connect(n) { o.connected = n; return n; }, start(t) { o.started = t; }, stop(t) { o.stopped = t; } }; made.push(o); return o; },
    createGain() { const calls = []; const g = { gain: { setValueAtTime: (...a) => calls.push(['set', ...a]), exponentialRampToValueAtTime: (...a) => calls.push(['ramp', ...a]) }, calls, connect(n) { g.connected = n; return n; } }; return g; },
  };
  return { ctx, made };
}

test('playKnock schedules both notes on the context clock and is silent in between', () => {
  const { ctx, made } = fakeCtx();
  assert.strictEqual(P.playKnock(ctx), 2);
  assert.deepStrictEqual(made.map(o => [o.type, o.frequency.value]), [['square', 220], ['square', 196]]);
  assert.ok(Math.abs(made[0].started - 10) < 1e-9);
  assert.ok(Math.abs(made[1].started - 10.12) < 1e-9);
  for (const o of made) assert.ok(o.stopped > o.started && o.stopped - o.started < 0.2, 'a short note');
  assert.ok(made[0].stopped <= made[1].started + 1e-9, 'the notes do not overlap');
});

test('playKnock never throws into the page: no context, or one that fails, plays nothing', () => {
  assert.strictEqual(P.playKnock(null), 0);
  assert.strictEqual(P.playKnock(undefined), 0);
  assert.strictEqual(P.playKnock({ currentTime: 0, createOscillator() { throw new Error('closed'); } }), 0);
});

test('the mute switch is saved as a real true only, and an unreadable store means "not muted"', () => {
  const store = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
  assert.strictEqual(P.readMuted(store()), false);
  assert.strictEqual(P.readMuted(store({ [P.MUTE_KEY]: 'true' })), true);
  assert.strictEqual(P.readMuted(store({ [P.MUTE_KEY]: 'false' })), false);
  assert.strictEqual(P.readMuted(store({ [P.MUTE_KEY]: '1' })), false);
  assert.strictEqual(P.readMuted(null), false);
  assert.strictEqual(P.readMuted({ getItem() { throw new Error('blocked'); } }), false);
  const s = store();
  P.writeMuted(s, true);
  assert.strictEqual(P.readMuted(s), true);
  P.writeMuted(s, false);
  assert.strictEqual(P.readMuted(s), false);
  assert.doesNotThrow(() => P.writeMuted({ setItem() { throw new Error('full'); } }, true));
});

test('PROPERTY: the tab\'s count only goes up by one, never past 99, and a look clears it to 0', () => {
  fc.assert(fc.property(fc.integer({ min: -5, max: 500 }), n => {
    const next = P.bumpCount(n);
    assert.ok(Number.isInteger(next) && next >= 1 && next <= 99);
    if (n >= 0 && n < 99) assert.strictEqual(next, n + 1);
  }));
  for (const bad of [undefined, null, NaN, 'x', {}, Infinity]) assert.strictEqual(P.bumpCount(bad), 1);
  assert.strictEqual(P.bumpCount(98), 99);
  assert.strictEqual(P.bumpCount(99), 99);
});


// --- PR #224 review fixes ------------------------------------------------------------------------------------------------------

const memStore = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('Miguel B1: the mute is read from the store at the moment of the decision, so a switch flipped in ANOTHER tab applies at once', () => {
  const shared = memStore();           // every tab page of the app shares one localStorage
  assert.strictEqual(P.shouldKnockFrom(shared, false), true);
  P.writeMuted(shared, true);          // ...muted from tab A; tab B never reloads
  assert.strictEqual(P.shouldKnockFrom(shared, false), false);
  P.writeMuted(shared, false);
  assert.strictEqual(P.shouldKnockFrom(shared, false), true);
  assert.strictEqual(P.shouldKnockFrom(shared, true), false, 'looking at it: still no knock');
  assert.strictEqual(P.shouldKnockFrom(null, false), true, 'no store: not muted');
});

test('Dexter 3 / Miguel I6: a held dialog notified again is the same message; a different dialog is another', () => {
  const held = P.createHeldSet();
  const a = { from: 'dexter-220', first: 'Please run /merged' };
  assert.strictEqual(held.admit(a), true);
  assert.strictEqual(held.admit({ ...a }), false, 're-notified: counted once');
  assert.strictEqual(held.admit({ from: 'dexter-220', first: 'Another one' }), true);
  assert.strictEqual(held.admit({ from: 'miguel-220', first: 'Please run /merged' }), true);
  held.clear();                       // a look
  assert.strictEqual(held.admit(a), true);
});

test('Dexter 3: a dialog that cannot be read has no identity: every arrival counts', () => {
  const held = P.createHeldSet();
  assert.strictEqual(held.admit(null), true);
  assert.strictEqual(held.admit(null), true);
  assert.strictEqual(held.admit({ from: null, first: null }), true);
  assert.strictEqual(held.admit({ from: null, first: null }), true);
  assert.strictEqual(P.identityOf({ from: 'x', first: null }), 'x|');
});

test('Dexter 3: the held set is bounded', () => {
  const held = P.createHeldSet();
  for (let i = 0; i < 1000; i++) held.admit({ from: 'f' + i, first: 'x' });
  assert.ok(held.size() <= P.HELD_MAX);
});

// knock(): the page's own audio context
function fakeWin({ state = 'running', resumeRejects = false, makeFails = false } = {}) {
  const made = [];
  const timers = [];
  class Ctx {
    constructor() { if (makeFails) throw new Error('no audio device'); this.state = state; this.currentTime = 1; this.destination = {}; this.resumed = 0; this.suspended = 0; made.push(this); }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    resume() { this.resumed++; this.state = 'running'; return resumeRejects ? Promise.reject(new Error('blocked')) : Promise.resolve(); }
    suspend() { this.suspended++; this.state = 'suspended'; return Promise.resolve(); }
  }
  return { win: { AudioContext: Ctx, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} }, made, timers };
}

test('Miguel I3: knock() makes the context once, plays both notes, and reuses it', () => {
  P._resetKnock();
  const { win, made } = fakeWin();
  assert.strictEqual(P.knock(win), 2);
  assert.strictEqual(P.knock(win), 2);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(P.knock({}), 0, 'no Web Audio: nothing, no throw');
});

test('Miguel I3: a closed context is dropped and rebuilt, so one bad moment does not silence every later knock', () => {
  P._resetKnock();
  const { win, made } = fakeWin();
  P.knock(win);
  made[0].state = 'closed';
  assert.strictEqual(P.knock(win), 2);
  assert.strictEqual(made.length, 2);
});

test('Miguel I3: a suspended context is resumed, and a resume that is refused is swallowed (no unhandled rejection)', async () => {
  P._resetKnock();
  const { win, made } = fakeWin({ state: 'suspended', resumeRejects: true });
  assert.strictEqual(P.knock(win), 2);
  assert.strictEqual(made[0].resumed, 1);
  await new Promise(r => setImmediate(r));           // an unhandled rejection would fail the run here
});

test('Miguel N2: a context that says it is running is still asked to resume (a suspend may be pending); only a closed one is not', () => {
  P._resetKnock();
  const { win, made } = fakeWin({ state: 'running' });
  P.knock(win);
  assert.strictEqual(made[0].resumed, 1);
  made[0].state = 'running';
  P.knock(win);
  assert.strictEqual(made[0].resumed, 2);
});

test('Miguel I3: a context that cannot be made is a silent 0, then tried again next time', () => {
  P._resetKnock();
  assert.strictEqual(P.knock(fakeWin({ makeFails: true }).win), 0);
  const ok = fakeWin();
  assert.strictEqual(P.knock(ok.win), 2);
});

test('Miguel I3: the context is suspended once the knock is over, so an idle tab holds no audio thread; the next knock resumes it', () => {
  P._resetKnock();
  const { win, made, timers } = fakeWin();
  P.knock(win);
  assert.strictEqual(timers.length, 1);
  assert.ok(timers[0].ms >= 300 && timers[0].ms <= 2000, 'after the last note, not before');
  timers[0].fn();
  assert.strictEqual(made[0].suspended, 1);
  assert.strictEqual(P.knock(win), 2);
  assert.strictEqual(made[0].resumed, 2, 'asked on every knock, the first one included');
});
