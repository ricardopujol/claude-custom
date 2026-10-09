'use strict';
/**
 * app/games-display.js (BACKLOG #41): the Games panel driven through a fake document. The rules are pinned in games-rules*.test.js
 * and games-round.test.js; what is pinned here is the wiring that only a real panel has: the HAND-BACK (an attention signal pauses
 * the round, says "Claude needs you" and gives the keyboard to the terminal), who gets keys, resuming, hiding, and the scores.
 */
const test = require('node:test');
const assert = require('node:assert');

const { FakeDocument } = require('./fake-dom');
const D = require('../app/games-display');

const drawCalls = [];
const ctx = new Proxy({}, {
  get(_t, name) { return (...args) => { drawCalls.push([name, ...args]); }; },
  set(_t, name, v) { drawCalls.push(['set:' + String(name), v]); return true; },
});

function rig({ bridge = null, rng = () => 0.5, terminalFocus = false } = {}) {
  const doc = new FakeDocument();
  const panel = doc.createElement('div');
  doc.root.appendChild(panel);
  const outside = doc.createElement('textarea');           // the terminal's own input
  doc.root.appendChild(outside);
  const frames = [];
  let t = 1000;
  const calls = { focusTerminal: 0, caf: 0 };
  const state = { terminalFocus };
  const g = D.mount({
    doc, root: panel, bridge, rng, context: ctx,
    focusTerminal: () => { calls.focusTerminal += 1; state.terminalFocus = true; },
    terminalHasFocus: () => state.terminalFocus,
    raf: (fn) => { frames.push(fn); return frames.length; },
    caf: () => { calls.caf += 1; frames.length = 0; },
    now: () => t,
    css: () => '#888888',
  });
  const canvas = panel.querySelector('canvas');
  canvas.layout = { width: 400, height: 300 };
  const advance = (ms) => { t += ms; };
  const runFrame = (ms = 16) => { advance(ms); const fn = frames.shift(); if (fn) fn(); return Boolean(fn); };
  const shown = () => g.setView({ shown: true, pageVisible: true, lean: false });
  const go = () => panel.querySelector('[data-act="go"]').dispatch('click');
  return { doc, panel, outside, canvas, g, frames, calls, state, advance, runFrame, shown, go };
}

const coverText = r => r.panel.querySelector('.games-cover-text').textContent;
const coverShown = r => !r.panel.querySelector('.games-cover').hidden;

test('the panel offers the three games, the best of each in its header, and starts on Stack with a cover', () => {
  const r = rig();
  assert.deepStrictEqual(r.panel.querySelectorAll('[data-game]').map(b => b.getAttribute('data-game')), ['stack', 'merge', 'pipeline']);
  assert.strictEqual(r.panel.querySelector('.games-best').textContent, 'Stack 0 · Merge 0 · Pipeline 0');
  assert.strictEqual(r.g.state().game, 'stack');
  assert.strictEqual(r.g.state().phase, 'idle');
  assert.ok(coverShown(r));
  assert.match(coverText(r), /Space or click/);
});

test('the best line shows every game and treats anything but a whole count as 0', () => {
  assert.strictEqual(D.bestLine({ stack: 12, merge: 340, pipeline: 3 }), 'Stack 12 · Merge 340 · Pipeline 3');
  assert.strictEqual(D.bestLine({ stack: '9', merge: 1.5 }), 'Stack 0 · Merge 0 · Pipeline 0');
  assert.strictEqual(D.bestLine(null), 'Stack 0 · Merge 0 · Pipeline 0');
});

test('Play starts a 45-second round that runs frame by frame, and the cover goes away', () => {
  const r = rig(); r.shown(); r.go();
  assert.strictEqual(r.g.state().phase, 'running');
  assert.strictEqual(coverShown(r), false);
  assert.strictEqual(r.frames.length, 1);
  r.runFrame(1000);                                     // a stalled frame counts as 50 ms
  assert.ok(Math.abs(r.g.state().left - 44.95) < 1e-9);
  assert.strictEqual(r.frames.length, 1, 'the next frame is asked for');
  assert.strictEqual(r.panel.querySelector('.games-time').textContent, '45');
});

