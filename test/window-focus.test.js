'use strict';
/**
 * The focus channel (host/window-focus.js): a second launch of a project tells the project's window to focus and select a lane,
 * over a named pipe the window listens on, named by its pid. Real pipes here; the module is loaded inside each test.
 *
 * THE OWNER ACCEPTS, THEN ACTS. A launch that finds a proven live owner must never open a second window just because the owner is still
 * starting (measured, verify/probe-one-window.js check 7: two launches together, the owner's window took longer than the launch's
 * wait, and the loser opened its own). So the answer is "accepted" the moment the message is understood; focusing and selecting
 * happen when the window is ready, with nobody waiting on them.
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

test('pipeNameFor: a named pipe on Windows, keyed by the owner pid; a socket file elsewhere', () => {
  const { pipeNameFor } = load();
  assert.strictEqual(pipeNameFor(4242, 'win32'), '\\\\.\\pipe\\claude-custom-window-4242');
  assert.match(pipeNameFor(4242, 'linux'), /claude-custom-window-4242\.sock$/);
});

test('a launch is accepted, and the owner then gets the folder and port', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const heard = [];
  const server = await listen({ pid, onFocus: async (msg) => { heard.push(msg); } });
  try {
    assert.deepStrictEqual(await send({ pid, msg: { cwd: 'C:\\p\\feat-x', port: 7002 } }), { ok: true });
    await until(() => heard.length === 1);
    assert.deepStrictEqual(heard, [{ cwd: 'C:\\p\\feat-x', port: 7002 }]);
  } finally { await server.close(); }
});

test('a launch with no lane still focuses (an empty message is a plain focus)', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  let heard = null;
  const server = await listen({ pid, onFocus: async (msg) => { heard = msg; } });
  try {
    assert.deepStrictEqual(await send({ pid, msg: {} }), { ok: true });
    await until(() => heard !== null);
    assert.deepStrictEqual(heard, {});
  } finally { await server.close(); }
});

test('the owner only hears what it understands: a wrong type, a bad port or a huge folder name never reaches onFocus', async () => {
  const { listen, pipeNameFor } = load();
  const pid = uniquePid();
  const heard = [];
  const server = await listen({ pid, onFocus: async (m) => { heard.push(m); } });
  try {
    const raw = (line) => new Promise((resolve) => {
      const s = net.connect(pipeNameFor(pid));
      let buf = '';
      s.on('data', d => { buf += d; });
      s.on('close', () => resolve(buf));
      s.on('error', () => resolve(buf));
      s.write(line + '\n');
    });
    assert.match(await raw('{"type":"nope"}'), /"ok":false/);
    assert.match(await raw('not json'), /"ok":false/);
    assert.match(await raw(JSON.stringify({ type: 'focus', port: 'x' })), /"ok":false/);
    assert.match(await raw(JSON.stringify({ type: 'focus', cwd: 'x'.repeat(5000) })), /"ok":false/);
    await new Promise(r => setTimeout(r, 100));
    assert.deepStrictEqual(heard, []);
  } finally { await server.close(); }
});

test('with no whenReady given the window counts as ready: the launch is accepted at once, and onFocus (which may be slow) acts after', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  let release;
  const ready = new Promise(r => { release = r; });
  let acted = null;
  const server = await listen({ pid, onFocus: async (msg) => { await ready; acted = msg; } });
  try {
    assert.deepStrictEqual(await send({ pid, msg: { cwd: 'C:\\p' }, timeoutMs: 1000 }), { ok: true });
    assert.strictEqual(acted, null, 'nothing has happened yet: the window is not ready');
    release();
    await until(() => acted !== null);
    assert.deepStrictEqual(acted, { cwd: 'C:\\p' });
  } finally { await server.close(); }
});

test('an onFocus that never finishes or throws does not change the answer: accepted', async () => {
  const { listen, send } = load();
  const hang = uniquePid();
  const boom = uniquePid();
  const a = await listen({ pid: hang, onFocus: () => new Promise(() => {}) });
  const logged = [];
  const b = await listen({ pid: boom, onFocus: async () => { throw new Error('no window'); }, log: (m) => logged.push(m) });
  try {
    assert.deepStrictEqual(await send({ pid: hang, msg: {}, timeoutMs: 1000 }), { ok: true });
    assert.deepStrictEqual(await send({ pid: boom, msg: {}, timeoutMs: 1000 }), { ok: true });
    await until(() => logged.some(m => /no window/.test(m)));
  } finally { await a.close(); await b.close(); }
});

test('send: nobody listening is a value, not a throw', async () => {
  const { send } = load();
  const r = await send({ pid: uniquePid(), msg: {}, timeoutMs: 500 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /./);
});

test('send: something on the pipe that accepts and never answers times out as a value', async () => {
  const { send, pipeNameFor } = load();
  const pid = uniquePid();
  const sockets = [];
  const silent = net.createServer((s) => { sockets.push(s); s.on('error', () => {}); });
  await new Promise(r => silent.listen(pipeNameFor(pid), r));
  try {
    const r = await send({ pid, msg: {}, timeoutMs: 300 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /timed out/);
  } finally { for (const s of sockets) s.destroy(); await new Promise(r => silent.close(r)); }
});

test('send: a bad pid is refused before any socket', async () => {
  const { send } = load();
  for (const pid of [0, -1, 1.5, '7', null, undefined]) assert.strictEqual((await send({ pid, msg: {} })).ok, false);
});

test('listen: a second listener on the same pid fails loudly (the caller then publishes no owner file)', async () => {
  const { listen } = load();
  const pid = uniquePid();
  const a = await listen({ pid, onFocus: async () => {} });
  try {
    await assert.rejects(() => listen({ pid, onFocus: async () => {} }));
  } finally { await a.close(); }
});

test('close: a closed owner is no longer reachable', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: async () => {} });
  await server.close();
  assert.strictEqual((await send({ pid, msg: {}, timeoutMs: 500 })).ok, false);
});
