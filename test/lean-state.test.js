'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { createLean } = require('../app/lean-state');

const NIGHT = 1_700_000_000_000;

test('starts normal', () => {
  assert.deepStrictEqual(createLean().view(), { on: false, byBedtime: false, bedtimeSince: null, night: false });
});

test('the button turns it on by hand and off again', () => {
  const l = createLean();
  assert.strictEqual(l.setByHand(true), true);
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: false, bedtimeSince: null, night: false });
  assert.strictEqual(l.setByHand(true), false, 'nothing changed');
  assert.strictEqual(l.setByHand(false), true);
  assert.strictEqual(l.view().on, false);
});

test('a night starting turns it on, remembering which night did', () => {
  const l = createLean();
  assert.strictEqual(l.nightStarted('a', NIGHT), true);
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: true, bedtimeSince: NIGHT, night: true });
});

test('the night ending turns it off when the night turned it on', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  assert.strictEqual(l.nightEnded('a'), true);
  assert.deepStrictEqual(l.view(), { on: false, byBedtime: false, bedtimeSince: null, night: false });
});

test('a night starting while it was already on by hand leaves it by hand, and the night ending leaves it on', () => {
  const l = createLean();
  l.setByHand(true);
  assert.strictEqual(l.nightStarted('a', NIGHT), true, 'only the night flag changed: still a change to tell the pages');
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: false, bedtimeSince: null, night: true });
  assert.strictEqual(l.nightEnded('a'), true);
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: false, bedtimeSince: null, night: false });
  assert.strictEqual(l.view().on, true);
});

test('the button always wins: Back to normal during a night stays normal, and the same night reported again does not undo it', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  l.setByHand(false);
  assert.strictEqual(l.view().on, false);
  assert.strictEqual(l.nightStarted('a', NIGHT), false, 'the same night, said again');
  assert.strictEqual(l.view().on, false);
  l.nightEnded('a');
  assert.strictEqual(l.view().on, false);
});

test('a NEW night after Back to normal turns it on again', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  l.setByHand(false);
  l.nightEnded('a');
  assert.strictEqual(l.nightStarted('a', NIGHT + 86_400_000), true);
  assert.strictEqual(l.view().on, true);
});

test('the button on while a night turned it on takes it over: the night ending no longer turns it off', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  assert.strictEqual(l.setByHand(true), true, 'the view changed: no longer "by bedtime"');
  assert.deepStrictEqual(l.view(), { on: true, byBedtime: false, bedtimeSince: null, night: true });
  l.nightEnded('a');
  assert.strictEqual(l.view().on, true);
});

test('two tabs with nights: it ends only when the last night ends', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  assert.strictEqual(l.nightStarted('b', NIGHT + 60_000), false, 'already on by bedtime');
  assert.strictEqual(l.nightEnded('a'), false);
  assert.strictEqual(l.view().on, true);
  assert.strictEqual(l.nightEnded('b'), true);
  assert.strictEqual(l.view().on, false);
});

test('an end nobody started changes nothing', () => {
  const l = createLean();
  assert.strictEqual(l.nightEnded('zzz'), false);
  l.setByHand(true);
  assert.strictEqual(l.nightEnded('zzz'), false);
  assert.strictEqual(l.view().on, true);
});

test('a malformed start (not a finite number) is ignored, never a night', () => {
  const l = createLean();
  for (const bad of [null, undefined, NaN, Infinity, '1700', {}]) assert.strictEqual(l.nightStarted('a', bad), false);
  assert.strictEqual(l.view().on, false);
});

test('a night restarting under the same tab replaces the old one (one night per tab)', () => {
  const l = createLean();
  l.nightStarted('a', NIGHT);
  l.nightStarted('a', NIGHT + 1000);
  assert.strictEqual(l.nightEnded('a'), true, 'one end closes the tab\'s only night');
  assert.strictEqual(l.view().on, false);
});

test('Dexter F2: a night dismissed by Back to normal stays dismissed when a NEW view (a reopened tab, a reload) reports the same night', () => {
  const l = createLean();
  l.nightStarted(1, NIGHT);
  l.setByHand(false);
  assert.strictEqual(l.nightStarted(2, NIGHT), false);
  assert.strictEqual(l.view().on, false);
});

test('Dexter F2: the dismissal survives a restart: it is handed out and comes back in', () => {
  const saved = [];
  const a = createLean({ onDismissed: (list) => saved.push(list) });
  a.nightStarted(1, NIGHT);
  a.setByHand(false);
  assert.deepStrictEqual(saved, [[NIGHT]]);
  const b = createLean({ dismissed: saved[0] });          // main restarted; every tab's hello reports the night again
  b.nightStarted(7, NIGHT);
  assert.strictEqual(b.view().on, false);
  assert.strictEqual(b.nightStarted(7, NIGHT + 1), true, 'a different night asks again');
});

