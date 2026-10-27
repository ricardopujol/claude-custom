'use strict';
/**
 * host/program-status-host.js, by what it does, against the REAL headless terminal (host/terminal-state.js) and the real parse gate.
 * Replaces the source-regex wiring test: host.js only hands these methods to the terminal, the pty and the sockets.
 */
const test = require('node:test');
const assert = require('node:assert');

const { createProgramStatusHost } = require('../host/program-status-host');
const { createTerminalState } = require('../host/terminal-state');
const { QUERY_REPLY } = require('../host/program-status');

const DA1 = '\x1b[?1;2c';
const QUERY_AND_SENTINEL = '\x1b]7501;?\x07\x1b[c';

function rig({ window = false, hostAnswersQueries = true } = {}) {
  const state = { window };
  const pty = [];            // everything written to the pty, in order
  const sent = [];           // control frames broadcast
  const seen = [];           // snapshots handed to attention
  const host = createProgramStatusHost({
    writePty: (d) => pty.push(d),
    broadcast: (f) => sent.push(f),
    attention: { programStatus: (s) => seen.push(s) },
    windowAttached: () => state.window,
    hostAnswersQueries,
  });
  const term = createTerminalState({
    cols: 40, rows: 10,
    onProgramStatus: host.onOsc, onPromptStart: host.onPromptStart, onReset: host.onReset, onResponse: host.onResponse,
  });
  return {
    state, pty, sent, seen, host, term,
    chunk(text) { const cb = host.deliver(); term.write(text, cb); },        // as host.js does for each pty chunk
    parsed: () => new Promise(r => term.write('', r)),
    // the window's xterm answering what it was sent, straight back as input
    windowInput(data) { host.input(data, (d) => pty.push(d)); },
  };
}

test('the query is answered with the capability reply, inside the parse', async () => {
  const r = rig();
  r.chunk('\x1b]7501;?\x07');
  assert.deepStrictEqual(r.pty, [], 'nothing before the parse runs');
  await r.parsed();
  assert.deepStrictEqual(r.pty, [QUERY_REPLY]);
  r.term.dispose();
});

test('window attached: its DA1 answer, submitted at once, leaves AFTER the 7501 reply', async () => {
  const r = rig({ window: true });
  r.chunk(QUERY_AND_SENTINEL);
  r.windowInput(DA1);                                   // the window is faster than the host's parse
  assert.deepStrictEqual(r.pty, []);
  await r.parsed();
  assert.deepStrictEqual(r.pty, [QUERY_REPLY, DA1]);
  r.term.dispose();
});

test('no window: the host answers the sentinel itself, once, after the 7501 reply', async () => {
  const r = rig({ window: false });
  r.chunk(QUERY_AND_SENTINEL);
  await r.parsed();
  assert.deepStrictEqual(r.pty, [QUERY_REPLY, DA1]);
  r.term.dispose();
});

test('window attached when the chunk arrived: the host stays silent about the terminal\'s own queries', async () => {
  const r = rig({ window: true });
  r.chunk('\x1b[c\x1b[6n');
  await r.parsed();
  assert.deepStrictEqual(r.pty, []);
  r.term.dispose();
});

test('a window that attaches between delivery and parse: exactly one answer (the host\'s), it was never sent the bytes', async () => {
  const r = rig({ window: false });
  r.chunk(QUERY_AND_SENTINEL);
  r.state.window = true;                                 // attached before the parse runs
  await r.parsed();
  assert.deepStrictEqual(r.pty, [QUERY_REPLY, DA1]);
  r.term.dispose();
});

test('a window that leaves between delivery and parse: only its own answer, once, in order', async () => {
  const r = rig({ window: true });
  r.chunk(QUERY_AND_SENTINEL);
  r.windowInput(DA1);
  r.state.window = false;                                // gone before the parse runs
  await r.parsed();
  assert.deepStrictEqual(r.pty, [QUERY_REPLY, DA1]);
  r.term.dispose();
});

test('two chunks, the first seen by a window and the second not: each is answered by the right party', async () => {
  const r = rig({ window: true });
  r.chunk('\x1b[c');
  r.windowInput(DA1);                                    // the window answers the first the moment it arrives
  r.state.window = false;
  r.chunk('\x1b[6n');
  await r.parsed();
  assert.deepStrictEqual(r.pty, [DA1, '\x1b[1;1R']);
  r.term.dispose();
});

test('a backend that answers queries itself (the OS ConPTY): a windowless host adds nothing, the 7501 reply still goes', async () => {
  const r = rig({ window: false, hostAnswersQueries: false });
  r.chunk(QUERY_AND_SENTINEL);
  await r.parsed();
  assert.deepStrictEqual(r.pty, [QUERY_REPLY]);
  r.term.dispose();
});

