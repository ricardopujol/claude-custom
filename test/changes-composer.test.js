'use strict';
/**
 * THE COMPOSER IS NEVER DESTRUCTIVE (BACKLOG #119 A3, PR #199 Dexter r2 N1-N3). A review comment is added at the END of the line this feature typed,
 * with no clear, when the screen says the box holds exactly that line; nothing sends Ctrl-U to a box that may hold a comment of ours. The CLI is
 * modelled by test/cli-box-sim.js on what was MEASURED (verify/probe-ctrl-u-wrapped.js): Ctrl-U kills only the last wrapped row.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { planCommentTyping, boxIsCommand, appendKeys, commandTyped } = require('../app/top-bar-display');
const { commentText } = require('../app/changes-compare');
const { createBox } = require('./cli-box-sim');

const DASH = String.fromCharCode(0x2014);
const line = (n, t) => commentText('src/app.js', n, t).text;
const A = line(3, 'rename this');
const B = line(9, 'guard null');

// one Enter on a comment, the way the renderer runs it: plan from the screen, then send the keys; true read-back or STOP (no cleanup of any kind)
function enter(sim, state, text, { termRows = 40 } = {}) {
  const plan = planCommentTyping({ lines: sim.screen(), last: state.last, text, vim: sim.vim, termRows, connected: true });
  if (!plan.ok) return { ok: false, reason: plan.reason, plan };
  if (plan.mode === 'fresh') {
    sim.pressAll(plan.keys);
    if (!boxIsCommand(sim.screen(), plan.command, { termRows })) return { ok: false, reason: 'read-back', plan };
    state.last = plan.command;
    return { ok: true, plan };
  }
  sim.pressAll(plan.keys);
  if (!boxIsCommand(sim.screen(), plan.expected, { termRows })) return { ok: false, reason: 'read-back', plan };
  state.last = plan.expected;
  return { ok: true, plan };
}

test('MEASURED premise: Ctrl-U on a wrapped line kills only its last row, so clear-and-retype is no clear (verify/probe-ctrl-u-wrapped.js)', () => {
  const sim = createBox({ cols: 80, box: 'x'.repeat(150) });
  sim.pressAll(['\x05', '\x15']);
  assert.strictEqual(sim.box.length, 156 - 78 - 78 > 0 ? 156 - 78 - 78 : 78, 'a row is left');
  assert.ok(sim.box.length > 0);
});

test('DEXTER 1 pinned: Enter on line 3, then Enter on line 9: the box holds BOTH, and the second Enter sent no Ctrl-U at all', () => {
  const sim = createBox();
  const st = { last: '' };
  assert.strictEqual(enter(sim, st, A).ok, true);
  assert.strictEqual(sim.box, A);
  sim.keys.length = 0;
  const second = enter(sim, st, B);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.plan.mode, 'append');
  assert.strictEqual(sim.box, `${A}; ${B}`);
  assert.ok(!sim.keys.includes('\x15'), 'nothing was cleared');
  assert.strictEqual(sim.ctrlU, 1, 'only the first, fresh typing cleared (an empty box)');
});

test('N1 pinned: a 150-character comment A at 80 columns wraps over 3 rows; adding B keeps ALL of A (the clear path would have left a row of it)', () => {
  const long = commentText('src/app.js', 4, 'w'.repeat(150 - 'In src/app.js:4 — '.length)).text;
  assert.strictEqual(long.length, 150);
  const sim = createBox({ cols: 80 });
  const st = { last: '' };
  assert.strictEqual(enter(sim, st, long).ok, true);
  assert.ok(sim.screen().length >= 5, 'wrapped over several rows');
  sim.keys.length = 0;
  const r = enter(sim, st, B);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(sim.box, `${long}; ${B}`);
  assert.ok(!sim.keys.includes('\x15'));
  // what the OLD path did to the same box, with the measured Ctrl-U: a row of A survives, mangled
  const old = createBox({ cols: 80, box: long });
  old.pressAll(['\x05', '\x15', `${long}; ${B}`]);
  assert.notStrictEqual(old.box, `${long}; ${B}`);
});

test('N2 pinned: vim latched, A typed, Esc (NORMAL): the box is still recognised as ours, and B is added with `A` first, not replacing it', () => {
  const sim = createBox({ vim: true, insert: true });
  const st = { last: '' };
  assert.strictEqual(enter(sim, st, A).ok, true);
  sim.esc();
  assert.strictEqual(sim.insert, false);
  assert.strictEqual(commandTyped(sim.screen(), A, { vim: true }), false, 'the Enter check says no in NORMAL: that is not the question');
  assert.strictEqual(boxIsCommand(sim.screen(), A), true, 'but the text is there');
  const r = enter(sim, st, B);
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(r.plan.keys.slice(0, 2), ['A', '\x05']);
  assert.strictEqual(sim.box, `${A}; ${B}`);
});

test('N2: a foreign draft in vim NORMAL is replaced the ordinary way (`i` first); nothing of ours was in the box', () => {
  const sim = createBox({ vim: true, insert: false, box: 'my draft' });
  const st = { last: '' };
  const r = enter(sim, st, A);
  assert.strictEqual(r.plan.mode, 'fresh');
  assert.strictEqual(r.plan.keys[0], 'i');
  assert.strictEqual(sim.box, A);
});

test('N3 pinned: the box is not exactly what was typed (an edit, a key pressed meanwhile): the composer REFUSES and sends nothing, so A is never cleared', () => {
  const sim = createBox();
  const st = { last: '' };
  enter(sim, st, A);
  sim.press('!');                              // the person typed into the box
  sim.keys.length = 0;
  const r = enter(sim, st, B);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /Nothing was changed/);
  assert.deepStrictEqual(sim.keys, [], 'not one key was sent');
  assert.strictEqual(sim.box, `${A}!`);
});

test('N3 pinned: a read-back that fails AFTER an append sends no cleanup: the plan has no Ctrl-U and nothing follows it', () => {
  const sim = createBox();
  const st = { last: '' };
  enter(sim, st, A);
  const plan = planCommentTyping({ lines: sim.screen(), last: st.last, text: B, vim: false, termRows: 40, connected: true });
  assert.ok(!plan.keys.includes('\x15') && !plan.keys.includes('\x03') && !plan.keys.includes('\x1b'));
  sim.pressAll(plan.keys);
  sim.press('x');                              // a late keystroke before the read-back
  assert.strictEqual(boxIsCommand(sim.screen(), plan.expected), false, 'the read-back fails');
  assert.strictEqual(sim.box, `${A}; ${B}x`, 'and the box is left exactly as it is: both comments are in it');
});

test('a box that LOOKS like our comment but is not exactly it is refused even with no `last` (a redraw lag must never get it cleared)', () => {
  const sim = createBox({ box: `In src/app.js:3 ${DASH} half drawn` });
  const r = planCommentTyping({ lines: sim.screen(), last: '', text: B, vim: false, termRows: 40, connected: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /Nothing was changed/);
});

test('a foreign draft or an empty box: typed fresh, the ordinary way (a draft is replaced, and the page says Ctrl+Y)', () => {
  for (const box of ['', 'my draft']) {
    const sim = createBox({ box });
    const r = enter(sim, { last: '' }, A);
    assert.strictEqual(r.plan.mode, 'fresh');
    assert.strictEqual(sim.box, A);
  }
});

test('the person sent the comment (the box is empty again): the next one starts fresh, it does not bring the sent one back', () => {
  const sim = createBox();
  const st = { last: '' };
  enter(sim, st, A);
  sim.box = '';
  enter(sim, st, B);
  assert.strictEqual(sim.box, B);
});

test('the append stops at the typing limit with a reason that names what to do, and types nothing', () => {
  const sim = createBox({ box: '' });
  const big = commentText('src/app.js', 1, 'q'.repeat(1900)).text;
  const st = { last: '' };
  enter(sim, st, big);
  sim.keys.length = 0;
  const r = enter(sim, st, commentText('src/app.js', 2, 'z'.repeat(200)).text);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /full/);
  assert.deepStrictEqual(sim.keys, []);
});

test('appendKeys: Ctrl-E and the text, `A` first only in vim NORMAL, never Ctrl-U; a long suffix goes in chunks', () => {
  assert.deepStrictEqual(appendKeys('; x', false), ['\x05', '; x']);
  assert.deepStrictEqual(appendKeys('; x', true), ['A', '\x05', '; x']);
  const keys = appendKeys('y'.repeat(450), false);
  assert.strictEqual(keys[0], '\x05');
  assert.ok(keys.length > 2 && keys.slice(1).join('') === 'y'.repeat(450));
  assert.ok(!keys.includes('\x15'));
});

test('PROPERTY: any run of comments typed one after another leaves exactly their stack in the box, and only the very first typing ever clears', () => {
  fc.assert(fc.property(
    fc.array(fc.tuple(fc.integer({ min: 1, max: 999 }), fc.string({ minLength: 1, maxLength: 25 })), { minLength: 1, maxLength: 5 }),
    fc.constantFrom(40, 80, 120),
    fc.boolean(),
    (items, cols, vim) => {
      const lines = items.map(([n, t]) => commentText('src/app.js', n, t)).filter(r => r.ok).map(r => r.text);
      const sim = createBox({ cols, vim, insert: true });
      const st = { last: '' };
      let want = '';
      for (const l of lines) {
        const r = enter(sim, st, l, { termRows: 200 });
        if (!r.ok) { assert.match(r.reason, /full/); return; }
        want = want ? `${want}; ${l}` : l;
        if (vim && sim.keys.length) sim.esc();       // the person presses Esc between comments
        assert.strictEqual(sim.box, want);
      }
      assert.ok(sim.ctrlU <= 1);
    },
  ));
});
