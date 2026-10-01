'use strict';
/**
 * host/host-client.js against a REAL `ws` server on an ephemeral port -- the
 * same class the host uses -- with the host's own handshake refusal
 * (`verifyClient` -> done(false, 403)).
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { WebSocketServer } = require('ws');

const { sendControl, EXPECTED } = require('../host/host-client');

const TOKEN = 'good token/with?odd&chars';
const SHORT = 300;

// A host of this code greets every client with the control types it accepts
// (host.js's hello). An older host's hello has no `controls`, and it TYPES any
// frame it doesn't know into the session -- so nothing may be sent to it.
const HELLO = { type: 'hello', controls: ['resize', 'input', 'lock-override', 'stop', 'raise'] };

// onMessage(ws, text, wss) decides how the fake host behaves; `hello` is what it
// greets a client with (null: it never does).
async function withServer(onMessage, fn, { hello = HELLO } = {}) {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }, done) => {
      const token = new URL(req.url, 'ws://127.0.0.1').searchParams.get('token');
      if (token !== TOKEN) return done(false, 403, 'Forbidden');
      done(true);
    },
  });
  await new Promise(r => wss.on('listening', r));
  const frames = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => { frames.push(raw.toString()); onMessage(ws, raw.toString(), wss); });
    if (hello !== null) ws.send(JSON.stringify(hello));
  });
  try {
    await fn({ port: wss.address().port, wss, frames });
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise(r => wss.close(r));
  }
}

async function until(pred, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return pred();
}

test('raise: sends exactly one frame and resolves with the raised reply', async () => {
  await withServer((ws, text) => {
    ws.send(JSON.stringify({ type: 'hello' }));                     // noise before the answer
    ws.send(Buffer.from('pty bytes'), { binary: true });
    if (JSON.parse(text).type === 'raise') ws.send(JSON.stringify({ type: 'raised', windows: 2 }));
  }, async ({ port, frames }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'raise' }, timeoutMs: SHORT, WebSocket: require('ws') });
    assert.deepStrictEqual(r, { ok: true, reply: { type: 'raised', windows: 2 } });
    assert.deepStrictEqual(frames, ['{"type":"raise"}']);
  });
});

test('a wrong token is refused at the handshake, with its own error', async () => {
  await withServer(() => {}, async ({ port, frames }) => {
    const r = await sendControl({ port, token: 'nope', msg: { type: 'raise' }, timeoutMs: SHORT });
    assert.deepStrictEqual(r, { ok: false, error: 'handshake refused (HTTP 403)' });
    assert.deepStrictEqual(frames, []);
  });
});

test('nothing listening is a connection error, distinct from a refusal and a timeout', async () => {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise(r => probe.close(r));
  const r = await sendControl({ port, token: TOKEN, msg: { type: 'raise' }, timeoutMs: 500 });
  assert.deepStrictEqual(r, { ok: false, error: 'connection refused' });
});

test('a host that accepts but never answers times out, and the socket is closed', async () => {
  await withServer(() => {}, async ({ port, wss, frames }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'raise' }, timeoutMs: 150 });
    assert.deepStrictEqual(r, { ok: false, error: 'timed out after 150ms' });
    assert.deepStrictEqual(frames, ['{"type":"raise"}']);
    assert.ok(await until(() => wss.clients.size === 0), 'the client socket was left open');
  });
});

test('a host that hangs up before answering a raise is its own error', async () => {
  await withServer(ws => ws.close(), async ({ port }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'raise' }, timeoutMs: 500 });
    assert.deepStrictEqual(r, { ok: false, error: 'closed before reply' });
  });
});

test('stop: ok, with no reply, once the host closes the socket', async () => {
  await withServer(ws => ws.close(), async ({ port, frames }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'stop' }, timeoutMs: 500 });
    assert.deepStrictEqual(r, { ok: true, reply: null });
    assert.deepStrictEqual(frames, ['{"type":"stop"}']);
  });
});

test('stop: a host that ends by dropping the connection hard is still ok', async () => {
  await withServer(ws => ws.terminate(), async ({ port }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'stop' }, timeoutMs: 500 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reply, null);
  });
});

test('stop: a host that never closes times out, and the socket is closed', async () => {
  await withServer(() => {}, async ({ port, wss }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'stop' }, timeoutMs: 150 });
    assert.deepStrictEqual(r, { ok: false, error: 'timed out after 150ms' });
    assert.ok(await until(() => wss.clients.size === 0));
  });
});

test('a successful raise leaves no socket open either', async () => {
  await withServer(ws => ws.send(JSON.stringify({ type: 'raised', windows: 1 })), async ({ port, wss }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'raise' }, timeoutMs: SHORT });
    assert.strictEqual(r.ok, true);
    assert.ok(await until(() => wss.clients.size === 0));
  });
});

test('it never throws: bad arguments and a throwing WebSocket become errors', async () => {
  const bad = [
    [{ port: null, token: 't', msg: { type: 'raise' } }, /invalid port/],
    [{ port: 0, token: 't', msg: { type: 'raise' } }, /invalid port/],
    [{ port: 70000, token: 't', msg: { type: 'raise' } }, /invalid port/],
    [{ port: 4000, token: '', msg: { type: 'raise' } }, /invalid token/],
    [{ port: 4000, token: 't', msg: { type: 'input' } }, /unsupported control type: input/],
    [{ port: 4000, token: 't', msg: null }, /unsupported control type/],
    [{ port: 4000, token: 't', msg: { type: 'toString' } }, /unsupported control type: toString/],
  ];
  for (const [args, re] of bad) {
    const r = await sendControl(args);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, re);
  }
  const Boom = function Boom() { throw new Error('no sockets today'); };
  const r = await sendControl({ port: 4000, token: 't', msg: { type: 'stop' }, WebSocket: Boom });
  assert.deepStrictEqual(r, { ok: false, error: 'socket error: no sockets today' });
  assert.deepStrictEqual((await sendControl()), { ok: false, error: 'invalid port: undefined' });
});

// --- an OLDER host: nothing is typed into its session -----------------------------
// A host started before this code doesn't know `stop` / `raise`, and control.js
// treats a frame of unknown type as INPUT: `{"type":"stop"}` would land in a
// live session's prompt. The client sends only to a host whose hello lists it.

test('an older host (hello without controls) is sent NOTHING, and the error says why', async () => {
  for (const type of ['stop', 'raise']) {
    await withServer(() => {}, async ({ port, frames }) => {
      const r = await sendControl({ port, token: TOKEN, msg: { type }, timeoutMs: SHORT });
      assert.strictEqual(r.ok, false, type);
      assert.match(r.error, new RegExp(`older claude-custom.*"${type}"`), type);
      assert.deepStrictEqual(frames, [], `${type} must never reach an older host`);
    }, { hello: { type: 'hello', cwd: 'C:/x' } });
  }
});

test('a host whose controls leave out this type is sent nothing either', async () => {
  await withServer(() => {}, async ({ port, frames }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'stop' }, timeoutMs: SHORT });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(frames, []);
  }, { hello: { type: 'hello', controls: ['resize', 'raise'] } });
});

test('a host that never says hello times out with nothing sent', async () => {
  await withServer(() => {}, async ({ port, frames }) => {
    const r = await sendControl({ port, token: TOKEN, msg: { type: 'stop' }, timeoutMs: 150 });
    assert.deepStrictEqual(r, { ok: false, error: 'timed out after 150ms' });
    assert.deepStrictEqual(frames, []);
  }, { hello: null });
});

test('the frame goes out only AFTER the hello, never on open', async () => {
  let helloAt = null;
  let frameAt = null;
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => wss.on('listening', r));
  wss.on('connection', (ws) => {
    ws.on('message', () => { frameAt = Date.now(); ws.close(); });
    setTimeout(() => { helloAt = Date.now(); ws.send(JSON.stringify(HELLO)); }, 80);
  });
  try {
    const r = await sendControl({ port: wss.address().port, token: TOKEN, msg: { type: 'stop' }, timeoutMs: 1000 });
    assert.strictEqual(r.ok, true);
    assert.ok(helloAt !== null && frameAt !== null && frameAt >= helloAt, 'sent before the host said what it takes');
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise(r => wss.close(r));
  }
});

test('exactly stop and raise are known, and each names how it is answered', () => {
  assert.deepStrictEqual(EXPECTED, { raise: { reply: 'raised' }, stop: { reply: null } });
});
