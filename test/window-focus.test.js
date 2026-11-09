'use strict';
/**
 * The focus channel (host/window-focus.js): a second launch of a project tells the project's window to focus and select a lane,
 * over a named pipe the window listens on, named by its pid. Real pipes here; the module is loaded inside each test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const load = () => require('../host/window-focus');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);

test('pipeNameFor: a named pipe on Windows, keyed by the owner pid; a socket file elsewhere', () => {
  const { pipeNameFor } = load();
  assert.strictEqual(pipeNameFor(4242, 'win32'), '\\\\.\\pipe\\claude-custom-window-4242');
  assert.match(pipeNameFor(4242, 'linux'), /claude-custom-window-4242\.sock$/);
});

test('a launch is heard: the owner gets the folder and port, and its answer comes back', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const heard = [];
  const server = await listen({ pid, onFocus: async (msg) => { heard.push(msg); return { selected: 'lane-b' }; } });
  try {
    const r = await send({ pid, msg: { cwd: 'C:\\p\\feat-x', port: 7002 } });
    assert.deepStrictEqual(r, { ok: true, selected: 'lane-b' });
    assert.deepStrictEqual(heard, [{ cwd: 'C:\\p\\feat-x', port: 7002 }]);
  } finally { await server.close(); }
});

test('a launch with no lane still focuses (an empty message is a plain focus)', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  let heard = null;
  const server = await listen({ pid, onFocus: async (msg) => { heard = msg; return { selected: null }; } });
  try {
    const r = await send({ pid, msg: {} });
    assert.deepStrictEqual(r, { ok: true, selected: null });
    assert.deepStrictEqual(heard, {});
  } finally { await server.close(); }
});

test('the owner only hears what it understands: a wrong type, a bad port or a huge folder name never reaches onFocus', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const heard = [];
  const server = await listen({ pid, onFocus: async (m) => { heard.push(m); return { selected: null }; } });
  try {
    const net = require('net');
    const raw = (line) => new Promise((resolve) => {
      const s = net.connect(require('../host/window-focus').pipeNameFor(pid));
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
    assert.deepStrictEqual(heard, []);
  } finally { await server.close(); }
});

test('a window not ready yet makes the launch wait, then answers (the pipe is up before the file names this window)', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  let release;
  const ready = new Promise(r => { release = r; });
  const server = await listen({ pid, onFocus: async () => { await ready; return { selected: 'k' }; } });
  try {
    const pending = send({ pid, msg: { cwd: 'C:\\p' } });
    setTimeout(release, 100);
    assert.deepStrictEqual(await pending, { ok: true, selected: 'k' });
  } finally { await server.close(); }
});

test('send: nobody listening is a value, not a throw', async () => {
  const { send } = load();
  const r = await send({ pid: uniquePid(), msg: {}, timeoutMs: 500 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /./);
});

test('send: an owner that accepts and never answers times out as a value', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: () => new Promise(() => {}), answerTimeoutMs: 60_000 });
  try {
    const r = await send({ pid, msg: {}, timeoutMs: 300 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /timed out/);
  } finally { await server.close(); }
});

test('send: a bad pid is refused before any socket', async () => {
  const { send } = load();
  for (const pid of [0, -1, 1.5, '7', null, undefined]) assert.strictEqual((await send({ pid, msg: {} })).ok, false);
});

test('listen: a second listener on the same pid fails loudly (the caller then publishes no owner file)', async () => {
  const { listen } = load();
  const pid = uniquePid();
  const a = await listen({ pid, onFocus: async () => ({ selected: null }) });
  try {
    await assert.rejects(() => listen({ pid, onFocus: async () => ({ selected: null }) }));
  } finally { await a.close(); }
});

test('close: a closed owner is no longer reachable', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: async () => ({ selected: null }) });
  await server.close();
  assert.strictEqual((await send({ pid, msg: {}, timeoutMs: 500 })).ok, false);
});
