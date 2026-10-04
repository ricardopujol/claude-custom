'use strict';
/**
 * The fake document's own test (test/fake-dom.js): the tests of app/git-rings-display.js lean on it, many of them with
 * absence assertions ("no such node", "empty text"), so the harness must match what it claims to and REFUSE the selector
 * syntax it can't honour rather than quietly match nothing.
 */
const test = require('node:test');
const assert = require('node:assert');

const { makePanel, FakeDocument } = require('./fake-dom');

function tree() {
  const doc = new FakeDocument();
  const a = doc.createElement('div'); a.setAttribute('class', 'a x'); doc.root.appendChild(a);
  const b = doc.createElement('button'); b.setAttribute('class', 'b'); b.setAttribute('data-act', 'go'); b.setAttribute('id', 'the-b'); a.appendChild(b);
  const c = doc.createElementNS('http://www.w3.org/2000/svg', 'g'); c.setAttribute('class', 'c'); b.appendChild(c);
  return { doc, a, b, c };
}

test('selectors: tag, class, id, attribute presence and value, compounds and comma lists', () => {
  const { doc, a, b, c } = tree();
  assert.deepStrictEqual(doc.root.querySelectorAll('div'), [a]);
  assert.deepStrictEqual(doc.root.querySelectorAll('.a.x'), [a]);
  assert.deepStrictEqual(doc.root.querySelectorAll('.a.nope'), []);
  assert.deepStrictEqual(doc.root.querySelectorAll('#the-b'), [b]);
  assert.deepStrictEqual(doc.root.querySelectorAll('[data-act]'), [b]);
  assert.deepStrictEqual(doc.root.querySelectorAll('button[data-act="go"]'), [b]);
  assert.deepStrictEqual(doc.root.querySelectorAll('[data-act="stop"]'), []);
  assert.deepStrictEqual(doc.root.querySelectorAll('.c, .a'), [a, c], 'document order, either side of the comma');
  assert.strictEqual(doc.root.querySelector('.nope'), null);
  assert.strictEqual(a.querySelector('.a'), null, 'an element is not its own descendant');
});

test('selectors the harness cannot honour THROW instead of matching nothing', () => {
  const { doc, b } = tree();
  for (const bad of ['.a .b', '.a > .b', '.a + .b', '.a ~ .b', 'button:not(.x)', ':first-child', '.b::before', '[data-act=go]x y', "[data-act='go']", '*', '']) {
    assert.throws(() => doc.root.querySelectorAll(bad), /unsupported selector/, JSON.stringify(bad));
  }
  assert.throws(() => b.closest('.a .b'), /unsupported selector/);
  assert.throws(() => b.matches('.a:hover'), /unsupported selector/);
});

test('closest finds the element itself or the nearest ancestor, and null when none', () => {
  const { a, b, c } = tree();
  assert.strictEqual(c.closest('.c'), c);
  assert.strictEqual(c.closest('button'), b);
  assert.strictEqual(c.closest('.a'), a);
  assert.strictEqual(c.closest('.nope'), null);
});

test('events bubble from the target up to the root, in order, with the original target', () => {
  const { doc, a, b, c } = tree();
  const seen = [];
  for (const [name, n] of [['c', c], ['b', b], ['a', a], ['root', doc.root]]) n.addEventListener('ping', (e) => seen.push([name, e.target === c, e.currentTarget === n]));
  c.dispatch('ping');
  assert.deepStrictEqual(seen, [['c', true, true], ['b', true, true], ['a', true, true], ['root', true, true]]);
});

test('classList.toggle with and without force, add, remove, contains', () => {
  const { a } = tree();
  assert.strictEqual(a.classList.toggle('on'), true);
  assert.strictEqual(a.classList.contains('on'), true);
  assert.strictEqual(a.classList.toggle('on'), false);
  assert.strictEqual(a.classList.toggle('on', true), true);
  assert.strictEqual(a.classList.toggle('on', true), true);
  assert.strictEqual(a.classList.toggle('x', false), false);
  assert.strictEqual(a.getAttribute('class'), 'a on');
  a.classList.add('z'); a.classList.remove('a');
  assert.strictEqual(a.getAttribute('class'), 'on z');
});

test('textContent: set replaces the children, get joins them in order; hidden mirrors the attribute', () => {
  const { a, b } = tree();
  b.textContent = 'hello';
  assert.strictEqual(b.children.length, 0);
  assert.strictEqual(a.textContent, 'hello');
  const doc = a.ownerDocument;
  const s1 = doc.createElement('span'); s1.textContent = 'x';
  const s2 = doc.createElement('span'); s2.textContent = 'y';
  a.textContent = '';
  a.appendChild(s1); a.appendChild(s2);
  assert.strictEqual(a.textContent, 'xy');
  a.textContent = '';
  assert.strictEqual(a.children.length, 0);
  assert.strictEqual(s1.parentNode, null, 'a cleared child is detached');
  assert.strictEqual(a.hidden, false);
  a.hidden = true;
  assert.strictEqual(a.getAttribute('hidden'), '');
  a.hidden = false;
  assert.strictEqual(a.getAttribute('hidden'), null);
});

test('appendChild re-parents (the old parent lets go); contains and isConnected follow the tree; focus sets activeElement', () => {
  const { doc, a, b } = tree();
  const other = doc.createElement('div'); doc.root.appendChild(other);
  other.appendChild(b);
  assert.deepStrictEqual(a.children, []);
  assert.strictEqual(b.parentNode, other);
  assert.ok(other.contains(b) && !a.contains(b) && other.contains(other));
  assert.strictEqual(b.isConnected, true);
  other.parentNode.children = other.parentNode.children.filter(x => x !== other); other.parentNode = null;
  assert.strictEqual(b.isConnected, false);
  b.focus();
  assert.strictEqual(doc.activeElement, b);
});

test('makePanel gives a connected root with #git-status and #git-dial', () => {
  const p = makePanel();
  assert.strictEqual(p.rootEl.querySelector('#git-status'), p.status);
  assert.strictEqual(p.rootEl.querySelector('#git-dial'), p.dial);
  assert.strictEqual(p.dial.isConnected, true);
});
