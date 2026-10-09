'use strict';
/**
 * Kill tests for the release-gate survivor S12 in app/canvas-csp.js (Mortimer, 2026-10-09). The shim is a function whose source is sent
 * to the page, so Stryker cannot judge it; these run it in a vm the way a page does, with Headers, header arrays, a Request, a null body
 * and a window with no `claudePanel`.
 */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { PANEL_SHIM } = require('../app/canvas-csp');

// Skipped when Stryker has instrumented the shim (see test/canvas-csp.test.js): it cannot run in a vm then.
const INSTRUMENTED = /stryMutAct|stryCov/.test(PANEL_SHIM) && 'the shim is instrumented by Stryker: it cannot run in a vm';

const good = { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, bodyBase64: Buffer.from('pong').toString('base64') };

function page(answer, { panel } = {}) {
  const calls = [];
  const claudePanel = panel === undefined
    ? { fetch: (url, init) => { calls.push({ url, init: JSON.parse(JSON.stringify(init)) }); return typeof answer === 'function' ? answer(url, init) : Promise.resolve(answer); } }
    : panel;
  const sentinel = function original() {};
  const ctx = { Response, Request, Headers, atob, Uint8Array, TypeError, Promise, Object, Array, String, claudePanel, fetch: sentinel };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(PANEL_SHIM, ctx);
  return { fetch: (...a) => vm.runInContext('window.fetch', ctx)(...a), calls, ctx, sentinel };
}
const settles = (p) => Promise.race([p.then(() => 'resolved', (e) => 'rejected:' + (e && e.constructor && e.constructor.name) + ':' + (e && e.message)), new Promise(r => setTimeout(() => r('HUNG'), 300))]);
const URL_ = 'https://a.example.com/x';

test('S12: with no usable window.claudePanel the page keeps its own fetch', { skip: INSTRUMENTED }, () => {
  for (const panel of [null, {}, { fetch: 'nope' }, { fetch: 5 }, false, 0]) {
    const p = page(good, { panel });
    assert.strictEqual(p.ctx.fetch, p.sentinel, `claudePanel ${JSON.stringify(panel)}`);
  }
  const absent = (() => { const ctx = { Response, Request, Headers, atob, Uint8Array, TypeError, Promise, Object, Array, String, fetch() {} }; ctx.window = ctx; const f = ctx.fetch; vm.createContext(ctx); vm.runInContext(PANEL_SHIM, ctx); return ctx.fetch === f; })();
  assert.strictEqual(absent, true, 'claudePanel not defined at all');
  const p = page(good);
  assert.notStrictEqual(p.ctx.fetch, p.sentinel, 'with a panel bridge fetch is replaced');
});

test('S12: Headers, an array of pairs and a plain object all reach main as the same plain object', { skip: INSTRUMENTED }, async () => {
  for (const headers of [new Headers({ a: 'b' }), [['a', 'b']], { a: 'b' }]) {
    const p = page(good);
    await p.fetch(URL_, { headers });
    assert.deepStrictEqual(p.calls[0].init.headers, { a: 'b' });
  }
  const none = page(good);
  await none.fetch(URL_, { headers: null });
  await none.fetch(URL_);
  assert.deepStrictEqual(none.calls.map(c => c.init.headers), [{}, {}]);
  const multi = page(good);
  await multi.fetch(URL_, { headers: [['a', '1'], ['b', '2']] });
  assert.deepStrictEqual(multi.calls[0].init.headers, { a: '1', b: '2' });
});

test('S12: a Request carries its url, method and headers; the options win over it', { skip: INSTRUMENTED }, async () => {
  const p = page(good);
  await p.fetch(new Request(URL_, { method: 'PUT', headers: { 'x-r': '1' } }));
  assert.deepStrictEqual(p.calls[0], { url: URL_, init: { method: 'PUT', headers: { 'x-r': '1' } } });
  await p.fetch(new Request(URL_, { method: 'PUT', headers: { 'x-r': '1' } }), { method: 'DELETE', headers: { 'x-o': '2' } });
  assert.deepStrictEqual(p.calls[1].init, { method: 'DELETE', headers: { 'x-o': '2' } });
  await p.fetch(new URL(URL_));
  assert.strictEqual(p.calls[2].url, URL_, 'anything else is stringified');
});

test('S12: the method defaults to GET', { skip: INSTRUMENTED }, async () => {
  const p = page(good);
  await p.fetch(URL_);
  await p.fetch(URL_, {});
  await p.fetch(URL_, { method: 'POST', body: 'x' });
  assert.deepStrictEqual(p.calls.map(c => c.init.method), ['GET', 'GET', 'POST']);
});

test('S12: a string body (even empty) is sent, null and undefined are no body, anything else is refused before main hears of it', { skip: INSTRUMENTED }, async () => {
  const p = page(good);
  await p.fetch(URL_, { method: 'POST', body: 'x' });
  await p.fetch(URL_, { method: 'POST', body: '' });
  await p.fetch(URL_, { method: 'POST', body: null });
  await p.fetch(URL_, { method: 'POST', body: undefined });
  assert.deepStrictEqual(p.calls.map(c => c.init.body), ['x', '', undefined, undefined]);
  for (const body of [5, {}, [], true, new Uint8Array(1)]) {
    const q = page(good);
    const out = await settles(q.fetch(URL_, { method: 'POST', body }));
    assert.match(out, /^rejected:TypeError:Only a string body/, String(body));
    assert.strictEqual(q.calls.length, 0);
  }
});

test('S12: an answer is accepted only with ok === true; every other shape is a failed fetch with a reason', { skip: INSTRUMENTED }, async () => {
  const rejects = async (answer, re) => assert.match(await settles(page(answer).fetch(URL_)), re, JSON.stringify(answer));
  await rejects(null, /^rejected:TypeError:Failed to fetch: refused$/);
  await rejects(undefined, /^rejected:TypeError:Failed to fetch: refused$/);
  await rejects({ ok: 'true', status: 200 }, /^rejected:TypeError:Failed to fetch: refused$/);
  await rejects({ ok: 1, status: 200 }, /^rejected:TypeError:Failed to fetch: refused$/);
  await rejects({ ok: false }, /^rejected:TypeError:Failed to fetch: refused$/);
  await rejects({ ok: false, error: 'not allowed' }, /^rejected:TypeError:Failed to fetch: not allowed$/);
  assert.match(await settles(page(() => Promise.reject(new Error('gone'))).fetch(URL_)), /^rejected:TypeError:Failed to fetch: gone$/);
  assert.match(await settles(page(() => Promise.reject(null)).fetch(URL_)), /^rejected:TypeError:Failed to fetch: refused$/);
  assert.match(await settles(page(() => Promise.reject({})).fetch(URL_)), /^rejected:TypeError:Failed to fetch: refused$/);
  assert.match(await settles(page({ ...good, statusText: 'bad\nstatus' }).fetch(URL_)), /^rejected:TypeError:Failed to fetch: the answer could not be read \(/);
});

test('S12: 204, 205 and 304 answer with no body even when main sent bytes; other statuses keep theirs', { skip: INSTRUMENTED }, async () => {
  for (const status of [204, 205, 304]) {
    const res = await page({ ...good, status, bodyBase64: Buffer.from('xx').toString('base64') }).fetch(URL_);
    assert.strictEqual(res.status, status);
    assert.strictEqual(await res.text(), '');
  }
  const res = await page({ ...good, status: 201 }).fetch(URL_);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(await res.text(), 'pong');
});
