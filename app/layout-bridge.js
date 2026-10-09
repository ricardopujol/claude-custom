'use strict';
/**
 * Main's side of the GLOBAL dock layout (layout pass L1, S6): which module sits
 * in which zone for every tab that hasn't got its own. Install-wide, like the
 * unfocused dim and the agent-images toggle, so it lives in main's store
 * (`.harness/state/layout-global.json`) and not in a host.
 *
 * Main stores and relays; it never judges the shape. The page normalizes every
 * layout it reads (app/dock-tree.js, app/dock-migrate.js for L1's shape) because only the page knows which
 * modules this build has. So a missing record reads as `null` -- "migrate from
 * the old per-window settings" -- rather than a default invented here.
 *
 * Same boundary shape as app/avatar-bridge.js: gated to this window's tab
 * views, a push goes to every view, and a watcher follows changes other
 * project windows (other mains sharing the store file) make.
 */
const fs = require('fs');
const { applyOp, needsIds, withIds } = require('./dock-presets');

const LAYOUT_KEY = 'layout-global';
const GET_CHANNEL = 'layout:get';
const SET_CHANNEL = 'layout:set';
const PUSH_CHANNEL = 'layout-global';
// The split-tree layout (dockable panels D1) is the same bridge under its own names. `layout-global`
// is left alone: a window on an older build may still write it, and a version-2 object read by L1's
// normalizer would come out as the default and be saved over it.
const TREE_NAMES = { key: 'layout-tree', get: 'layout-tree:get', set: 'layout-tree:set', push: 'layout-tree' };
// The layout presets (dockable panels D3): the same bridge holding an ARRAY. `shape` is opt-in, so the layout
// names above keep their one-object rule. There is no whole-list `set`: the page sends `op` (what the user did:
// save, rename, delete) and main applies it to a fresh locked read of the file (app/dock-presets.js applyOp).
const PRESET_NAMES = {
  key: 'layout-presets', get: 'layout-presets:get', op: 'layout-presets:op', push: 'layout-presets',
  shape: 'array',
};
const DEFAULT_NAMES = { key: LAYOUT_KEY, get: GET_CHANNEL, set: SET_CHANNEL, push: PUSH_CHANNEL };
// Seven modules in four zones is well under 1 KB; the cap only stops a bad
// sender from bloating the store and every push.
const MAX_LAYOUT_BYTES = 8192;

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
// What a stored or sent value must be for these names: one plain object, or (the presets) one array.
const validFor = names => (names && names.shape === 'array' ? Array.isArray : isPlainObject);

function readLayout(store, key = LAYOUT_KEY, valid = isPlainObject) {
  try {
    const rec = store.read(key, null);
    return valid(rec) ? rec : null;
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
function readLayoutState(store, key = LAYOUT_KEY, valid = isPlainObject) {
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
  // `layout` is the answer's field for the value under every names, the presets' list included.
  return valid(st.value) ? { status: 'ok', layout: st.value } : { status: 'corrupt', layout: null };
}

function registerLayoutHandlers({ ipcMain, store, sync = {}, isSender, send, names = DEFAULT_NAMES, newId }) {
  const fromView = e => !!e && typeof isSender === 'function' && isSender(e.sender) === true;
  const ids = newId === undefined ? {} : { newId };

  const valid = validFor(names);
  ipcMain.handle(names.get, (e) => {
    if (!fromView(e)) return null;
    const answer = readLayoutState(store, names.key, valid);
    return names.op ? giveIds(answer) : answer;
  });

  if (names.op) ipcMain.handle(names.op, (e, req) => (fromView(e) ? runOp(req) : null));

  // Presets stored before they had ids (BACKLOG #59) get theirs the first time a window reads the list, so every
  // question the page asks can name the preset it is about. Written back as one locked read-modify-write; if that
  // fails the list is answered as it was read (an id-less preset is still asked about by name, as null).
  let saidIdsFailed = false;
  function giveIds(answer) {
    if (answer.status !== 'ok' || !needsIds(answer.layout)) return answer;
    try {
      const list = store.withLock(names.key, () => {
        const st = store.readState(names.key);
        if (st.status !== 'ok' || !Array.isArray(st.value)) return null;
        const next = withIds(st.value, ids.newId);
        if (next !== st.value) store.write(names.key, next);
        return next;
      });
      if (list === null) return answer;
      sync.last = JSON.stringify(list);
      try { send(names.push, list); } catch { /* window is going away */ }
      return { status: 'ok', layout: list };
    } catch (err) {
      if (!saidIdsFailed) { saidIdsFailed = true; console.error('[main] could not give the presets their ids (said once; each read tries again):', err && err.message); }
      return answer;
    }
  }

  // ONE read-modify-write on the store: under its lock, on a read made now, never on a list the page remembers.
  // Anything but ok or missing (unreadable, corrupt, not a list) is refused and the file is left as it is.
  function runOp(req) {
    let result;
    try {
      result = store.withLock(names.key, () => {
        let raw;
        try {
          const st = store.readState(names.key);
          if (st.status === 'missing' || (st.status === 'ok' && (st.value === null || st.value === undefined))) raw = [];
          else if (st.status === 'ok' && Array.isArray(st.value)) raw = st.value;
          else return { ok: false, reason: 'unreadable' };
        } catch { return { ok: false, reason: 'unreadable' }; }
        const r = applyOp(raw, req, ids);
        if (r.ok) store.write(names.key, r.list);
        return r;
      });
    } catch (err) {
      console.error('[main] could not save the presets:', err && err.message);
      return { ok: false, reason: 'failed' };
    }
    if (!result.ok) return { ok: false, reason: result.reason };
    // The watcher must know what this window was just told (see `set` below).
    sync.last = JSON.stringify(result.list);
    try { send(names.push, result.list); } catch { /* window is going away */ }
    return { ok: true, list: result.list };
  }

  if (!names.set) return;
  ipcMain.handle(names.set, (e, value) => {
    if (!fromView(e) || !valid(value)) return null;
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
  const now = () => { const l = readLayout(store, names.key, validFor(names)); return l === null ? null : JSON.stringify(l); };
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
  LAYOUT_KEY, GET_CHANNEL, SET_CHANNEL, PUSH_CHANNEL, MAX_LAYOUT_BYTES, TREE_NAMES, PRESET_NAMES,
};
