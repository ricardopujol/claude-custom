'use strict';
/**
 * The page's side of the `changes` conversation (BACKLOG #119 A3) is app/repo-requester.js with another `type`: nothing is sent
 * until THIS host's hello lists `changes` (an older host would type the frame into its pty), answers go to their ask by seq, and
 * a dropped socket forgets what the host accepted.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createRequester } = require('../app/repo-requester');

const OLD = 'This session\'s host is older than this window and can\'t list changes. Restart the session (close this tab and open it again).';

function make(extra) {
  const sent = [];
  const r = createRequester({ send: (m) => { sent.push(m); return true; }, type: 'changes', older: OLD, setTimer: () => 1, clearTimer: () => {}, ...extra });
  return { r, sent };
}

test('nothing is sent before the hello, and the answer says why', async () => {
  const { r, sent } = make();
  assert.deepStrictEqual(await r.request('list', { scope: 'auto' }), { type: 'changes', action: 'list', ok: false, error: 'Waiting for the session to connect.' });
  assert.deepStrictEqual(sent, []);
});

test('a host that lists `repo` but not `changes` is an OLDER host: refused with the page-specific words, nothing sent', async () => {
  const { r, sent } = make();
  r.setControls(['resize', 'repo']);
  const a = await r.request('list', {});
  assert.deepStrictEqual([a.ok, a.error, a.type], [false, OLD, 'changes']);
  assert.deepStrictEqual(sent, []);
});

test('once the hello lists `changes`, an ask carries type, action and seq, and the answer with that seq settles it', async () => {
  const { r, sent } = make();
  r.setControls(['changes']);
  const p = r.request('base', { scope: 'working', path: 'a.js' });
  assert.deepStrictEqual(sent[0], { scope: 'working', path: 'a.js', type: 'changes', action: 'base', seq: sent[0].seq });
  assert.strictEqual(r.onMessage({ type: 'changes', action: 'base', seq: sent[0].seq, ok: true, text: 'x' }), true);
  assert.strictEqual((await p).text, 'x');
});

test('a `repo` answer is not ours; the host `changed` push (no seq) reaches onChanged and settles nothing', () => {
  const { r, sent } = make();
  r.setControls(['changes']);
  r.request('list', {});
  let pushes = 0;
  r.onChanged(() => { pushes += 1; });
  assert.strictEqual(r.onMessage({ type: 'repo', action: 'list', seq: sent[0].seq, ok: true }), false);
  assert.strictEqual(r.onMessage({ type: 'changes', action: 'changed' }), true);
  assert.strictEqual(pushes, 1);
  assert.strictEqual(r.onMessage({ type: 'changes', action: 'list', seq: 424242, ok: true }), false, 'a late answer is nobody\'s');
});

test('a dropped socket fails every ask and forgets the controls', async () => {
  const { r, sent } = make();
  r.setControls(['changes']);
  const p = r.request('list', {});
  r.failAll('socket closed');
  assert.deepStrictEqual([(await p).ok, (await p).error], [false, 'socket closed']);
  const again = await r.request('list', {});
  assert.strictEqual(again.error, 'Waiting for the session to connect.');
  assert.strictEqual(sent.length, 1);
});

test('the default is still the repo conversation', async () => {
  const sent = [];
  const r = createRequester({ send: (m) => { sent.push(m); return true; }, setTimer: () => 1, clearTimer: () => {} });
  r.setControls(['repo']);
  r.request('list', { dir: '' });
  assert.strictEqual(sent[0].type, 'repo');
});
