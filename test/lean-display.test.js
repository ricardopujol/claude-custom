'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const L = require('../app/lean-display');

// --- normalize / chip --------------------------------------------------------------

test('normalize: only a real true is on; the night fields belong to bedtime only', () => {
  assert.deepStrictEqual(L.normalize(null), { on: false, byBedtime: false, bedtimeSince: null, night: false });
  assert.deepStrictEqual(L.normalize({ on: 'yes' }), { on: false, byBedtime: false, bedtimeSince: null, night: false });
  assert.deepStrictEqual(L.normalize({ on: true }), { on: true, byBedtime: false, bedtimeSince: null, night: false });
  assert.deepStrictEqual(L.normalize({ on: true, byBedtime: true, bedtimeSince: 5 }), { on: true, byBedtime: true, bedtimeSince: 5, night: false });
  assert.deepStrictEqual(L.normalize({ on: true, byBedtime: true, bedtimeSince: NaN }), { on: true, byBedtime: false, bedtimeSince: null, night: false },
    'a night with no believable start is not shown as one');
  assert.deepStrictEqual(L.normalize({ on: false, byBedtime: true, bedtimeSince: 5 }), { on: false, byBedtime: false, bedtimeSince: null, night: false });
});

test('chip: absent while normal; "lean" by hand; "bedtime HH:MM" when a night started it', () => {
  assert.strictEqual(L.chip({ on: false }), null);
  assert.deepStrictEqual(L.chip({ on: true }), { label: '\u263E lean', night: null, back: 'Back to normal' });
  const at = new Date(2026, 9, 9, 23, 5).getTime();
  assert.strictEqual(L.chip({ on: true, byBedtime: true, bedtimeSince: at }).night, 'bedtime 23:05');
  const early = new Date(2026, 9, 10, 0, 7).getTime();
  assert.strictEqual(L.chip({ on: true, byBedtime: true, bedtimeSince: early }).night, 'bedtime 00:07');
});

// --- the terminal renderer -------------------------------------------------------------

test('wantWebgl: only when not lean, no background is set, and the addon exists', () => {
  assert.strictEqual(L.wantWebgl({ lean: false, hasBackground: false, supported: true }), true);
  assert.strictEqual(L.wantWebgl({ lean: true, hasBackground: false, supported: true }), false, 'lean');
  assert.strictEqual(L.wantWebgl({ lean: false, hasBackground: true, supported: true }), false, 'a background: WebGL mis-draws transparency');
  assert.strictEqual(L.wantWebgl({ lean: false, hasBackground: false, supported: false }), false, 'no addon');
  assert.strictEqual(L.wantWebgl({}), false, 'unknown is not on');
});

// --- animated images ---------------------------------------------------------------------

test('mayAnimate: everything but a known-static decode, by name only because the content cannot be read here (Dexter F4)', () => {
  for (const u of ['file:///C:/p/background.gif', 'file:///C:/p/Background.GIF?v=123', 'file:///C:/p/a.apng#x', 'file:///C:/p/bg.webp',
    'file:///C:/p/bg.png', 'file:///C:/p/bg.svg', 'file:///C:/p/gif/bg.png', 'file:///C:/p/noextension']) assert.strictEqual(L.mayAnimate(u), true, u);
  for (const u of ['file:///C:/p/bg.jpg', 'file:///C:/p/bg.JPEG?v=2', 'file:///C:/p/bg.jpg#frag']) assert.strictEqual(L.mayAnimate(u), false, u);
  assert.strictEqual(L.mayAnimate(null), false);
  assert.strictEqual(L.mayAnimate(''), false);
});

test('advanceCooldowns: a resume after 30 minutes drops the expired and shows the real time left (Dexter F7)', () => {
  const t0 = 1_000_000;
  const list = [{ agent: 'a', remainingMs: 10 * 60_000, _tick: t0 }, { agent: 'b', remainingMs: 45 * 60_000, _tick: t0 }];
  const out = L.advanceCooldowns(list, t0 + 30 * 60_000);
  assert.deepStrictEqual(out.map(c => [c.agent, c.remainingMs]), [['b', 15 * 60_000]]);
  assert.deepStrictEqual(L.advanceCooldowns(undefined, t0), []);
  assert.strictEqual(L.advanceCooldowns([{ agent: 'x', remainingMs: 5 }], t0)[0].remainingMs, 5, 'a first stamp subtracts nothing');
});

// --- the suspender ---------------------------------------------------------------------------

