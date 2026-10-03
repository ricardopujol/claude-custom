'use strict';
/**
 * `planTyping` with kind 'mention' (#32): the same screen checks as Type /merged (a dialog, a multi-line
 * draft, no box: nothing typed), and a different shape check for the line that is typed.
 */
const test = require('node:test');
const assert = require('node:assert');
const { planTyping, commandTyped } = require('../app/top-bar-display');

const plan = (command, screen = 'ready', extra = {}) => planTyping({ command, screen, connected: true, kind: 'mention', ...extra });

test('an @ mention of a file, with or without a line range, is typable', () => {
  for (const c of ['@src/app.js', '@a.js#L7', '@src/a.js#L40-60', '@docs/café.md']) {
    const p = plan(c);
    assert.strictEqual(p.ok, true, c);
    assert.deepStrictEqual(p.keys, ['\x05', '\x15', c]);
  }
});

test('anything that is not one @ mention is refused: other text, a slash command, a CR, a space, a second mention', () => {
  for (const c of ['src/app.js', '/merged', '@a.js\r', '@a b.js', '@a.js @b.js', '@', '@a.js#L0', '@a.js#Lx', '@a.js#L1-', '@a.js\n/exit', '']) {
    const p = plan(c);
    assert.strictEqual(p.ok, false, JSON.stringify(c));
    assert.match(p.reason, /@ mention/);
  }
});

test('the default kind is still a slash command only: an @ mention is not one', () => {
  assert.strictEqual(planTyping({ command: '@a.js', screen: 'ready', connected: true }).ok, false);
  assert.strictEqual(planTyping({ command: '/merged', screen: 'ready', connected: true }).ok, true);
});

test('a slash command is not a mention', () => {
  assert.strictEqual(plan('/merged').ok, false);
});

test('the screen is judged exactly as for Type /merged: dialog, multi-line draft and no box type nothing', () => {
  assert.match(plan('@a.js', 'dialog').reason, /dialog/);
  assert.match(plan('@a.js', 'multiline').reason, /several lines/);
  assert.match(plan('@a.js', 'unknown').reason, /input box/);
});

test('in vim NORMAL an i goes first, so the mention lands as text', () => {
  assert.deepStrictEqual(plan('@a.js', 'vim-normal').keys, ['i', '\x05', '\x15', '@a.js']);
});

test('not connected types nothing', () => {
  assert.match(planTyping({ command: '@a.js', screen: 'ready', connected: false, kind: 'mention' }).reason, /not connected/);
});

test('the read-back accepts exactly `❯ @path#Lx-y` in the live box', () => {
  const rule = '─'.repeat(40);
  const screen = (line) => ['', rule, line, rule, '  footer'];
  assert.strictEqual(commandTyped(screen('❯ @src/a.js#L4-9'), '@src/a.js#L4-9'), true);
  assert.strictEqual(commandTyped(screen('❯ @src/a.js#L4-9 and more'), '@src/a.js#L4-9'), false);
  assert.strictEqual(commandTyped(screen('❯ earlier draft @src/a.js#L4-9'), '@src/a.js#L4-9'), false);
});
