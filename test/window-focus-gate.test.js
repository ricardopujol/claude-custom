'use strict';
/**
 * host/window-focus.js, the review fixes of PR #247: the owner's gate (it says no while quitting or past its start bound),
 * the idle timeout on a connection, send() trusting only { ok: true }, and the validation bounds pinned at their edges.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const load = () => require('../host/window-focus');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);

function raw(pid, line, { end = true } = {}) {
  const { pipeNameFor } = load();
  return new Promise((resolve) => {
    const s = net.connect(pipeNameFor(pid));
    let buf = '';
    s.on('data', d => { buf += d; });
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
    s.write(end ? line + '\n' : line);
  });
}
const answerOf = (text) => { try { return JSON.parse(text.split('\n')[0]); } catch { return null; } };

// ---- the gate ----------------------------------------------------------------------------------------------------

test('accepting() false: the launch is answered not-ok, onFocus is never called', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  let heard = 0;
  let open = true;
  const server = await listen({ pid, onFocus: async () => { heard++; }, accepting: () => open });
  try {
    assert.deepStrictEqual(await send({ pid, msg: {} }), { ok: true });
    open = false;
    const r = await send({ pid, msg: {} });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /closing/);
    await new Promise(res => setTimeout(res, 80));
    assert.strictEqual(heard, 1, 'only the launch accepted while open reached onFocus');
  } finally { await server.close(); }
});

test('no accepting() given: always open (the old behaviour)', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: async () => {} });
  try { assert.deepStrictEqual(await send({ pid, msg: {} }), { ok: true }); } finally { await server.close(); }
});

test('an accepting() that throws counts as closed, never as a crash', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: async () => {}, accepting: () => { throw new Error('boom'); } });
  try { assert.strictEqual((await send({ pid, msg: {} })).ok, false); } finally { await server.close(); }
});

// ---- the idle timeout --------------------------------------------------------------------------------------------

test('a connection that never finishes a line is dropped after the idle time', async () => {
  const { listen, pipeNameFor } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: async () => {}, idleMs: 150 });
  try {
    const closedAt = await new Promise((resolve) => {
      const t0 = Date.now();
      const s = net.connect(pipeNameFor(pid));
      s.on('connect', () => s.write('{"type":"foc'));
      s.on('close', () => resolve(Date.now() - t0));
      s.on('error', () => {});
      setTimeout(() => { s.destroy(); resolve(-1); }, 3000);
    });
    assert.ok(closedAt >= 100 && closedAt < 2500, `closed after ${closedAt} ms`);
  } finally { await server.close(); }
});

// ---- send() trusts { ok: true } only -----------------------------------------------------------------------------

async function sendToFake(reply) {
  const { send, pipeNameFor } = load();
  const pid = uniquePid();
  const srv = net.createServer((s) => { s.on('error', () => {}); s.on('data', () => s.end(reply)); });
  await new Promise(r => srv.listen(pipeNameFor(pid), r));
  try { return await send({ pid, msg: {}, timeoutMs: 1000 }); } finally { await new Promise(r => srv.close(r)); }
}

test('send: null, an array, a string, a truthy non-true ok and a missing ok are all NOT accepted, and nothing throws', async () => {
  for (const reply of ['null\n', '[]\n', '"ok"\n', '7\n', '{"ok":"x"}\n', '{"ok":1}\n', '{}\n']) {
    const r = await sendToFake(reply);
    assert.strictEqual(r.ok, false, reply);
    assert.strictEqual(typeof r.error, 'string', reply);
  }
});

test('send: { ok: true } is accepted, { ok: false, error } keeps its reason', async () => {
  assert.deepStrictEqual(await sendToFake('{"ok":true}\n'), { ok: true });
  assert.deepStrictEqual(await sendToFake('{"ok":false,"error":"closing"}\n'), { ok: false, error: 'closing' });
});

// ---- the bounds, at their edges ----------------------------------------------------------------------------------

test('cwd: 1024 characters are heard, 1025 are refused as a bad request (not as a long line)', async () => {
  const { listen } = load();
  const pid = uniquePid();
  const heard = [];
  const server = await listen({ pid, onFocus: async (m) => { heard.push(m); } });
  try {
    assert.deepStrictEqual(answerOf(await raw(pid, JSON.stringify({ type: 'focus', cwd: 'x'.repeat(1024) }))), { ok: true });
    for (const n of [1025, 3000]) {
      const a = answerOf(await raw(pid, JSON.stringify({ type: 'focus', cwd: 'x'.repeat(n) })));
      assert.deepStrictEqual(a, { ok: false, error: 'not a focus request' }, `cwd ${n}`);
    }
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(heard.length, 1);
  } finally { await server.close(); }
});

test('a line longer than 4096 with no newline is cut off as too long', async () => {
  const { listen } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: async () => {} });
  try {
    assert.deepStrictEqual(answerOf(await raw(pid, 'x'.repeat(5000), { end: false })), { ok: false, error: 'too long' });
  } finally { await server.close(); }
});

test('port: 1 and 65535 are heard; 0, -1, 65536, 1.5 and a string are refused', async () => {
  const { listen } = load();
  const pid = uniquePid();
  const heard = [];
  const server = await listen({ pid, onFocus: async (m) => { heard.push(m.port); } });
  try {
    for (const p of [1, 65535]) assert.deepStrictEqual(answerOf(await raw(pid, JSON.stringify({ type: 'focus', port: p }))), { ok: true }, String(p));
    for (const p of [0, -1, 65536, 1.5, '7000', null]) {
      assert.deepStrictEqual(answerOf(await raw(pid, JSON.stringify({ type: 'focus', port: p }))), { ok: false, error: 'not a focus request' }, String(p));
    }
    await new Promise(r => setTimeout(r, 80));
    assert.deepStrictEqual(heard, [1, 65535]);
  } finally { await server.close(); }
});

test('cleanMessage: only type focus, a bounded cwd and a port are kept; anything else is dropped', () => {
  const { cleanMessage } = load();
  assert.deepStrictEqual(cleanMessage({ type: 'focus', cwd: 'C:\\p', port: 7001, extra: 'x', __proto__: { y: 1 } }), { cwd: 'C:\\p', port: 7001 });
  assert.deepStrictEqual(cleanMessage({ type: 'focus' }), {});
  for (const bad of [null, [], 'focus', { type: 'Focus' }, { type: 'focus', cwd: 5 }]) assert.strictEqual(cleanMessage(bad), null);
});
