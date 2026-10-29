'use strict';
/**
 * BACKLOG #156 (agent cues, part 2): the pure half of the held-message cue (app/peer-cue.js) -- what the toast says, when the knock
 * sounds, the knock itself, the mute switch and the tab's count. The CLI's own signal that a message is held is host/attention.js;
 * this reads the dialog the CLI draws only to NAME the sender and the first line, and never decides anything from it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
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

test('this is the only file in the app that makes a sound', () => {
  const app = path.join(__dirname, '..', 'app');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  const makers = fs.readdirSync(app).filter(f => f.endsWith('.js') && !/codemirror|bundle|vendor/.test(f)
    && /AudioContext|new Audio\(|<audio/.test(strip(fs.readFileSync(path.join(app, f), 'utf8'))));
  assert.deepStrictEqual(makers, ['peer-cue.js']);
});