test('Dexter F2: the dismissal is written once per night, and only when the button turned a lean off', () => {
  const saved = [];
  const l = createLean({ onDismissed: (list) => saved.push(list) });
  l.setByHand(true); l.setByHand(false);                  // no night going
  l.nightStarted(1, NIGHT);                                // on already (by hand? no: off after the above, so the night turns it on)
  l.setByHand(false); l.setByHand(false);
  assert.deepStrictEqual(saved, [[NIGHT]]);
});

test('Dexter F3: a night that went quiet and was REVIVED (same start) gets its lean back', () => {
  const l = createLean();
  l.nightStarted(1, NIGHT);
  assert.strictEqual(l.nightEnded(1), true, 'the host said "no night": overdue wake');
  assert.strictEqual(l.nightStarted(1, NIGHT), true, 'the late wake revived the same night');
  assert.strictEqual(l.view().on, true);
});

test('Dexter F3 (contrast): a night the person dismissed is not revived into lean', () => {
  const l = createLean();
  l.nightStarted(1, NIGHT);
  l.setByHand(false);
  l.nightEnded(1);
  l.nightStarted(1, NIGHT);
  assert.strictEqual(l.view().on, false);
});

// A reference model written as a plain table of rules (Miguel M1): the state machine must agree with it after EVERY operation.
function model() {
  const m = { on: false, owned: false, nights: new Map(), dismissed: new Set() };
  return {
    on: () => m.on,
    hand(next) {
      if (!next && m.on) for (const at of m.nights.values()) m.dismissed.add(at);
      m.on = next; m.owned = false;
    },
    start(tab, at) {
      m.nights.set(tab, at);
      if (m.dismissed.has(at) || m.on) return;
      m.on = true; m.owned = true;
    },
    end(tab) {
      if (!m.nights.delete(tab)) return;
      if (m.nights.size === 0 && m.on && m.owned) { m.on = false; m.owned = false; }
    },
  };
}

test('property: after every operation the state machine agrees with the reference model (button wins, night starts only if off, end only if owned and last, dismissals stick)', () => {
  const op = fc.oneof(
    fc.record({ t: fc.constant('hand'), on: fc.boolean() }),
    fc.record({ t: fc.constant('start'), tab: fc.constantFrom('a', 'b'), at: fc.integer({ min: 1, max: 4 }) }),
    fc.record({ t: fc.constant('end'), tab: fc.constantFrom('a', 'b') }),
  );
  fc.assert(fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
    const l = createLean();
    const m = model();
    for (const o of ops) {
      if (o.t === 'hand') { l.setByHand(o.on); m.hand(o.on); }
      else if (o.t === 'start') { l.nightStarted(o.tab, o.at); m.start(o.tab, o.at); }
      else { l.nightEnded(o.tab); m.end(o.tab); }
      const v = l.view();
      assert.strictEqual(v.on, m.on(), JSON.stringify(o));
      if (!v.on) assert.deepStrictEqual([v.byBedtime, v.bedtimeSince], [false, null]);
      if (v.byBedtime) assert.strictEqual(typeof v.bedtimeSince, 'number');
    }
  }));
});

const { unionDismissed } = require('../app/lean-state');

test('Dexter N3: two mains write the dismissed list through a union, so neither erases the other\'s nights', () => {
  assert.deepStrictEqual(unionDismissed([1], [2]), [1, 2]);
  assert.deepStrictEqual(unionDismissed([1, 2], [2, 3]), [1, 2, 3]);
  assert.deepStrictEqual(unionDismissed(undefined, [5]), [5]);
  assert.deepStrictEqual(unionDismissed([1, 'x', NaN], null), [1]);
  const many = Array.from({ length: 80 }, (_, i) => i + 1);
  assert.strictEqual(unionDismissed(many, [999]).length, 50);
  assert.strictEqual(unionDismissed(many, [999]).at(-1), 999, 'the newest survive the cap');
});

test('Ricardo video rule: the view says a night is going in ANY tab, whoever turned lean on; a change of only that flag is a change to push, a second tab changes nothing', () => {
  const l = createLean();
  l.setByHand(true);
  assert.strictEqual(l.view().night, false);
  assert.strictEqual(l.nightStarted('a', NIGHT), true);
  assert.strictEqual(l.view().night, true);
  assert.strictEqual(l.nightStarted('b', NIGHT + 1), false);
  assert.strictEqual(l.nightEnded('a'), false, 'b is still going');
  assert.strictEqual(l.view().night, true);
  assert.strictEqual(l.nightEnded('b'), true);
  assert.strictEqual(l.view().night, false);
});