test('HAND-BACK: an attention signal pauses a running round, says Claude needs you, and gives the terminal the keyboard', () => {
  const r = rig(); r.shown(); r.go(); r.runFrame();
  const left = r.g.state().left;
  assert.strictEqual(r.g.handBack(), true);
  const st = r.g.state();
  assert.strictEqual(st.phase, 'paused');
  assert.strictEqual(st.why, 'claude');
  assert.strictEqual(r.calls.focusTerminal, 1, 'keyboard focus goes back to the terminal');
  assert.match(coverText(r), /Claude needs you/);
  assert.ok(coverShown(r));
  assert.strictEqual(r.panel.querySelector('.games-cover-btn').textContent, 'Resume');
  assert.strictEqual(r.frames.length, 0, 'no frame is left asked for');
  r.runFrame(5000);
  assert.strictEqual(r.g.state().left, left, 'the clock is frozen');
});

test('HAND-BACK: with no round running it does nothing, and does not grab the keyboard', () => {
  const r = rig(); r.shown();
  assert.strictEqual(r.g.handBack(), false);
  assert.strictEqual(r.calls.focusTerminal, 0);
  assert.strictEqual(r.g.state().phase, 'idle');
  r.go();
  r.g.handBack(); r.g.handBack();
  assert.strictEqual(r.calls.focusTerminal, 1, 'a second signal while already paused does not refocus');
});

test('the round resumes when Ricardo comes back to the board, from where it stopped, and not before', () => {
  const r = rig(); r.shown(); r.go(); r.runFrame();
  r.g.handBack();
  const left = r.g.state().left;
  r.outside.dispatch('pointerdown');                    // clicking the terminal is not coming back
  assert.strictEqual(r.g.state().phase, 'paused');
  r.canvas.dispatch('pointerdown');
  assert.strictEqual(r.g.state().phase, 'running');
  assert.strictEqual(r.g.state().left, left);
  assert.strictEqual(coverShown(r), false);
  assert.strictEqual(r.frames.length, 1);
});

test('focusing the board resumes too, but focusing the cover\'s own button does not (its click does)', () => {
  const r = rig(); r.shown(); r.go();
  r.g.handBack();
  const btn = r.panel.querySelector('.games-cover-btn');
  btn.dispatch('focusin');
  assert.strictEqual(r.g.state().phase, 'paused');
  btn.dispatch('pointerdown');
  assert.strictEqual(r.g.state().phase, 'paused');
  btn.dispatch('click');
  assert.strictEqual(r.g.state().phase, 'running');
  assert.strictEqual(r.g.state().left, 45 - 0 , 'Resume does not restart the round');
  r.g.handBack();
  r.canvas.dispatch('focusin');
  assert.strictEqual(r.g.state().phase, 'running');
});

test('resuming by a click on the board is not also a move', () => {
  const r = rig(); r.shown(); r.go();
  r.g.handBack();
  r.canvas.dispatch('pointerdown', { clientX: 10, clientY: 10 });
  r.canvas.dispatch('click', { clientX: 10, clientY: 10 });
  assert.strictEqual(r.g.state().score, 0, 'no block was dropped by the resuming click');
  r.canvas.dispatch('click', { clientX: 10, clientY: 10 });
  assert.strictEqual(r.g.state().score, 1, 'the next click is');
});

test('KEYS: Space drops the Stack block while the round runs and focus is in the panel', () => {
  const r = rig(); r.shown(); r.go();
  const e = r.canvas.dispatch('keydown', { key: ' ', code: 'Space' });
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(r.g.state().score, 1);
});

test('KEYS: a game never takes keys while the terminal has focus', () => {
  const r = rig({ terminalFocus: true }); r.shown(); r.go();
  const e = r.canvas.dispatch('keydown', { key: ' ', code: 'Space' });
  assert.strictEqual(e.defaultPrevented, false);
  assert.strictEqual(r.g.state().score, 0);
});

test('KEYS: after the hand-back the terminal has focus, so a keystroke meant for Claude does nothing in the game', () => {
  const r = rig(); r.shown(); r.go();
  r.g.handBack();
  assert.strictEqual(r.state.terminalFocus, true);
  r.canvas.dispatch('keydown', { key: ' ', code: 'Space' });
  assert.strictEqual(r.g.state().score, 0);
  assert.strictEqual(r.g.state().phase, 'paused');
});

