'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { EventEmitter } = require('events');

const { probePort } = require('../host/port-probe');

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.destroy());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A socket whose fate the test decides.
function fakeNet(act) {
  const sockets = [];
  return {
    sockets,
    connect() {
      const s = new EventEmitter();
      s.destroyed = false;
      s.setTimeout = (ms) => { s.timeoutMs = ms; };
      s.destroy = () => { s.destroyed = true; };
      sockets.push(s);
      setImmediate(() => act(s));
      return s;
    },
  };
}

test('a port something listens on -> listening', async () => {
  const server = await listen();
  try {
    assert.strictEqual(await probePort(server.address().port), 'listening');
  } finally {
    server.close();
  }
});

test('a port nothing listens on -> refused (the only answer that means "gone")', async () => {
  const server = await listen();
  const { port } = server.address();
  await new Promise(r => server.close(r));
  assert.strictEqual(await probePort(port), 'refused');
});

test('a connection that never answers -> unknown, never refused', async () => {
  const fake = fakeNet((s) => s.emit('timeout'));
  assert.strictEqual(await probePort(7700, { net: fake, timeoutMs: 50 }), 'unknown');
  assert.strictEqual(fake.sockets[0].timeoutMs, 50);
  assert.strictEqual(fake.sockets[0].destroyed, true);
});

test('any other socket error -> unknown', async () => {
  for (const code of ['EHOSTUNREACH', 'ECONNRESET', 'EACCES', undefined]) {
    const fake = fakeNet((s) => s.emit('error', Object.assign(new Error('x'), { code })));
    assert.strictEqual(await probePort(7700, { net: fake }), 'unknown', String(code));
    assert.strictEqual(fake.sockets[0].destroyed, true);
  }
});

test('ECONNREFUSED from the socket -> refused; connect -> listening; socket destroyed either way', async () => {
  const refused = fakeNet((s) => s.emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' })));
  assert.strictEqual(await probePort(7700, { net: refused }), 'refused');
  assert.strictEqual(refused.sockets[0].destroyed, true);
  const ok = fakeNet((s) => s.emit('connect'));
  assert.strictEqual(await probePort(7700, { net: ok }), 'listening');
  assert.strictEqual(ok.sockets[0].destroyed, true);
});

test('an invalid port is unknown and connects to nothing (absence is never port 0)', async () => {
  const fake = fakeNet(() => assert.fail('no socket'));
  for (const p of [null, undefined, 0, -1, 65536, 1.5, '7700', NaN]) {
    assert.strictEqual(await probePort(p, { net: fake }), 'unknown', String(p));
  }
  assert.strictEqual(fake.sockets.length, 0);
});

test('a connect that throws synchronously -> unknown', async () => {
  const fake = { connect() { throw new Error('boom'); } };
  assert.strictEqual(await probePort(7700, { net: fake }), 'unknown');
});
