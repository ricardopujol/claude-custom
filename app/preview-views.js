'use strict';
/**
 * The Preview panel, main-process side (BACKLOG #119 A4). It shows a page a dev server of this worktree serves, so unlike Claude's
 * panel (app/canvas-views.js, whose page is untrusted and is cut off from the network) this one MUST reach loopback. What it keeps
 * from that pattern is the shape: one WebContentsView per tab, on its own in-memory session, laid over a slot of the tab's page, and
 * destroyed when hidden. What changes is the rule: app/preview-guard.js, loopback http and nothing else.
 *
 * THE WALLS, every one of them in this file:
 *   - no preload, no Node, sandbox and context isolation on, no webview, no dialogs: the page gets no bridge to the app.
 *   - navigation: will-navigate, will-redirect and will-frame-navigate refuse anything the guard refuses, in any frame; the refusal is
 *     said on the header ("blocked: example.com"). window.open makes no window (it is refused, even to loopback). A download is
 *     cancelled. Every permission and device request is refused.
 *   - requests: the session filter cancels everything that is not loopback http/ws (or data:/blob:), which also covers an address
 *     given as an IP literal, where the process-wide resolver rule (app/main.js) cannot help.
 *   - nothing is kept: the session is in memory and emptied whenever the view goes. The last ADDRESS per worktree is remembered in this
 *     process only, so the panel comes back to where it was.
 *
 * ACCEPTED, ON PURPOSE (PR #198 review):
 *   - The header's "open in browser" opens the page's CURRENT loopback address, which may be one the page moved itself to (Dexter 6): only
 *     loopback can be chosen, never the app's own ports, and the address field shows it first. It is kept.
 *   - The page may request `devtools:` addresses because the DevTools window needs them in this session; Chromium blocks that scheme for
 *     web content (Miguel S5).
 *   - The deny of the app's own ports covers URL loads only. A WebRTC TURN socket to 127.0.0.1:77xx is a non-URL connection to loopback,
 *     which the proxy must leave direct for the dev server to load, so nothing in the session stops it. It carries only fixed STUN bytes with no
 *     page-chosen field, and every port demands its token (Dexter r2 N3).
 *   - The block of ports for each tab is read from the ports file once per tab per sample, on the main thread (a small read, Miguel S2).
 *   - app/main.js keeps its own `win.on` and `will-quit` lines for the sampler beside the Resources ones, so the lines the Resources
 *     tests pin stay as they are (Miguel S1); the tray's hide/show feeds both (host/dev-servers.js unseen).
 *
 * The Electron classes arrive as arguments so test/preview-views.test.js can drive this with fakes.
 */
const guard = require('./preview-guard');

