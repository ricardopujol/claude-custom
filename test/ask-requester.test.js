'use strict';
/** app/ask-requester.js (BACKLOG #33): the page's side of the `ask` protocol: every ask gets an answer or a named failure. */
const test = require('node:test');
const assert = require('node:assert');
const { createRequester, hostNote, TIMEOUTS } = require('../app/ask-requester');

function rig(extra = {}) {
  const sent = [];
  const timers = [];
  const r = createRequester({
    send: (o) => { sent.push(o); return extra.sendOk !== false; },
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimer: (i) => { if (timers[i]) timers[i].live = false; },
  });
  return { r, sent, timers };
}

test('nothing is sent until the host says it knows `ask` (an older host would type the frame into the pty)', async () => {
  const { r, sent } = rig();
  assert.deepStrictEqual(await r.request('status'), { type: 'ask', op: 'status', ok: false, error: 'Waiting for the session to connect.' });
  r.setControls(['stop', 'repo']);
  const old = await r.request('status');
  assert.strictEqual(old.ok, false);
  assert.match(old.error, /older than this window/);
  assert.strictEqual(sent.length, 0);
});

test('an ask carries a seq; the reply with that seq answers it', async () => {
  const { r, sent } = rig();
  r.setControls(['ask']);
  const p = r.request('ask', { question: 'where is x?' });
  assert.deepStrictEqual(sent[0], { type: 'ask', op: 'ask', seq: 1, question: 'where is x?' });
  assert.strictEqual(r.onMessage({ type: 'ask', seq: 1, ok: true, text: 'here' }), true);
  assert.deepStrictEqual(await p, { type: 'ask', seq: 1, ok: true, text: 'here' });
});

test('replies find THEIR ask, in any order, and a late or unknown one is nobody\'s', async () => {
  const { r } = rig();
  r.setControls(['ask']);
  const a = r.request('ask', {});
  const b = r.request('explain', {});
  r.onMessage({ type: 'ask', seq: 2, ok: true, text: 'B' });
  r.onMessage({ type: 'ask', seq: 1, ok: true, text: 'A' });
  assert.strictEqual((await a).text, 'A');
  assert.strictEqual((await b).text, 'B');
  assert.strictEqual(r.onMessage({ type: 'ask', seq: 99, ok: true }), true, 'it was an ask frame, just not anyone\'s');
  assert.strictEqual(r.onMessage({ type: 'repo', seq: 1 }), false);
  assert.strictEqual(r.onMessage(null), false);
});

test('a closed socket is a named failure at once', async () => {
  const { r } = rig({ sendOk: false });
  r.setControls(['ask']);
  const reply = await r.request('status');
  assert.strictEqual(reply.ok, false);
  assert.match(reply.error, /not connected/i);
});

test('a host that never answers times out per op, and the timer is cleared on an answer', async () => {
  const { r, timers } = rig();
  r.setControls(['ask']);
  const p = r.request('explain', {});
  assert.strictEqual(timers[0].ms, TIMEOUTS.explain);
  timers[0].fn();
  const reply = await p;
  assert.strictEqual(reply.ok, false);
  assert.match(reply.error, /did not answer/i);
  const q = r.request('status');
  r.onMessage({ type: 'ask', seq: 2, ok: true });
  await q;
  assert.strictEqual(timers[1].live, false);
  assert.ok(TIMEOUTS.ask > TIMEOUTS.places && TIMEOUTS.places >= TIMEOUTS.status);
});

test('failAll: a dropped socket fails every pending ask now', async () => {
  const { r } = rig();
  r.setControls(['ask']);
  const a = r.request('ask', {});
  const b = r.request('status');
  r.failAll('The session connection dropped.');
  assert.strictEqual((await a).error, 'The session connection dropped.');
  assert.strictEqual((await b).ok, false);
});

test('hostNote: why the panel cannot work, in words', () => {
  assert.strictEqual(hostNote(['ask']), null);
  assert.match(hostNote(undefined), /Waiting/);
  assert.match(hostNote([]), /older than this window/);
});

// --- notify: a frame nobody waits on (the panel's open/closed, a place opened) goes through the SAME gate as request (BACKLOG #33 gamification, PR #178 Miguel B1)

test('notify sends nothing until the host\'s hello lists ask: an older host would type the frame into the session', () => {
  const sent = [];
  const r = createRequester({ send: (o) => { sent.push(o); return true; } });
  assert.strictEqual(r.notify('panel', { open: true }), false, 'before any hello');
  r.setControls([]);
  assert.strictEqual(r.notify('panel', { open: true }), false, 'a host that lists nothing');
  r.setControls(['lean', 'repo']);
  assert.strictEqual(r.notify('opened'), false, 'a host that lists other things but not ask');
  assert.deepStrictEqual(sent, []);
});

test('notify sends the frame, with no seq, when the host lists ask; a socket that is closed or throws is false, never a throw', () => {
  const sent = [];
  const r = createRequester({ send: (o) => { sent.push(o); return true; } });
  r.setControls(['ask']);
  assert.strictEqual(r.notify('panel', { open: true }), true);
  assert.strictEqual(r.notify('opened'), true);
  assert.deepStrictEqual(sent, [{ type: 'ask', op: 'panel', open: true }, { type: 'ask', op: 'opened' }]);
  const closed = createRequester({ send: () => false });
  closed.setControls(['ask']);
  assert.strictEqual(closed.notify('opened'), false);
  const boom = createRequester({ send: () => { throw new Error('x'); } });
  boom.setControls(['ask']);
  assert.strictEqual(boom.notify('opened'), false);
});
