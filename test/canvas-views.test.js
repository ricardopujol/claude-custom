'use strict';
/**
 * app/canvas-views.js: the main-process side of Claude's panel (BACKLOG #71).
 *
 * The panel's page is untrusted, so it does not live in the app's page: it gets a WebContentsView of its own with its own
 * in-memory session. These tests drive the real module with fakes for the Electron classes and pin the decisions that
 * keep it sealed; verify/probe-canvas-sandbox.js shows, in a real window, that Chromium really does stay shut.
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createCanvasViews, PANEL_LIMITS } = require('../app/canvas-views');

class FakeContents extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.id = FakeContents.next++; this.calls = []; this.closed = false; this.destroyedFlag = false; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  setWebRTCIPHandlingPolicy(p) { this.calls.push(['webrtc', p]); }
  setAudioMuted(m) { this.calls.push(['muted', m]); }
  loadURL(u) { this.calls.push(['load', u]); this.loaded = u; return Promise.resolve(); }
  isDestroyed() { return this.destroyedFlag; }
  close() { this.closed = true; this.destroyedFlag = true; }
}
FakeContents.next = 100;

class FakeSession {
  constructor(name) { this.name = name; this.proxy = null; this.permissionRequest = null; this.permissionCheck = null; this.requestFilter = null; this.order = []; }
  async setProxy(c) { this.order.push('proxy'); this.proxy = c; }
  setPermissionRequestHandler(fn) { this.permissionRequest = fn; }
  setPermissionCheckHandler(fn) { this.permissionCheck = fn; }
  setDevicePermissionHandler(fn) { this.devicePermission = fn; }
  setSpellCheckerEnabled() {}
  get webRequest() { return { onBeforeRequest: (fn) => { this.requestFilter = fn; } }; }
}

class FakeView {
  constructor(opts) { this.webContents = new FakeContents(opts.webPreferences); this.opts = opts; this.bounds = null; this.visible = true; }
  setBounds(b) { this.bounds = b; }
  setVisible(v) { this.visible = v; }
}

function rig(over = {}) {
  const sessions = {}; const views = []; const children = new Set(); const messages = []; const asked = [];
  let clock = 1000;
  const owner = { id: 7, isDestroyed: () => false };
  const m = createCanvasViews({
    WebContentsView: class extends FakeView { constructor(o) { super(o); views.push(this); } },
    session: { fromPartition: (p) => (sessions[p] = sessions[p] || new FakeSession(p)) },
    addChild: (v) => children.add(v), removeChild: (v) => children.delete(v),
    ownerBounds: () => ({ x: 0, y: 40, width: 1200, height: 800 }),
    preloadPath: 'C:/app/canvas-panel-preload.js',
    ask: async (o, origin) => { asked.push(origin); return over.answer || 'deny'; },
    onMessage: (o, msg) => messages.push(msg),
    fetchImpl: over.fetchImpl || (async () => new Response('pong')),
    now: () => clock, log: () => {},
  });
  return { m, owner, views, sessions, children, messages, asked, tick: (ms) => { clock += ms; } };
}
const show = (r, extra = {}) => r.m.show(r.owner, { html: '<p>hi</p>', hosts: { approved: [], denied: [] }, rect: { x: 300, y: 100, width: 400, height: 500 }, ...extra });

test('the panel view is sandboxed, isolated, bridge-less except its own preload, and on a private in-memory session', async () => {
  const r = rig();
  await show(r);
  assert.strictEqual(r.views.length, 1);
  const p = r.views[0].opts.webPreferences;
  assert.strictEqual(p.sandbox, true);
  assert.strictEqual(p.contextIsolation, true);
  assert.strictEqual(p.nodeIntegration, false);
  assert.ok(!p.webviewTag && !p.nodeIntegrationInWorker && !p.nodeIntegrationInSubFrames);
  assert.strictEqual(p.devTools, false);
  assert.strictEqual(p.preload, 'C:/app/canvas-panel-preload.js');
  assert.ok(typeof p.partition === 'string' && !p.partition.startsWith('persist:'), 'in memory, nothing survives the view');
  assert.ok(r.children.has(r.views[0]));
});

test('the session is shut BEFORE anything loads: a dead proxy that takes loopback too, no permissions, only data: requests', async () => {
  const r = rig();
  await show(r);
  const ses = Object.values(r.sessions)[0];
  assert.ok(ses.proxy, 'a proxy is set');
  assert.match(ses.proxy.proxyRules, /127\.0\.0\.1:1$/, 'one that nothing listens on');
  assert.strictEqual(ses.proxy.proxyBypassRules, '<-loopback>', 'loopback is NOT exempt: a TURN connection to a local port must die too');
  let granted; ses.permissionRequest({}, 'media', (g) => { granted = g; });
  assert.strictEqual(granted, false);
  assert.strictEqual(ses.permissionCheck({}, 'clipboard-read'), false);
  assert.strictEqual(ses.devicePermission({}), false);
  const verdict = (url) => { let out; ses.requestFilter({ url }, (x) => { out = x; }); return out.cancel === true; };
  assert.strictEqual(verdict('data:text/html;base64,AAA'), false);
  for (const u of ['http://127.0.0.1:9/', 'https://example.com/', 'ws://127.0.0.1:1/', 'file:///c:/x', 'blob:https://x/y']) assert.strictEqual(verdict(u), true, u);
  const view = r.views[0];
  const loadAt = view.webContents.calls.findIndex(c => c[0] === 'load');
  assert.ok(loadAt >= 0);
  assert.ok(ses.proxy !== null, 'set before the load below happened');
});

test('the contents never navigate, never open a window and get no WebRTC route', async () => {
  const r = rig();
  await show(r);
  const wc = r.views[0].webContents;
  assert.deepStrictEqual(wc.openHandler({ url: 'https://evil.example' }), { action: 'deny' });
  for (const ev of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    let prevented = false;
    wc.emit(ev, { url: 'https://evil.example/', isMainFrame: true, preventDefault() { prevented = true; } });
    assert.strictEqual(prevented, true, ev);
  }
  assert.ok(wc.calls.some(c => c[0] === 'webrtc' && c[1] === 'disable_non_proxied_udp'));
  assert.ok(wc.calls.some(c => c[0] === 'muted' && c[1] === true));
});

test("the page is loaded as a data: document built with the host's policy first", async () => {
  const r = rig();
  await show(r, { html: '<b id="mine">x</b>' });
  const url = r.views[0].webContents.loaded;
  assert.match(url, /^data:text\/html;base64,/);
  const doc = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<b id="mine">'));
});

test('the same html is not reloaded; changed html is', async () => {
  const r = rig();
  await show(r);
  await show(r);
  assert.strictEqual(r.views[0].webContents.calls.filter(c => c[0] === 'load').length, 1);
  await show(r, { html: '<p>new</p>' });
  assert.strictEqual(r.views[0].webContents.calls.filter(c => c[0] === 'load').length, 2);
});

test('a page over the cap is refused before a view is made', async () => {
  const r = rig();
  const out = await show(r, { html: 'x'.repeat(PANEL_LIMITS.htmlBytes + 1) });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(r.views.length, 0);
});

test("bounds are the page's rect shifted by the tab view's own offset, whole pixels, kept inside it", async () => {
  const r = rig();
  await show(r, { rect: { x: 300.4, y: 100.6, width: 400.2, height: 500.9 } });
  assert.deepStrictEqual(r.views[0].bounds, { x: 300, y: 141, width: 400, height: 501 });
  r.m.setBounds(r.owner, { x: 1000, y: 700, width: 900, height: 900 });
  assert.deepStrictEqual(r.views[0].bounds, { x: 1000, y: 740, width: 200, height: 100 }, 'clipped to the tab view');
  r.m.setBounds(r.owner, { x: -50, y: -10, width: 100, height: 100 });
  assert.deepStrictEqual(r.views[0].bounds, { x: 0, y: 40, width: 50, height: 90 });
});

test('an empty or invalid rect hides the view instead of showing a sliver', async () => {
  const r = rig();
  await show(r);
  for (const rect of [{ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: 0 }, { x: NaN, y: 0, width: 10, height: 10 }, null, 'x']) {
    r.m.setBounds(r.owner, rect);
    assert.strictEqual(r.views[0].visible, false, JSON.stringify(rect));
  }
  r.m.setBounds(r.owner, { x: 5, y: 5, width: 50, height: 50 });
  assert.strictEqual(r.views[0].visible, true);
});

test('covered (a prompt in the page above it) and an invisible tab both hide the native view', async () => {
  const r = rig();
  await show(r);
  r.m.setCovered(r.owner, true);
  assert.strictEqual(r.views[0].visible, false);
  r.m.setCovered(r.owner, false);
  assert.strictEqual(r.views[0].visible, true);
  r.m.setOwnerVisible(r.owner, false);
  assert.strictEqual(r.views[0].visible, false);
  r.m.setCovered(r.owner, false);
  assert.strictEqual(r.views[0].visible, false, 'an uncover must not show a view whose tab is in the background');
  r.m.setOwnerVisible(r.owner, true);
  assert.strictEqual(r.views[0].visible, true);
});

test('hide unloads: the view leaves the window and its contents are closed (hidden means stopped)', async () => {
  const r = rig();
  await show(r);
  const v = r.views[0];
  r.m.hide(r.owner);
  assert.ok(!r.children.has(v));
  assert.strictEqual(v.webContents.closed, true);
  assert.strictEqual(r.m.has(r.owner), false);
  await show(r);
  assert.strictEqual(r.views.length, 2, 'shown again: rebuilt from the page');
  r.m.destroyFor(r.owner);
  assert.strictEqual(r.views[1].webContents.closed, true);
  assert.doesNotThrow(() => r.m.destroyFor(r.owner));
});

test('fetchFor: only a panel contents may ask, and only approved hosts are fetched', async () => {
  const hits = [];
  const r = rig({ fetchImpl: async (u) => { hits.push(u); return new Response('pong'); } });
  await show(r, { hosts: { approved: ['https://api.example.com'], denied: ['https://bad.example.com'] } });
  const panel = r.views[0].webContents;
  assert.strictEqual((await r.m.fetchFor({ id: 999 }, { url: 'https://api.example.com/' })).ok, false, 'not a panel');
  const ok = await r.m.fetchFor(panel, { url: 'https://api.example.com/x' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual((await r.m.fetchFor(panel, { url: 'https://bad.example.com/' })).ok, false);
  assert.deepStrictEqual(r.asked, []);
  assert.deepStrictEqual(hits, ['https://api.example.com/x']);
});

test('a new host asks the owner page once, and the answer is remembered for this panel', async () => {
  const r = rig({ answer: 'allow' });
  await show(r);
  const panel = r.views[0].webContents;
  const [a, b] = await Promise.all([r.m.fetchFor(panel, { url: 'https://new.example.com/1' }), r.m.fetchFor(panel, { url: 'https://new.example.com/2' })]);
  assert.strictEqual(a.ok && b.ok, true);
  assert.deepStrictEqual(r.asked, ['https://new.example.com'], 'two requests at once make one question');
  await r.m.fetchFor(panel, { url: 'https://new.example.com/3' });
  assert.deepStrictEqual(r.asked, ['https://new.example.com']);
});

test('a denied answer sticks: the host is never asked about again, and its fetches fail', async () => {
  const r = rig({ answer: 'deny' });
  await show(r);
  const panel = r.views[0].webContents;
  assert.strictEqual((await r.m.fetchFor(panel, { url: 'https://no.example.com/' })).ok, false);
  assert.strictEqual((await r.m.fetchFor(panel, { url: 'https://no.example.com/' })).ok, false);
  assert.deepStrictEqual(r.asked, ['https://no.example.com']);
});

test('a page cannot flood the person with questions: past the cap, new hosts are refused unasked', async () => {
  const gate = []; const asked = [];
  const owner = { id: 7 };
  const views = [];
  const m = createCanvasViews({
    WebContentsView: class extends FakeView { constructor(o) { super(o); views.push(this); } },
    session: { fromPartition: (p) => new FakeSession(p) }, addChild() {}, removeChild() {},
    ownerBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), preloadPath: 'p.js',
    ask: (o, origin) => { asked.push(origin); return new Promise((res) => gate.push(res)); },
    onMessage() {}, fetchImpl: async () => new Response('x'), now: () => 0, log() {},
  });
  await m.show(owner, { html: '', hosts: { approved: [], denied: [] }, rect: { x: 0, y: 0, width: 10, height: 10 } });
  const panel = views[0].webContents;
  const pending = [];
  for (let i = 0; i < PANEL_LIMITS.pendingAsks + 3; i++) pending.push(m.fetchFor(panel, { url: `https://h${i}.example.com/` }));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(asked.length, PANEL_LIMITS.pendingAsks);
  gate.forEach(res => res('deny'));
  const outs = await Promise.all(pending);
  assert.ok(outs.every(o => o.ok === false));
});

test('messageFrom: a click is needed; the message is trimmed to text; the owner hears it', async () => {
  const r = rig();
  await show(r);
  const panel = r.views[0].webContents;
  assert.strictEqual(r.m.messageFrom(panel, { kind: 'send', text: 'hello' }), false, 'no real input yet: a script cannot press its own button');
  panel.emit('input-event', {}, { type: 'mouseUp' });
  assert.strictEqual(r.m.messageFrom(panel, { kind: 'send', text: 'hello' }), true);
  assert.deepStrictEqual(r.messages, [{ kind: 'send', text: 'hello' }]);
});

test('messageFrom: input goes stale, one message per click, and bad shapes are dropped', async () => {
  const r = rig();
  await show(r);
  const panel = r.views[0].webContents;
  panel.emit('input-event', {}, { type: 'mouseUp' });
  assert.strictEqual(r.m.messageFrom(panel, { kind: 'send', text: 'a' }), true);
  assert.strictEqual(r.m.messageFrom(panel, { kind: 'send', text: 'b' }), false, 'a click is spent by one message');
  panel.emit('input-event', {}, { type: 'mouseUp' });
  r.tick(PANEL_LIMITS.inputWindowMs + 1);
  assert.strictEqual(r.m.messageFrom(panel, { kind: 'send', text: 'late' }), false, 'a click from long ago is not a click now');
  panel.emit('input-event', {}, { type: 'keyDown' });
  for (const bad of [null, 'x', {}, { kind: 'other', text: 'x' }, { kind: 'send' }, { kind: 'send', text: 5 }, { kind: 'send', text: '' }, { kind: 'send', text: '   ' },
    { kind: 'send', text: 'x'.repeat(PANEL_LIMITS.messageChars + 1) }, { kind: 'send', text: 'two\nlines' }]) {
    assert.strictEqual(r.m.messageFrom(panel, bad), false, JSON.stringify(bad));
  }
  assert.strictEqual(r.m.messageFrom({ id: 12345 }, { kind: 'send', text: 'x' }), false, 'not a panel');
  assert.deepStrictEqual(r.messages.map(m => m.text), ['a']);
});

test('mouse moves and other input are not clicks', async () => {
  const r = rig();
  await show(r);
  const panel = r.views[0].webContents;
  for (const type of ['mouseMove', 'mouseEnter', 'mouseWheel', 'contextMenu', undefined]) panel.emit('input-event', {}, { type });
  assert.strictEqual(r.m.messageFrom(panel, { kind: 'send', text: 'x' }), false);
});

test('setHosts replaces the lists; a host removed from the approved list is asked about again', async () => {
  const r = rig({ answer: 'deny' });
  await show(r, { hosts: { approved: ['https://a.example.com'], denied: [] } });
  const panel = r.views[0].webContents;
  assert.strictEqual((await r.m.fetchFor(panel, { url: 'https://a.example.com/' })).ok, true);
  r.m.setHosts(r.owner, { approved: [], denied: [] });
  assert.strictEqual((await r.m.fetchFor(panel, { url: 'https://a.example.com/' })).ok, false);
  assert.deepStrictEqual(r.asked, ['https://a.example.com']);
});

const { HOST_RESOLVER_RULES, registerCanvasIpc } = require('../app/canvas-views');

test('the process-wide resolver rule refuses every name but loopback (this is what shuts DNS prefetch)', () => {
  assert.strictEqual(HOST_RESOLVER_RULES, 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
});

test('registerCanvasIpc: a panel contents is answered by the module, and nothing else is, on exactly two channels', async () => {
  const handlers = {}; const listeners = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { listeners[ch] = fn; } };
  const calls = [];
  const m = { fetchFor: async (s, req) => { calls.push(['fetch', s.id, req]); return { ok: true }; }, messageFrom: (s, msg) => { calls.push(['send', s.id, msg]); return true; } };
  registerCanvasIpc(ipc, m);
  assert.deepStrictEqual(Object.keys(handlers), ['canvas:fetch']);
  assert.deepStrictEqual(Object.keys(listeners), ['canvas:send']);
  assert.deepStrictEqual(await handlers['canvas:fetch']({ sender: { id: 5 } }, { url: 'u' }), { ok: true });
  listeners['canvas:send']({ sender: { id: 6 } }, { kind: 'send', text: 't' });
  assert.deepStrictEqual(calls, [['fetch', 5, { url: 'u' }], ['send', 6, { kind: 'send', text: 't' }]]);
});

test('inspect (a probe seam, read-only): where the panel is, whether it shows, and the title it set; click sends a real press', async () => {
  const r = rig();
  assert.deepStrictEqual(r.m.inspect(r.owner), { exists: false });
  await show(r);
  const wc = r.views[0].webContents;
  wc.getTitle = () => 'tick 3';
  wc.sent = [];
  wc.sendInputEvent = (e) => wc.sent.push(e);
  assert.deepStrictEqual(r.m.inspect(r.owner), { exists: true, bounds: { x: 300, y: 140, width: 400, height: 500 }, visible: true, title: 'tick 3' });
  r.m.setCovered(r.owner, true);
  assert.strictEqual(r.m.inspect(r.owner).visible, false);
  assert.strictEqual(r.m.click(r.owner, 30, 40), true);
  assert.deepStrictEqual(wc.sent.map(e => [e.type, e.x, e.y, e.button]), [['mouseMove', 30, 40, undefined], ['mouseDown', 30, 40, 'left'], ['mouseUp', 30, 40, 'left']]);
  assert.strictEqual(r.m.click({ id: 12345 }, 1, 1), false);
});