test('suspender: suspends each registered pair once, resumes them in reverse, and is idempotent', () => {
  const log = [];
  const s = L.createSuspender();
  s.register('a', { suspend: () => log.push('a-'), resume: () => log.push('a+') });
  s.register('b', { suspend: () => log.push('b-'), resume: () => log.push('b+') });
  s.set(true); s.set(true);
  assert.deepStrictEqual(log, ['a-', 'b-']);
  s.set(false); s.set(false);
  assert.deepStrictEqual(log, ['a-', 'b-', 'b+', 'a+']);
  assert.strictEqual(s.isOn(), false);
});

test('suspender: one pair throwing never stops the others, and is reported by name', () => {
  const log = [];
  const s = L.createSuspender();
  s.register('bad', { suspend: () => { throw new Error('x'); }, resume: () => { throw new Error('y'); } });
  s.register('good', { suspend: () => log.push('g-'), resume: () => log.push('g+') });
  assert.deepStrictEqual(s.set(true).failed, ['bad']);
  assert.deepStrictEqual(s.set(false).failed, ['bad']);
  assert.deepStrictEqual(log, ['g-', 'g+']);
});

test('suspender: a pair registered while already lean is suspended at once', () => {
  const log = [];
  const s = L.createSuspender();
  s.set(true);
  s.register('late', { suspend: () => log.push('l-'), resume: () => log.push('l+') });
  assert.deepStrictEqual(log, ['l-']);
  s.set(false);
  assert.deepStrictEqual(log, ['l-', 'l+']);
});

test('suspender: registering the same name again replaces the old pair', () => {
  const log = [];
  const s = L.createSuspender();
  s.register('a', { suspend: () => log.push('old'), resume: () => {} });
  s.register('a', { suspend: () => log.push('new'), resume: () => {} });
  s.set(true);
  assert.deepStrictEqual(log, ['new']);
});

test('suspender: a malformed registration is refused, not stored', () => {
  const s = L.createSuspender();
  assert.throws(() => s.register('x', {}), /suspend/);
  assert.throws(() => s.register('', { suspend() {}, resume() {} }), /name/);
});

test('property: every suspend is matched by exactly one resume however the switch is flipped', () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 40 }), (flips) => {
    let down = 0; let up = 0;
    const s = L.createSuspender();
    s.register('p', { suspend: () => { down++; }, resume: () => { up++; } });
    for (const f of flips) s.set(f);
    s.set(false);
    assert.strictEqual(down, up);
    assert.ok(down <= flips.length);
  }));
});

// --- the working strip -------------------------------------------------------------------------

test('workingFaces: only working agents, by name, capped, with the count that did not fit', () => {
  const r = (agent, state) => ({ agent, state, portrait: { kind: 'file', path: `C:/p/${agent}.png` } });
  const out = L.workingFaces([r('zed', 'working'), r('amy', 'working'), r('bob', 'sleeping'), r('cat', 'stressed'), r('dan', 'working')], { limit: 2 });
  assert.deepStrictEqual(out.faces.map(f => f.agent), ['amy', 'dan']);
  assert.strictEqual(out.more, 1);
});

test('workingFaces: nothing working is an empty strip, and junk rows are skipped', () => {
  assert.deepStrictEqual(L.workingFaces([], {}), { faces: [], more: 0 });
  assert.deepStrictEqual(L.workingFaces([null, 3, { state: 'working' }, { agent: 'x', state: 'working' }], {}).faces.map(f => f.agent), ['x']);
});

test('hostListsLean: only a hello whose controls list lean may be told (an older host would type the frame into the session) (Dexter N1)', () => {
  assert.strictEqual(L.hostListsLean(['resize', 'lean']), true);
  for (const c of [null, undefined, [], ['resize', 'input'], 'lean', { lean: true }]) assert.strictEqual(L.hostListsLean(c), false, JSON.stringify(c));
});

test('stillSize: a vector image covers the box at the size it will be shown (Chromium reports 240x150 for the generated viewBox-only SVG)', () => {
  assert.deepStrictEqual(L.stillSize(240, 150, 1186, 730, true), { width: 1186, height: 741 });
  assert.deepStrictEqual(L.stillSize(0, 0, 1186, 730, true), { width: 1186, height: 730 });
  assert.deepStrictEqual(L.stillSize(240, 150, 1000, 1000, true), { width: 1600, height: 1000 });
  assert.deepStrictEqual(L.stillSize(240, 150, 0, 0, true), { width: 240, height: 150 }, 'no box to cover: its own size');
});