test('KEYS: nothing is taken while idle, paused, or from outside the panel', () => {
  const r = rig(); r.shown();
  assert.strictEqual(r.canvas.dispatch('keydown', { key: ' ' }).defaultPrevented, false, 'idle');
  r.go(); r.g.handBack();
  assert.strictEqual(r.canvas.dispatch('keydown', { key: ' ' }).defaultPrevented, false, 'paused');
  r.canvas.dispatch('pointerdown');
  // the event's target is the terminal's input, which the panel's listener sees only if it bubbled through the panel
  assert.strictEqual(r.outside.dispatch('keydown', { key: ' ' }).defaultPrevented, false, 'outside the panel');
  assert.strictEqual(r.g.state().score, 0);
});

test('Stack: a drop with no overlap is a miss, and a drop over the block is not', () => {
  const st = D.makeGames(() => 0.5, () => '#888').stack;
  st.reset();
  st.s.cur = { x: 0, w: 20, dir: 1 };
  assert.strictEqual(st.drop(), 'missed');
  st.reset();
  st.s.cur = { x: 120, w: 100, dir: 1 };
  assert.strictEqual(st.drop(), null);
  assert.strictEqual(st.score(), 1);
});

test('Stack: dropping the block mid-slide through the panel keeps the round going or ends it, never throws', () => {
  const r = rig(); r.shown(); r.go();
  for (let k = 0; k < 400 && r.g.state().phase === 'running'; k += 1) { r.runFrame(40); if (k % 7 === 0) r.canvas.dispatch('keydown', { key: ' ' }); }
  assert.ok(['running', 'over'].includes(r.g.state().phase));
});

test('Merge: arrow keys move the board, a swipe moves it, and a wall move costs nothing', () => {
  const r = rig({ rng: (() => { let i = 0; const v = [0, 0.5, 0.5, 0.5]; return () => v[i++ % v.length]; })() }); r.shown();
  r.panel.querySelector('[data-game="merge"]').dispatch('click');
  assert.strictEqual(r.g.state().game, 'merge');
  r.go();
  const e = r.canvas.dispatch('keydown', { key: 'ArrowLeft' });
  assert.strictEqual(e.defaultPrevented, true);
  r.canvas.dispatch('keydown', { key: 'ArrowRight' });
  r.canvas.dispatch('pointerdown', { clientX: 200, clientY: 150 });
  r.canvas.dispatch('pointerup', { clientX: 200, clientY: 40 });
  assert.strictEqual(r.g.state().phase, 'running');
  r.canvas.dispatch('keydown', { key: 'a' });
  assert.strictEqual(r.g.state().phase, 'running');
});

test('Merge: a swipe shorter than 20 px is nothing, a longer one is a move', () => {
  const mg = D.makeGames(() => 0.5, () => '#888').merge;
  mg.reset();
  const board = mg.s.board.slice();
  mg.down(200, 150);
  assert.strictEqual(mg.up(210, 150), undefined);
  assert.deepStrictEqual(mg.s.board, board);
  mg.down(200, 150);
  assert.notStrictEqual(mg.up(300, 150), undefined, 'a long swipe is a move');
  assert.strictEqual(mg.up(300, 150), undefined, 'an up with no down is nothing');
});

test('Pipeline: a click on a tile turns it; a click off the board does nothing', () => {
  const r = rig(); r.shown();
  r.panel.querySelector('[data-game="pipeline"]').dispatch('click'); r.go();
  assert.strictEqual(r.g.state().game, 'pipeline');
  r.canvas.dispatch('click', { clientX: 5, clientY: 5 });
  r.canvas.dispatch('click', { clientX: 80, clientY: 30 });
  assert.strictEqual(r.g.state().phase, 'running');
});

test('choosing another game abandons the round and starts that game idle', () => {
  const r = rig(); r.shown(); r.go();
  r.panel.querySelector('[data-game="pipeline"]').dispatch('click');
  assert.strictEqual(r.g.state().game, 'pipeline');
  assert.strictEqual(r.g.state().phase, 'idle');
  assert.match(coverText(r), /Click tiles/);
  assert.ok(r.panel.querySelector('[data-game="pipeline"]').classList.contains('on'));
  assert.ok(!r.panel.querySelector('[data-game="stack"]').classList.contains('on'));
});

