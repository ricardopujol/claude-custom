'use strict';
/**
 * `planTyping` with kind 'panel' (BACKLOG #71, PR 2): the one line a button in Claude's panel types into the prompt,
 * `(from Claude's panel) <text>`. The same screen checks as Type /merged and @ mentions (a dialog, a multi-line draft, no box:
 * nothing typed), and its own shape check for the line.
 *
 * Why a new kind and not a slash command: the wand types `/skill args`, and planTyping refuses anything else, because a CR or a
 * control key in the line would submit or edit something other than what was shown. A panel's text is free text. It is allowed
 * only behind the fixed prefix (so the CLI cannot read it as a slash command or a `!` shell line), on one line, with no control
 * or C1 character, and capped, so the read-back before the Enter can still prove the box holds exactly what was typed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { planTyping, commandTyped } = require('../app/top-bar-display');
const { sessionLine } = require('../app/canvas-display');

const plan = (command, screen = 'ready', extra = {}) => planTyping({ command, screen, connected: true, kind: 'panel', ...extra });
const PREFIX = "(from Claude's panel) ";

test("a panel's line is typable: the prefix, then one line of text", () => {
  for (const c of [`${PREFIX}hello`, `${PREFIX}what's the weather in Santiago?`, `${PREFIX}/clear`, `${PREFIX}!rm -rf`, `${PREFIX}café ☃`, `${PREFIX}a`]) {
    const p = plan(c);
    assert.strictEqual(p.ok, true, c);
    assert.deepStrictEqual(p.keys, ['\x05', '\x15', c]);
  }
});

test('a text that looks like a slash command or a shell line is harmless behind the prefix, and the prefix is required', () => {
  for (const c of ['/clear', '!ls', 'hello', '(from Claude\'s panel)', "(from claude's panel) x", ` ${PREFIX}x`, '(from Claude\'s panel)x', '', null, undefined, 42]) {
    const p = plan(c);
    assert.strictEqual(p.ok, false, JSON.stringify(c));
    assert.match(p.reason, /single-line message from Claude's panel/);
  }
});

test('a CR, a newline, a control key or a C1 character anywhere in it is refused', () => {
  for (const bad of ['a\rb', 'a\nb', 'a\x1bb', 'a\x7fb', 'a\u0085b', 'a\u009bb', 'a\x00b', 'a\tb', `x\r`]) {
    assert.strictEqual(plan(PREFIX + bad).ok, false, JSON.stringify(bad));
  }
});

test('the length is capped, and exactly at the cap is fine', () => {
  assert.strictEqual(plan(PREFIX + 'x'.repeat(2000)).ok, true);
  assert.strictEqual(plan(PREFIX + 'x'.repeat(2001)).ok, false);
  assert.strictEqual(plan(PREFIX).ok, false, 'an empty message is not a message');
});

test('the line canvasDisplay builds is always one planTyping accepts, and what planTyping accepts is what it builds', () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.constantFrom('hello', 'a\nb', '  x  ', '/x', '\u0085')), (text) => {
    const line = sessionLine(text);
    if (line !== null) assert.strictEqual(plan(line).ok, true, JSON.stringify(line));
    if (plan(PREFIX + String(text)).ok) assert.notStrictEqual(sessionLine(text), null);
  }), { numRuns: 500 });
});

test('the other kinds are untouched: a panel line is not a slash command or a mention, and they are not panel lines', () => {
  assert.strictEqual(planTyping({ command: `${PREFIX}hi`, screen: 'ready', connected: true }).ok, false);
  assert.strictEqual(planTyping({ command: `${PREFIX}hi`, screen: 'ready', connected: true, kind: 'mention' }).ok, false);
  assert.strictEqual(plan('/merged').ok, false);
  assert.strictEqual(plan('@a.js').ok, false);
  assert.strictEqual(planTyping({ command: '/merged', screen: 'ready', connected: true }).ok, true);
});

test('the screen is judged exactly as for Type /merged: dialog, multi-line draft and no box type nothing', () => {
  assert.match(plan(`${PREFIX}x`, 'dialog').reason, /dialog/);
  assert.match(plan(`${PREFIX}x`, 'multiline').reason, /several lines/);
  assert.match(plan(`${PREFIX}x`, 'unknown').reason, /input box/);
  assert.match(planTyping({ command: `${PREFIX}x`, screen: 'ready', connected: false, kind: 'panel' }).reason, /not connected/);
});

test('in vim NORMAL an i goes first, so the line lands as text', () => {
  assert.deepStrictEqual(plan(`${PREFIX}x`, 'vim-normal').keys, ['i', '\x05', '\x15', `${PREFIX}x`]);
});

test('the read-back accepts exactly `❯ (from Claude\'s panel) <text>` in the live box', () => {
  const rule = '─'.repeat(40);
  const screen = (line) => ['', rule, line, rule, '  footer'];
  const text = `${PREFIX}hello there`;
  assert.strictEqual(commandTyped(screen(`❯ ${text}`), text), true);
  assert.strictEqual(commandTyped(screen(`❯ ${text} and more`), text), false);
  assert.strictEqual(commandTyped(screen(`❯ earlier draft ${text}`), text), false);
});