const REMEMBERED_MAX = 64;               // worktrees whose last address is kept (in memory)
const FAIL_TEXT_MAX = 140;
// A proxy nothing listens on (the same as Claude's panel, app/canvas-views.js), with NO bypass rules: Chromium's implicit bypass keeps loopback direct.
// The bypass rules (PR #198 Dexter r2 N1): <-loopback> FIRST, which removes Chromium's implicit bypass (the rest of 127/8, 169.254/16 and fe80::/10
// would otherwise connect direct), THEN the three hosts the guard allows. MEASURED by verify/probe-preview-bypass.js (the other order sends
// localhost and 127.0.0.1 to the proxy too, and the page never loads): with this list localhost and 127.0.0.1 are direct, and 127.0.0.2, 169.254.x and
// every other address go to the proxy.
const PREVIEW_BYPASS = '<-loopback>;localhost;127.0.0.1;[::1]';
const DEAD_PROXY = Object.freeze({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:1', proxyBypassRules: PREVIEW_BYPASS });
const ABORTED = -3;                      // ERR_ABORTED: a navigation replaced by another, not a failure

const isRect = (r) => r !== null && typeof r === 'object' && ['x', 'y', 'width', 'height'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]));
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + '-' + String.fromCharCode(159) + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + ']+', 'g');
const plain = (s, n) => String(s).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function createPreviewViews({
  WebContentsView, session, addChild, removeChild, ownerBounds, keyOf = () => null, onEvent = () => {},
  isOwnerVisible = () => true, onPress = () => {}, openUrl = () => false, log = () => {}, denyPorts = [],
  // PROBE SEAM only (app/main.js passes it when the probe driver is on): another proxy config, to count what reaches a proxy the probe owns.
  proxyConfig = DEAD_PROXY,
} = {}) {
  const deny = { denyPorts };
  const byOwner = new Map();          // owner contents id -> record
  const sessions = new Map();         // partition -> { ses, ready }
  const watched = new Set();          // owner ids whose 'destroyed' we already listen for
  const remembered = new Map();       // worktree key -> last accepted address

  const emit = (rec, ev) => { try { onEvent(rec.owner, ev); } catch (err) { log(`[preview] event threw: ${err && err.message}`); } };
  const blocked = (rec, text) => emit(rec, { kind: 'blocked', text });

  function remember(owner, url) {
    const key = keyOf(owner);
    if (typeof key !== 'string' || key === '') return;
    remembered.delete(key);
    remembered.set(key, url);
    if (remembered.size > REMEMBERED_MAX) remembered.delete(remembered.keys().next().value);
  }

  function applyBounds(rec) {
    const v = rec.view;
    if (!rec.attached || rec.dead || !v || v.webContents.isDestroyed()) return;
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

  // The session's half of the lock-down, once per session (a tab's panel keeps one across hide/show; Electron never frees a session).
  function lockSession(st) {
    const ses = st.ses;
    ses.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
    if (typeof ses.setSpellCheckerEnabled === 'function') ses.setSpellCheckerEnabled(false);
    ses.webRequest.onBeforeRequest((d, cb) => {
      const v = guard.requestVerdict(d && d.url, deny);
      // A loopback request cut for its length is said on the header: nothing else would tell the page's author why it failed.
      if (v.tooLong && st.rec) blocked(st.rec, `blocked: a request longer than ${guard.MAX_LENGTH} characters`);
      cb({ cancel: !v.ok });
    });
    if (typeof ses.on === 'function') {
      ses.on('will-download', (e) => {
        e.preventDefault();
        if (st.rec) blocked(st.rec, 'blocked: a download');
      });
    }
  }

  const urlOf = (e, arg) => [typeof arg === 'string' ? arg : null, e && typeof e.url === 'string' ? e.url : null].filter(u => u !== null);

  function lockContents(rec) {
    const wc = rec.wc;
    wc.setWindowOpenHandler(() => { blocked(rec, 'blocked: a new window'); return { action: 'deny' }; });
    // Both places Electron puts the address are checked; either one refused refuses the move. An event with no address at all is refused.
    // The MAIN frame goes by the strict rule (previewUrl); a sub-frame by the one frame rule the request filter shares (guard.frameAllowed).
    // An event that does not say it is a sub-frame is the main frame.
    const check = (e, arg) => {
      const urls = urlOf(e, arg);
      const sub = e && e.isMainFrame === false;
      const ok = (u) => (sub ? guard.frameAllowed(u, deny) : guard.previewUrl(u, deny).ok);
      const bad = urls.length === 0 ? '' : urls.find(u => !ok(u));
      if (urls.length === 0 || bad !== undefined) {
        e.preventDefault();
        blocked(rec, guard.blockedLabel(bad === undefined ? '' : bad, deny));
      }
    };
    for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) wc.on(ev, check);
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.on('will-prevent-unload', (e) => e.preventDefault());
    try { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch { /* a destroyed contents has nothing left to protect */ }

    wc.on('did-navigate', (_e, url) => accepted(rec, url));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame !== false) accepted(rec, url); });
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame !== true || code === ABORTED) return;
      emit(rec, { kind: 'failed', text: plain(`couldn't load the page: ${desc}`, FAIL_TEXT_MAX) });
    });
    wc.on('did-start-loading', () => emit(rec, { kind: 'loading', on: true }));
    wc.on('did-stop-loading', () => emit(rec, { kind: 'loading', on: false }));
    wc.on('render-process-gone', (_e, d) => log(`[preview] page renderer gone: ${d && d.reason}`));
  }

  function accepted(rec, url) {
    const r = guard.previewUrl(url, deny);
    if (!r.ok) return;                         // the guard stopped anything else before it got here; never remember it
    rec.url = r.url;
    remember(rec.owner, r.url);
    emit(rec, { kind: 'url', url: r.url });
  }

  function begin(owner) {
    const partition = `preview-${owner.id}`;                  // no `persist:`: nothing outlives the app
    let st = sessions.get(partition);
    if (!st) {
      st = { ses: session.fromPartition(partition), ready: null, rec: null };
      lockSession(st);
      sessions.set(partition, st);
    }
    // SEALED LIKE CLAUDE'S PANEL (PR #198 Dexter 1): a proxy nothing listens on, so every connection that is not a URL load (WebRTC TURN over
    // TCP, preconnect) dies at the proxy and never reaches another host. Loopback is NOT listed in the bypass rules: Chromium's own implicit
    // bypass keeps it direct, which is why the dev server still loads. (`direct` here let a TURN allocate reach any host:port; measured by
    // verify/probe-preview-panel.js.)
    if (!st.ready) st.ready = Promise.resolve(st.ses.setProxy(proxyConfig)).catch((err) => { st.ready = null; throw err; });
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, partition,
      // The header's DevTools button needs them; they open detached, and only on that click.
      devTools: true,
      disableDialogs: true, safeDialogs: true,
    } });
    const wc = view.webContents;
    const rec = { owner, view, wc, ses: st.ses, rect: null, covered: false, ownerVisible: !!isOwnerVisible(owner), url: null, attached: false, dead: false, ready: null, st };
    st.rec = rec;
    lockContents(rec);
    // A press in the page never reaches the owner's document, so the owner is told: a rail popover closes on a press outside it (#138).
    wc.on('input-event', (_e, ev) => { if (ev && ev.type === 'mouseDown') { try { onPress(owner); } catch { /* the owner is going away */ } } });
    byOwner.set(owner.id, rec);
    if (typeof owner.once === 'function' && !watched.has(owner.id)) {
      watched.add(owner.id);
      owner.once('destroyed', () => {
        watched.delete(owner.id);
        const cur = byOwner.get(owner.id);
        if (cur) destroyRecord(cur);
        sessions.delete(partition);
      });
    }
    // Nothing loads before the proxy is in AND the last view's storage has been emptied (PR #198 Dexter 7): the session is reused.
    const proxied = Promise.all([st.ready, st.clearing]);
    rec.ready = (async () => {
      await proxied;                                         // nothing loads before the session is locked
      if (rec.dead) return false;
      addChild(view);
      rec.attached = true;
      applyBounds(rec);
      return true;
    })().catch((err) => { log(`[preview] could not start the panel: ${err && err.message}`); destroyRecord(rec); return false; });
    return rec;
  }

  function destroyRecord(rec) {
    rec.dead = true;
    if (byOwner.get(rec.owner.id) === rec) byOwner.delete(rec.owner.id);
    try { removeChild(rec.view); } catch { /* the window is going away */ }
    try { if (!rec.wc.isDestroyed()) rec.wc.forcefullyCrashRenderer(); } catch { /* nothing left to kill */ }
    try { if (!rec.wc.isDestroyed()) rec.wc.close(); } catch { /* already gone */ }
    // Awaited by the NEXT view of this session before it loads anything (PR #198 Dexter 7).
    const clears = ['clearStorageData', 'clearCache'].map((clear) => { try { return Promise.resolve(rec.ses[clear] && rec.ses[clear]()).catch(() => {}); } catch { return Promise.resolve(); } });
    if (rec.st) rec.st.clearing = Promise.all([rec.st.clearing, ...clears]);
  }

  // What the person (or the chip) asked to see, as a verdict: { ok, url } | { ok: false, reason } | { ok: true, url: null } (nothing asked).
  function resolve(owner, target) {
    if (target === undefined) {
      const key = keyOf(owner);
      const back = typeof key === 'string' ? remembered.get(key) : undefined;
      if (back === undefined) return { ok: true, url: null };
      const r = guard.previewUrl(back, deny);
      return r.ok ? { ok: true, url: r.url } : { ok: true, url: null };
    }
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return { ok: false, reason: 'not an address' };
    if ('port' in target) return guard.forPort(target.port);
    if ('typed' in target) return guard.fromTyped(target.typed);
    return { ok: false, reason: 'not an address' };
  }

  /** show(owner, { target?: { port } | { typed }, rect, covered }) -> { ok, url } | { ok: false, error }. No target: back to the remembered address, if any. */
  async function show(owner, { target, rect, covered = false } = {}) {
    if (!owner || (typeof owner.isDestroyed === 'function' && owner.isDestroyed())) return { ok: false, error: 'the tab is gone', stale: true };
    const verdict = resolve(owner, target);
    if (!verdict.ok) {
      const rec = byOwner.get(owner.id);
      const text = target && typeof target === 'object' && 'typed' in target ? guard.typedLabel(target.typed) : null;
      if (rec) blocked(rec, text || 'blocked: not a local address');
      else onEvent(owner, { kind: 'blocked', text: text || 'blocked: not a local address' });
      return { ok: false, error: verdict.reason };
    }
    let rec = byOwner.get(owner.id);
    if (verdict.url === null && !rec) return { ok: true, url: null };
    rec = rec || begin(owner);
    if (isRect(rect)) rec.rect = rect;
    rec.covered = !!covered;
    applyBounds(rec);
    // Remembered when ASKED for, not when the load starts: a hide that lands during the session setup must not lose the address.
    if (verdict.url !== null) remember(owner, verdict.url);
    if (!(await rec.ready) || rec.dead) return { ok: false, error: 'the panel was closed before it started', stale: true };
    if (verdict.url !== null && rec.url !== verdict.url) {
      rec.url = verdict.url;
      rec.wc.loadURL(verdict.url).catch((err) => {
        // A refused connection also lands on did-fail-load, which tells the header; a load replaced by another is not a failure.
        log(`[preview] load failed: ${err && err.message}`);
        if (rec.url === verdict.url) rec.url = null;
      });
    }
    return { ok: true, url: rec.url };
  }

  const withRec = (owner, fn) => { const rec = byOwner.get(owner && owner.id); return rec ? fn(rec) : undefined; };
  const setBounds = (owner, rect) => withRec(owner, (rec) => { rec.rect = rect; applyBounds(rec); });
  const setCovered = (owner, covered) => withRec(owner, (rec) => { rec.covered = !!covered; applyBounds(rec); });
  const setOwnerVisible = (owner, visible) => withRec(owner, (rec) => { rec.ownerVisible = !!visible; applyBounds(rec); });
  const relayout = (owner) => withRec(owner, applyBounds);
  const hide = (owner) => withRec(owner, destroyRecord);
  const has = (owner) => byOwner.has(owner && owner.id);

  function reload(owner) {
    return withRec(owner, (rec) => { try { rec.wc.reload(); return true; } catch { return false; } }) === true;
  }
  function toggleDevTools(owner) {
    return withRec(owner, (rec) => {
      try {
        if (rec.wc.isDevToolsOpened()) rec.wc.closeDevTools(); else rec.wc.openDevTools({ mode: 'detach' });
        return true;
      } catch { return false; }
    }) === true;
  }
  /** The page's CURRENT address, if (and only if) the guard still accepts it, to the system browser. The page never supplies the address. */
  function openExternal(owner) {
    return withRec(owner, (rec) => {
      let current = '';
      try { current = rec.wc.getURL(); } catch { return false; }
      const ok = guard.previewUrl(current, deny);
      const target = ok.ok ? guard.openExternalTarget(ok.url) : null;
      if (!target) return false;
      try { return openUrl(target) !== false; } catch { return false; }
    }) === true;
  }
  /** A listening port, in the system browser: the chip's "Open in browser". */
  function openPort(port) {
    const r = guard.forPort(port);
    const target = r.ok ? guard.openExternalTarget(r.url) : null;
    if (!target) return false;
    try { return openUrl(target) !== false; } catch { return false; }
  }
  const lastUrl = (owner) => { const key = keyOf(owner); const v = typeof key === 'string' ? remembered.get(key) : undefined; return v === undefined ? null : v; };

  // PROBE SEAM (app/main.js exposes it only on the probe driver's authenticated channel): read-only. A probe reads the title the page chose to set.
  function inspect(owner) {
    const rec = byOwner.get(owner && owner.id);
    if (!rec) return { exists: false };
    let url = ''; let title = '';
    try { url = rec.wc.getURL(); title = rec.wc.getTitle(); } catch { /* destroyed */ }
    return { exists: true, bounds: rec.lastBounds || null, visible: rec.lastVisible === true, url, title };
  }

  // PROBE SEAM, for a picture of the page (app/main.js, the probe driver only): the view's contents, which nothing else gets.
  const shotTarget = (owner) => { const rec = byOwner.get(owner && owner.id); return rec ? rec.wc : null; };

  return { show, setBounds, setCovered, setOwnerVisible, relayout, hide, destroyFor: hide, has, reload, toggleDevTools, openExternal, openPort, lastUrl, inspect, shotTarget };
}

module.exports = { createPreviewViews, PREVIEW_BYPASS };
