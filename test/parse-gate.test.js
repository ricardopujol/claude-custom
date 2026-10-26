'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createParseGate, isDa1Reply } = require('../host/parse-gate');
const { createTerminalState } = require('../host/terminal-state');
const { QUERY_REPLY } = require('../host/program-status');

test('isDa1Reply: device-attributes answers, nothing a person types', () => {
  for (const d of ['\x1b[?1;2c', '\x1b[?62;4c', '\x1b[>0;276;0c', '\x1b[c']) assert.strictEqual(isDa1Reply(d), true, JSON.stringify(d));
  for (const d of ['c', 'hello\r', '\x1b[A', '\x1b[?1;2c\x1b[A', '\x1b[1;5R', '', undefined, 5]) assert.strictEqual(isDa1Reply(d), false, JSON.stringify(d));
});

test('with nothing waiting to be parsed, everything goes straight through', () => {
  const g = createParseGate();
  const sent = [];
  g.submit('\x1b[?1;2c', d => sent.push(d));
  g.submit('x', d => sent.push(d));
  assert.deepStrictEqual(sent, ['\x1b[?1;2c', 'x']);
});

test('a DA1 answer waits for the parse of every chunk received before it', () => {
  const g = createParseGate();
  const sent = [];
  const parsed1 = g.track();
  const parsed2 = g.track();
  g.submit('\x1b[?1;2c', d => sent.push(d));
  assert.deepStrictEqual(sent, []);
  parsed1();
  assert.deepStrictEqual(sent, []);
  parsed2();
  assert.deepStrictEqual(sent, ['\x1b[?1;2c']);
});

test('a chunk received AFTER the answer arrived does not hold it up', () => {
  const g = createParseGate();
  const sent = [];
  const parsed1 = g.track();
  g.submit('\x1b[?1;2c', d => sent.push(d));
  const parsed2 = g.track();
  parsed1();
  assert.deepStrictEqual(sent, ['\x1b[?1;2c']);
  parsed2();
});

test('typing is not held while nothing is queued, but never overtakes a held answer', () => {
  const g = createParseGate();
  const sent = [];
  const parsed = g.track();
  g.submit('a', d => sent.push(d));                  // typing: straight through
  assert.deepStrictEqual(sent, ['a']);
  g.submit('\x1b[?1;2c', d => sent.push(d));         // held
  g.submit('b', d => sent.push(d));                  // behind it, order kept
  assert.deepStrictEqual(sent, ['a']);
  parsed();
  assert.deepStrictEqual(sent, ['a', '\x1b[?1;2c', 'b']);
});

test('a sender that throws does not strand the ones behind it', () => {
  const g = createParseGate();
  const sent = [];
  const parsed = g.track();
  g.submit('\x1b[?1;2c', () => { throw new Error('socket gone'); });
  g.submit('\x1b[?1;2c', d => sent.push(d));
  parsed();
  assert.deepStrictEqual(sent, ['\x1b[?1;2c']);
});

test('property: inputs leave in the order they arrived, and a DA1 answer never leaves before the chunks that preceded it were parsed', () => {
  const step = fc.constantFrom('chunk', 'parse', 'da1', 'key');
  fc.assert(fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
    const g = createParseGate();
    const sent = [];
    const callbacks = [];            // parse callbacks, fired by 'parse' in the order the chunks arrived (xterm's guarantee)
    let issued = 0, fired = 0, n = 0;
    const needs = new Map();
    for (const s of steps) {
      if (s === 'chunk') { callbacks.push(g.track()); issued++; }
      else if (s === 'parse') { if (fired < callbacks.length) { callbacks[fired++](); } }
      else {
        const label = n++;
        needs.set(label, issued);
        g.submit(s === 'da1' ? '\x1b[?1;2c' : 'k', () => sent.push({ label, firedAtSend: fired, isDa1: s === 'da1' }));
      }
    }
    while (fired < callbacks.length) callbacks[fired++]();
    const order = sent.map(x => x.label);
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
    assert.strictEqual(sent.length, n);                       // nothing is ever stranded once everything is parsed
    for (const x of sent) if (x.isDa1) assert.ok(x.firedAtSend >= needs.get(x.label), 'sent before its chunks were parsed');
  }), { numRuns: 300 });
});

// --- the whole rule, against a real headless parse ---------------------------------------------------------------

test('the 7501 answer is written to the pty before a DA1 answer that arrives right behind the query', async () => {
  const toPty = [];
  const gate = createParseGate();
  const term = createTerminalState({
    cols: 40, rows: 10,
    onProgramStatus: (d) => { if (d === '?') toPty.push(QUERY_REPLY); },
  });
  // the program's query + sentinel arrive as one chunk; the window's xterm answers DA1 immediately (a faster round trip than
  // the headless parse), so its answer is submitted before the host has parsed anything
  term.write('\x1b]7501;?\x07\x1b[c', gate.track());
  gate.submit('\x1b[?1;2c', d => toPty.push(d));
  assert.deepStrictEqual(toPty, [], 'nothing has been parsed yet, so nothing is answered');
  await new Promise(r => term.write('', r));
  assert.strictEqual(toPty[0], QUERY_REPLY);
  assert.strictEqual(toPty[1], '\x1b[?1;2c');
  assert.strictEqual(toPty.length, 2);
  term.dispose();
});