test('stillSize: the image\'s own size, else the fallback box (a viewBox-only SVG reports 0), else a square (Dexter N2)', () => {
  assert.deepStrictEqual(L.stillSize(1600, 1000, 1920, 1080), { width: 1600, height: 1000 });
  assert.deepStrictEqual(L.stillSize(0, 0, 1920, 1080), { width: 1920, height: 1080 });
  assert.deepStrictEqual(L.stillSize(0, 150, 1920, 1080), { width: 1920, height: 1080 }, 'half a size is no size');
  assert.deepStrictEqual(L.stillSize(NaN, undefined, 0, -3), { width: 300, height: 300 });
});

// --- Ricardo's video rule (2026-10-09): lean shows an animated background moving only while focused and never during a night ---

test('holdStill: lean + focused + no night plays', () => {
  assert.strictEqual(L.holdStill({ lean: true, focused: true, night: false }), false);
  assert.strictEqual(L.holdStill({ lean: true, focused: true }), false, 'no night said: none');
});

test('holdStill: lean + unfocused is the still frame', () => {
  assert.strictEqual(L.holdStill({ lean: true, focused: false, night: false }), true);
});

test('holdStill: a night holds it still even while focused; the night ending while focused plays again', () => {
  assert.strictEqual(L.holdStill({ lean: true, focused: true, night: true }), true);
  assert.strictEqual(L.holdStill({ lean: true, focused: true, night: false }), false);
});

test('holdStill: not lean is never held (outside lean nothing changes), whatever the focus or night', () => {
  for (const focused of [true, false, null]) for (const night of [true, false]) assert.strictEqual(L.holdStill({ lean: false, focused, night }), false);
  assert.strictEqual(L.holdStill(undefined), false);
});

test('holdStill: an unknown focus holds (only a real true plays)', () => {
  for (const f of [null, undefined, 'yes', 1]) assert.strictEqual(L.holdStill({ lean: true, focused: f, night: false }), true, String(f));
});

test('normalize carries the window-wide night flag (a real true only), lean or not', () => {
  assert.strictEqual(L.normalize({ on: true, night: true }).night, true);
  assert.strictEqual(L.normalize({ on: false, night: true }).night, true);
  assert.strictEqual(L.normalize({ on: true, night: 'yes' }).night, false);
  assert.strictEqual(L.normalize(null).night, false);
});

// --- stillNode: one portrait for the strip, never moving (option C) ---------------------------------------------------------

function fakeDoc() {
  const mk = (tag) => ({ tag, className: '', title: '', textContent: '', style: {}, dataset: {}, children: [], alt: '', src: '', listeners: {}, addEventListener(n, f) { this.listeners[n] = f; }, getContext: () => ({ drawImage() {} }), appendChild(c) { this.children.push(c); } });
  return { createElement: mk };
}
const PM = require('../app/portrait-media-display');

test('stillNode: images off or no portrait is the initials placeholder', () => {
  const n = L.stillNode(fakeDoc(), { agent: 'a', images: false, portrait: { kind: 'placeholder', initials: 'AB', hue: 120 } }, PM);
  assert.strictEqual(n.className, 'face-media face-placeholder');
  assert.strictEqual(n.textContent, 'AB');
});

test('stillNode: a jpg is an <img>; a gif/webp/png/svg is a canvas holding its first frame; a video is a canvas too, never a <video>', () => {
  const face = (p, media = 'image') => ({ agent: 'a', images: true, portrait: { kind: 'file', path: p, media, tier: 'forge' } });
  assert.strictEqual(L.stillNode(fakeDoc(), face('C:/p/a.jpg'), PM).tag, 'img');
  for (const p of ['C:/p/a.gif', 'C:/p/a.webp', 'C:/p/a.png', 'C:/p/a.svg']) {
    const n = L.stillNode(fakeDoc(), face(p), PM);
    assert.strictEqual(n.tag, 'canvas', p);
    assert.strictEqual(n.dataset.stillKind, 'image');
  }
  const v = L.stillNode(fakeDoc(), face('C:/p/a.webm', 'video'), PM);
  assert.strictEqual(v.tag, 'canvas');
  assert.strictEqual(v.dataset.stillKind, 'video');
});

test('Miguel S6: a video that never loads (no loadeddata, no error) is unloaded by a timeout, not left loading for ever', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unloaded = [];
  const video = { addEventListener() {}, muted: false, preload: '', set src(v) { this._src = v; }, pause() {}, removeAttribute() {}, load() {} };
  const doc = { createElement: (tag) => (tag === 'video' ? video : {}) };
  const c = { dataset: { stillSrc: 'file:///C:/p/a.webm', stillKind: 'video' }, getContext: () => ({}) };
  const pm = { unloadVideo: (v) => unloaded.push(v) };
  L.paintStill(doc, c, pm);
  assert.strictEqual(unloaded.length, 0);
  t.mock.timers.tick(10000);
  assert.deepStrictEqual(unloaded, [video]);
});
