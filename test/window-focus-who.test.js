'use strict';
/**
 * fix/owner-proof: "who are you" on a launch pipe (host/window-focus.js `who` + listen's `who` option).
 *
 * MEASURED 2026-11-27: a launch proved the running owner with ONE powershell.exe Get-Process (1.3-1.7 s calm, 2.3-4.5 s under load, 5 s
 * budget); on a busy machine it timed out and the launch went on as a second Jiandu process ('unproven-owner'). The owner's own answer on
 * its pipe is the faster proof: the launch asks `{"type":"who"}`, the owner answers its `{ pid, start }`, and the claim compares them with
 * the owner file (host/owner-file.js proveOwner). Real pipes here; pids are made up, so a name never meets a real process's.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');

const load = () => require('../host/window-focus');
const uniquePid = () => 900_000_000 + Math.floor(Math.random() * 90_000_000);
const START = '133800000000000001';

test('who: the owner answers its pid and start at once, before and regardless of the launch gates, and acts on nothing', async () => {
  const { listen, who, appPipeNameFor } = load();
  const pid = uniquePid();
  const name = appPipeNameFor(pid);
  let acted = 0;
  let gated = 0;
  const server = await listen({ pid, name, clean: () => null, who: () => ({ pid, start: START }), onFocus: () => { acted++; },
    accepting: () => { gated++; return false; }, whenReady: () => { gated++; return false; } });
  try {
    assert.deepStrictEqual(await who({ name }), { pid, start: START });
    assert.strictEqual(acted, 0);
    assert.strictEqual(gated, 0, 'a starting or quitting owner still says who it is: the launch gates are for opens, not for identity');
  } finally { await server.close(); }
});

test('who: an owner that does not know its start yet (or gives junk, or throws) answers no identity: null', async () => {
  const { listen, who } = load();
  for (const answer of [() => null, () => ({ pid: 5 }), () => ({ pid: 5, start: '' }), () => ({ pid: 0, start: START }), () => 'x', () => { throw new Error('boom'); }]) {
    const pid = uniquePid();
    const server = await listen({ pid, who: answer, onFocus: () => {} });
    try {
      assert.strictEqual(await who({ pid }), null, String(answer));
    } finally { await server.close(); }
  }
});

test('who: an owner of older code (no `who` option) refuses the line: null, so the caller falls back to the start-time query', async () => {
  const { listen, who } = load();
  const pid = uniquePid();
  const server = await listen({ pid, onFocus: () => {} });
  try {
    assert.strictEqual(await who({ pid }), null);
  } finally { await server.close(); }
});

test('who: nobody listening is null at once; a pipe that never answers is null after timeoutMs; junk is null', async () => {
  const { who, pipeNameFor } = load();
  const t0 = Date.now();
  assert.strictEqual(await who({ pid: uniquePid(), timeoutMs: 5000 }), null);
  assert.ok(Date.now() - t0 < 2000, `no pipe answers at once (${Date.now() - t0} ms)`);

  const silentPid = uniquePid();
  const socks = [];
  const silent = net.createServer((s) => { socks.push(s); s.on('error', () => {}); });
  await new Promise((r) => silent.listen(pipeNameFor(silentPid), r));
  try {
    const t1 = Date.now();
    assert.strictEqual(await who({ pid: silentPid, timeoutMs: 300 }), null);
    assert.ok(Date.now() - t1 < 2000);
  } finally { for (const s of socks) s.destroy(); await new Promise((r) => silent.close(r)); }

  const junkPid = uniquePid();
  const junkSocks = [];
  const junk = net.createServer((s) => { junkSocks.push(s); s.on('error', () => {}); s.end('not json\n'); });
  await new Promise((r) => junk.listen(pipeNameFor(junkPid), r));
  try {
    assert.strictEqual(await who({ pid: junkPid }), null);
  } finally { for (const s of junkSocks) s.destroy(); await new Promise((r) => junk.close(r)); }
});

test('who: an invalid pid with no name asks nothing: null', async () => {
  const { who } = load();
  for (const bad of [0, -1, 1.5, '7', null]) assert.strictEqual(await who({ pid: bad }), null);
});

test('a focus line on a pipe that also answers who is served as before (the who option changes nothing else)', async () => {
  const { listen, send } = load();
  const pid = uniquePid();
  const heard = [];
  const server = await listen({ pid, who: () => ({ pid, start: START }), onFocus: (m) => { heard.push(m); } });
  try {
    assert.deepStrictEqual(await send({ pid, msg: { cwd: 'C:\\p' } }), { ok: true });
  } finally { await server.close(); }
});
