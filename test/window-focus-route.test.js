'use strict';
/**
 * The listener of host/window-focus.js as the single-instance PR 3 needs it (step 1): it serves any name and message type, hands the cleaned
 * message to its gates, and acknowledges at once when the sender asks, so a launch can tell a hung owner from a slow one. The old one-line
 * protocol (no ack asked, exactly one line out) stays byte for byte for old senders and old owners. Real pipes.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const load = () => require('../host/window-focus');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};

// One raw exchange: write `line`, collect every byte until the server closes.
const exchange = (name, line, { waitMs = 2000 } = {}) => new Promise((resolve) => {
  const s = net.connect(name);
  let buf = '';
  const done = () => { clearTimeout(t); try { s.destroy(); } catch { /* gone */ } resolve(buf); };
  const t = setTimeout(done, waitMs);
  s.setEncoding('utf8');
  s.on('connect', () => s.write(line));
  s.on('data', (d) => { buf += d; });
  s.on('end', done);
  s.on('error', done);
});

test('appPipeNameFor: a second name, per pid, beside the window pipe', () => {
  const { appPipeNameFor, pipeNameFor } = load();
  assert.strictEqual(appPipeNameFor(4242, 'win32'), '\\\\.\\pipe\\claude-custom-app-4242');
  assert.notStrictEqual(appPipeNameFor(4242, 'win32'), pipeNameFor(4242, 'win32'));
});

test('listen({ name, clean }) serves another name and another message type', async () => {
  const { listen, send } = load();
  const name = `\\\\.\\pipe\\cc-route-test-${uniquePid()}`;
  const heard = [];
  const clean = (raw) => (raw && raw.type === 'open' && typeof raw.cwd === 'string' ? { cwd: raw.cwd } : null);
  const server = await listen({ name, clean, onFocus: async (m) => { heard.push(m); } });
  try {
    assert.deepStrictEqual(await send({ name, type: 'open', msg: { cwd: 'C:\\p' } }), { ok: true });
    await until(() => heard.length === 1);
    assert.deepStrictEqual(heard, [{ cwd: 'C:\\p' }]);
    const r = await send({ name, msg: { cwd: 'C:\\p' } });          // a focus sent to an open listener is not understood
    assert.strictEqual(r.ok, false);
  } finally { await server.close(); }
});

test('accepting(msg), whenReady(msg) and onFocus(msg) each receive the cleaned message', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const seen = { accepting: [], whenReady: [], onFocus: [] };
  const server = await listen({
    pid,
    accepting: (m) => { seen.accepting.push(m); return true; },
    whenReady: (m) => { seen.whenReady.push(m); return true; },
    onFocus: async (m) => { seen.onFocus.push(m); },
  });
  try {
    assert.deepStrictEqual(await send({ pid, msg: { root: 'C:\\b', cwd: 'C:\\b\\dev', junk: 1 } }), { ok: true });
    await until(() => seen.onFocus.length === 1);
    const want = { root: 'C:\\b', cwd: 'C:\\b\\dev' };
    assert.deepStrictEqual(seen.accepting[0], want);
    assert.deepStrictEqual(seen.whenReady[0], want);
    assert.deepStrictEqual(seen.onFocus[0], want);
  } finally { await server.close(); }
});

test('a sender that asks for the ack gets {"ack":true} at once, then the final line', async () => {
  const { listen, pipeNameFor } = load();
  const pid = uniquePid();
  let release;
  const gate = new Promise((r) => { release = r; });
  const server = await listen({ pid, whenReady: () => gate, onFocus: async () => {} });
  try {
    const p = exchange(pipeNameFor(pid), JSON.stringify({ type: 'focus', ack: true }) + '\n', { waitMs: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    release(true);
    const out = await p;
    assert.strictEqual(out, '{"ack":true}\n{"ok":true}\n');
  } finally { await server.close(); }
});

test('a sender that does not ask gets exactly one line: the old protocol, byte for byte', async () => {
  const { listen, pipeNameFor } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: async () => {} });
  try {
    assert.strictEqual(await exchange(pipeNameFor(pid), JSON.stringify({ type: 'focus' }) + '\n'), '{"ok":true}\n');
    assert.strictEqual(await exchange(pipeNameFor(pid), JSON.stringify({ type: 'nope' }) + '\n'), '{"ok":false,"error":"not a focus request"}\n');
  } finally { await server.close(); }
});

test('send({ ackMs }) to a server that accepts and never writes answers "no ack" within ackMs', async () => {
  const { send } = load();
  const name = `\\\\.\\pipe\\cc-route-mute-${uniquePid()}`;
  const socks = [];
  const mute = net.createServer((s) => { socks.push(s); s.on('error', () => {}); });
  await new Promise((r) => mute.listen(name, r));
  try {
    const t0 = Date.now();
    const r = await send({ name, msg: {}, ackMs: 200, timeoutMs: 5000 });
    assert.deepStrictEqual(r, { ok: false, error: 'no ack' });
    assert.ok(Date.now() - t0 < 2000, 'answered within the ack bound, not the full timeout');
  } finally { for (const s of socks) s.destroy(); await new Promise((r) => mute.close(r)); }
});

test('a held launch that was acknowledged waits for the final line past ackMs', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const server = await listen({ pid, whenReady: () => new Promise((r) => setTimeout(() => r(true), 500)), onFocus: async () => {} });
  try {
    assert.deepStrictEqual(await send({ pid, msg: {}, ackMs: 100, timeoutMs: 5000 }), { ok: true });
  } finally { await server.close(); }
});

test('send({ ackMs }) to an old owner (one line, no ack) still resolves ok', async () => {
  const { send } = load();
  const name = `\\\\.\\pipe\\cc-route-old-${uniquePid()}`;
  const old = net.createServer((s) => {
    s.on('error', () => {});
    s.setEncoding('utf8');
    s.on('data', () => s.end('{"ok":true}\n'));
  });
  await new Promise((r) => old.listen(name, r));
  try {
    assert.deepStrictEqual(await send({ name, msg: {}, ackMs: 1000 }), { ok: true });
  } finally { await new Promise((r) => old.close(r)); }
});

test('cleanMessage keeps root (text, at most 1024) and still accepts a message without it', () => {
  const { cleanMessage } = load();
  assert.deepStrictEqual(cleanMessage({ type: 'focus', root: 'C:\\b' }), { root: 'C:\\b' });
  assert.deepStrictEqual(cleanMessage({ type: 'focus' }), {});
  assert.deepStrictEqual(cleanMessage({ type: 'focus', ack: true, cwd: 'C:\\b' }), { cwd: 'C:\\b' });
  assert.strictEqual(cleanMessage({ type: 'focus', root: 7 }), null);
  assert.strictEqual(cleanMessage({ type: 'focus', root: 'x'.repeat(1025) }), null);
  assert.deepStrictEqual(cleanMessage({ type: 'focus', root: 'x'.repeat(1024) }), { root: 'x'.repeat(1024) });
});
