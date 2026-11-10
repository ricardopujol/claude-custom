'use strict';
/**
 * host/window-focus.js listen(): the HOLD (PR #247 round 2 M2, PR #248 Miguel Y1 / Dexter 2): a launch that arrives while the window is
 * not ready waits on whenReady() with no idle drop, and is answered ok only when it settles true. Anything else is not-ok, and a launch
 * whose socket is gone is never acted on.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const load = () => require('../host/window-focus');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const settles = async (p, ms) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await new Promise(r => setTimeout(r, ms)); return done; };
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); }
};

test('hold: a whenReady that has not settled holds the launch past the idle time; resolving true then answers ok and acts', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  let go; const gate = new Promise(r => { go = r; });
  const heard = [];
  const server = await listen({ pid, idleMs: 80, whenReady: () => gate, onFocus: async (m) => { heard.push(m); } });
  try {
    const p = send({ pid, msg: { cwd: 'C:\p' }, timeoutMs: 5000 });
    assert.strictEqual(await settles(p, 300), false, 'still held after 300 ms although the idle time is 80 ms');
    go(true);
    assert.deepStrictEqual(await p, { ok: true });
    await until(() => heard.length === 1);
  } finally { await server.close(); }
});

test('hold: whenReady resolving false, rejecting or throwing answers not-ok (closing) and never acts', async () => {
  const { listen, send } = load();
  const heard = [];
  for (const [name, whenReady] of [['false', () => Promise.resolve(false)], ['reject', () => Promise.reject(new Error('x'))],
    ['throw', () => { throw new Error('y'); }], ['not true', () => Promise.resolve('yes')]]) {
    const pid = uniquePid();
    const server = await listen({ pid, whenReady, onFocus: async (m) => { heard.push(m); } });
    try {
      const r = await send({ pid, msg: {}, timeoutMs: 2000 });
      assert.strictEqual(r.ok, false, name);
      assert.strictEqual(r.error, 'closing', name);
    } finally { await server.close(); }
  }
  await new Promise(r => setTimeout(r, 50));
  assert.deepStrictEqual(heard, []);
});

test('hold: a launch whose socket died while held is not acted on', async () => {
  const { listen, pipeNameFor } = load();
  const pid = uniquePid();
  let go; const gate = new Promise(r => { go = r; });
  const heard = [];
  const server = await listen({ pid, whenReady: () => gate, onFocus: async (m) => { heard.push(m); } });
  try {
    const s = net.connect(pipeNameFor(pid));
    s.on('error', () => {});
    await new Promise(r => s.on('connect', r));
    s.write(JSON.stringify({ type: 'focus' }) + '\n');
    await new Promise(r => setTimeout(r, 80));
    s.destroy();                                          // the launch gave up (its own timeout)
    await new Promise(r => setTimeout(r, 80));
    go(true);
    await new Promise(r => setTimeout(r, 150));
    assert.deepStrictEqual(heard, []);
  } finally { await server.close(); }
});

test('hold: accepting() false answers not-ok at once, without ever asking whenReady', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  let asked = 0;
  const server = await listen({ pid, accepting: () => false, whenReady: () => { asked++; return true; }, onFocus: async () => {} });
  try {
    assert.strictEqual((await send({ pid, msg: {}, timeoutMs: 2000 })).ok, false);
    assert.strictEqual(asked, 0);
  } finally { await server.close(); }
});
