'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const L = require('../app/lean-display');

// --- normalize / chip --------------------------------------------------------------

test('normalize: only a real true is on; the night fields belong to bedtime only', () => {
  assert.deepStrictEqual(L.normalize(null), { on: false, byBedtime: false, bedtimeSince: null });
  assert.deepStrictEqual(L.normalize({ on: 'yes' }), { on: false, byBedtime: false, bedtimeSince: null });
  assert.deepStrictEqual(L.normalize({ on: true }), { on: true, byBedtime: false, bedtimeSince: null });
  assert.deepStrictEqual(L.normalize({ on: true, byBedtime: true, bedtimeSince: 5 }), { on: true, byBedtime: true, bedtimeSince: 5 });
  assert.deepStrictEqual(L.normalize({ on: true, byBedtime: true, bedtimeSince: NaN }), { on: true, byBedtime: false, bedtimeSince: null },
    'a night with no believable start is not shown as one');
  assert.deepStrictEqual(L.normalize({ on: false, byBedtime: true, bedtimeSince: 5 }), { on: false, byBedtime: false, bedtimeSince: null });
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