test('HIDDEN: a panel that leaves the screen freezes the round and stops drawing; it waits for a click when it comes back', () => {
  const r = rig(); r.shown(); r.go(); r.runFrame();
  r.g.setView({ shown: false });
  assert.strictEqual(r.g.state().phase, 'paused');
  assert.strictEqual(r.g.state().why, 'hidden');
  assert.strictEqual(r.frames.length, 0);
  const n = drawCalls.length;
  r.runFrame(100);
  r.g.setView({ pageVisible: false });
  assert.strictEqual(drawCalls.length, n, 'nothing is drawn while hidden');
  r.g.setView({ shown: true, pageVisible: true });
  assert.strictEqual(r.g.state().phase, 'paused', 'it does not run on its own');
  r.canvas.dispatch('pointerdown');
  assert.strictEqual(r.g.state().phase, 'running');
});

test('LEAN: lean mode counts as not on screen', () => {
  const r = rig(); r.shown(); r.go();
  r.g.setView({ lean: true });
  assert.strictEqual(r.g.state().phase, 'paused');
  assert.strictEqual(r.g.state().drawing, false);
  r.g.setView({ lean: false });
  assert.strictEqual(r.g.state().drawing, true);
});

test('a frame that finds the panel hidden pauses instead of drawing', () => {
  const r = rig(); r.shown(); r.go();
  // the view changes without setView hearing in time: the frame itself must refuse to paint
  const frame = r.frames.shift();
  r.g.setView({ shown: false });
  const n = drawCalls.length;
  frame();
  assert.strictEqual(drawCalls.length, n);
});

test('SCORES: the round\'s score is banked once when it ends, and the new best shows in the header', async () => {
  const submitted = [];
  const bridge = {
    scores: () => Promise.resolve({ stack: 4, merge: 0, pipeline: 0 }),
    submit: (g, v) => { submitted.push([g, v]); return Promise.resolve({ stack: v, merge: 0, pipeline: 0 }); },
  };
  const r = rig({ bridge }); r.shown();
  await new Promise(res => setImmediate(res));
  assert.strictEqual(r.panel.querySelector('.games-best').textContent, 'Stack 4 · Merge 0 · Pipeline 0');
  r.go();
  r.canvas.dispatch('keydown', { key: ' ' });
  for (let k = 0; k < 1000 && r.g.state().phase === 'running'; k += 1) r.runFrame(50);
  assert.strictEqual(r.g.state().phase, 'over');
  await new Promise(res => setImmediate(res));
  assert.deepStrictEqual(submitted, [['stack', 1]]);
  assert.strictEqual(r.panel.querySelector('.games-best').textContent, 'Stack 1 · Merge 0 · Pipeline 0');
  assert.match(coverText(r), /^(Time|Missed): 1$/);
  assert.strictEqual(r.panel.querySelector('.games-cover-btn').textContent, 'Again');
});

test('SCORES: a round that scored nothing banks nothing, and a missing or failing bridge is fine', async () => {
  const submitted = [];
  const r = rig({ bridge: { scores: () => Promise.reject(new Error('x')), submit: (g, v) => { submitted.push([g, v]); return Promise.reject(new Error('x')); } } });
  r.shown(); r.go();
  for (let k = 0; k < 1000 && r.g.state().phase === 'running'; k += 1) r.runFrame(50);
  await new Promise(res => setImmediate(res));
  assert.deepStrictEqual(submitted, []);
  const none = rig(); none.shown(); none.go();
  none.canvas.dispatch('keydown', { key: ' ' });
  for (let k = 0; k < 1000 && none.g.state().phase === 'running'; k += 1) none.runFrame(50);
  assert.strictEqual(none.g.state().phase, 'over');
});

test('Again starts a fresh round', () => {
  const r = rig(); r.shown(); r.go();
  for (let k = 0; k < 1000 && r.g.state().phase === 'running'; k += 1) r.runFrame(50);
  assert.strictEqual(r.g.state().phase, 'over');
  r.go();
  assert.strictEqual(r.g.state().phase, 'running');
  assert.strictEqual(r.g.state().left, 45);
  assert.strictEqual(r.g.state().score, 0);
});

test('the games draw nothing before the panel is shown', () => {
  const n = drawCalls.length;
  const r = rig();
  assert.strictEqual(drawCalls.length, n);
  r.shown();
  assert.ok(drawCalls.length > n, 'showing the panel paints the board once');
});
