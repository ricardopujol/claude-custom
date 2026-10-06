'use strict';
/**
 * Claude's panel, main-process side (BACKLOG #71, documentation/DESIGN_LIVE_PANEL.md).
 *
 * The page the panel shows was written by the running Claude and is UNTRUSTED. It does not live in the app's page: each
 * tab's panel is a WebContentsView of its own, on its own in-memory session, laid over the dock panel's body at the
 * rectangle the tab's page reports. verify/probe-canvas-sandbox.js measured why an iframe in the tab page was not enough
 * (Electron 33 / Chromium 130, a strict CSP and a navigation guard in place): WebRTC over UDP, WebRTC TURN over TCP (a raw
 * connection to any host:port, loopback included) and `<link rel=dns-prefetch>` all still reached out. So here:
 *
 *   - the session's proxy is one nothing listens on, and `<-loopback>` takes loopback too: no direct TCP or UDP
 *     connection from the panel can complete. WebRTC UDP is also shut by policy.
 *   - every request but the one `data:` document is cancelled; all permissions, devices and windows are refused;
 *     the contents can never navigate (a page that sets its own location goes nowhere).
 *   - DNS is shut for the whole process in app/main.js (`host-resolver-rules`): the app makes no external Chromium request.
 *   - the panel's `fetch` is a message to this module, which makes the request itself, only to a host the person
 *     approved for THAT panel (app/canvas-fetch.js). An unknown host is a question to the owner's page, asked once.
 *   - the only other things the panel can do: `send` a line of text toward the session (a button), and `open` an address that is
 *     exactly on the artifact shelf. Each must come with a real click or key press the contents received (a script cannot press
 *     its own button), one use per click, one line of text. It can also READ the shelf (the host fills it from the CLI's hook).
 *   - hidden means stopped (design, call 7): `hide` destroys the view, so no timer or fetch of the page keeps running.
 *
 * The Electron classes arrive as arguments so test/canvas-views.test.js can drive this with fakes.
 */
const { brokerFetch } = require('./canvas-fetch');
const { buildPage, hostOrigin } = require('./canvas-csp');

const PANEL_LIMITS = Object.freeze({
  htmlBytes: 1024 * 1024,        // the design's size cap on index.html
  messageChars: 2000,
  pendingAsks: 3,                // hosts waiting on an answer at once; past this a new one is refused unasked
  inputWindowMs: 2000,           // how recent a real click or key press must be for a `send` to count
});

const DEAD_PROXY = Object.freeze({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:1', proxyBypassRules: '<-loopback>' });
const CLICK_TYPES = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char']);

const isRect = (r) => r !== null && typeof r === 'object' && ['x', 'y', 'width', 'height'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]));
const SHELF_MAX = 200;
function cleanShelf(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (it === null || typeof it !== 'object' || typeof it.title !== 'string' || it.title === '' || typeof it.time !== 'string' || typeof it.url !== 'string') continue;
    let u;
    try { u = new URL(it.url); } catch { continue; }
    if (u.protocol === 'https:' && !u.username && !u.password && out.length < SHELF_MAX) out.push({ title: it.title, url: it.url, time: it.time });
  }
  return out;
}
const originList = (list) => [...new Set((Array.isArray(list) ? list : []).map(hostOrigin).filter(Boolean))];

