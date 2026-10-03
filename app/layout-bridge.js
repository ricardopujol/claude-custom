'use strict';
/**
 * Main's side of the GLOBAL dock layout (layout pass L1, S6): which module sits
 * in which zone for every tab that hasn't got its own. Install-wide, like the
 * unfocused dim and the agent-images toggle, so it lives in main's store
 * (`.harness/state/layout-global.json`) and not in a host.
 *
 * Main stores and relays; it never judges the shape. The page normalizes every
 * layout it reads (app/dock-layout.js) because only the page knows which
 * modules this build has. So a missing record reads as `null` -- "migrate from
 * the old per-window settings" -- rather than a default invented here.
 *
 * Same boundary shape as app/avatar-bridge.js: gated to this window's tab
 * views, a push goes to every view, and a watcher follows changes other
 * project windows (other mains sharing the store file) make.
 */
const fs = require('fs');

const LAYOUT_KEY = 'layout-global';
const GET_CHANNEL = 'layout:get';
const SET_CHANNEL = 'layout:set';
const PUSH_CHANNEL = 'layout-global';
// The split-tree layout (dockable panels D1) is the same bridge under its own names. `layout-global`
// is left alone: a window on an older build may still write it, and a version-2 object read by L1's
// normalizer would come out as the default and be saved over it.
const TREE_NAMES = { key: 'layout-tree', get: 'layout-tree:get', set: 'layout-tree:set', push: 'layout-tree' };
const DEFAULT_NAMES = { key: LAYOUT_KEY, get: GET_CHANNEL, set: SET_CHANNEL, push: PUSH_CHANNEL };
// Seven modules in four zones is well under 1 KB; the cap only stops a bad
// sender from bloating the store and every push.
const MAX_LAYOUT_BYTES = 8192;

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

function readLayout(store, key = LAYOUT_KEY) {
  try {
    const rec = store.read(key, null);
    return isPlainObject(rec) ? rec : null;
  } catch {
    return null;
  }
}

/**
 * The stored layout WITH the store's status, for `layout:get`. The page may
 * migrate (and save over the file) only on `missing` -- ENOENT and nothing
 * else. An unreadable file (antivirus holding it, EBUSY) or a corrupt one is
 * said so, never reported as "nothing saved" (PR #82 Dexter F3, Miguel I1).
 */
function readLayoutState(store, key = LAYOUT_KEY) {
  let st;
  try {
    st = typeof store.readState === 'function'
      ? store.readState(key)
      : { status: 'ok', value: store.read(key, null) };
  } catch {
    return { status: 'unreadable', layout: null };
  }
  if (st.status === 'missing') return { status: 'missing', layout: null };
  if (st.status !== 'ok') return { status: st.status === 'corrupt' ? 'corrupt' : 'unreadable', layout: null };
  if (st.value === null || st.value === undefined) return { status: 'missing', layout: null };
  return isPlainObject(st.value) ? { status: 'ok', layout: st.value } : { status: 'corrupt', layout: null };
}

function registerLayoutHandlers({ ipcMain, store, sync = {}, isSender, send, names = DEFAULT_NAMES }) {
  const fromView = e => !!e && typeof isSender === 'function' && isSender(e.sender) === true;

  ipcMain.handle(names.get, e => (fromView(e) ? readLayoutState(store, names.key) : null));

  ipcMain.handle(names.set, (e, value) => {
    if (!fromView(e) || !isPlainObject(value)) return null;
    let json;
    try { json = JSON.stringify(value); } catch { return null; }
    if (Buffer.byteLength(json, 'utf8') > MAX_LAYOUT_BYTES) return null;
    try {
      store.update(names.key, null, () => value);
    } catch (err) {
      console.error('[main] could not save the layout:', err && err.message);
      return null;
    }
    // The watcher must know what this window was just told, or it would push
    // the same layout back when its own write lands in the file.
    sync.last = json;
    try { send(names.push, value); } catch { /* window is going away */ }
    return value;
  });
}

/**
 * Other project windows are other mains sharing the store file: poll it
 * (fs.watchFile survives the store's temp+rename writes) and push when the
 * layout differs from the last one this window was told. A failed read (EBUSY
 * under an antivirus scan, a corrupt file) says nothing: skip it.
 * Returns stop().
 */
function watchLayout({
  store, file, intervalMs = 500, watchFile = fs.watchFile, unwatchFile = fs.unwatchFile, sync = {}, send, names = DEFAULT_NAMES,
}) {
  const now = () => { const l = readLayout(store, names.key); return l === null ? null : JSON.stringify(l); };
  sync.last = now();
  const listener = () => {
    if (typeof store.readState === 'function') {
      const st = store.readState(names.key);
      if (st.status !== 'ok' && st.status !== 'missing') return;
    }
    const json = now();
    if (json === null || json === sync.last) return;
    sync.last = json;
    try { send(names.push, JSON.parse(json)); } catch { /* window is going away */ }
  };
  watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

module.exports = {
  readLayout, readLayoutState, registerLayoutHandlers, watchLayout,
  LAYOUT_KEY, GET_CHANNEL, SET_CHANNEL, PUSH_CHANNEL, MAX_LAYOUT_BYTES, TREE_NAMES,
};
