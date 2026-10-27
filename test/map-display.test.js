'use strict';
/**
 * app/map-display.js (BACKLOG #120) driven through a fake document and a recording canvas context. The pure decisions are pinned in
 * map-model*.test.js and map-layout.test.js; what is pinned here is what only the panel has: THE FRAME BUDGET (animate only while shown x
 * focused x not lean, one static frame otherwise, nothing at all when hidden, a loop that stops by itself), the pointer, the hover card,
 * the keeping of the picture per project, and crisp text at devicePixelRatio.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { FakeDocument } = require('./fake-dom');
const D = require('../app/map-display');
const M = require('../app/map-model');

const TOKENS = { '--bg': '#101218', '--chrome': '#171a23', '--accent': '#d08c4a', '--ok': '#5fb07a', '--bad': '#cc5f5f', '--dim': '#6d7689', '--text': '#c7cede', '--warn': '#e6c34a', '--font-ui': 'Segoe UI' };

function rig({ dpr: dprIn = 2, reduced = false, storage = null, size = { width: 520, height: 420 }, makeImage = null, layered = false, tokens = {}, source = null } = {}) {
  const doc = new FakeDocument();
  // LAYERED: offscreen canvases that can draw (a real browser's), each with its own recording context; the visible canvas keeps `ctx`
  const layers = [];
  let mainMade = false;               // the first canvas mount() makes is the visible one: it is drawn through `ctx`, not recorded here
  if (layered) {
    const make = doc.createElement.bind(doc);
    doc.createElement = (tag) => {
      const e = make(tag);
      if (String(tag).toLowerCase() === 'canvas') {
        const rec = [];
        const g = new Proxy({}, {
          get(_t, name) { return (...args) => { rec.push([name, ...args]); if (name === 'createRadialGradient') return { addColorStop: (...stop) => rec.push(['stop', ...stop]) }; return undefined; }; },
          set(_t, name, v) { rec.push(['set:' + String(name), v]); return true; },
        });
        e.getContext = () => g;
        if (mainMade) layers.push({ canvas: e, calls: rec }); else mainMade = true;
      }
      return e;
    };
  }
  const panel = doc.createElement('div');
  doc.root.appendChild(panel);
  const calls = [];
  const work = { fn: null, done: false };
  const ctx = new Proxy({}, {
    get(_t, name) { return (...args) => { calls.push([name, ...args]); if (name === 'fillRect' && work.fn && !work.done) { work.done = true; work.fn(); } }; },
    set(_t, name, v) { calls.push(['set:' + String(name), v]); return true; },
  });
  const pending = new Map();
  const paced = new Map();         // the waits between two frames of the loop (timers)
  const counts = { raf: 0, caf: 0, pace: 0, unpace: 0, css: 0, disposed: 0 };
  let id = 0; let t = 1000;
  const later = [];
  const clicks = { session: [], agent: [] };
  const flags = { reduced };
  const dpr = { value: dprIn };
  const observers = [];
  const m = D.mount({
    doc, root: panel, context: ctx, storage, makeImage, source,
    raf: (fn) => { counts.raf += 1; id += 1; pending.set(id, fn); return id; },
    caf: (i) => { counts.caf += 1; pending.delete(i); },
    pace: (fn, ms) => { counts.pace += 1; id += 1; paced.set(id, { fn, ms }); return id; },
    unpace: (i) => { counts.unpace += 1; paced.delete(i); },
    now: () => t, wall: () => 1_700_000_000_000 + t, later: (fn) => { later.push(fn); return later.length; },
    css: (name) => { counts.css += 1; return ({ ...TOKENS, ...tokens })[name] || ''; }, dpr: () => dpr.value, reducedMotion: () => flags.reduced,
    observe: (el, fn) => { observers.push(fn); return () => { counts.disposed += 1; }; },
    onSession: (s) => clicks.session.push(s), onAgent: (a) => clicks.agent.push(a),
  });
  const stage = panel.querySelector('.map-stage');
  const canvas = panel.querySelector('canvas');
  stage.layout = { ...size };
  canvas.layout = { ...size };
  // run every pending animation frame once, `ms` apart; returns how many ran
  const pump = (n = 1, ms = 34) => {
    let ran = 0;
    for (let i = 0; i < n; i += 1) {
      t += ms;
      const waits = [...paced.values()]; paced.clear();
      waits.forEach(w => w.fn());                         // a wait over: it asks for its animation frame
      const fns = [...pending.values()]; pending.clear();
      fns.forEach(fn => fn()); ran += fns.length;
      if (fns.length === 0 && waits.length === 0) break;
    }
    return ran;
  };
  const advance = (ms) => { t += ms; };
  return { m, doc, panel, stage, canvas, ctx, calls, work, pending, paced, layers, dpr, counts, pump, advance, later, clicks, flags, observers, now: () => t, size };
}

const VIEW_ON = { shown: true, focused: true, lean: false };
const sess = (id, o = {}) => ({ id, label: id, state: 'idle', self: false, folder: `C:\\p\\${id}`, ...o });
const ag = (name, o = {}) => ({ name, state: 'working', detail: 'working', eventsPerMin: 60, portrait: { url: null, initials: name.slice(0, 2).toUpperCase(), hue: 200 }, ...o });
function data(o = {}) {
  return {
    project: { name: 'demo' },
    sessions: [sess('a', { self: true, state: 'working', label: 'develop', folder: 'C:\\p\\dev' }), sess('b', { label: 'feat/x', folder: 'C:\\p\\x' })],
    agents: [ag('dexter', { model: 'opus', tokens: 120000, tool: 'Edit', since: 1_700_000_000_000 - 130_000 }), ag('miguel', { state: 'sleeping', detail: 'sleeping' })],
    claims: [], lanes: { open: 2, withPr: 1 }, feed: { events: 1234, uptimeMs: 125000 },
    ...o,
  };
}
const settle = (r, max = 400) => { for (let i = 0; i < max && r.m.state().looping; i += 1) r.pump(1); };

// --- structure ------------------------------------------------------------------------------------------------------------

test('it builds a strip, a canvas, a legend of the four states and a Fit button', () => {
  const r = rig();
  assert.ok(r.canvas && r.panel.querySelector('.map-fit') && r.panel.querySelector('.map-strip'));
  assert.deepStrictEqual(r.panel.querySelectorAll('.map-key').map(k => k.getAttribute('data-state')), ['working', 'needs', 'done', 'idle']);
  assert.deepStrictEqual(r.panel.querySelectorAll('.map-key').map(k => k.textContent), ['running', 'needs you', 'done', 'idle']);
  assert.strictEqual(r.panel.querySelector('[data-stat="tasks"]').textContent, 'tasks —', 'nothing known is a dash, not a 0');
  assert.strictEqual(r.canvas.getAttribute('role'), 'img');
});

test('the strip: lanes with a PR, events, active of total agents, and uptime', () => {
  const r = rig();
  r.m.setData(data());
  const s = k => r.panel.querySelector(`[data-stat="${k}"]`).textContent;
  assert.strictEqual(s('tasks'), 'tasks 2 · 1 PR');
  assert.strictEqual(s('events'), 'events 1.2k');
  assert.strictEqual(s('active'), 'active 1 / 2');
  assert.strictEqual(s('uptime'), 'this host up 2m 05s');
  r.m.setData(data({ lanes: { open: 3, withPr: 0 }, feed: null }));
  assert.strictEqual(s('tasks'), 'tasks 3');
  assert.strictEqual(s('events'), 'events —');
  assert.strictEqual(s('uptime'), 'this host up —');
  assert.match(r.canvas.getAttribute('aria-label'), /2 sessions, 1 agent active/);
});

// --- THE FRAME BUDGET -----------------------------------------------------------------------------------------------------

test('HIDDEN: the panel is not shown, so no frame is asked for and none is drawn', () => {
  const r = rig();
  r.m.setView({ shown: false, focused: true, lean: false });
  r.m.setData(data());
  r.pump(20);
  r.m.setData(data({ feed: { events: 5, uptimeMs: 1 } }));
  r.pump(20);
  assert.strictEqual(r.counts.raf, 0, 'asked for no animation frame at all');
  assert.strictEqual(r.m.state().frames, 0);
  assert.strictEqual(r.calls.length, 0, 'touched the canvas not once');
});

test('LEAN: shown but lean, it draws nothing', () => {
  const r = rig();
  r.m.setView({ shown: true, focused: true, lean: true });
  r.m.setData(data());
  r.pump(20);
  assert.strictEqual(r.counts.raf, 0);
  assert.strictEqual(r.m.state().frames, 0);
});

test('UNKNOWN focus or lean holds still: one static frame, no loop', () => {
  const r = rig();
  r.m.setView({ shown: true });                     // focused and lean not yet reported
  r.m.setData(data());
  r.pump(30);
  assert.strictEqual(r.m.state().animating, false);
  assert.strictEqual(r.m.state().looping, false);
  assert.strictEqual(r.m.state().particles, 0);
});

test('ANIMATING: shown, focused, not lean, a working agent -> the loop runs and particles flow from it', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(30);
  const s = r.m.state();
  assert.strictEqual(s.animating, true);
  assert.strictEqual(s.looping, true, 'streams keep the loop alive');
  assert.ok(s.frames >= 10);
  assert.ok(s.particles > 0, 'particles are in flight');
  assert.ok(s.flows >= 1);
});

test('UNFOCUSED: shown but the window has lost focus -> exactly one static frame, no loop, no particles', () => {
  const r = rig();
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data());
  r.pump(30);
  const s = r.m.state();
  assert.strictEqual(s.frames, 1, 'one static frame');
  assert.strictEqual(s.looping, false);
  assert.strictEqual(s.particles, 0);
  assert.strictEqual(r.pending.size, 0, 'no frame is waiting');
  assert.strictEqual(s.settled, true, 'the static frame shows a SETTLED layout, not one frozen mid-unfold');
});

test('LOSING FOCUS mid-animation cancels the loop and leaves one static frame', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(15);
  const cancelled = r.counts.caf + r.counts.unpace;
  const before = r.m.state().frames;
  r.m.setView({ focused: false });
  assert.ok(r.counts.caf + r.counts.unpace > cancelled, 'the pending frame (or the wait for it) was cancelled');
  r.pump(30);
  const s = r.m.state();
  assert.strictEqual(s.frames, before + 1, 'exactly one more frame: the static one');
  assert.strictEqual(s.looping, false);
  assert.strictEqual(s.particles, 0);
  r.m.setView({ focused: true });
  r.pump(5);
  assert.strictEqual(r.m.state().looping, true, 'and it carries on when focus returns');
});

test('HIDING mid-animation stops everything, and showing again restarts it', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(10);
  r.m.setView({ shown: false });
  const frames = r.m.state().frames;
  r.pump(30);
  assert.strictEqual(r.m.state().frames, frames);
  assert.strictEqual(r.m.state().looping, false);
  r.m.setView({ shown: true });
  r.pump(10);
  assert.ok(r.m.state().frames > frames);
});

test('THE LOOP STOPS BY ITSELF: a settled layout with nothing flowing asks for no more frames', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data({ agents: [ag('miguel', { state: 'sleeping', detail: 'sleeping' })], sessions: [sess('a', { self: true }), sess('b')] }));
  settle(r);
  const s = r.m.state();
  assert.strictEqual(s.looping, false);
  assert.strictEqual(s.settled, true);
  assert.ok(s.frames < 250, `took ${s.frames} frames`);
  const frames = s.frames;
  r.pump(50);
  assert.strictEqual(r.m.state().frames, frames, 'and nothing is drawn after that');
  assert.strictEqual(r.pending.size, 0);
});

test('...and wakes when something changes', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data({ agents: [], sessions: [sess('a', { self: true })] }));
  settle(r);
  assert.strictEqual(r.m.state().looping, false);
  r.m.setData(data({ agents: [ag('dexter')], sessions: [sess('a', { self: true })] }));
  assert.ok(r.pending.size > 0, 'a new agent asks for a frame');
  r.pump(5);
  assert.strictEqual(r.m.state().looping, true);
});

test('the same data again is not a change: it draws nothing new', () => {
  const r = rig();
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data());
  r.pump(5);
  const frames = r.m.state().frames;
  r.m.setData(data());
  assert.strictEqual(r.pending.size, 0);
  r.pump(5);
  assert.strictEqual(r.m.state().frames, frames);
});

test('PREFERS-REDUCED-MOTION: no particles, and the loop stops once the layout rests even with an agent working', () => {
  const r = rig({ reduced: true });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  settle(r);
  const s = r.m.state();
  assert.strictEqual(s.particles, 0);
  assert.strictEqual(s.looping, false);
  assert.strictEqual(s.settled, true);
});

test('the loop keeps its gap: a callback that comes too soon draws nothing', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(1, 34);
  const frames = r.m.state().frames;
  r.pump(1, 8);
  assert.strictEqual(r.m.state().frames, frames, '8 ms later: skipped');
  assert.strictEqual(r.m.state().looping, true, 'and it carries on');
  r.pump(1, 40);
  assert.strictEqual(r.m.state().frames, frames + 1);
});

test('the wait between two frames is a TIMER, then one animation frame: the page is not woken on every vsync to do nothing', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(1, 34);                                   // the first frame
  assert.strictEqual(r.pending.size, 0, 'no animation frame is waiting during the wait');
  assert.strictEqual(r.paced.size, 1, 'a timer is');
  const [{ ms }] = [...r.paced.values()];
  assert.ok(ms >= 20 && ms < 30, `it wakes a little before the end of the 30 ms slot: ${ms} ms`);
  const rafsBefore = r.counts.raf;
  r.pump(10, 34);
  assert.ok(r.counts.raf - rafsBefore <= 10, 'at most one animation frame per drawn frame');
  assert.ok(r.counts.pace >= 10);
});

test('a frame that took the whole slot does not wait at all', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.work.fn = () => r.advance(31);
  r.pump(1, 34);
  assert.strictEqual(r.paced.size, 0, 'no timer: the next animation frame is asked for straight away');
  assert.strictEqual(r.pending.size, 1);
});

test('a slow frame (over 40 ms of work) halves the particle budget', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.work.fn = () => r.advance(60);
  r.pump(1);
  assert.strictEqual(r.m.state().budget, 0.5);
  assert.ok(r.m.state().lastCost >= 60);
});

test('the budget really thins the stream: fewer particles at the floor than at full', () => {
  const full = rig(); full.m.setView(VIEW_ON); full.m.setData(data());
  full.pump(25);
  const slow = rig(); slow.m.setView(VIEW_ON); slow.m.setData(data());
  for (let i = 0; i < 4; i += 1) { slow.work.done = false; slow.work.fn = () => slow.advance(60); slow.pump(1); }
  slow.work.fn = null;
  assert.strictEqual(slow.m.state().budget, M.BUDGET_MIN, 'four slow frames reach the floor');
  slow.pump(21);
  assert.ok(slow.m.state().particles < full.m.state().particles, `${slow.m.state().particles} < ${full.m.state().particles}`);
});

// --- the layers ----------------------------------------------------------------------------------------------------------------

test('LAYERS: once the picture rests, a frame blits two layers and draws only what moves (it does not repaint the labels)', () => {
  const r = rig({ layered: true });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  for (let i = 0; i < 400 && !r.m.state().settled; i += 1) r.pump(1);
  r.pump(3);
  const [back, front] = r.layers;                       // the two big layers are made first
  const fills = (l) => l.calls.filter(c => c[0] === 'fillText').length;
  const backPaints = back.calls.filter(c => c[0] === 'fillRect').length;
  const frontText = fills(front);
  assert.ok(frontText > 0, 'the front layer carries the labels');
  const blits = (l) => r.calls.filter(c => c[0] === 'drawImage' && c[1] === l.canvas).length;
  const b0 = blits(back); const f0 = blits(front);
  r.pump(20);
  assert.strictEqual(back.calls.filter(c => c[0] === 'fillRect').length, backPaints, 'the back layer was not repainted');
  assert.strictEqual(fills(front), frontText, 'nor the front layer');
  assert.ok(blits(back) > b0 && blits(front) > f0, 'but both were blitted, every frame');
  assert.strictEqual(blits(back) - b0, blits(front) - f0, 'once each per frame');
});

test('LAYERS: the streams are drawn between the two blits, so nodes stay on top of them', () => {
  const r = rig({ layered: true });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(40);
  const [back, front] = r.layers;
  const order = r.calls.filter(c => c[0] === 'drawImage').map(c => (c[1] === back.canvas ? 'B' : c[1] === front.canvas ? 'F' : 'p')).join('');
  assert.match(order, /B(p+)F/, order.slice(-60));
  assert.ok(!/F(p+)B/.test(order.replace(/Bp+F/g, 'x')), 'never a particle after the front blit and before the next back one');
});

test('LAYERS: a change they show repaints them: the hover, the data, the view', () => {
  const r = rig({ layered: true });
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data());
  r.pump(5);
  const [back, front] = r.layers;
  const paints = () => [back.calls.filter(c => c[0] === 'fillRect').length, front.calls.filter(c => c[0] === 'fillText').length];
  const p0 = paints();
  const a = r.m.screenPos('agent:dexter');
  r.canvas.dispatch('pointermove', { clientX: a.x, clientY: a.y });
  r.pump(3);
  const p1 = paints();
  assert.ok(p1[0] > p0[0] && p1[1] > p0[1], 'the hover redrew both');
  r.canvas.dispatch('wheel', { clientX: 10, clientY: 10, deltaY: -300, preventDefault() {} });
  r.pump(3);
  const p2 = paints();
  assert.ok(p2[0] > p1[0] && p2[1] > p1[1], 'the zoom did');
  r.m.setData(data({ agents: [ag('dexter'), ag('newcomer')] }));
  r.pump(3);
  const p3 = paints();
  assert.ok(p3[0] > p2[0] && p3[1] > p2[1], 'a new agent did');
});

test('LAYERS: a new size (or ratio) makes new layers, and the old picture is never stretched', () => {
  const r = rig({ layered: true, dpr: 1 });
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data());
  r.pump(3);
  const before = r.layers.length;
  r.stage.layout = { width: 300, height: 260 };
  r.observers[0]();
  r.pump(3);
  assert.ok(r.layers.length >= before + 2, 'two fresh layers');
  assert.deepStrictEqual([r.layers[before].canvas.width, r.layers[before].canvas.height], [300, 260]);
});

test('PARTICLES: additive on a dark panel, normal on a light one (additive light on light is invisible)', () => {
  const composite = (tokens) => {
    const r = rig({ layered: true, tokens });
    r.m.setView(VIEW_ON);
    r.m.setData(data());
    r.pump(30);
    return new Set(r.calls.filter(c => c[0] === 'set:globalCompositeOperation').map(c => c[1]));
  };
  assert.ok(composite({ '--bg': '#11131a' }).has('lighter'), 'dark');
  assert.ok(!composite({ '--bg': '#f6eef3' }).has('lighter'), 'light');
  assert.ok(!composite({ '--bg': 'rgb(240, 236, 232)' }).has('lighter'), 'light, written as rgb()');
});

test('PARTICLES: a sprite fades to its own colour at alpha 0, not to black (a canvas gradient does not premultiply: no dark fringe)', () => {
  const r = rig({ layered: true });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(30);
  const sprites = r.layers.filter(l => l.canvas.width <= 64 && l.calls.some(c => c[0] === 'fillRect'));
  assert.ok(sprites.length >= 1, 'a sprite was made');
  const ends = sprites.map(l => l.calls.filter(c => c[0] === 'stop').pop()[2]);
  assert.ok(ends.includes('rgba(208,140,74,0)'), `the working colour #d08c4a fades to itself at 0: ${ends}`);
  assert.ok(ends.every(e => /^rgba\(\d+,\d+,\d+,0\)$/.test(e)), 'every one ends fully transparent');
});

test('the gap between frames can be changed (a slower animation is a cheaper one), and junk is ignored', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  assert.strictEqual(r.m.state().frameMs, 30);
  r.m.setFrameMs(60);
  assert.strictEqual(r.m.state().frameMs, 60);
  r.pump(1, 34);
  const frames = r.m.state().frames;
  r.pump(1, 34);
  assert.strictEqual(r.m.state().frames, frames, '34 ms is now too soon');
  r.pump(1, 40);
  assert.strictEqual(r.m.state().frames, frames + 1, '74 ms is enough');
  for (const bad of [NaN, null, 'x', undefined]) r.m.setFrameMs(bad);
  assert.strictEqual(r.m.state().frameMs, 60);
  r.m.setFrameMs(1); assert.strictEqual(r.m.state().frameMs, 8);
  r.m.setFrameMs(1e9); assert.strictEqual(r.m.state().frameMs, 250);
});

test('destroy() stops the loop, the timers and the observer, and the panel draws nothing after it', () => {
  let disposed = 0;
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(5);
  assert.strictEqual(r.m.state().looping, true);
  const frames = r.m.state().frames;
  r.m.destroy();
  assert.strictEqual(r.m.state().looping, false);
  r.pump(20);
  assert.strictEqual(r.m.state().frames, frames);
  r.m.setData(data({ agents: [ag('newcomer')] }));
  r.m.setView(VIEW_ON);
  r.pump(5);
  void disposed;
  assert.ok(r.m.state().frames >= frames, 'a destroyed panel that is told things does not throw');
});

test('destroy() disconnects the size observer and keeps the picture it has', () => {
  const storage = memoryStorage();
  const r = rig({ storage });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  for (let i = 0; i < 400 && !r.m.state().settled; i += 1) r.pump(1);
  assert.strictEqual(r.counts.disposed, 0);
  assert.strictEqual(storage.writes.length, 0, 'the debounced save has not run yet');
  r.m.destroy();
  assert.strictEqual(r.counts.disposed, 1);
  assert.ok(storage.writes.length >= 1, 'the picture is kept at once, not left to a timer that nobody will run');
});

// --- what a frame asks of the page ------------------------------------------------------------------------------------------

test('the stage is measured once and kept until the size observer says it changed (a rect read every frame is a forced layout)', () => {
  const r = rig();
  let reads = 0;
  const real = r.stage.getBoundingClientRect.bind(r.stage);
  r.stage.getBoundingClientRect = () => { reads += 1; return real(); };
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(30);
  assert.ok(r.m.state().frames >= 20);
  assert.ok(reads <= 3, `read ${reads} times in ${r.m.state().frames} frames`);
  const before = reads;
  r.stage.layout = { width: 300, height: 300 };
  r.observers[0]();
  r.pump(3);
  assert.ok(reads > before, 'and read again after the observer fired');
  assert.strictEqual(r.canvas.width, 600);
});

test('without a size observer the stage is read every frame (it cannot know otherwise)', () => {
  const doc = new FakeDocument();
  const panel = doc.createElement('div'); doc.root.appendChild(panel);
  const pending = new Map(); let id = 0; let t = 1000;
  const m = D.mount({ doc, root: panel, context: new Proxy({}, { get: () => () => {}, set: () => true }), raf: (fn) => { id += 1; pending.set(id, fn); return id; }, caf: () => {}, now: () => t, css: () => '#888', dpr: () => 1, observe: () => null });
  const stage = panel.querySelector('.map-stage');
  stage.layout = { width: 400, height: 300 };
  let reads = 0;
  const real = stage.getBoundingClientRect.bind(stage);
  stage.getBoundingClientRect = () => { reads += 1; return real(); };
  m.setView({ shown: true, focused: false, lean: false });
  m.setData(data());
  for (let i = 0; i < 3; i += 1) { t += 40; const fns = [...pending.values()]; pending.clear(); fns.forEach(fn => fn()); m.redraw(); }
  assert.ok(reads >= 2);
});

test('the colours of the page are read a few times a second, not every frame', () => {
  const r = rig();
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(3);
  const afterStart = r.counts.css;
  r.pump(8, 34);                                     // inside the 400 ms the colours are kept for (the first read was at the first frame)
  assert.strictEqual(r.counts.css, afterStart, 'no new reads inside the window');
  r.pump(20, 34);                                    // well past it
  assert.ok(r.counts.css > afterStart, 'and fresh ones after');
});

// --- the review fixes (PR #205) -------------------------------------------------------------------------------------------------

test('DEXTER 1: a conflict card says when each agent was last active, never that it "wrote"', () => {
  const c = D.cardFor({ kind: 'conflict', label: 'feat-x', claims: [{ agent: 'a', lastAt: 1_700_000_000_000 }, { agent: 'b', lastAt: 1_700_000_000_000 }] }, 1_700_000_005_000);
  assert.deepStrictEqual(c.lines, ['a was last active here 5s ago', 'b was last active here 5s ago']);
  assert.ok(!c.lines.some(l => /wrote/.test(l)));
});

test('DEXTER 5: reduced motion is a STATIC graph: one frame, a settled layout at once, no loop, no pulse, no particles', () => {
  const r = rig({ reduced: true });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(1);
  const s = r.m.state();
  assert.strictEqual(s.settled, true, 'no easing of new nodes');
  assert.strictEqual(s.looping, false);
  assert.strictEqual(s.particles, 0);
  assert.strictEqual(s.frames, 1, 'one frame');
  r.m.setData(data({ agents: [ag('dexter'), ag('newcomer')] }));
  r.pump(5);
  assert.strictEqual(r.m.state().frames, 2, 'one more frame for the one change');
  assert.strictEqual(r.m.state().settled, true);
});

test('DEXTER 6: turning reduced motion off wakes the loop (refresh), and a pixel-ratio change re-measures (DEXTER 7)', () => {
  const r = rig({ reduced: true });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(3);
  assert.strictEqual(r.m.state().looping, false);
  r.flags.reduced = false;
  r.m.refresh();
  r.pump(3);
  assert.strictEqual(r.m.state().looping, true);
  assert.ok(r.m.state().particles > 0);
  const r2 = rig({ dpr: 1 });
  r2.m.setView({ shown: true, focused: false, lean: false });
  r2.m.setData(data());
  r2.pump(2);
  assert.strictEqual(r2.canvas.width, 520);
  r2.dpr.value = 2;
  r2.m.refresh();
  r2.pump(2);
  assert.strictEqual(r2.canvas.width, 1040);
  assert.strictEqual(r2.m.state().size.dpr, 2);
});

test('DEXTER 9: Fit is saved: after zoom, flush, Fit, flush, a reload starts from the fitted view', () => {
  const storage = memoryStorage();
  const a = rig({ storage });
  a.m.setView(VIEW_ON);
  a.m.setData(data());
  for (let i = 0; i < 400 && !a.m.state().settled; i += 1) a.pump(1);
  a.canvas.dispatch('wheel', { clientX: 100, clientY: 100, deltaY: -400, preventDefault() {} });
  a.later.splice(0).forEach(fn => fn());
  assert.strictEqual(JSON.parse(storage.map.get(storage.writes[0])).view !== null, true);
  a.canvas.dispatch('dblclick');
  a.later.splice(0).forEach(fn => fn());
  assert.strictEqual(JSON.parse(storage.map.get(storage.writes[storage.writes.length - 1])).view, null);
  const b = rig({ storage });
  b.m.setView({ shown: true, focused: false, lean: false });
  b.m.setData(data());
  b.pump(3);
  assert.strictEqual(b.m.state().userView, false);
});

test('MIGUEL Y2: fifty messages in one tick cause ONE rebuild, at the next frame', () => {
  let reads = 0;
  const r = rig({ source: () => { reads += 1; return data(); } });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(3);
  const before = reads;
  for (let i = 0; i < 50; i += 1) r.m.invalidate();
  assert.strictEqual(reads, before, 'nothing is rebuilt inside the tick');
  r.pump(1);
  assert.strictEqual(reads, before + 1, 'one rebuild at the next frame');
  r.pump(5);
  assert.strictEqual(reads, before + 1, 'and none after it');
});

test('MIGUEL Y2: with no loop running (a static frame) the changes wait ~100 ms for company, then one rebuild', () => {
  let reads = 0;
  const r = rig({ source: () => { reads += 1; return data(); } });
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data());
  r.pump(3);
  for (let i = 0; i < 50; i += 1) r.m.invalidate();
  assert.strictEqual(reads, 0);
  assert.strictEqual(r.later.length, 1, 'one timer for fifty calls');
  r.later.splice(0).forEach(fn => fn());
  assert.strictEqual(reads, 1);
});

test('MIGUEL Y2: a hidden panel is not rebuilt for the page\'s messages, and catches up when shown', () => {
  let reads = 0;
  const r = rig({ source: () => { reads += 1; return data(); } });
  r.m.setView({ shown: false, focused: true, lean: false });
  r.m.invalidate();
  r.later.splice(0).forEach(fn => fn());
  assert.strictEqual(reads, 0);
  r.m.setView({ shown: true });
  assert.strictEqual(reads, 1, 'the missed changes are applied when it is shown');
});

test('MIGUEL S5/S6: only the primary button acts, and the second click of a double-click selects nothing', () => {
  const r = shown();
  const s = r.m.screenPos('session:b');
  r.canvas.dispatch('pointerdown', { clientX: s.x, clientY: s.y, button: 2 });
  r.canvas.dispatch('pointerup', { clientX: s.x, clientY: s.y, button: 2 });
  assert.strictEqual(r.clicks.session.length, 0, 'a right click');
  r.canvas.dispatch('pointerdown', { clientX: s.x, clientY: s.y, button: 0, detail: 1 });
  r.canvas.dispatch('pointerup', { clientX: s.x, clientY: s.y, button: 0, detail: 1 });
  r.canvas.dispatch('pointerdown', { clientX: s.x, clientY: s.y, button: 0, detail: 2 });
  r.canvas.dispatch('pointerup', { clientX: s.x, clientY: s.y, button: 0, detail: 2 });
  assert.strictEqual(r.clicks.session.length, 1, 'one selection for a double-click');
});

test('a claim-only agent has no card to open: clicking it does nothing', () => {
  const r = rig();
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data({ agents: [], claims: [{ agentId: 'zz', agent: 'builder', worktree: 'C:/p/x', also: [], lastAt: 1, own: false }] }));
  r.pump(3);
  const a = r.m.screenPos('agent:zz');
  r.canvas.dispatch('pointerdown', { clientX: a.x, clientY: a.y });
  r.canvas.dispatch('pointerup', { clientX: a.x, clientY: a.y });
  assert.deepStrictEqual(r.clicks.agent, []);
});

test('MIGUEL S11: destroy() leaves no debounced save behind', () => {
  const storage = memoryStorage();
  const r = rig({ storage });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  for (let i = 0; i < 400 && !r.m.state().settled; i += 1) r.pump(1);
  r.m.destroy();
  const n = storage.writes.length;
  r.later.splice(0).forEach(fn => fn());
  assert.strictEqual(storage.writes.length, n, 'the timer that was pending finds nothing to do');
});

test('MIGUEL S12: a project is kept under its PATH: two projects with one folder name are two pictures', () => {
  const storage = memoryStorage();
  const a = rig({ storage });
  a.m.setView(VIEW_ON);
  a.m.setData(data({ project: { name: 'app', path: 'C:/one/app' } }));
  for (let i = 0; i < 400 && !a.m.state().settled; i += 1) a.pump(1);
  a.canvas.dispatch('wheel', { clientX: 1, clientY: 1, deltaY: -400, preventDefault() {} });
  a.later.splice(0).forEach(fn => fn());
  const b = rig({ storage });
  b.m.setView({ shown: true, focused: false, lean: false });
  b.m.setData(data({ project: { name: 'app', path: 'C:/two/app' } }));
  b.pump(3);
  assert.strictEqual(b.m.state().userView, false, 'another path, another picture');
  const c = rig({ storage });
  c.m.setView({ shown: true, focused: false, lean: false });
  c.m.setData(data({ project: { name: 'app', path: 'C:/one/app' } }));
  c.pump(3);
  assert.strictEqual(c.m.state().userView, true);
});

test('a rebuild that CHANGES the graph, asked for from inside a frame, does not start a second loop', () => {
  let n = 0;
  const r = rig({ source: () => { n += 1; return data({ agents: [ag('dexter'), ag('a' + (n % 4))] }); } });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  for (let i = 0; i < 80; i += 1) { r.m.invalidate(); r.pump(1, 34); }
  const frames = r.m.state().frames;
  assert.ok(frames > 20);
  assert.ok(r.pending.size + r.paced.size <= 1, `one chain, not ${r.pending.size + r.paced.size}`);
  assert.ok(r.counts.raf <= frames * 1.5 + 2, `${r.counts.raf} animation frames asked for ${frames} drawn`);
});

// --- crisp at devicePixelRatio ----------------------------------------------------------------------------------------------

test('the canvas is sized in DEVICE pixels and every frame is drawn through the ratio', () => {
  const r = rig({ dpr: 2, size: { width: 520, height: 420 } });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(2);
  assert.strictEqual(r.canvas.width, 1040);
  assert.strictEqual(r.canvas.height, 840);
  const first = r.calls.find(c => c[0] === 'setTransform');
  assert.deepStrictEqual(first.slice(1), [2, 0, 0, 2, 0, 0], 'the CSS-pixel pass starts from the ratio');
  const world = r.calls.filter(c => c[0] === 'setTransform').pop();
  assert.ok(Math.abs(world[1] - 2 * r.m.state().zoom) < 1e-9, 'and the world pass carries ratio x zoom, so text is rasterised at its final size');
});

test('a different ratio (a screen change) resizes the bitmap', () => {
  const r = rig({ dpr: 1 });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  r.pump(2);
  assert.strictEqual(r.canvas.width, 520);
});

test('a zero-size panel (collapsed) draws nothing and does not throw', () => {
  const r = rig({ size: { width: 0, height: 0 } });
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  assert.doesNotThrow(() => r.pump(5));
  assert.strictEqual(r.m.state().frames, 0);
});

test('a resize is noticed: the observer makes the next frame re-measure', () => {
  const r = rig();
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data());
  r.pump(2);
  assert.strictEqual(r.canvas.width, 1040);
  r.stage.layout = { width: 300, height: 300 };
  r.observers[0]();
  r.pump(2);
  assert.strictEqual(r.canvas.width, 600);
});

// --- pointer ---------------------------------------------------------------------------------------------------------------

function shown(o) {
  const r = rig(o);
  r.m.setView(VIEW_ON);
  r.m.setData(data());
  settle(r);
  r.m.setView({ focused: false });       // a still picture to point at
  r.pump(5);
  return r;
}

test('the wheel zooms about the pointer within 40%..300%, and the strip says so', () => {
  const r = shown();
  const k0 = r.m.state().zoom;
  r.canvas.dispatch('wheel', { clientX: 200, clientY: 150, deltaY: -300, preventDefault() {} });
  assert.ok(r.m.state().zoom > k0);
  assert.match(r.panel.querySelector('.map-zoom').textContent, /^\d+%$/);
  for (let i = 0; i < 60; i += 1) r.canvas.dispatch('wheel', { clientX: 200, clientY: 150, deltaY: -500, preventDefault() {} });
  assert.strictEqual(r.m.state().zoom, 3);
  for (let i = 0; i < 120; i += 1) r.canvas.dispatch('wheel', { clientX: 200, clientY: 150, deltaY: 500, preventDefault() {} });
  assert.strictEqual(r.m.state().zoom, 0.4);
  assert.strictEqual(r.panel.querySelector('.map-zoom').textContent, '40%');
});

test('the wheel is taken by the map: it does not scroll the dock behind it', () => {
  const r = shown();
  const e = r.canvas.dispatch('wheel', { clientX: 10, clientY: 10, deltaY: 100 });
  assert.strictEqual(e.defaultPrevented, true);
});

test('dragging pans; a drag is not a click', () => {
  const r = shown();
  const before = r.m.state().view;
  const spot = r.m.screenPos('session:a');
  r.canvas.dispatch('pointerdown', { clientX: spot.x, clientY: spot.y, pointerId: 1 });
  r.canvas.dispatch('pointermove', { clientX: spot.x + 40, clientY: spot.y + 30, pointerId: 1 });
  r.canvas.dispatch('pointerup', { clientX: spot.x + 40, clientY: spot.y + 30, pointerId: 1 });
  const after = r.m.state().view;
  assert.ok(Math.abs(after.x - before.x - 40) < 1e-9 && Math.abs(after.y - before.y - 30) < 1e-9);
  assert.strictEqual(r.clicks.session.length, 0, 'a drag that began on a node did not select it');
  assert.strictEqual(r.m.state().userView, true);
});

test('Fit (the button, or a double-click) brings everything back and hands the view back to the layout', () => {
  const r = shown();
  r.canvas.dispatch('wheel', { clientX: 10, clientY: 10, deltaY: -900, preventDefault() {} });
  const zoomed = r.m.state().zoom;
  r.panel.querySelector('.map-fit').dispatch('click');
  assert.notStrictEqual(r.m.state().zoom, zoomed);
  assert.strictEqual(r.m.state().userView, false);
  r.canvas.dispatch('wheel', { clientX: 10, clientY: 10, deltaY: -900, preventDefault() {} });
  r.canvas.dispatch('dblclick');
  assert.strictEqual(r.m.state().userView, false);
  for (const n of r.m.state().nodes) {
    const p = r.m.screenPos(n.id);
    assert.ok(p.x >= 0 && p.x <= 520 && p.y >= 0 && p.y <= 420, `${n.id} is on screen at ${p.x | 0},${p.y | 0}`);
  }
});

test('the keyboard: + and - zoom, 0 fits', () => {
  const r = shown();
  const k = r.m.state().zoom;
  r.canvas.dispatch('keydown', { key: '+', preventDefault() {} });
  assert.ok(r.m.state().zoom > k);
  r.canvas.dispatch('keydown', { key: '0', preventDefault() {} });
  assert.strictEqual(r.m.state().userView, false);
});

test('clicking a session selects its tab; clicking an agent opens its card; clicking nothing does neither', () => {
  const r = shown();
  const s = r.m.screenPos('session:b');
  r.canvas.dispatch('pointerdown', { clientX: s.x, clientY: s.y });
  r.canvas.dispatch('pointerup', { clientX: s.x, clientY: s.y });
  assert.strictEqual(r.clicks.session.length, 1);
  assert.strictEqual(r.clicks.session[0].id, 'b');
  assert.strictEqual(r.clicks.session[0].folder, 'C:\\p\\x');
  const a = r.m.screenPos('agent:dexter');
  r.canvas.dispatch('pointerdown', { clientX: a.x, clientY: a.y });
  r.canvas.dispatch('pointerup', { clientX: a.x, clientY: a.y });
  assert.deepStrictEqual(r.clicks.agent, ['dexter']);
  r.canvas.dispatch('pointerdown', { clientX: 2, clientY: 2 });
  r.canvas.dispatch('pointerup', { clientX: 2, clientY: 2 });
  assert.strictEqual(r.clicks.session.length + r.clicks.agent.length, 2);
  const p = r.m.screenPos('project');
  r.canvas.dispatch('pointerdown', { clientX: p.x, clientY: p.y });
  r.canvas.dispatch('pointerup', { clientX: p.x, clientY: p.y });
  assert.strictEqual(r.clicks.session.length + r.clicks.agent.length, 2, 'the project node is not a button');
});

test('hovering an agent shows its card: model, tokens, tool, elapsed; leaving hides it', () => {
  const r = shown();
  r.m.setData(data({ agents: [ag('dexter', { model: 'opus', tokens: 120000, tool: 'Edit', since: 1_700_000_000_000 + r.now() - 130_000 }), ag('miguel', { state: 'sleeping', detail: 'sleeping' })] }));
  r.pump(3);
  const a = r.m.screenPos('agent:dexter');
  r.canvas.dispatch('pointermove', { clientX: a.x, clientY: a.y });
  const card = r.panel.querySelector('.map-card');
  assert.strictEqual(card.hidden, false);
  assert.strictEqual(r.panel.querySelector('.map-card-title').textContent, 'dexter');
  const lines = r.panel.querySelectorAll('.map-card-line').map(l => l.textContent);
  assert.ok(lines.includes('model: opus'));
  assert.ok(lines.includes('tokens: 120k in this project'));
  assert.ok(lines.includes('tool: Edit'));
  assert.ok(lines.includes('elapsed: 2m 10s'));
  r.canvas.dispatch('pointerleave');
  assert.strictEqual(card.hidden, true);
});

test('what the card does not know it shows as a dash, never as a zero', () => {
  const r = rig();
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data({ agents: [{ name: 'x', state: 'working', detail: 'working' }] }));
  r.pump(5);
  const a = r.m.screenPos('agent:x');
  r.canvas.dispatch('pointermove', { clientX: a.x, clientY: a.y });
  const lines = r.panel.querySelectorAll('.map-card-line').map(l => l.textContent);
  assert.ok(lines.includes('model: —') && lines.includes('tokens: —') && lines.includes('tool: —'));
  assert.ok(!lines.some(l => /^elapsed/.test(l)), 'no start time known: no elapsed line');
});

test('a conflict edge is hoverable and names both claims', () => {
  const r = rig();
  r.m.setView({ shown: true, focused: false, lean: false });
  r.m.setData(data({
    agents: [ag('dexter'), ag('miguel')],
    claims: [{ agentId: 'i1', agent: 'dexter', worktree: 'C:\\p\\feat-x', also: [], wroteAt: 1_700_000_000_000, lastAt: 1_700_000_000_000 + 1000 - 60_000 }, { agentId: 'i2', agent: 'miguel', worktree: 'c:/p/feat-x', also: [], wroteAt: 1_700_000_000_000, lastAt: 1_700_000_000_000 + 1000 - 5000 }],
  }));
  r.pump(5);
  assert.strictEqual(r.m.state().conflicts, 1);
  const id = r.m.state().edges.find(e => e.kind === 'conflict').id;
  const mid = r.m.edgePos(id, 0.5);
  r.canvas.dispatch('pointermove', { clientX: mid.x, clientY: mid.y });
  assert.strictEqual(r.panel.querySelector('.map-card-title').textContent, 'Conflict · feat-x');
  const lines = r.panel.querySelectorAll('.map-card-line').map(l => l.textContent);
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.some(l => /^dexter was last active here/.test(l)) && lines.some(l => /^miguel was last active here/.test(l)));
});

test('hiding the panel drops the hover card', () => {
  const r = shown();
  const a = r.m.screenPos('agent:dexter');
  r.canvas.dispatch('pointermove', { clientX: a.x, clientY: a.y });
  assert.strictEqual(r.m.state().cardShown, true);
  r.m.setView({ shown: false });
  assert.strictEqual(r.m.state().cardShown, false);
});

// --- keeping the picture ---------------------------------------------------------------------------------------------------

function memoryStorage() {
  const m = new Map(); const writes = [];
  return { read: (k) => (m.has(k) ? m.get(k) : null), write: (k, v) => { writes.push(k); m.set(k, v); }, map: m, writes };
}

test('the picture and the view are kept per project, and come back', () => {
  const storage = memoryStorage();
  const a = rig({ storage });
  a.m.setView(VIEW_ON);
  a.m.setData(data());
  settle(a);
  a.canvas.dispatch('wheel', { clientX: 100, clientY: 100, deltaY: -400, preventDefault() {} });
  a.later.splice(0).forEach(fn => fn());
  assert.ok(storage.writes.length >= 1);
  const key = storage.writes[storage.writes.length - 1];
  assert.match(key, /^claude-custom\.map\./);
  const kept = JSON.parse(storage.map.get(key));
  assert.strictEqual(kept.v, 1);
  assert.ok(kept.pos['session:a'] && kept.pos.project);
  const b = rig({ storage });
  b.m.setView({ shown: true, focused: false, lean: false });
  b.m.setData(data());
  b.pump(5);
  assert.deepStrictEqual(b.m.state().view, a.m.state().view);
  assert.strictEqual(b.m.state().userView, true);
  assert.strictEqual(b.m.state().settled, true, 'a kept picture is already at rest');
});

test('another project does not get this project\'s picture', () => {
  const storage = memoryStorage();
  const a = rig({ storage });
  a.m.setView(VIEW_ON); a.m.setData(data()); settle(a);
  a.canvas.dispatch('wheel', { clientX: 1, clientY: 1, deltaY: -400, preventDefault() {} });
  a.later.splice(0).forEach(fn => fn());
  const b = rig({ storage });
  b.m.setView({ shown: true, focused: false, lean: false });
  b.m.setData(data({ project: { name: 'other' } }));
  b.pump(5);
  assert.strictEqual(b.m.state().userView, false);
});

test('a damaged kept picture is ignored, and storage that throws is survived', () => {
  const storage = memoryStorage();
  const first = rig({ storage }); first.m.setView(VIEW_ON); first.m.setData(data()); settle(first);
  first.canvas.dispatch('wheel', { clientX: 1, clientY: 1, deltaY: -1, preventDefault() {} });
  first.later.splice(0).forEach(fn => fn());
  const key = storage.writes[0];
  for (const bad of ['{not json', '{"v":2}', '{"v":1,"pos":"x","view":{"x":1e99,"y":0,"k":9}}', 'null']) {
    storage.map.set(key, bad);
    const r = rig({ storage });
    r.m.setView({ shown: true, focused: false, lean: false });
    assert.doesNotThrow(() => { r.m.setData(data()); r.pump(5); });
    assert.strictEqual(r.m.state().userView, false, bad);
  }
  const angry = { read: () => { throw new Error('no'); }, write: () => { throw new Error('full'); } };
  const r = rig({ storage: angry });
  r.m.setView(VIEW_ON);
  assert.doesNotThrow(() => { r.m.setData(data()); settle(r); r.later.splice(0).forEach(fn => fn()); });
});

// --- portraits -------------------------------------------------------------------------------------------------------------

test('a portrait is loaded once, drawn only after it has loaded, and a broken one falls back to initials', () => {
  const made = [];
  const r = rig({ makeImage: () => { const img = { onload: null, onerror: null, src: '' }; made.push(img); return img; } });
  r.m.setView({ shown: true, focused: false, lean: false });
  const withUrl = (url) => data({ agents: [ag('dexter', { portrait: { url, initials: 'DX', hue: 10 } })] });
  r.m.setData(withUrl('file:///a.png'));
  r.pump(3);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].src, 'file:///a.png');
  assert.ok(!r.calls.some(c => c[0] === 'drawImage' && c[1] === made[0]), 'not drawn before it loaded');
  made[0].onload();
  r.pump(3);
  assert.ok(r.calls.some(c => c[0] === 'drawImage' && c[1] === made[0]), 'drawn once it has');
  r.m.setData(withUrl('file:///a.png'));
  r.pump(3);
  assert.strictEqual(made.length, 1, 'the same url is not loaded twice');
  r.m.setData(withUrl('file:///broken.png'));
  r.pump(3);
  made[1].onerror();
  assert.doesNotThrow(() => { r.m.setData(withUrl('file:///broken.png')); r.pump(3); });
  assert.ok(r.calls.some(c => c[0] === 'fillText' && c[1] === 'DX'), 'initials stand in');
});

test('portraitSpec: a file image becomes a url; a video, images off or no file become initials', () => {
  const fileUrl = (p) => 'file:///' + p;
  const on = { imagesEnabled: true, fileUrl };
  assert.deepStrictEqual(D.portraitSpec({ kind: 'file', media: 'image', path: 'C:/a.png', fallback: { initials: 'MI', hue: 30 } }, 'miguel', on), { url: 'file:///C:/a.png', initials: 'MI', hue: 30 });
  assert.strictEqual(D.portraitSpec({ kind: 'file', media: 'video', path: 'C:/a.mp4', fallback: { initials: 'MI', hue: 30 } }, 'miguel', on).url, null);
  assert.strictEqual(D.portraitSpec({ kind: 'file', media: 'image', path: 'C:/a.png' }, 'miguel', { imagesEnabled: false, fileUrl }).url, null);
  assert.strictEqual(D.portraitSpec({ kind: 'file', media: 'image', path: 'C:/a.png' }, 'miguel', { imagesEnabled: null, fileUrl }).url, null, 'unknown is not on');
  assert.deepStrictEqual(D.portraitSpec({ kind: 'placeholder', initials: 'ZZ', hue: 99 }, 'z', on), { url: null, initials: 'ZZ', hue: 99 });
  const none = D.portraitSpec(null, 'paris', on);
  assert.strictEqual(none.initials, 'PA');
  assert.ok(none.hue >= 0 && none.hue < 360);
  assert.strictEqual(D.portraitSpec(undefined, '', on).initials, '?');
});

// --- what the card says (pure) ------------------------------------------------------------------------------------------------

test('cardFor: a session says its state, whether it is this window, and its folder', () => {
  const c = D.cardFor({ kind: 'session', label: 'feat/x', state: 'needs', self: true, data: { folder: 'C:\\p\\x' } }, 0);
  assert.strictEqual(c.title, 'feat/x');
  assert.deepStrictEqual(c.lines, ['needs you', 'this window', 'C:\\p\\x']);
  assert.strictEqual(D.cardFor(null, 0), null);
});

test('cardFor: the role leads the title when the roster knows one, and the detail shows beside the state', () => {
  const c = D.cardFor({ kind: 'agent', label: 'dexter', state: 'working', data: { role: 'Logic reviewer', state: 'working', detail: 'reading' } }, 0);
  assert.strictEqual(c.title, 'Logic reviewer · dexter');
  assert.strictEqual(c.lines[0], 'state: working (reading)');
});

// --- safety ----------------------------------------------------------------------------------------------------------------

test('names are set as text, never as markup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'map-display.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(src, /require\(['"](?!\.\/map-)/, 'only its own two siblings are required');
  const r = shown();
  r.m.setData(data({ agents: [ag('<img src=x onerror=alert(1)>')] }));
  r.pump(3);
  const id = r.m.state().nodes.find(n => n.kind === 'agent').id;
  const a = r.m.screenPos(id);
  r.canvas.dispatch('pointermove', { clientX: a.x, clientY: a.y });
  assert.strictEqual(r.panel.querySelector('.map-card-title').textContent, '<img src=x onerror=alert(1)>');
});

test('the panel has no sounds and loads nothing from the network', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'map-display.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  assert.doesNotMatch(src, /\bAudio\b|AudioContext|fetch\(|XMLHttpRequest|WebSocket|http:\/\/|https:\/\//);
});

test('the model and display agree on what a node is (every drawn kind has a card)', () => {
  const g = M.buildGraph(data());
  for (const n of g.nodes) assert.ok(D.cardFor(n, 0), n.kind);
});
