'use strict';
/**
 * app/occupancy-confirm.js (backlog #47): the first-keystroke confirm in a worktree an agent is writing in.
 * Nothing is made read-only: the first keystroke typed during an agent's run is held behind "An agent is
 * writing here. Type anyway?", *Type* releases it (and doesn't ask again for that run), *Wait* drops it.
 * The terminal's own replies (focus, mouse, cursor reports) are not typing and always pass.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createConfirm, isKeystroke, HOLD_MAX } = require('../app/occupancy-confirm');

const here = (...ids) => ids.map(agentId => ({ agentId, agent: 'electron-pro' }));

function rig() {
  const r = { sent: [], states: [] };
  r.c = createConfirm({ send: (d) => r.sent.push(d), onChange: (s) => r.states.push(s) });
  return r;
}

test('no live claim: every keystroke goes straight through and nothing is ever asked', () => {
  const r = rig();
  assert.strictEqual(r.c.input('a'), 'sent');
  assert.deepStrictEqual(r.sent, ['a']);
  assert.strictEqual(r.c.state().asking, false);
  assert.strictEqual(r.c.type(), false, 'nothing to release');
  assert.strictEqual(r.c.wait(), false);
});

test('a live claim: the first keystroke is HELD and the question opens', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  assert.strictEqual(r.c.input('x'), 'held');
  assert.deepStrictEqual(r.sent, []);
  assert.strictEqual(r.c.state().asking, true);
});

test('Type releases the held keystroke exactly once, and the run is not asked again', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x');
  assert.strictEqual(r.c.type(), true);
  assert.deepStrictEqual(r.sent, ['x']);
  assert.strictEqual(r.c.type(), false, 'a second Type has nothing to release');
  assert.deepStrictEqual(r.sent, ['x']);
  assert.strictEqual(r.c.input('y'), 'sent');
  assert.strictEqual(r.c.input('z'), 'sent');
  assert.deepStrictEqual(r.sent, ['x', 'y', 'z']);
  assert.strictEqual(r.c.state().asking, false);
});

test('Wait drops the held keystroke, and the next keystroke asks again (a Wait is not remembered)', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x');
  assert.strictEqual(r.c.wait(), true);
  assert.deepStrictEqual(r.sent, []);
  assert.strictEqual(r.c.state().asking, false);
  assert.strictEqual(r.c.input('y'), 'held');
  assert.strictEqual(r.c.state().asking, true);
});

test('what is typed while the question is open is held with it, in order, and released on Type', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  assert.strictEqual(r.c.input('h'), 'held');
  assert.strictEqual(r.c.input('i'), 'held');
  r.c.type();
  assert.deepStrictEqual(r.sent, ['h', 'i'], 'each piece released once, in order, never glued (a paste is its own frame)');
});

test('...and dropped together on Wait', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('h'); r.c.input('i');
  r.c.wait();
  assert.deepStrictEqual(r.sent, []);
});

test('the hold is bounded: past HOLD_MAX characters the rest is dropped, never queued without limit', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x'.repeat(HOLD_MAX));
  assert.strictEqual(r.c.input('y'), 'dropped');
  r.c.type();
  assert.strictEqual(r.sent.join('').length, HOLD_MAX);
});

// --- PR #96 review: Dexter F4, Miguel Y1 + Y2 ------------------------------------------------------------

test('a paste is ONE piece, held whole and released intact on Type (a 5 KB control frame, not 256 characters of it)', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  const frame = JSON.stringify({ type: 'input', data: '\u001b[200~' + 'p'.repeat(5000) + '\u001b[201~' });
  assert.strictEqual(r.c.input(frame), 'held');
  assert.strictEqual(r.c.state().asking, true);
  assert.deepStrictEqual(r.sent, []);
  r.c.type();
  assert.deepStrictEqual(r.sent, [frame]);
});

test('the FIRST piece is always held, however long: the question never opens over nothing', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  const huge = 'y'.repeat(HOLD_MAX + 1);
  assert.strictEqual(r.c.input(huge), 'held');
  r.c.type();
  assert.deepStrictEqual(r.sent, [huge]);
});

test('once the hold has overflowed, everything after it is dropped too: Type never sends a spliced input', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('f');
  assert.strictEqual(r.c.input('x'.repeat(HOLD_MAX)), 'dropped', 'does not fit');
  assert.strictEqual(r.c.input('b'), 'dropped', 'would fit, but what came before it is gone');
  r.c.type();
  assert.deepStrictEqual(r.sent, ['f'], 'what was typed before the overflow, in order, and nothing after');
  // answered: the latch is gone with the question
  r.c.setClaims(here('a1', 'a2'));
  assert.strictEqual(r.c.input('z'), 'held');
});

test('Ctrl+C with nothing held goes straight through and asks nothing: stopping your own session writes nothing', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  assert.strictEqual(r.c.input('\x03'), 'sent');
  assert.deepStrictEqual(r.sent, ['\x03']);
  assert.strictEqual(r.c.state().asking, false);
  // ...but it approves nothing: the next key still asks
  assert.strictEqual(r.c.input('a'), 'held');
  // and once the question is open it is typing like the rest (it is not an answer)
  assert.strictEqual(r.c.input('\x03'), 'held');
  r.c.type();
  assert.deepStrictEqual(r.sent, ['\x03', 'a', '\x03']);
});

test('Enter while the question is open is Type: what was held is released, the Enter itself is not sent', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('f');
  r.c.input('i');
  assert.strictEqual(r.c.input('\r'), 'dropped');
  assert.deepStrictEqual(r.sent, ['f', 'i'], 'the person presses Enter again to submit: nothing is sent to the CLI unseen');
  assert.strictEqual(r.c.state().asking, false);
  assert.strictEqual(r.c.input('x'), 'sent', 'approved for this run, like the Type button');
});

test('Enter as the FIRST key of an unconfirmed run is held like any key', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  assert.strictEqual(r.c.input('\r'), 'held');
  assert.strictEqual(r.c.state().asking, true);
  r.c.wait();
  assert.deepStrictEqual(r.sent, []);
});

test('Escape while the question is open is Wait (and is itself not sent)', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x');
  assert.strictEqual(r.c.input('\x1b'), 'dropped');
  assert.deepStrictEqual(r.sent, []);
  assert.strictEqual(r.c.state().asking, false);
});

test('Escape as the FIRST key of an unconfirmed run is held like any key (it may be the person\'s Esc to the CLI)', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  assert.strictEqual(r.c.input('\x1b'), 'held');
  r.c.type();
  assert.deepStrictEqual(r.sent, ['\x1b']);
});

test('a second agent arriving is a NEW run: asked again even after Type; one that is still there is not', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x'); r.c.type();
  r.c.setClaims(here('a1'));
  assert.strictEqual(r.c.input('y'), 'sent');
  r.c.setClaims(here('a1', 'b2'));
  assert.strictEqual(r.c.input('z'), 'held');
  r.c.type();
  assert.strictEqual(r.c.input('w'), 'sent');
});

test('an agent that ends and comes back (the same id resumed) is a new run', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x'); r.c.type();
  r.c.setClaims([]);
  r.c.setClaims(here('a1'));
  assert.strictEqual(r.c.input('y'), 'held');
});

test('the agent finishing while the question is open closes it and releases what was held (nothing is in the way now)', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x');
  r.c.setClaims([]);
  assert.deepStrictEqual(r.sent, ['x']);
  assert.strictEqual(r.c.state().asking, false);
});

test('the agents changing while the question is open keeps it open (it is still someone\'s folder)', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x');
  r.c.setClaims(here('b2'));
  assert.strictEqual(r.c.state().asking, true);
  assert.deepStrictEqual(r.sent, []);
  r.c.type();
  assert.deepStrictEqual(r.sent, ['x']);
});

test('the terminal\'s own replies pass through untouched, even while the question is open', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  for (const reply of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[Mabc', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b]11;rgb:0000/0000/0000\x07', '\x1bP1$r0m\x1b\\']) {
    assert.strictEqual(r.c.input(reply), 'sent', JSON.stringify(reply));
  }
  assert.strictEqual(r.c.state().asking, false, 'and they never open the question');
  r.c.input('x');
  assert.strictEqual(r.c.input('\x1b[I'), 'sent');
  assert.strictEqual(r.c.state().asking, true);
});

test('isKeystroke: typing, Enter, arrows, Ctrl keys and Esc are keystrokes; protocol replies and nothing are not', () => {
  for (const k of ['a', ' ', '\r', '\x7f', '\x03', '\x1b', '\x1b[A', '\x1b[1;5C', '\x1b[3~', '\x1b\r', '\x1b[Z', '\x1bP', '\x1b]', '\x1bb', 'hello', 'é']) {
    assert.strictEqual(isKeystroke(k), true, JSON.stringify(k));
  }
  for (const n of ['', null, undefined, 5, {}, '\x1b[I', '\x1b[O']) assert.strictEqual(isKeystroke(n), false, String(n));
});

test('claims that aren\'t a list, or have no agentId, are no claim', () => {
  const r = rig();
  r.c.setClaims('nope');
  assert.strictEqual(r.c.input('a'), 'sent');
  r.c.setClaims([null, {}, { agentId: '' }, { agentId: 5 }]);
  assert.strictEqual(r.c.input('b'), 'sent');
});

test('onChange is told when the question opens and when it closes, and a throwing listener is harmless', () => {
  const r = rig();
  r.c.setClaims(here('a1'));
  r.c.input('x');
  r.c.type();
  assert.deepStrictEqual(r.states.map(s => s.asking), [true, false]);
  const t = createConfirm({ send: () => {}, onChange: () => { throw new Error('ui'); } });
  t.setClaims(here('a1'));
  assert.doesNotThrow(() => t.input('x'));
});

test('a send that throws never loses the verdict: the key is released once and the confirm carries on', () => {
  let n = 0;
  const c = createConfirm({ send: () => { n += 1; throw new Error('socket'); } });
  c.setClaims(here('a1'));
  c.input('x');
  assert.doesNotThrow(() => c.type());
  assert.strictEqual(n, 1);
  assert.strictEqual(c.state().asking, false);
});

test('PROPERTY: a held key is released at most once and only ever by Type; Wait and finishing never invent one', () => {
  const op = fc.oneof(
    fc.constant({ k: 'claim1' }), fc.constant({ k: 'claim2' }), fc.constant({ k: 'none' }),
    fc.constant({ k: 'type' }), fc.constant({ k: 'wait' }),
    fc.string({ minLength: 1, maxLength: 3 }).filter(isKeystroke).map(s => ({ k: 'key', s })));
  fc.assert(fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
    const sent = [];
    const typed = [];
    const c = createConfirm({ send: d => sent.push(d) });
    for (const o of ops) {
      if (o.k === 'claim1') c.setClaims(here('a1'));
      else if (o.k === 'claim2') c.setClaims(here('a1', 'b2'));
      else if (o.k === 'none') c.setClaims([]);
      else if (o.k === 'type') c.type();
      else if (o.k === 'wait') c.wait();
      else { typed.push(o.s); c.input(o.s); }
    }
    // everything released was typed, in order, and never more than once: the sent text is a subsequence of what was typed
    const all = typed.join('');
    let at = 0;
    for (const piece of sent) {
      const i = all.indexOf(piece, at);
      assert.ok(i !== -1, `released ${JSON.stringify(piece)} that was never typed (or twice)`);
      at = i + piece.length;
    }
    return true;
  }), { numRuns: 400 });
});

test('PROPERTY: with no live claim nothing is ever held or dropped', () => {
  fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 20 }), (keys) => {
    const sent = [];
    const c = createConfirm({ send: d => sent.push(d) });
    for (const k of keys) assert.strictEqual(c.input(k), 'sent');
    assert.deepStrictEqual(sent, keys);
    return true;
  }), { numRuns: 100 });
});
