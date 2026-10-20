'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createTerminalState } = require('../host/terminal-state');

// xterm parses writes asynchronously. A fixed sleep guessed how long that takes
// and lost the race under full-suite load; an empty write's callback fires when
// everything queued before it has been parsed, so this waits on the event.
const flush = (s) => new Promise(r => s.write('', r));

test('replays written text to a fresh client', async () => {
  const s = createTerminalState({ cols: 40, rows: 10 });
  s.write('hello world');
  await flush(s);
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
  await flush(s);
  const out = s.serialize();
  assert.ok(out.includes('SECOND DRAW'), 'current screen missing');
  assert.ok(!out.includes('FIRST DRAW'), 'stale frame leaked into replay');
  s.dispose();
});

test('preserves colour so the replayed screen is not monochrome', async () => {
  const s = createTerminalState({ cols: 40, rows: 10 });
  s.write('\x1b[31mRED\x1b[0m');
  await flush(s);
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
  await flush(s);
  s.resize(100, 30);
  await flush(s);
  assert.ok(s.serialize().includes('KEEP ME'));
  s.dispose();
});

test('keeps a bounded scrollback rather than growing without limit', async () => {
  // The host is long-lived; an unbounded buffer is a slow memory leak.
  const s = createTerminalState({ cols: 40, rows: 10, scrollback: 50 });
  for (let i = 0; i < 500; i++) s.write(`line ${i}\r\n`);
  await flush(s);
  const lines = s.serialize().split('\n');
  assert.ok(lines.length <= 80, `replay grew to ${lines.length} lines`);
  assert.ok(s.serialize().includes('line 499'), 'newest output missing');
  s.dispose();
});

test('exposes plain text rows, free of escape sequences', async () => {
  // serialize() is for REPLAY and deliberately carries ANSI. Parsing it is
  // fragile: a colour change mid-phrase splits the text and a regex that should
  // match silently does not. Anything reading the screen wants plain rows.
  const s = createTerminalState({ cols: 60, rows: 8 });
  s.write('\x1b[33mbypass \x1b[1mpermissions\x1b[0m on');
  await flush(s);
  const rows = s.lines();
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some(r => r.includes('bypass permissions on')),
    `escape codes leaked into ${JSON.stringify(rows.filter(Boolean))}`);
  assert.ok(!rows.join('').includes('\x1b'), 'escape sequence present in plain rows');
  s.dispose();
});

test('plain rows come from the VIEWPORT, not the top of scrollback', async () => {
  // buffer.active.getLine(y) is indexed from the start of history, so once
  // anything has scrolled, y=0 is ancient output rather than the current
  // screen. Reading the permission mode that way returned the banner forever.
  const s = createTerminalState({ cols: 40, rows: 6, scrollback: 200 });
  for (let i = 0; i < 60; i++) s.write(`old line ${i}\r\n`);
  s.write('CURRENT STATUS LINE');
  await flush(s);
  const rows = s.lines();
  assert.ok(rows.some(r => r.includes('CURRENT STATUS LINE')), JSON.stringify(rows));
  assert.ok(!rows.some(r => r.includes('old line 0')), 'scrollback leaked into the viewport');
  s.dispose();
});

// --- OSC 7501 (Program Status Protocol): the host hears it here -----------------------------------------------

test('an OSC 7501 payload reaches the handler, with either terminator, in stream order', async () => {
  const seen = [];
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: (d) => seen.push(d) });
  s.write('\x1b]7501;?\x07\x1b]7501;state=working:id=a/b\x1b\\');
  await flush(s);
  assert.deepStrictEqual(seen, ['?', 'state=working:id=a/b']);
  s.dispose();
});

test('a 7501 sequence prints nothing on the screen', async () => {
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: () => {} });
  s.write('ab\x1b]7501;state=done\x07cd');
  await flush(s);
  assert.strictEqual(s.lines()[0], 'abcd');
  s.dispose();
});

test('the handler runs DURING the parse, before the write callback of the same chunk', async () => {
  // This is what lets the host answer the query before anything that follows it in the stream.
  const order = [];
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: () => order.push('handler') });
  await new Promise(r => s.write('\x1b]7501;?\x07\x1b[c', () => { order.push('parsed'); r(); }));
  assert.deepStrictEqual(order, ['handler', 'parsed']);
  s.dispose();
});

test('OSC 133 A (a new prompt) calls onPromptStart, B/C/D do not', async () => {
  let n = 0;
  const s = createTerminalState({ cols: 40, rows: 10, onPromptStart: () => { n++; } });
  s.write('\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07');
  await flush(s);
  assert.strictEqual(n, 0);
  s.write('\x1b]133;A\x07\x1b]133;A;k=i\x07');
  await flush(s);
  assert.strictEqual(n, 2);
  s.dispose();
});

test('RIS (ESC c) calls onReset and still resets the screen; DECSTR (CSI ! p) does not call it', async () => {
  let n = 0;
  const s = createTerminalState({ cols: 40, rows: 10, onReset: () => { n++; } });
  s.write('hello');
  s.write('\x1b[!p');
  await flush(s);
  assert.strictEqual(n, 0);
  s.write('\x1bc');
  await flush(s);
  assert.strictEqual(n, 1);
  assert.strictEqual(s.lines()[0], '');
  s.dispose();
});

test('a handler that throws does not stop the stream', async () => {
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: () => { throw new Error('boom'); } });
  s.write('\x1b]7501;?\x07after');
  await flush(s);
  assert.strictEqual(s.lines()[0], 'after');
  s.dispose();
});

test('without the options the terminal behaves as before', async () => {
  const s = createTerminalState({ cols: 40, rows: 10 });
  s.write('\x1b]7501;?\x07\x1b]133;A\x07\x1bcok');
  await flush(s);
  assert.strictEqual(s.lines()[0], 'ok');
  s.dispose();
});

// --- the terminal's own answers (DA1, cursor position...): the host sends them on when no window is there to ---

test('onResponse gets what the terminal itself answers, and after the 7501 handler of the same chunk', async () => {
  const order = [];
  const s = createTerminalState({
    cols: 40, rows: 10,
    onProgramStatus: () => order.push('7501'),
    onResponse: (d) => order.push(d),
  });
  await new Promise(r => s.write('\x1b]7501;?\x07\x1b[c', r));
  assert.deepStrictEqual(order, ['7501', '\x1b[?1;2c']);
  s.dispose();
});

test('onResponse: a cursor position report is answered too, and a throwing listener does not stop the stream', async () => {
  const got = [];
  const s = createTerminalState({ cols: 40, rows: 10, onResponse: (d) => { got.push(d); throw new Error('boom'); } });
  s.write('ab\x1b[6ncd');
  await flush(s);
  assert.deepStrictEqual(got, ['\x1b[1;3R']);
  assert.strictEqual(s.lines()[0], 'abcd');
  s.dispose();
});
