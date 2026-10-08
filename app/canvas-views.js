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
 *     exactly on the artifact shelf. Each must come with a real click, or an Enter or Space press, the contents received (a script cannot press
 *     its own button), one use per click, one line of text. It can also READ the shelf (the host fills it from the CLI's hook).
 *   - no native dialog over the app's window: alert/confirm/prompt are disabled (`disableDialogs`). Measured (Electron 33, verify/
 *     probe-canvas-sandbox.js, PR #122 Dexter R2): `window.print()` raises NO dialog but wedges the panel's renderer and the browser's
 *     exit (app/quit-watchdog.js ends a stalled quit; `hide` kills the renderer outright), `<input type=file>` raises none, `<input type=color>`
 *     raises a popup widget, not a dialog. The probe fails the day any of them becomes a native dialog. None of the panel's abilities
 *     (`fetch`, `send`, `open`, reading the shelf) shows a picker or reads a file.
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
  totalAsks: 12,                 // questions one view may put to the person in its lifetime; past this a new host is refused unasked (PR #122 Miguel G3)
  inputWindowMs: 2000,           // how recent a real click or Enter/Space press must be for a `send` to count
});

const DEAD_PROXY = Object.freeze({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:1', proxyBypassRules: '<-loopback>' });
// A GESTURE, not an event: a click is a mouseDown and its mouseUp. Only the mouseDown arms the gate; the mouseUp keeps it fresh without
// un-spending it (PR #122 Dexter F7 / Miguel G1: a mouseUp re-armed it, so onmousedown + onclick sent twice from one click).
// A KEY counts as a click only for the two keys that activate a button, Enter and Space, once per press and never on auto-repeat (PR #125
// Dexter #6, Ricardo's call 2026-10-08: typing into a field of the page, or holding a key, must authorise nothing). Which key is not in
// 'input-event' (a type and modifiers only), so keys are read from 'before-input-event'. Space acts on the key UP in a browser, so a
// release of Enter or Space keeps the press fresh, like a mouseUp.
const ARMS = new Set(['mouseDown']);
const KEEPS_FRESH = new Set(['mouseUp']);
const ACTIVATION_KEYS = new Set(['Enter', ' ']);

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
  isOwnerVisible = () => true, openUrl = () => false, fetchImpl, resolveHost, now = Date.now, log = () => {} } = {}) {
  const byOwner = new Map();          // owner contents id -> record
  const byPanel = new Map();          // panel contents id -> record
  // ONE in-memory session per tab, kept across hide/show: Electron never frees a session, so a fresh partition per show leaked a network
  // context, a webRequest hook and permission handlers every time the module was shown (PR #122 Dexter F8 / Miguel G2). Storage and
  // cache are cleared whenever the view goes.
  const sessions = new Map();        // partition -> { ses, ready }: ready = the dead proxy is in place
  const watched = new Set();         // owner ids whose 'destroyed' we already listen for

  function applyBounds(rec) {
    const v = rec.view;
    if (!rec.attached || rec.dead || !v || v.webContents.isDestroyed()) return;       // not in the window yet: the latched state is applied when it is
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

  // The session's half of the lock-down. Done ONCE per session: a tab's panel keeps one session across hide/show (below).
  function lockSession(ses) {
    ses.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
    if (typeof ses.setSpellCheckerEnabled === 'function') ses.setSpellCheckerEnabled(false);
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !String(d.url).startsWith('data:') }));
    // `<a download href="data:...">` is not a navigation, so the guards below never see it, and a `data:` request is allowed:
    // with no handler Electron raises a Save-As box for a file name and content the page chose (measured: verify/probe-canvas-sandbox.js).
    if (typeof ses.on === 'function') ses.on('will-download', (e) => e.preventDefault());
  }

  function lockContents(wc) {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const ev of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) wc.on(ev, (e) => e.preventDefault());
    // A page whose beforeunload handler cancels leaving it would pin itself: Claude's next page is a loadURL, which runs that handler,
    // and with no listener here Electron cancels the load. preventDefault ignores the handler and lets the unload happen.
    wc.on('will-prevent-unload', (e) => e.preventDefault());
    try { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* a destroyed contents has nothing left to protect */ }
    wc.setAudioMuted(true);
  }

  // The record is registered SYNCHRONOUSLY, before anything awaits: a hide, a tab switch or a second show that lands while the proxy is
  // being set must find it (PR #122 Dexter F4 / Miguel Y1). The view joins the window only once the proxy is in place (rec.ready).
  function begin(owner) {
    const partition = `canvas-${owner.id}`;                   // no `persist:`: nothing outlives the app
    let st = sessions.get(partition);
    if (!st) {
      const fresh = session.fromPartition(partition);
      lockSession(fresh);
      st = { ses: fresh, ready: null };
      sessions.set(partition, st);
    }
    if (!st.ready) st.ready = Promise.resolve(st.ses.setProxy(DEAD_PROXY)).catch((err) => { st.ready = null; throw err; });
    const ses = st.ses;
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, preload: preloadPath, partition,
      // alert/confirm/prompt are native message boxes parented to the app's window: a page looping on confirm() would lock the
      // whole window (and a single one carries text the page chose, under the app's title). Both set: disableDialogs wins.
      disableDialogs: true, safeDialogs: true,
    } });
    const wc = view.webContents;
    const rec = { owner, view, wc, ses, rect: null, covered: false, ownerVisible: !!isOwnerVisible(owner), html: null, approved: new Set(), denied: new Set(),
      pending: new Map(), asked: 0, lastInput: -Infinity, spent: true, attached: false, dead: false, ready: null, shelf: [], shelfKey: '[]' };
    wc.on('input-event', (_e, ev) => {
      if (!ev) return;
      if (ARMS.has(ev.type)) { rec.lastInput = now(); rec.spent = false; } else if (KEEPS_FRESH.has(ev.type)) rec.lastInput = now();
    });
    wc.on('before-input-event', (_e, input) => {
      if (!input || !ACTIVATION_KEYS.has(input.key)) return;
      if (input.type === 'keyDown' && input.isAutoRepeat !== true) { rec.lastInput = now(); rec.spent = false; }
      else if (input.type === 'keyUp') rec.lastInput = now();
    });
    wc.on('render-process-gone', (_e, d) => log(`[canvas] panel renderer gone: ${d && d.reason}`));
    lockContents(wc);
    byOwner.set(owner.id, rec);
    byPanel.set(wc.id, rec);
    if (typeof owner.once === 'function' && !watched.has(owner.id)) {
      watched.add(owner.id);
      owner.once('destroyed', () => {
        watched.delete(owner.id);
        const cur = byOwner.get(owner.id);
        if (cur) destroyRecord(cur);
        sessions.delete(partition);
      });
    }
    const proxied = st.ready;
    rec.ready = (async () => {
      await proxied;                                       // awaited: nothing may load before the proxy is in place
      if (rec.dead) return false;                          // hidden or destroyed meanwhile: the view never joins the window
      addChild(view);
      rec.attached = true;
      applyBounds(rec);
      return true;
    })().catch((err) => { log(`[canvas] could not start the panel: ${err && err.message}`); destroyRecord(rec); return false; });
    return rec;
  }

  function destroyRecord(rec) {
    rec.dead = true;
    if (byOwner.get(rec.owner.id) === rec) byOwner.delete(rec.owner.id);
    byPanel.delete(rec.wc.id);
    try { removeChild(rec.view); } catch { /* the window is going away */ }
    // Killed outright first, healthy or not: a renderer wedged inside window.print() never answers a polite close, and the app then cannot
    // exit (measured, verify/probe-canvas-sandbox.js print-loop). The page is being thrown away either way.
    try { if (!rec.wc.isDestroyed()) rec.wc.forcefullyCrashRenderer(); } catch { /* nothing left to kill */ }
    try { if (!rec.wc.isDestroyed()) rec.wc.close(); } catch { /* already gone */ }
    // The session stays (Electron never frees one) but holds nothing of the page that was in it.
    for (const clear of ['clearStorageData', 'clearCache']) { try { Promise.resolve(rec.ses[clear] && rec.ses[clear]()).catch(() => {}); } catch { /* nothing to clear */ } }
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
    if (owner && typeof owner.isDestroyed === 'function' && owner.isDestroyed()) return { ok: false, error: 'the tab is gone', stale: true };
    const rec = byOwner.get(owner.id) || begin(owner);
    setHosts(owner, hosts);
    if (shelf !== undefined) { const clean = cleanShelf(shelf); rec.shelf = clean; rec.shelfKey = JSON.stringify(clean); }
    rec.rect = isRect(rect) ? rect : rec.rect;
    rec.covered = !!covered;
    applyBounds(rec);
    // A hide (or a newer show that replaced this record) during the proxy await is the last word: this show then has nothing to do.
    if (!(await rec.ready) || rec.dead) return { ok: false, error: 'the panel was closed before it started', stale: true };
    if (rec.html !== html) {
      rec.html = html;
      const url = 'data:text/html;base64,' + Buffer.from(buildPage(html), 'utf8').toString('base64');
      rec.wc.loadURL(url).catch((err) => {
        log(`[canvas] load failed: ${err && err.message}`);
        if (rec.html === html) rec.html = null;      // not shown: the same page is tried again on the next show, not skipped as 'already there'
      });
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
      fetchImpl,           // undefined: the broker's own pinned transport (app/canvas-net.js); never the engine's fetch, which resolves for itself
      resolveHost,
      decide: (o) => (rec.approved.has(o) ? 'allow' : rec.denied.has(o) ? 'deny' : 'ask'),
      ask: (origin) => {
        if (rec.pending.has(origin)) return rec.pending.get(origin);
        if (rec.pending.size >= PANEL_LIMITS.pendingAsks || rec.asked >= PANEL_LIMITS.totalAsks) return Promise.resolve('deny');
        rec.asked += 1;
        const p = (async () => {
          let answer = 'deny';
          try { answer = (await ask(rec.owner, origin)) === 'allow' ? 'allow' : 'deny'; } catch { /* no answer is a no */ }
          (answer === 'allow' ? rec.approved : rec.denied).add(origin);       // bounded by totalAsks
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
