'use strict';
/**
 * app/preview-views.js (BACKLOG #119 A4): the main-process side of the Preview panel. Fakes stand in for the Electron classes and pin
 * the decisions that keep it on loopback; verify/probe-preview-panel.js runs the same module in a real window.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const { EventEmitter } = require('events');
const { createPreviewViews } = require('../app/preview-views');

class FakeContents extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.id = FakeContents.next++; this.calls = []; this.destroyedFlag = false; this.url = ''; this.devtools = false; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  setWebRTCIPHandlingPolicy(p) { this.calls.push(['webrtc', p]); }
  loadURL(u) { this.calls.push(['load', u]); this.url = u; return Promise.resolve(); }
  getURL() { return this.url; }
  getTitle() { return this.title || ''; }
  reload() { this.calls.push(['reload']); }
  isDevToolsOpened() { return this.devtools; }
  openDevTools(o) { this.calls.push(['devtools-open', o]); this.devtools = true; }
  closeDevTools() { this.calls.push(['devtools-close']); this.devtools = false; }
  isDestroyed() { return this.destroyedFlag; }
  forcefullyCrashRenderer() { this.calls.push(['crash']); }
  close() { this.calls.push(['close']); this.destroyedFlag = true; }
}
FakeContents.next = 500;

class FakeSession extends EventEmitter {
  constructor(name) { super(); this.name = name; this.proxy = null; this.requestFilter = null; }
  async setProxy(c) { this.proxy = c; }
  setPermissionRequestHandler(fn) { this.permissionRequest = fn; }
  setPermissionCheckHandler(fn) { this.permissionCheck = fn; }
  setDevicePermissionHandler(fn) { this.devicePermission = fn; }
  setSpellCheckerEnabled() {}
  async clearStorageData() { this.clears = (this.clears || 0) + 1; }
  async clearCache() { this.clears = (this.clears || 0) + 1; }
  get webRequest() { return { onBeforeRequest: (fn) => { this.requestFilter = fn; } }; }
}

class FakeView {
  constructor(opts) { this.webContents = new FakeContents(opts.webPreferences); this.opts = opts; this.bounds = null; this.visible = true; }
  setBounds(b) { this.bounds = b; }
  setVisible(v) { this.visible = v; }
}

function rig(over = {}) {
  const sessions = {}; const views = []; const children = new Set(); const events = []; const opened = [];
  const owner = over.owner || new EventEmitter();
  owner.id = owner.id || 7;
  owner.isDestroyed = owner.isDestroyed || (() => false);
  const keys = { 7: 'C:\\p\\a', 8: 'C:\\p\\b' };
  const m = createPreviewViews({
    WebContentsView: class extends FakeView { constructor(o) { super(o); views.push(this); } },
    session: { fromPartition: (p) => (sessions[p] = sessions[p] || new FakeSession(p)) },
    isOwnerVisible: over.isOwnerVisible,
    addChild: (v) => children.add(v), removeChild: (v) => children.delete(v),
    ownerBounds: () => ({ x: 0, y: 40, width: 1200, height: 800 }),
    keyOf: (o) => keys[o.id] || null,
    onEvent: (o, ev) => events.push(ev),
    openUrl: (u) => { opened.push(u); return true; },
    log: () => {},
  });
  return { m, owner, views, sessions, children, events, opened };
}
const RECT = { x: 300, y: 100, width: 400, height: 500 };
const show = (r, target, extra = {}) => r.m.show(r.owner, { ...(target === undefined ? {} : { target }), rect: RECT, ...extra });
const lastEvent = (r, kind) => [...r.events].reverse().find(e => e.kind === kind);
const emitNav = (wc, ev, url, extra = {}) => {
  let prevented = false;
  const e = { url, preventDefault() { prevented = true; }, isMainFrame: true, ...extra };
  wc.emit(ev, e, url);
  return prevented;
};

// ---- the view -------------------------------------------------------------------------------------------------------------

test('the view is sandboxed, isolated, has NO preload and no Node, and sits on a private in-memory session', async () => {
  const r = rig();
  const res = await show(r, { port: 20003 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(r.views.length, 1);
  const p = r.views[0].opts.webPreferences;
  assert.strictEqual(p.sandbox, true);
  assert.strictEqual(p.contextIsolation, true);
  assert.strictEqual(p.nodeIntegration, false);
  assert.strictEqual(p.preload, undefined, 'the page gets no bridge of any kind');
  assert.ok(!p.webviewTag && !p.nodeIntegrationInWorker && !p.nodeIntegrationInSubFrames);
  assert.strictEqual(p.webSecurity === false, false, 'web security stays on');
  assert.ok(!p.allowRunningInsecureContent);
  assert.strictEqual(p.disableDialogs, true);
  assert.strictEqual(p.safeDialogs, true);
  assert.ok(typeof p.partition === 'string' && !p.partition.startsWith('persist:'), 'nothing outlives the view');
  assert.ok(r.children.has(r.views[0]));
});

test('the session is locked before anything loads: a dead proxy (loopback stays direct by Chromium implicit bypass), no permissions, loopback-only requests', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const ses = Object.values(r.sessions)[0];
  assert.deepStrictEqual(ses.proxy, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:1' }, 'every non-URL connection (WebRTC TURN over TCP) dies at a dead proxy');
  assert.ok(!('proxyBypassRules' in ses.proxy), 'no bypass rules: <-loopback> would send loopback to the dead proxy, anything else would open a hole');
  let granted; ses.permissionRequest({}, 'media', (g) => { granted = g; });
  assert.strictEqual(granted, false);
  assert.strictEqual(ses.permissionCheck({}, 'clipboard-read'), false);
  assert.strictEqual(ses.devicePermission({}), false);
  const cancelled = (url) => { let out; ses.requestFilter({ url }, (x) => { out = x; }); return out.cancel === true; };
  assert.strictEqual(cancelled('http://localhost:20003/app.js'), false);
  assert.strictEqual(cancelled('ws://127.0.0.1:24678/'), false);
  for (const u of ['https://example.com/x.js', 'http://8.8.8.8/', 'http://192.168.1.1/', 'file:///C:/x', 'wss://localhost/']) assert.strictEqual(cancelled(u), true, u);
  assert.ok(ses.proxy !== null);
});

test('a download is cancelled and said so on the header', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const ses = Object.values(r.sessions)[0];
  assert.ok(ses.listenerCount('will-download') >= 1);
  let prevented = false;
  ses.emit('will-download', { preventDefault() { prevented = true; } }, { getFilename: () => 'x.bat' });
  assert.strictEqual(prevented, true);
  assert.strictEqual(lastEvent(r, 'blocked').text, 'blocked: a download');
});

test('window.open is refused and said so; no new window is ever made', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  assert.deepStrictEqual(wc.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepStrictEqual(wc.openHandler({ url: 'http://localhost:20003/next' }), { action: 'deny' }, 'not even a loopback one');
  assert.strictEqual(lastEvent(r, 'blocked').text, 'blocked: a new window');
  assert.deepStrictEqual(r.opened, [], 'and nothing is handed to the system browser on the page\'s say-so');
});

test('every way a page can move is checked: will-navigate, will-redirect, will-frame-navigate', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    assert.strictEqual(emitNav(wc, ev, 'https://example.com/login'), true, `${ev} to the web is stopped`);
    assert.strictEqual(lastEvent(r, 'blocked').text, 'blocked: example.com');
    assert.strictEqual(emitNav(wc, ev, 'file:///C:/Windows/win.ini'), true, `${ev} to a file is stopped`);
    assert.strictEqual(emitNav(wc, ev, 'http://localhost:20004/other'), false, `${ev} to loopback goes through`);
    assert.strictEqual(emitNav(wc, ev, 'http://127.0.0.1.evil.example:20004/'), true, `${ev} to a look-alike is stopped`);
    assert.strictEqual(emitNav(wc, ev, 'javascript:alert(1)'), true);
  }
});

test('a sub-frame going to the web is stopped too', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  assert.strictEqual(emitNav(wc, 'will-frame-navigate', 'https://ads.example/', { isMainFrame: false }), true);
});

test('the url may arrive on the event or as the second argument (Electron passes both)', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  let prevented = false;
  wc.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.com/');
  assert.strictEqual(prevented, true);
  prevented = false;
  wc.emit('will-navigate', { url: 'https://example.com/', preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true);
  prevented = false;
  wc.emit('will-navigate', { preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true, 'no url at all is not a pass');
});

test('webviews are refused, and a beforeunload handler cannot pin the page', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  for (const ev of ['will-attach-webview', 'will-prevent-unload']) {
    let prevented = false;
    wc.emit(ev, { preventDefault() { prevented = true; } });
    assert.strictEqual(prevented, true, ev);
  }
});

test('WebRTC is held to proxied UDP', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  assert.ok(r.views[0].webContents.calls.some(c => c[0] === 'webrtc' && c[1] === 'disable_non_proxied_udp'));
});

// ---- show: what may be loaded ---------------------------------------------------------------------------------------------

test('a port loads http://localhost:<port>/', async () => {
  const r = rig();
  const res = await show(r, { port: 20003 });
  assert.strictEqual(res.url, 'http://localhost:20003/');
  assert.deepStrictEqual(r.views[0].webContents.calls.find(c => c[0] === 'load'), ['load', 'http://localhost:20003/']);
});

test('typed text goes through the same rule: shorthand loads, the web is refused with a line and no view', async () => {
  const r = rig();
  const ok = await show(r, { typed: '3000' });
  assert.strictEqual(ok.url, 'http://localhost:3000/');
  const r2 = rig();
  const bad = await show(r2, { typed: 'https://example.com' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(r2.views.length, 0, 'nothing was made for an address that is refused');
  assert.strictEqual(lastEvent(r2, 'blocked').text, 'blocked: example.com');
});

test('a refused typed address says what it reached for, in the header', async () => {
  for (const [typed, line] of [['example.com', 'blocked: example.com'], ['javascript:alert(1)', 'blocked: a javascript: address'], ['70000', 'blocked: a port that is not 1-65535']]) {
    const r = rig();
    await show(r, { typed });
    assert.strictEqual(lastEvent(r, 'blocked').text, line, typed);
  }
});

test('a target that is neither a port nor typed text is refused', async () => {
  for (const t of [{ url: 'http://localhost:3000/' }, { port: 'x' }, { port: 0 }, { typed: 5 }, null, 'http://localhost:3000/', 5]) {
    const r = rig();
    const res = await show(r, t);
    assert.strictEqual(res.ok, false, JSON.stringify(t));
    assert.strictEqual(r.views.length, 0);
  }
});

test('no target and nothing remembered: no view (a blank white pane would say nothing)', async () => {
  const r = rig();
  const res = await show(r);
  assert.deepStrictEqual({ ok: res.ok, url: res.url }, { ok: true, url: null });
  assert.strictEqual(r.views.length, 0);
});

test('the same address shown again is not reloaded', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  await show(r, { port: 20003 });
  assert.strictEqual(r.views[0].webContents.calls.filter(c => c[0] === 'load').length, 1);
  await show(r, { port: 20004 });
  assert.strictEqual(r.views[0].webContents.calls.filter(c => c[0] === 'load').length, 2);
});

// ---- the last address, per worktree ---------------------------------------------------------------------------------------

test('the panel remembers its last address per worktree, through a hide', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  wc.url = 'http://localhost:20003/page2';
  wc.emit('did-navigate', {}, 'http://localhost:20003/page2');
  assert.strictEqual(r.m.lastUrl(r.owner), 'http://localhost:20003/page2');
  r.m.hide(r.owner);
  assert.strictEqual(r.views[0].webContents.destroyedFlag, true);
  const res = await show(r);
  assert.strictEqual(res.url, 'http://localhost:20003/page2', 'asked for nothing, it comes back to where it was');
  assert.strictEqual(r.views.length, 2);
});

test('two worktrees keep their own last address, each on its own session', async () => {
  const r = rig();
  const other = new EventEmitter(); other.id = 8; other.isDestroyed = () => false;
  await show(r, { port: 20003 });
  await r.m.show(other, { target: { port: 20103 }, rect: RECT });
  assert.strictEqual(r.m.lastUrl(r.owner), 'http://localhost:20003/');
  assert.strictEqual(r.m.lastUrl(other), 'http://localhost:20103/');
  assert.strictEqual(r.views.length, 2);
  assert.notStrictEqual(r.views[0].opts.webPreferences.partition, r.views[1].opts.webPreferences.partition);
  r.m.hide(other);
  assert.strictEqual(r.m.has(r.owner), true, 'hiding one leaves the other');
  assert.strictEqual(r.m.lastUrl({ id: 99 }), null, 'a tab with no worktree remembers nothing');
});

test('a page that moved somewhere refused is never remembered', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  wc.emit('did-navigate', {}, 'https://example.com/');
  assert.strictEqual(r.m.lastUrl(r.owner), 'http://localhost:20003/');
});

test('did-navigate and did-navigate-in-page tell the owner\'s page the new address', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  wc.emit('did-navigate', {}, 'http://localhost:20003/a');
  assert.strictEqual(lastEvent(r, 'url').url, 'http://localhost:20003/a');
  wc.emit('did-navigate-in-page', {}, 'http://localhost:20003/a#x', true);
  assert.strictEqual(lastEvent(r, 'url').url, 'http://localhost:20003/a#x');
  const before = r.events.length;
  wc.emit('did-navigate-in-page', {}, 'http://localhost:20003/frame', false);
  assert.strictEqual(r.events.length, before, 'a sub-frame\'s move is not the panel\'s address');
});

// ---- failures -------------------------------------------------------------------------------------------------------------

test('a page that could not be loaded says why on the header; an aborted load (-3) says nothing', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:20003/', true);
  assert.match(lastEvent(r, 'failed').text, /ERR_CONNECTION_REFUSED/);
  const n = r.events.length;
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:20003/', true);
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:20003/x.png', false);
  assert.strictEqual(r.events.length, n);
});

test('a failure text is plain: control characters and length are cut', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  r.views[0].webContents.emit('did-fail-load', {}, -2, 'ERR\n\u0007' + 'x'.repeat(500), 'http://localhost:20003/', true);
  const t = lastEvent(r, 'failed').text;
  assert.ok(t.length <= 140);
  assert.doesNotMatch(t, /[\u0000-\u001f]/);
});

// ---- the header's buttons -------------------------------------------------------------------------------------------------

test('reload reloads; with no view it does nothing', async () => {
  const r = rig();
  assert.strictEqual(r.m.reload(r.owner), false);
  await show(r, { port: 20003 });
  assert.strictEqual(r.m.reload(r.owner), true);
  assert.ok(r.views[0].webContents.calls.some(c => c[0] === 'reload'));
});

test('devtools toggles, detached', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  r.m.toggleDevTools(r.owner);
  assert.deepStrictEqual(r.views[0].webContents.calls.find(c => c[0] === 'devtools-open'), ['devtools-open', { mode: 'detach' }]);
  r.m.toggleDevTools(r.owner);
  assert.ok(r.views[0].webContents.calls.some(c => c[0] === 'devtools-close'));
});

test('open in browser opens the page\'s current loopback address, nothing else', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  r.views[0].webContents.url = 'http://localhost:20003/deep?x=1';
  assert.strictEqual(r.m.openExternal(r.owner), true);
  assert.deepStrictEqual(r.opened, ['http://localhost:20003/deep?x=1']);
  r.views[0].webContents.url = 'https://example.com/';
  assert.strictEqual(r.m.openExternal(r.owner), false, 'a current address that is not loopback is never opened');
  assert.strictEqual(r.opened.length, 1);
  assert.strictEqual(rig().m.openExternal({ id: 99 }), false, 'no view, nothing to open');
});

test('open a port in the browser: a real port only, as a loopback address', () => {
  const r = rig();
  assert.strictEqual(r.m.openPort(20003), true);
  assert.deepStrictEqual(r.opened, ['http://localhost:20003/']);
  for (const p of [0, 65536, 'x', null, 1.5, undefined]) assert.strictEqual(r.m.openPort(p), false, String(p));
  assert.strictEqual(r.opened.length, 1);
});

// ---- placement and lifetime -----------------------------------------------------------------------------------------------

test('the view sits over the slot the page reported, clipped to the window, and follows covered/visible', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const v = r.views[0];
  assert.deepStrictEqual(v.bounds, { x: 300, y: 140, width: 400, height: 500 });
  assert.strictEqual(v.visible, true);
  r.m.setCovered(r.owner, true);
  assert.strictEqual(v.visible, false);
  r.m.setCovered(r.owner, false);
  r.m.setOwnerVisible(r.owner, false);
  assert.strictEqual(v.visible, false);
  r.m.setOwnerVisible(r.owner, true);
  r.m.setBounds(r.owner, { x: 1100, y: 0, width: 400, height: 2000 });
  assert.deepStrictEqual(v.bounds, { x: 1100, y: 40, width: 100, height: 800 });
  r.m.setBounds(r.owner, { x: 5000, y: 0, width: 10, height: 10 });
  assert.strictEqual(v.visible, false, 'off the window is hidden, not stretched');
});

test('hide destroys the view and is safe to repeat; the page stops (hidden means stopped)', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  r.m.hide(r.owner);
  r.m.hide(r.owner);
  assert.strictEqual(r.children.size, 0);
  assert.ok(r.views[0].webContents.calls.some(c => c[0] === 'crash'));
  assert.strictEqual(r.m.has(r.owner), false);
});

test('the owner going away takes its view with it', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  r.owner.emit('destroyed');
  assert.strictEqual(r.children.size, 0);
  assert.strictEqual(r.m.has(r.owner), false);
});

test('a destroyed owner gets no view', async () => {
  const owner = new EventEmitter(); owner.id = 7; owner.isDestroyed = () => true;
  const r = rig({ owner });
  const res = await show(r, { port: 20003 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(r.views.length, 0);
});

test('a hide that lands during the session setup wins: the view never joins the window', async () => {
  const r = rig();
  const pending = show(r, { port: 20003 });
  r.m.hide(r.owner);
  const res = await pending;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(r.children.size, 0);
  assert.strictEqual(r.m.lastUrl(r.owner), 'http://localhost:20003/', 'the address that was asked for is not lost to the hide');
});

test('the session holds nothing of the page after it goes', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  r.m.hide(r.owner);
  assert.ok(Object.values(r.sessions)[0].clears >= 2, 'storage and cache cleared');
});

// ---- the probe seam -------------------------------------------------------------------------------------------------------

test('inspect reports a view from the outside: where it is, whether it shows, its address and the title its page set; read-only', async () => {
  const r = rig();
  assert.deepStrictEqual(r.m.inspect(r.owner), { exists: false });
  await show(r, { port: 20003 });
  r.views[0].webContents.title = 'tick 4';
  const i = r.m.inspect(r.owner);
  assert.deepStrictEqual(i, { exists: true, bounds: { x: 300, y: 140, width: 400, height: 500 }, visible: true, url: 'http://localhost:20003/', title: 'tick 4' });
  r.m.setCovered(r.owner, true);
  assert.strictEqual(r.m.inspect(r.owner).visible, false);
});

test('shotTarget gives the probe the contents of a view that exists, and nothing for one that does not', async () => {
  const r = rig();
  assert.strictEqual(r.m.shotTarget(r.owner), null);
  await show(r, { port: 20003 });
  assert.strictEqual(r.m.shotTarget(r.owner), r.views[0].webContents);
});

// ---- properties -----------------------------------------------------------------------------------------------------------

test('property: whatever a page navigates to, it is let through only if the guard accepts it', async () => {
  const guard = require('../app/preview-guard');
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  fc.assert(fc.property(fc.oneof(fc.webUrl(), fc.string({ maxLength: 60 }), fc.constantFrom('http://localhost:1/', 'http://[::1]:9/x', 'http://127.0.0.1:80/')), fc.constantFrom('will-navigate', 'will-redirect', 'will-frame-navigate'), (url, ev) => {
    return emitNav(wc, ev, url) === !guard.previewUrl(url).ok;
  }), { numRuns: 400 });
});

// ---- PR #198 fix pass ------------------------------------------------------------------------------------------------------------

test('the proxy is never direct (Dexter 1): a direct session lets a WebRTC TURN allocation reach any host', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const ses = Object.values(r.sessions)[0];
  assert.notStrictEqual(ses.proxy.mode, 'direct');
  assert.strictEqual(ses.proxy.mode, 'fixed_servers');
  assert.match(ses.proxy.proxyRules, /127\.0\.0\.1:1$/);
});

test('one frame rule (Dexter 2 / Miguel Y4): sub-frames may be blob: of the loopback origin, data:, srcdoc or loopback pages; the main frame may not be blob/data', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  for (const u of ['blob:http://localhost:20003/abc', 'data:text/html,<p>x</p>', 'about:srcdoc', 'http://localhost:20003/frame']) {
    assert.strictEqual(emitNav(wc, 'will-frame-navigate', u, { isMainFrame: false }), false, `sub-frame ${u}`);
    assert.strictEqual(emitNav(wc, 'will-frame-navigate', u, { isMainFrame: true }), !/^http:/.test(u), `main frame ${u}`);
  }
  for (const u of ['https://example.com/', 'file:///C:/x', 'blob:https://example.com/x', 'http://localhost:7701/']) {
    assert.strictEqual(emitNav(wc, 'will-frame-navigate', u, { isMainFrame: false }), true, `sub-frame ${u}`);
  }
});

test('the app own ports are refused for the page: navigation, frame and request, with a header line (Miguel Y3)', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const wc = r.views[0].webContents;
  assert.strictEqual(emitNav(wc, 'will-navigate', 'http://127.0.0.1:7701/'), true);
  assert.strictEqual(lastEvent(r, 'blocked').text, 'blocked: a port this app uses');
  const ses = Object.values(r.sessions)[0];
  let out; ses.requestFilter({ url: 'http://127.0.0.1:7750/x' }, (x) => { out = x; });
  assert.strictEqual(out.cancel, true);
});

test('extra ports named by the caller are refused too (the probe driver)', async () => {
  const events = [];
  const owner = new EventEmitter(); owner.id = 7; owner.isDestroyed = () => false;
  const sessions = {}; const views = [];
  const m = createPreviewViews({
    WebContentsView: class extends FakeView { constructor(o) { super(o); views.push(this); } },
    session: { fromPartition: (p) => (sessions[p] = sessions[p] || new FakeSession(p)) },
    addChild() {}, removeChild() {}, ownerBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), onEvent: (o, ev) => events.push(ev), denyPorts: [4321],
  });
  await m.show(owner, { target: { port: 20003 }, rect: RECT });
  assert.strictEqual(emitNav(views[0].webContents, 'will-navigate', 'http://localhost:4321/'), true);
  let out; Object.values(sessions)[0].requestFilter({ url: 'http://localhost:4321/' }, (x) => { out = x; });
  assert.strictEqual(out.cancel, true);
});

test('a loopback request cut for its length says so on the header (Dexter 5)', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const ses = Object.values(r.sessions)[0];
  let out; ses.requestFilter({ url: 'http://localhost:20003/api?q=' + 'x'.repeat(40000) }, (x) => { out = x; });
  assert.strictEqual(out.cancel, true);
  assert.match(lastEvent(r, 'blocked').text, /a request longer than 32768 characters/);
  ses.requestFilter({ url: 'http://localhost:20003/api?q=' + 'x'.repeat(9000) }, (x) => { out = x; });
  assert.strictEqual(out.cancel, false);
});

test('a new view of the session waits for the last one\'s storage to be emptied before it loads anything (Dexter 7)', async () => {
  const r = rig();
  await show(r, { port: 20003 });
  const ses = Object.values(r.sessions)[0];
  let release;
  const pending = new Promise((res) => { release = res; });
  ses.clearStorageData = () => pending;
  r.m.hide(r.owner);
  const again = show(r, { port: 20004 });
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(r.views.length, 2);
  assert.ok(!r.views[1].webContents.calls.some(c => c[0] === 'load'), 'not loaded while the clear is pending');
  assert.strictEqual(r.children.has(r.views[1]), false, 'not even in the window yet');
  release();
  await again;
  assert.ok(r.views[1].webContents.calls.some(c => c[0] === 'load'));
});