function createCanvasViews({ WebContentsView, session, addChild, removeChild, ownerBounds, preloadPath, ask, onMessage,
  openUrl = () => false, fetchImpl = fetch, now = Date.now, log = () => {} } = {}) {
  const byOwner = new Map();          // owner contents id -> record
  const byPanel = new Map();          // panel contents id -> record
  let counter = 0;

  function applyBounds(rec) {
    const v = rec.view;
    if (!v || v.webContents.isDestroyed()) return;
    const ob = ownerBounds(rec.owner);
    let shown = rec.ownerVisible && !rec.covered && ob && isRect(rec.rect);
    let b = null;
    if (shown) {
      let x = Math.round(rec.rect.x) + ob.x; let y = Math.round(rec.rect.y) + ob.y;
      let w = Math.round(rec.rect.width); let h = Math.round(rec.rect.height);
      if (x < ob.x) { w -= ob.x - x; x = ob.x; }
      if (y < ob.y) { h -= ob.y - y; y = ob.y; }
      w = Math.min(w, ob.x + ob.width - x); h = Math.min(h, ob.y + ob.height - y);
      if (w > 0 && h > 0) b = { x, y, width: w, height: h }; else shown = false;
    }
    if (b) { v.setBounds(b); rec.lastBounds = b; }
    rec.lastVisible = !!shown;
    v.setVisible(!!shown);
  }

  function lockDown(ses, wc) {
    ses.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
    if (typeof ses.setSpellCheckerEnabled === 'function') ses.setSpellCheckerEnabled(false);
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !String(d.url).startsWith('data:') }));
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const ev of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) wc.on(ev, (e) => e.preventDefault());
    try { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* a destroyed contents has nothing left to protect */ }
    wc.setAudioMuted(true);
  }

  async function create(owner) {
    counter += 1;
    const partition = `canvas-${owner.id}-${counter}`;       // no `persist:`: nothing outlives the view
    const ses = session.fromPartition(partition);
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, preload: preloadPath, partition,
    } });
    const wc = view.webContents;
    const rec = { owner, view, wc, ses, rect: null, covered: false, ownerVisible: true, html: null, approved: new Set(), denied: new Set(),
      pending: new Map(), lastInput: -Infinity, spent: true, shelf: [], shelfKey: '[]' };
    wc.on('input-event', (_e, ev) => { if (ev && CLICK_TYPES.has(ev.type)) { rec.lastInput = now(); rec.spent = false; } });
    wc.on('render-process-gone', (_e, d) => log(`[canvas] panel renderer gone: ${d && d.reason}`));
    lockDown(ses, wc);
    await ses.setProxy(DEAD_PROXY);                          // awaited: nothing may load before the proxy is in place
    addChild(view);
    byOwner.set(owner.id, rec);
    byPanel.set(wc.id, rec);
    if (typeof owner.once === 'function') owner.once('destroyed', () => destroyRecord(rec));
    return rec;
  }

  function destroyRecord(rec) {
    byOwner.delete(rec.owner.id);
    byPanel.delete(rec.wc.id);
    try { removeChild(rec.view); } catch { /* the window is going away */ }
    try { if (!rec.wc.isDestroyed()) rec.wc.close(); } catch { /* already gone */ }
  }

  function setHosts(owner, hosts) {
    const rec = byOwner.get(owner.id);
    if (!rec) return;
    rec.approved = new Set(originList(hosts && hosts.approved));
    rec.denied = new Set(originList(hosts && hosts.denied));
  }

  // The artifact shelf: given with the page, and pushed to the live panel when it changes. The page can only READ it.
  function setShelf(owner, items) {
    const rec = byOwner.get(owner && owner.id);
    if (!rec) return;
    const clean = cleanShelf(items);
    const key = JSON.stringify(clean);
    if (key === rec.shelfKey) return;
    rec.shelf = clean; rec.shelfKey = key;
    try { if (!rec.wc.isDestroyed()) rec.wc.send('canvas:shelf', clean); } catch { /* the contents is going away */ }
  }

  async function show(owner, { html, hosts, rect, covered = false, shelf } = {}) {
    if (typeof html !== 'string') return { ok: false, error: 'no page' };
    if (Buffer.byteLength(html) > PANEL_LIMITS.htmlBytes) return { ok: false, error: 'the page is too big' };
    let rec = byOwner.get(owner.id);
    if (!rec) rec = await create(owner);
    setHosts(owner, hosts);
    if (shelf !== undefined) { const clean = cleanShelf(shelf); rec.shelf = clean; rec.shelfKey = JSON.stringify(clean); }
    rec.rect = isRect(rect) ? rect : rec.rect;
    rec.covered = !!covered;
    applyBounds(rec);
    if (rec.html !== html) {
      rec.html = html;
      const url = 'data:text/html;base64,' + Buffer.from(buildPage(html), 'utf8').toString('base64');
      rec.wc.loadURL(url).catch((err) => log(`[canvas] load failed: ${err && err.message}`));
    }
    return { ok: true };
  }

  const withRec = (owner, fn) => { const rec = byOwner.get(owner && owner.id); if (rec) fn(rec); };
  const setBounds = (owner, rect) => withRec(owner, (rec) => { rec.rect = rect; applyBounds(rec); });
  const setCovered = (owner, covered) => withRec(owner, (rec) => { rec.covered = !!covered; applyBounds(rec); });
  const setOwnerVisible = (owner, visible) => withRec(owner, (rec) => { rec.ownerVisible = !!visible; applyBounds(rec); });
  const relayout = (owner) => withRec(owner, applyBounds);
  const hide = (owner) => withRec(owner, destroyRecord);
  const destroyFor = hide;
  const has = (owner) => byOwner.has(owner && owner.id);

  // PROBE SEAMS (app/main.js exposes them only on the probe driver's authenticated channel): read-only, and a real press. There
  // is deliberately no way to run code in the panel from outside it: a probe reads what the page chose to put in its title.
  function inspect(owner) {
    const rec = byOwner.get(owner && owner.id);
    if (!rec) return { exists: false };
    let title = '';
    try { title = rec.wc.getTitle(); } catch { /* destroyed */ }
    return { exists: true, bounds: rec.lastBounds || null, visible: rec.lastVisible === true, title };
  }
  function click(owner, x, y) {
    const rec = byOwner.get(owner && owner.id);
    if (!rec) return false;
    rec.wc.sendInputEvent({ type: 'mouseMove', x, y });
    rec.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    rec.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return true;
  }

  async function fetchFor(sender, req) {
    const rec = sender ? byPanel.get(sender.id) : null;
    if (!rec) return { ok: false, error: 'not a panel' };
    return brokerFetch(req, {
      fetchImpl,
      decide: (o) => (rec.approved.has(o) ? 'allow' : rec.denied.has(o) ? 'deny' : 'ask'),
      ask: (origin) => {
        if (rec.pending.has(origin)) return rec.pending.get(origin);
        if (rec.pending.size >= PANEL_LIMITS.pendingAsks) return Promise.resolve('deny');
        const p = (async () => {
          let answer = 'deny';
          try { answer = (await ask(rec.owner, origin)) === 'allow' ? 'allow' : 'deny'; } catch { /* no answer is a no */ }
          (answer === 'allow' ? rec.approved : rec.denied).add(origin);
          return answer;
        })().finally(() => rec.pending.delete(origin));
        rec.pending.set(origin, p);
        return p;
      },
    });
  }

  function messageFrom(sender, msg) {
    const rec = sender ? byPanel.get(sender.id) : null;
    if (!rec) return false;
    if (msg === null || typeof msg !== 'object' || msg.kind !== 'send' || typeof msg.text !== 'string') return false;
    const text = msg.text.trim();
    if (!text || text.length > PANEL_LIMITS.messageChars || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) return false;
    if (!takeClick(rec)) return false;
    onMessage(rec.owner, { kind: 'send', text });
    return true;
  }

  // A real click or key press the contents received a moment ago, spent by whichever of `send` and `open` uses it first.
  function takeClick(rec) {
    if (rec.spent || now() - rec.lastInput > PANEL_LIMITS.inputWindowMs) return false;
    rec.spent = true;
    return true;
  }

  const shelfFor = (sender) => { const rec = sender ? byPanel.get(sender.id) : null; return rec ? rec.shelf : []; };

  /** Open one of the shelf's own addresses in the browser, on a real click. Never any other address, never a variant of one. */
  function openFrom(sender, msg) {
    const rec = sender ? byPanel.get(sender.id) : null;
    if (!rec || msg === null || typeof msg !== 'object' || typeof msg.url !== 'string' || !rec.shelf.some(i => i.url === msg.url)) return false;
    if (!takeClick(rec)) return false;
    try { return openUrl(msg.url) !== false; } catch { return false; }
  }

  return { show, setBounds, setCovered, setOwnerVisible, setHosts, setShelf, relayout, hide, destroyFor, has, fetchFor, messageFrom, shelfFor, openFrom, inspect, click };
}

// Process-wide, set before the app is ready (app/main.js): Chromium resolves nothing but loopback. This is the only thing
// that shuts DNS prefetch, which a proxy and a CSP both leave open (measured). It costs nothing today: the app makes no
// external request of its own through Chromium (the host and the Electron main process use Node's networking).
const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';

/** The four channels the panel's preload talks on. `ipc` is Electron's ipcMain; `views` is a createCanvasViews result. */
function registerCanvasIpc(ipc, views) {
  ipc.handle('canvas:fetch', (e, req) => views.fetchFor(e.sender, req));
  ipc.handle('canvas:shelf', (e) => views.shelfFor(e.sender));
  ipc.on('canvas:send', (e, msg) => { views.messageFrom(e.sender, msg); });
  ipc.on('canvas:open', (e, msg) => { views.openFrom(e.sender, msg); });
}

module.exports = { createCanvasViews, registerCanvasIpc, HOST_RESOLVER_RULES, PANEL_LIMITS, DEAD_PROXY };
