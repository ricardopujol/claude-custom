'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createTerminalState } = require('../host/terminal-state');

const flush = () => new Promise(r => setTimeout(r, 30));

test('replays written text to a fresh client', async () => {
  const s = createTerminalState({ cols: 40, rows: 10 });
  s.write('hello world');
  await flush();
  assert.ok(s.serialize().includes('hello world'));
  s.dispose();
});

test('replay reproduces the CURRENT screen, not the raw byte log', async () => {
  // The point of replaying terminal STATE rather than a byte buffer: a screen
  // cleared and redrawn must come back as the redraw, not as both.
  const s = createTerminalState({ cols: 40, rows: 10 });
  s.write('FIRST DRAW');
  s.write('\x1b[2J\x1b[H');          // clear screen, home cursor
  s.write('SECOND DRAW');
  await flush();
  const out = s.serialize();
  assert.ok(out.includes('SECOND DRAW'), 'current screen missing');
  assert.ok(!out.includes('FIRST DRAW'), 'stale frame leaked into replay');
  s.dispose();
});

test('preserves colour so the replayed screen is not monochrome', async () => {
  const s = createTerminalState({ cols: 40, rows: 10 });
  s.write('\x1b[31mRED\x1b[0m');
  await flush();
  assert.ok(/\x1b\[/.test(s.serialize()), 'no escape sequences in replay');
  s.dispose();
});

test('tracks unicode width at version 11', async () => {
  // Ink positions box-drawing by computed character width. A Unicode 6 table
  // measures emoji differently and shreds the TUI subtly.
  const s = createTerminalState({ cols: 40, rows: 10 });
  assert.strictEqual(s.unicodeVersion(), '11');
  s.dispose();
});

test('resize is reflected in the replayed state', async () => {
  const s = createTerminalState({ cols: 40, rows: 10 });
  s.resize(100, 30);
  assert.deepStrictEqual(s.size(), { cols: 100, rows: 30 });
  s.dispose();
});

test('survives a resize without losing the visible screen', async () => {
  const s = createTerminalState({ cols: 80, rows: 24 });
  s.write('KEEP ME');
  await flush();
  s.resize(100, 30);
  await flush();
  assert.ok(s.serialize().includes('KEEP ME'));
  s.dispose();
});

test('keeps a bounded scrollback rather than growing without limit', async () => {
  // The host is long-lived; an unbounded buffer is a slow memory leak.
  const s = createTerminalState({ cols: 40, rows: 10, scrollback: 50 });
  for (let i = 0; i < 500; i++) s.write(`line ${i}\r\n`);
  await flush();
  const lines = s.serialize().split('\n');
  assert.ok(lines.length <= 80, `replay grew to ${lines.length} lines`);
  assert.ok(s.serialize().includes('line 499'), 'newest output missing');
  s.dispose();
});
