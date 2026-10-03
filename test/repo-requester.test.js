'use strict';
/**
 * The page's side of the `repo` protocol (#45 / #32): ask the host, get THE answer to THAT ask, and never
 * wait forever. A host that is older than this page doesn't know the `repo` type and would TYPE the frame
 * into the pty, so nothing is sent to one that didn't list it in `hello.controls`.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createRequester, hostNote, TIMEOUT_MS } = require('../app/repo-requester');

function rig(over = {}) {
  const sent = [];
  const timers = [];
  const r = createRequester({
    send: (obj) => { sent.push(obj); return over.sendOk === false ? false : true; },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    ...over,
  });
  return { r, sent, timers };
}

test('a request is a `repo` frame with the action, its fields and a fresh seq', async () => {
  const { r, sent } = rig();
  r.setControls(['resize', 'repo']);
  const p = r.request('list', { dir: 'src' });
  assert.deepStrictEqual(sent[0], { type: 'repo', action: 'list', dir: 'src', seq: sent[0].seq });
  assert.ok(Number.isSafeInteger(sent[0].seq));
  r.onMessage({ type: 'repo', action: 'list', seq: sent[0].seq, ok: true, entries: [] });
  assert.deepStrictEqual(await p, { type: 'repo', action: 'list', seq: sent[0].seq, ok: true, entries: [] });
});

test('each answer goes to its own ask, whatever order they arrive in', async () => {
  const { r, sent } = rig();
  r.setControls(['repo']);
  const a = r.request('read', { path: 'a' });
  const b = r.request('read', { path: 'b' });
  assert.notStrictEqual(sent[0].seq, sent[1].seq);
  r.onMessage({ type: 'repo', action: 'read', seq: sent[1].seq, ok: true, path: 'b' });
  r.onMessage({ type: 'repo', action: 'read', seq: sent[0].seq, ok: true, path: 'a' });
  assert.strictEqual((await a).path, 'a');
  assert.strictEqual((await b).path, 'b');
});

test('an answer nobody asked for, or one asked for twice, is not ours and is not swallowed as an answer', async () => {
  const { r, sent } = rig();
  r.setControls(['repo']);
  const p = r.request('stat', { path: 'a' });
  assert.strictEqual(r.onMessage({ type: 'repo', action: 'stat', seq: 99999, ok: true }), false);
  assert.strictEqual(r.onMessage({ type: 'repo', action: 'stat', seq: sent[0].seq, ok: true }), true);
  assert.strictEqual(r.onMessage({ type: 'repo', action: 'stat', seq: sent[0].seq, ok: true }), false);
  await p;
});

test('`changed` is a push with no seq: it goes to the listener, not to a request', () => {
  const { r } = rig();
  const seen = [];
  r.onChanged(() => seen.push(1));
  assert.strictEqual(r.onMessage({ type: 'repo', action: 'changed' }), true);
  assert.deepStrictEqual(seen, [1]);
});

test('a host that never answers is a timed-out failure, after TIMEOUT_MS, not a hang', async () => {
  const { r, timers } = rig();
  r.setControls(['repo']);
  const p = r.request('overlay');
  assert.strictEqual(timers[0].ms, TIMEOUT_MS);
  timers[0].fn();
  const out = await p;
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /did not answer/);
});

test('an answer clears its timer, and a late answer after a timeout is not ours any more', async () => {
  const { r, sent, timers } = rig();
  r.setControls(['repo']);
  const p = r.request('list', { dir: '' });
  r.onMessage({ type: 'repo', action: 'list', seq: sent[0].seq, ok: true });
  await p;
  assert.strictEqual(timers[0].cleared, true);
  const q = r.request('list', { dir: '' });
  timers[1].fn();
  await q;
  assert.strictEqual(r.onMessage({ type: 'repo', action: 'list', seq: sent[1].seq, ok: true }), false);
});

test('a socket that is not open fails at once and says so', async () => {
  const { r, sent } = rig({ sendOk: false });
  r.setControls(['repo']);
  const out = await r.request('list', { dir: '' });
  assert.deepStrictEqual({ ok: out.ok, error: out.error }, { ok: false, error: 'not connected to the session' });
  assert.strictEqual(sent.length, 1);
});

test('a host that did not list `repo` is never sent one: the frame would be typed into its session', async () => {
  for (const controls of [undefined, [], ['resize', 'fog'], 'repo', null]) {
    const { r, sent } = rig();
    r.setControls(controls);
    const out = await r.request('list', { dir: '' });
    assert.strictEqual(sent.length, 0, JSON.stringify(controls));
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /older/);
  }
});

test('before any hello, nothing is sent either', async () => {
  const { r, sent } = rig();
  const out = await r.request('list', { dir: '' });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(out.ok, false);
});

test('failAll answers every pending ask with the reason (a dropped socket), and clears their timers', async () => {
  const { r, timers } = rig();
  r.setControls(['repo']);
  const a = r.request('list', { dir: '' });
  const b = r.request('overlay');
  r.failAll('the connection dropped');
  assert.deepStrictEqual([(await a).ok, (await b).error], [false, 'the connection dropped']);
  assert.ok(timers.every(t => t.cleared));
});

test('a body field can\'t overwrite type, action or seq', async () => {
  const { r, sent } = rig();
  r.setControls(['repo']);
  r.request('read', { path: 'a', type: 'input', action: 'x', seq: 'evil' });
  assert.strictEqual(sent[0].type, 'repo');
  assert.strictEqual(sent[0].action, 'read');
  assert.notStrictEqual(sent[0].seq, 'evil');
});

test('hostNote says what to do, only when the host is the problem', () => {
  assert.strictEqual(hostNote(['repo']), null);
  assert.strictEqual(hostNote(['resize', 'repo']), null);
  assert.match(hostNote(['resize']), /restart/i);
  assert.match(hostNote(undefined), /restart/i);
});
