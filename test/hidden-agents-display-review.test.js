'use strict';
/**
 * PR #66 review fixes for app/hidden-agents-display.js: Dexter F1, F4, F5 and
 * Miguel M3. Each test fails without its fix.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  hideButtonFor, rosterActionFromClick, repaintNeeded, HIDDEN_NAME_MAX, cleanNames,
} = require('../app/hidden-agents-display');
const { validRosterMsg } = require('../host/hidden-agents');

const row = (agent, state) => ({ agent, state });

test('Dexter F4: the offer matches what the host accepts, at the cap and just past it', () => {
  for (const n of [1, 200, 201, 500]) {
    const r = row('x'.repeat(n), 'sleeping');
    assert.strictEqual(hideButtonFor(r), validRosterMsg({ action: 'hide', agent: r.agent }), String(n));
  }
  assert.strictEqual(HIDDEN_NAME_MAX, 200);
});

test('cleanNames drops names over the cap and dedups', () => {
  assert.deepStrictEqual(cleanNames(['a', 'x'.repeat(201), 'a', 'x'.repeat(200)]), ['a', 'x'.repeat(200)]);
});

// A stand-in for the two DOM facts the click reader uses: closest() and dataset.
function el(cls, dataset, parent) {
  return {
    cls, parent, dataset: dataset || {},
    closest(sel) {
      for (let n = this; n; n = n.parent) if (n.cls === sel.slice(1)) return n;
      return null;
    },
  };
}

test('Dexter F5 / Miguel M3: a click on a hide button reads as {hide, agent}', () => {
  const card = el('agent', { agent: 'paris' });
  assert.deepStrictEqual(rosterActionFromClick(el('agent-hide', { rosterAction: 'hide' }, card)),
    { action: 'hide', agent: 'paris' });
});

test('an unhide button reads as unhide; any other value reads as hide, never a third action', () => {
  const card = el('agent', { agent: 'paris' });
  assert.deepStrictEqual(rosterActionFromClick(el('agent-hide', { rosterAction: 'unhide' }, card)),
    { action: 'unhide', agent: 'paris' });
  assert.strictEqual(rosterActionFromClick(el('agent-hide', { rosterAction: 'delete' }, card)).action, 'hide');
  assert.strictEqual(rosterActionFromClick(el('agent-hide', {}, card)).action, 'hide');
});

test('a click that is not on a hide button, or whose card has no name, reads as null', () => {
  const card = el('agent', { agent: 'paris' });
  assert.strictEqual(rosterActionFromClick(card), null);
  assert.strictEqual(rosterActionFromClick(el('face', {}, card)), null);
  assert.strictEqual(rosterActionFromClick(el('agent-hide', { rosterAction: 'hide' }, el('agent', {}))), null);
  assert.strictEqual(rosterActionFromClick(el('agent-hide', { rosterAction: 'hide' })), null);
  for (const t of [null, undefined, 5, 'x', {}]) assert.strictEqual(rosterActionFromClick(t), null);
});

test('Dexter F1: the roster is repainted only when the markup actually changed', () => {
  assert.strictEqual(repaintNeeded('<a>', '<a>'), false);
  assert.strictEqual(repaintNeeded('<a>', '<b>'), true);
  assert.strictEqual(repaintNeeded(null, '<a>'), true);
  assert.strictEqual(repaintNeeded(undefined, ''), true);
  assert.strictEqual(repaintNeeded('', ''), false);
  assert.strictEqual(repaintNeeded('<a>', 5), true);
});