test('typing is never held, and never overtakes a held answer', async () => {
  const r = rig({ window: true });
  r.windowInput('a');
  r.chunk(QUERY_AND_SENTINEL);
  r.windowInput(DA1);
  r.windowInput('b');
  assert.deepStrictEqual(r.pty, ['a']);
  await r.parsed();
  assert.deepStrictEqual(r.pty, ['a', QUERY_REPLY, DA1, 'b']);
  r.term.dispose();
});

test('a report is broadcast as a capped program-status frame and handed to attention; an unchanged one is not sent again', async () => {
  const r = rig();
  r.chunk('\x1b]7501;state=working\x07');
  r.chunk('\x1b]7501;state=working\x07');
  await r.parsed();
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.sent[0].type, 'program-status');
  assert.strictEqual(r.sent[0].root.state, 'working');
  assert.strictEqual(r.sent[0].childCount, 0);
  assert.strictEqual(r.seen.length, 1);
  assert.strictEqual(r.seen[0].live, true);
  r.chunk('\x1b]7501;state=done\x07');
  await r.parsed();
  assert.strictEqual(r.sent.length, 2);
  assert.strictEqual(r.seen.length, 2);
  r.term.dispose();
});

test('the first valid report flips live even when it changes no record (a clear on nothing)', async () => {
  const r = rig();
  assert.strictEqual(r.host.frame().live, false);
  r.chunk('\x1b]7501;state=clear\x07');
  await r.parsed();
  assert.strictEqual(r.host.frame().live, true);
  assert.strictEqual(r.sent.length, 1);
  r.term.dispose();
});

test('a frame holds the root and at most 32 children, whatever the CLI reported', async () => {
  const r = rig();
  for (let i = 0; i < 100; i++) r.chunk(`\x1b]7501;state=working:id=t${i}\x07`);
  await r.parsed();
  const last = r.sent[r.sent.length - 1];
  assert.strictEqual(last.children.length, 32);
  assert.strictEqual(last.childCount, 100);
  r.term.dispose();
});

test('a new prompt (OSC 133 A) drops working records and says so; RIS clears all', async () => {
  const r = rig();
  r.chunk('\x1b]7501;state=working\x07\x1b]7501;state=done:id=a\x07');
  await r.parsed();
  r.chunk('\x1b]133;A\x07');
  await r.parsed();
  let f = r.sent[r.sent.length - 1];
  assert.strictEqual(f.root, null);
  assert.strictEqual(f.children.length, 1);
  r.chunk('\x1bc');
  await r.parsed();
  f = r.sent[r.sent.length - 1];
  assert.deepStrictEqual(f.children, []);
  r.term.dispose();
});

test('discarded reports (unknown state, an unclean sequence) change and send nothing', async () => {
  const r = rig();
  r.chunk('\x1b]7501;state=nonsense\x07\x1b]7501;state=do\x01ne\x07\x1b]7501;state=done\x1b[0m');
  await r.parsed();
  assert.deepStrictEqual(r.sent, []);
  assert.deepStrictEqual(r.seen, []);
  r.term.dispose();
});

// --- PR #201 round 2, N6: a closing window gets no bytes, so it does not count as attached ---------------------------

const { windowAttachedAmong } = require('../host/program-status-host');

test('N6: only an OPEN window socket counts as attached; a control client or a closing socket does not', () => {
  const sock = (isWindow, readyState) => ({ isWindow, readyState });
  assert.strictEqual(windowAttachedAmong(new Set()), false);
  assert.strictEqual(windowAttachedAmong(new Set([sock(true, 1)])), true);
  assert.strictEqual(windowAttachedAmong(new Set([sock(true, 2)])), false, 'CLOSING');
  assert.strictEqual(windowAttachedAmong(new Set([sock(true, 3)])), false, 'CLOSED');
  assert.strictEqual(windowAttachedAmong(new Set([sock(true, 0)])), false, 'CONNECTING');
  assert.strictEqual(windowAttachedAmong(new Set([sock(false, 1)])), false, 'a one-shot control client');
  assert.strictEqual(windowAttachedAmong(new Set([sock(true, 2), sock(true, 1)])), true);
});

test('N6: with the only window closing, the host answers the query itself', async () => {
  const clients = new Set([{ isWindow: true, readyState: 2 }]);
  const pty = [];
  const host = createProgramStatusHost({ writePty: (d) => pty.push(d), broadcast: () => {}, attention: { programStatus() {} }, windowAttached: () => windowAttachedAmong(clients), hostAnswersQueries: true });
  const term = createTerminalState({ cols: 40, rows: 10, onProgramStatus: host.onOsc, onResponse: host.onResponse });
  term.write('\x1b[c', host.deliver());
  await new Promise(r => term.write('', r));
  assert.deepStrictEqual(pty, [DA1]);
  term.dispose();
});
