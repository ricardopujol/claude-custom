'use strict';
/**
 * The typing gate for a review comment (BACKLOG #119 A3, app/top-bar-display.js planTyping kind `comment`): free text is allowed
 * behind the fixed prefix "In ", on one line, and nothing else gets through. Same stance as the `panel` kind next to it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { planTyping } = require('../app/top-bar-display');

const plan = (command, over = {}) => planTyping({ command, screen: 'ready', connected: true, kind: 'comment', ...over });
const DASH = String.fromCharCode(0x2014);

test('a one-line comment types, with the ordinary box rules (vim NORMAL gets an `i` first)', () => {
  const c = `In src/a.js:12 ${DASH} rename this`;
  const ok = plan(c);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.enterInsert, false);
  assert.ok(ok.keys.includes(c) || ok.keys.join('').includes(c));
  assert.strictEqual(plan(c, { screen: 'vim-normal' }).enterInsert, true);
});

test('what is not the comment shape is refused before a key is typed', () => {
  const bad = [
    'rename this', '/clear', '!rm -rf x', 'In', 'In ', 'in a:1 x', ' In a:1 x', 'In a:1 x ',
    'In a:1 — two\nlines', 'In a:1 — cr\rhere', 'In a:1 — bell\u0007', 'In a:1 — esc\u001b[2J', 'In a:1 — c1\u0085x',
    'In a:1 — ends with a backslash \\', `In a:1 ${DASH} ` + 'x'.repeat(2000), 'In a:1 x' + String.fromCharCode(0x2028) + 'y', 'In a:1 x' + String.fromCharCode(0x2029) + 'y',
    '', null, undefined, 5, {},
  ];
  for (const c of bad) {
    const r = plan(c);
    assert.strictEqual(r.ok, false, JSON.stringify(c));
  }
  assert.strictEqual(plan('rename this').reason, 'not a single-line review comment');
});

test('the comment kind does not widen the other kinds: the same text is refused as a slash command and as a mention', () => {
  const c = `In a:1 ${DASH} x`;
  assert.strictEqual(planTyping({ command: c, screen: 'ready', connected: true, kind: undefined }).ok, false);
  assert.strictEqual(planTyping({ command: c, screen: 'ready', connected: true, kind: 'mention' }).ok, false);
  assert.strictEqual(planTyping({ command: c, screen: 'ready', connected: true, kind: 'panel' }).ok, false);
});

test('a dialog, a multi-line draft, an unknown screen or a closed socket still stop it', () => {
  const c = `In a:1 ${DASH} x`;
  assert.strictEqual(plan(c, { screen: 'dialog' }).ok, false);
  assert.strictEqual(plan(c, { screen: 'multiline' }).ok, false);
  assert.strictEqual(plan(c, { screen: 'unknown' }).ok, false);
  assert.strictEqual(plan(c, { connected: false }).reason, 'not connected to the session');
});

test('the length limit is exactly the one the composer uses', () => {
  const { MAX_STACK_CHARS } = require('../app/changes-compare');
  const at = 'In a:1 x'.padEnd(MAX_STACK_CHARS, 'y');
  assert.strictEqual(at.length, MAX_STACK_CHARS);
  assert.strictEqual(plan(at).ok, true);
  assert.strictEqual(plan(at + 'y').ok, false);
});

test('PROPERTY: whatever the composer builds, the gate accepts; whatever has a control character, it refuses', () => {
  const { commentText, stackText } = require('../app/changes-compare');
  fc.assert(fc.property(
    fc.string({ minLength: 1, maxLength: 30, unit: 'binary' }).filter(p => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(p)),
    fc.integer({ min: 1, max: 100000 }),
    fc.array(fc.string({ unit: 'binary', maxLength: 80 }), { minLength: 1, maxLength: 4 }),
    (p, line, texts) => {
      const made = texts.map(t => commentText(p, line, t)).filter(r => r.ok).map(r => r.text);
      if (!made.length) return;
      const s = stackText(made);
      if (s.ok) assert.strictEqual(plan(s.text).ok, true, JSON.stringify(s.text));
    },
  ));
  fc.assert(fc.property(fc.string({ maxLength: 20 }), fc.constantFrom('\n', '\r', '\u0000', '\u001b', '\u007f', '\u009f'), fc.string({ maxLength: 20 }),
    (a, ctl, b) => { assert.strictEqual(plan(`In x:1 ${a}${ctl}${b}`).ok, false); }));
});
