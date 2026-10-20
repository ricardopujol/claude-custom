'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { createOscGuard } = require('../host/osc-guard');
const { createTerminalState } = require('../host/terminal-state');

const flush = (s) => new Promise(r => s.write('', r));

async function applied(chunks) {
  const seen = [];
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: (d) => seen.push(d) });
  for (const c of chunks) s.write(c);
  await flush(s);
  s.dispose();
  return seen;
}

// Through the REAL parser: what the handler is given is what xterm cleaned, and the guard says whether to apply it.
test('a clean report, BEL or ESC \\ terminated, is applied', async () => {
  assert.deepStrictEqual(await applied(['\x1b]7501;state=done\x07', '\x1b]7501;state=idle\x1b\\']), ['state=done', 'state=idle']);
});

test('a C0 byte inside the report discards it whole (xterm would have dropped the byte and applied the rest)', async () => {
  assert.deepStrictEqual(await applied(['\x1b]7501;state=blo\x01cked\x07']), []);
  assert.deepStrictEqual(await applied(['\x1b]7501;state=bl\x08ocked\x1b\\']), []);
  assert.deepStrictEqual(await applied(['\x1b]7501;state=blocked\x7f\x07']), []);
  assert.deepStrictEqual(await applied(['\x1b]7501;state=blocked\x00\x07']), []);
});

test('a report ended by a bare ESC (not ESC \\) is discarded whole, and what follows still works', async () => {
  assert.deepStrictEqual(await applied(['\x1b]7501;state=done\x1b[0m']), []);
  assert.deepStrictEqual(await applied(['\x1b]7501;state=done:msg=SGVs\x1b[0m', '\x1b]7501;state=idle\x07']), ['state=idle']);
});

test('a C1 ST (0x9c) ends it wrongly: discarded; CAN, SUB and other C1 codes abort it: nothing to apply', async () => {
  assert.deepStrictEqual(await applied(['\x1b]7501;state=done\u009c']), []);
  assert.deepStrictEqual(await applied(['\x1b]7501;state=done\x18', '\x1b]7501;state=idle\x07']), ['state=idle']);
  assert.deepStrictEqual(await applied(['\x1b]7501;state=done\x1a', '\x1b]7501;state=idle\x07']), ['state=idle']);
  assert.deepStrictEqual(await applied(['\x1b]7501;state=done\u0085', '\x1b]7501;state=idle\x07']), ['state=idle']);
});

test('other OSC sequences around it do not confuse it', async () => {
  assert.deepStrictEqual(await applied(['\x1b]0;a title\x07\x1b]7501;state=done\x07\x1b]8;;http://x\x1b\link\x1b]8;;\x1b\\', '\x1b]7501;state=idle\x07']), ['state=done', 'state=idle']);
});

test('a query is guarded the same way', async () => {
  assert.deepStrictEqual(await applied(['\x1b]7501;?\x07', '\x1b]7501;?\x01\x07']), ['?']);
});

test('the guard fails closed: a payload it never saw is not applied', () => {
  const g = createOscGuard();
  const took = (payload) => { let n = 0; g.take(payload, () => n++); return n; };
  assert.strictEqual(took('state=done'), 0);
  g.scan('\x1b]7501;state=done\x07');
  assert.strictEqual(took('state=other'), 0);
  assert.strictEqual(took('state=done'), 1);
  assert.strictEqual(took('state=done'), 0, 'one record, one use');
});

test('a very long dirty report cannot grow memory without bound and is not applied', () => {
  const g = createOscGuard();
  g.scan('\x1b]7501;' + 'a'.repeat(50000) + '\x07');
  let n = 0;
  g.take('a'.repeat(8192), () => n++);
  assert.strictEqual(n, 0);
});

// N5: xterm ends the string AT the ESC and runs the handler; the byte after it may not have arrived. Parse between the chunks.
test('N5: a report split at its ESC, parsed in between, is applied once the backslash arrives', async () => {
  const seen = [];
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: (d) => seen.push(d) });
  s.write('\x1b]7501;state=blocked\x1b');
  await flush(s);
  assert.deepStrictEqual(seen, [], 'not before the verdict is known');
  s.write('\\');
  await flush(s);
  assert.deepStrictEqual(seen, ['state=blocked']);
  s.dispose();
});

test('N5: a report split at its ESC whose next byte is not a backslash is discarded, and does not poison the next identical one', async () => {
  const seen = [];
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: (d) => seen.push(d) });
  s.write('\x1b]7501;state=blocked\x1b');
  await flush(s);
  s.write('[0m');
  await flush(s);
  assert.deepStrictEqual(seen, []);
  s.write('\x1b]7501;state=blocked\x07');
  await flush(s);
  assert.deepStrictEqual(seen, ['state=blocked']);
  s.dispose();
});

test('N5: a clean split report followed by a dirty identical one applies only the first', async () => {
  const seen = [];
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: (d) => seen.push(d) });
  s.write('\x1b]7501;state=blocked\x1b');
  await flush(s);
  s.write('\\');
  await flush(s);
  s.write('\x1b]7501;state=blocked\x1b[0m');
  await flush(s);
  assert.deepStrictEqual(seen, ['state=blocked']);
  s.dispose();
});

const piece = fc.constantFrom(
  '\x1b]7501;state=done\x07', '\x1b]7501;state=idle\x1b\\', '\x1b]7501;state=blo\x01cked\x07', '\x1b]7501;state=done\x1b[0m',
  '\x1b]7501;state=working\x18', '\x1b]0;t\x07', 'plain text', '\x1b[31m', '\x1b]7501;?\x07', '\x1b]7501;state=error\u009c');

async function appliedFlushing(chunks) {
  const seen = [];
  const s = createTerminalState({ cols: 40, rows: 10, onProgramStatus: (d) => seen.push(d) });
  for (const c of chunks) { s.write(c); await flush(s); }          // parsed as each chunk arrives, like the real pty
  s.dispose();
  return seen;
}

test('property: where the stream is cut into chunks never changes which reports are applied (all written first, or parsed as they arrive)', async () => {
  await fc.assert(fc.asyncProperty(fc.array(piece, { maxLength: 8 }), fc.array(fc.integer({ min: 1, max: 9 }), { maxLength: 6 }), async (pieces, cuts) => {
    const text = pieces.join('');
    const whole = await applied([text]);
    const chunks = [];
    let at = 0;
    for (const c of cuts) { if (at >= text.length) break; chunks.push(text.slice(at, at + c)); at += c; }
    if (at < text.length) chunks.push(text.slice(at));
    assert.deepStrictEqual(await applied(chunks), whole);
    assert.deepStrictEqual(await appliedFlushing(chunks), whole);
  }), { numRuns: 200 });
});

test('property: only clean sequences are ever applied', async () => {
  await fc.assert(fc.asyncProperty(fc.array(piece, { maxLength: 8 }), async (pieces) => {
    const got = await applied([pieces.join('')]);
    const clean = pieces.filter(p => p === '\x1b]7501;state=done\x07' || p === '\x1b]7501;state=idle\x1b\\' || p === '\x1b]7501;?\x07').length;
    assert.strictEqual(got.length, clean);
  }), { numRuns: 150 });
});
