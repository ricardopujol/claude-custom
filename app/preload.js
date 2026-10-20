'use strict';
/**
 * The only channel between the window and the main process.
 *
 * It exists for one reason: an OS notification raised by the RENDERER depends
 * on the page's notification permission and cannot flash the taskbar or focus
 * the window. Raised by MAIN it does both, and needs no permission at all.
 *
 * Deliberately one-way and one-purpose. contextIsolation stays on; nothing from
 * Node reaches page scripts.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  attention: (surfaces) => ipcRenderer.send('attention', surfaces),

  // Worktree tabs (PR 2). This page is one tab of a shell window; main owns the
  // strip and decides what these mean.
  //   tabStatus   what this tab reports about itself (app/tab-status.js)
  //   closeTab    the blocked pane's close button: end this tab (or the window)
  //   goToSession the lock holder -> { kind, text? } (select / raise / explain)
  //   raise       a host said `raise`: select this tab, bring the window forward
  //   onTabSelected / onLockOverride: main -> page, replace-don't-accumulate
  tabStatus: (status) => ipcRenderer.send('tab:status', status),
  closeTab: () => ipcRenderer.send('tab:close'),
  goToSession: (holder) => ipcRenderer.invoke('tab:goTo', holder),
  //   selectFolder a worktree folder -> { kind, text? }: the Git panel's *Jump to its tab*
  selectFolder: (folder) => ipcRenderer.invoke('tab:selectFolder', folder),
  //   tabStates   worktree folders -> [{ folder, open, started, known, working, needsInput }]: the Git drawer's
  //               view of those tabs' sessions (null working / needsInput: that session hasn't reported)
  //   typeMerged   a worktree folder and the branch the drawer shows -> { kind, text?, branch?, cleared?, submitted? }:
  //               switch to its tab, and its page types /merged and, if its submit gate allows, Enter (main re-checks all of it)
  tabStates: (folders) => ipcRenderer.invoke('tab:states', folders),
  typeMerged: (folder, branch) => ipcRenderer.invoke('tab:typeMerged', folder, branch),
  raise: () => ipcRenderer.send('tab:raise'),
  //   reportAccent the look's accent (#rrggbb): main hands it to the strip page, which is its own document (#64)
  reportAccent: (hex) => ipcRenderer.send('tab:accent', hex),
  //   onTypeCommand main -> page { id, command, submit }: type it into THIS tab's box, the top bar's way (PR #93 F3);
  //                 with submit, press Enter too when the page's submit gate allows (BACKLOG #61)
  //   typed         page -> main { id, ok, reason?, box?, submitted?, flash? }: what came of it; main
  //                 keeps ok, reason, box and submitted (the wand shows `flash` itself; the drawer words its own)
  onTypeCommand: (fn) => (ipcRenderer.removeAllListeners('type-command'), ipcRenderer.on('type-command',
    (_e, ask) => {
      try { fn(ask); } catch (err) { console.error('[preload] type-command listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('type-command')),
  typed: (reply) => ipcRenderer.send('tab:typed', reply),
  // A link clicked in the terminal (fix/terminal-links). Main opens it in the
  // default browser if, and only if, it is plain http(s), and answers whether
  // it did, so the page can say when it didn't.
  openExternal: (url) => ipcRenderer.invoke('tab:openExternal', url),
  // A local path in the terminal (#37): main answers which of the offered
  // paths exist and whether a click opens each or shows it in Explorer, then
  // re-decides and does it on the click.
  checkPaths: (lists) => ipcRenderer.invoke('tab:checkPaths', lists),
  openPath: (p) => ipcRenderer.invoke('tab:openPath', p),
  // The Files tab (#45): a path RELATIVE to this tab's worktree. Main re-runs the realpath guard against the
  // tab's own folder, then shows it in Explorer / starts an OS drag of the file. Neither ever opens or runs it.
  // The code reader's unsaved file (a path relative to the worktree) or null, so ending this tab can warn (#50).
  // main asks every page to save its reader (the window-close question's Save): the page answers by reporting null
  onReaderSave: (fn) => { ipcRenderer.on('reader-save', () => { try { fn(); } catch (err) { console.error('[preload] reader-save listener threw', err); } }); },
  readerDirty: (rel) => ipcRenderer.send('tab:readerDirty', rel === null ? null : String(rel)),
  repoReveal: (rel) => ipcRenderer.invoke('tab:repoReveal', rel),
  repoDrag: (rel) => ipcRenderer.invoke('tab:repoDrag', rel),
  // drag-out, in the gesture (PR #95 Miguel M2): prepare when the pointer reaches a row, then a SYNCHRONOUS start
  // inside `dragstart`; repoDrag above is the checked fallback for a row that was not prepared yet
  repoDragPrepare: (rel) => ipcRenderer.invoke('tab:repoDragPrepare', rel),
  repoDragStart: (rel) => ipcRenderer.sendSync('tab:repoDragStart', rel),
  onTabSelected: (fn) => (ipcRenderer.removeAllListeners('tab-selected'), ipcRenderer.on('tab-selected',
    () => {
      try { fn(); } catch (err) { console.error('[preload] tab-selected listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('tab-selected')),
  onLockOverride: (fn) => (ipcRenderer.removeAllListeners('lock-override'), ipcRenderer.on('lock-override',
    () => {
      try { fn(); } catch (err) { console.error('[preload] lock-override listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('lock-override')),

  // Worktree occupancy (backlog #44 + #47). `get` answers this page's { here, launched } at first paint: the live
  // agent claims in THIS folder (its banner and keystroke confirm) and the ones THIS session launched (its roster
  // cards' `-> worktree` lines). `onChange` is the same payload pushed whenever it changes (replace-don't-accumulate).
  occupancy: {
    get: () => ipcRenderer.invoke('occupancy:get'),
    onChange: (fn) => (ipcRenderer.removeAllListeners('occupancy'), ipcRenderer.on('occupancy',
      (_e, payload) => {
        try { fn(payload); } catch (err) { console.error('[preload] occupancy listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('occupancy')),
  },

  // FF4. Main raises and clears the finished-task cue, because only main knows
  // whether the window is focused -- the page cannot tell "you are looking at
  // me" from "I am merely visible". One boolean, one direction.
  // IDEMPOTENT. Miguel, PR #33, A4: this is the bridge's first `ipcRenderer.on`
  // and therefore sets the convention for the next one. Two calls used to
  // register two listeners and ten would trip Node's MaxListeners warning.
  // Replacing rather than accumulating is right for a cue with exactly one
  // owner; it also returns a disposer, so a future caller with two has a way
  // out that is not "reload the window".
  //
  // (No leak on reload: the preload re-executes in a fresh context and the old
  // ipcRenderer listeners die with the old one. The reload problem was the
  // cue being LOST, which main now restores on did-finish-load.)
  onAttentionCue: (fn) => (ipcRenderer.removeAllListeners('attention-cue'), ipcRenderer.on('attention-cue',
    (_e, on) => {
      // LOGGED, not swallowed. Miguel, A3: the old comment claimed this kept
      // a bad listener from killing the bridge, which it cannot -- the bridge
      // is established at load and a throwing listener cannot un-expose it.
      // What the catch actually buys is that one throwing listener does not
      // abort emit()'s loop over the others, and there is exactly one. So the
      // comment claimed a protection the code does not provide against a
      // failure that cannot happen, while the empty block delivered a real
      // cost: a renderer bug in the cue became invisible.
      try { fn(!!on); } catch (err) { console.error('[preload] attention-cue listener threw', err); }
    }), () => ipcRenderer.removeAllListeners('attention-cue')),

  // The real filesystem path behind a dropped File.
  //
  // `File.path` WAS REMOVED IN ELECTRON 32 -- this app is on 33 -- so the old
  // one-liner every drag-and-drop snippet on the internet still shows returns
  // undefined here, silently. `webUtils.getPathForFile` is the replacement and
  // it only exists in the preload: with contextIsolation on, page scripts
  // cannot reach it, which is the whole reason this crosses the bridge.
  //
  // Returns '' rather than throwing for anything that is not a real file (a
  // dragged URL, a text selection), so the caller filters instead of crashing.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },

  // Ctrl+V (BACKLOG #12, #8). Main reads the OS clipboard and answers
  // { text, hasImage } -- see app/clipboard-bridge.js. Read-only: nothing is
  // ever written to the clipboard through this.
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  // Ctrl+C with a selection: main writes it (app/clipboard-bridge.js).
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),

  // The secret store. Every call crosses into main, where the vault lives --
  // the window never holds the file, the key, or more than one secret at a
  // time, and the host (which owns the pty) never sees any of it at all.
  secrets: {
    available: () => ipcRenderer.invoke('secrets:available'),
    list: (query) => ipcRenderer.invoke('secrets:list', query),
    add: (entry) => ipcRenderer.invoke('secrets:add', entry),
    remove: (id) => ipcRenderer.invoke('secrets:remove', id),
    reveal: (id) => ipcRenderer.invoke('secrets:reveal', id),
    copy: (id) => ipcRenderer.invoke('secrets:copy', id),

    // The lock. The password travels INWARD only -- the user types it here and
    // main derives from it. Nothing about the key ever comes back out.
    lockState: () => ipcRenderer.invoke('secrets:lockState'),
    setKey: (key) => ipcRenderer.invoke('secrets:setKey', key),
    unlock: (key) => ipcRenderer.invoke('secrets:unlock', key),
    lock: () => ipcRenderer.invoke('secrets:lock'),
    removeKey: () => ipcRenderer.invoke('secrets:removeKey'),
    melt: () => ipcRenderer.invoke('secrets:melt'),
  },

  // Focus, for the unfocused-window dim. Same replace-don't-accumulate
  // convention as onAttentionCue. `dim` rides along so the page never has to
  // ask for it separately at the moment it needs it.
  onWindowFocus: (fn) => (ipcRenderer.removeAllListeners('window-focus'), ipcRenderer.on('window-focus',
    (_e, state) => {
      try { fn({ focused: !!(state && state.focused), dim: state && state.dim }); } catch (err) {
        console.error('[preload] window-focus listener threw', err);
      }
    }), () => ipcRenderer.removeAllListeners('window-focus')),

  // The install-wide unfocused dim (the project-scoped look goes to the host).
  look: {
    getDim: () => ipcRenderer.invoke('look:getDim'),
    setDim: (value) => ipcRenderer.invoke('look:setDim', value),
  },

  // Model favourites (BACKLOG E #5, #3): a star on an OpenRouter row or a
  // Claude choice, persisted install-wide -- see app/favourites-bridge.js.
  // Its own two channels, not a widened look:setDim: a generic "set any key"
  // handler reachable from the page could overwrite look-global itself.
  // `set`, not `toggle` (Dexter, PR #60 review, F6): the page always knows
  // the state it wants (it just decided which way the star should go), so it
  // sends THAT rather than asking main to flip whatever the store currently
  // holds -- a toggle computed against a second window's fresher state
  // inverts the click's intent instead of losing to it.
  favourites: {
    get: () => ipcRenderer.invoke('favourites:get'),
    set: (kind, id, on) => ipcRenderer.invoke('favourites:set', kind, id, on),
  },

  // Agent pictures (BACKLOG C #13, #18) -- see app/avatar-bridge.js. `pick`
  // opens the OS file dialog and answers a path (or null); the page then hands
  // that path to the host, which copies it into the app's data folder.
  // `setImagesEnabled` takes the DESIRED boolean; main pushes the result back
  // through `onImagesEnabled` (replace-don't-accumulate, like onWindowFocus).
  avatar: {
    pick: () => ipcRenderer.invoke('avatar:pick'),
    getImagesEnabled: () => ipcRenderer.invoke('avatar:getImagesEnabled'),
    setImagesEnabled: (enabled) => ipcRenderer.invoke('avatar:setImagesEnabled', enabled),
    onImagesEnabled: (fn) => (ipcRenderer.removeAllListeners('avatar-images'), ipcRenderer.on('avatar-images',
      (_e, enabled) => {
        try { fn(enabled === true); } catch (err) { console.error('[preload] avatar-images listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('avatar-images')),
    // #76: the roster card's Role/Name toggle, install-wide in the same record. `setRosterNames` takes 'role' or 'name'.
    getRosterNames: () => ipcRenderer.invoke('avatar:getRosterNames'),
    setRosterNames: (mode) => ipcRenderer.invoke('avatar:setRosterNames', mode),
    onRosterNames: (fn) => (ipcRenderer.removeAllListeners('avatar-roster-names'), ipcRenderer.on('avatar-roster-names',
      (_e, mode) => {
        try { fn(mode === 'role' ? 'role' : 'name'); } catch (err) { console.error('[preload] avatar-roster-names listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('avatar-roster-names')),
  },
  // Window chrome (layout pass L2): "status line in the header" (#27) and
  // "hide the title bar" (#28), install-wide -- see app/window-chrome-bridge.js.
  // Setters take the DESIRED boolean; main pushes the settings back through
  // `onChange` (replace-don't-accumulate).
  chrome: {
    get: () => ipcRenderer.invoke('chrome:getSettings'),
    setStatusInHeader: (on) => ipcRenderer.invoke('chrome:setStatusInHeader', on),
    setFrameless: (on) => ipcRenderer.invoke('chrome:setFrameless', on),
    onChange: (fn) => (ipcRenderer.removeAllListeners('chrome-settings'), ipcRenderer.on('chrome-settings',
      (_e, settings) => {
        try {
          fn({ statusInHeader: !!settings && settings.statusInHeader !== false,
            framelessWindow: !!settings && settings.framelessWindow === true });
        } catch (err) { console.error('[preload] chrome-settings listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('chrome-settings')),
  },
  // The background video's play inputs (backlog #34) -- see app/playback-bridge.js. `get` answers
  // { minimised, hidden, onBattery }, each a boolean or null (unknown); `onChange` replaces its
  // one listener and is handed the same shape.
  playback: {
    get: () => ipcRenderer.invoke('playback:get'),
    onChange: (fn) => (ipcRenderer.removeAllListeners('playback-state'), ipcRenderer.on('playback-state',
      (_e, state) => {
        try { fn(state); } catch (err) { console.error('[preload] playback-state listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('playback-state')),
  },
  // The Games panel (BACKLOG #41): the best of each wait game, install-wide. main keeps them (host/game-scores.js) and refuses
  // anything but one of the three games and a whole count.
  games: {
    scores: () => ipcRenderer.invoke('games:scores'),
    submit: (game, score) => ipcRenderer.invoke('games:submit', game, score),
  },
  // The Resources panel and the top bar's machine chip (BACKLOG #63). Main owns the sampler (host/resource-sampler.js
  // through app/resources-service.js); the page hears each payload
  // `{ model, status, machine }` (onState replaces its one listener), and asks for a Stop by pid and start time:
  // main re-reads the process list and refuses anything that is not a child of this window's own sessions.
  resources: {
    get: () => ipcRenderer.invoke('resources:get'),
    setChip: (on) => ipcRenderer.invoke('resources:setChip', on === true),
    // whether this page is showing the Resources panel (main samples faster while any page does)
    viewing: (on) => ipcRenderer.send('resources:viewing', on === true),
    // the saved setting, read synchronously so the page decides the chip before its first paint
    chipOn: () => ipcRenderer.sendSync('resources:chipOn') !== false,
    stop: (req) => ipcRenderer.invoke('resources:stop', req),
    // The Leftovers section's Stop: { rows: [{ pid, start }] } or { group }. Main resolves it against its own latest sample.
    stopLeftovers: (req) => ipcRenderer.invoke('resources:stopLeftovers', req),
    onState: (fn) => (ipcRenderer.removeAllListeners('resources:state'), ipcRenderer.on('resources:state',
      (_e, payload) => {
        try { fn(payload); } catch (err) { console.error('[preload] resources:state listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('resources:state')),
  },
  // Claude's panel (BACKLOG #71). The panel's page is a native view of its own that main lays over the dock panel's body
  // (app/canvas-views.js); THIS page is its trusted controller: `show` gives it the page Claude wrote, the hosts the person
  // approved and where it goes ({ html, hosts, rect, covered } -> { ok }); `bounds` / `cover` / `hosts` keep it in step;
  // `hide` destroys it (hidden means stopped); `answerHost` is the person's answer to a host question; `onNeedHost` and
  // `onMessage` are main -> page ({ id, origin } / { kind: 'send', text }), each replacing its one listener.
  canvas: {
    show: (req) => ipcRenderer.invoke('canvas:show', req),
    bounds: (rect) => ipcRenderer.send('canvas:bounds', rect),
    cover: (on) => ipcRenderer.send('canvas:cover', on === true),
    hosts: (hosts) => ipcRenderer.send('canvas:hosts', hosts),
    shelf: (items) => ipcRenderer.send('canvas:set-shelf', items),
    hide: () => ipcRenderer.send('canvas:hide'),
    // the Style tab's switch for the panel's MCP server: a boolean, or null when main could not tell (read) / save (write)
    settingsGet: () => ipcRenderer.invoke('canvas:settings-get'),
    settingsSet: (on) => ipcRenderer.invoke('canvas:settings-set', on),
    answerHost: (id, answer) => ipcRenderer.send('canvas:host-answer', { id, answer }),
    onNeedHost: (fn) => (ipcRenderer.removeAllListeners('canvas:need-host'), ipcRenderer.on('canvas:need-host',
      (_e, ask) => {
        try { fn(ask); } catch (err) { console.error('[preload] canvas:need-host listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('canvas:need-host')),
    onMessage: (fn) => (ipcRenderer.removeAllListeners('canvas:message'), ipcRenderer.on('canvas:message',
      (_e, msg) => {
        try { fn(msg); } catch (err) { console.error('[preload] canvas:message listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('canvas:message')),
  },
  // Focus mode (layout pass L1, #1): only the terminal shows. Main owns it (the
  // tab view has to cover the strip); the page hides its header and zones when
  // told through onChange, which replaces its one listener.
  focus: {
    toggle: () => ipcRenderer.send('focus:toggle'),
    set: (on) => ipcRenderer.send('focus:set', on === true),
    onChange: (fn) => (ipcRenderer.removeAllListeners('focus-mode'), ipcRenderer.on('focus-mode',
      (_e, on) => {
        try { fn(on === true); } catch (err) { console.error('[preload] focus-mode listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('focus-mode')),
  },
  // Lean mode (BACKLOG #62; main's half is app/lean-bridge.js): one window-level state. `get` asks it, `set` is the
  // button, `night` forwards THIS session's /bedtime night (its start in ms, or null when it ended: the host's word),
  // and `onChange` replaces its one listener.
  lean: {
    get: () => ipcRenderer.invoke('lean:get'),
    set: (on) => ipcRenderer.send('lean:set', on === true),
    // this page's working agents (name, images flag, portrait result), for the strip's portraits
    faces: (list) => ipcRenderer.send('lean:faces', Array.isArray(list) ? list.slice(0, 48) : []),
    night: (startedAt) => ipcRenderer.send('lean:night', typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null),
    onChange: (fn) => (ipcRenderer.removeAllListeners('lean-state'), ipcRenderer.on('lean-state',
      (_e, state) => {
        try { fn(state); } catch (err) { console.error('[preload] lean-state listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('lean-state')),
  },
  // The global dock layout (layout pass L1) -- see app/layout-bridge.js. `get`
  // answers null when nothing is saved yet (the page migrates); `onChange`
  // replaces its one listener, like onImagesEnabled.
  layout: {
    get: () => ipcRenderer.invoke('layout:get'),
    set: (layout) => ipcRenderer.invoke('layout:set', layout),
    onChange: (fn) => (ipcRenderer.removeAllListeners('layout-global'), ipcRenderer.on('layout-global',
      (_e, layout) => {
        try { fn(layout); } catch (err) { console.error('[preload] layout-global listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('layout-global')),
  },
  // Fonts (BACKLOG #88) -- see app/fonts-bridge.js. `get` answers { status, settings }, `set` the settings main stored (null: not saved),
  // `list` { ok, families } of every installed family; `onChange` replaces its one listener.
  fonts: {
    get: () => ipcRenderer.invoke('fonts:get'),
    set: (settings) => ipcRenderer.invoke('fonts:set', settings),
    list: () => ipcRenderer.invoke('fonts:list'),
    onChange: (fn) => (ipcRenderer.removeAllListeners('fonts-global'), ipcRenderer.on('fonts-global',
      (_e, settings) => {
        try { fn(settings); } catch (err) { console.error('[preload] fonts-global listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('fonts-global')),
  },
  // The split-tree layout (dockable panels D1): the same shape under its own key. The page reads
  // `layout` once, to migrate from it, and never writes it.
  layoutTree: {
    get: () => ipcRenderer.invoke('layout-tree:get'),
    set: (layout) => ipcRenderer.invoke('layout-tree:set', layout),
    onChange: (fn) => (ipcRenderer.removeAllListeners('layout-tree'), ipcRenderer.on('layout-tree',
      (_e, layout) => {
        try { fn(layout); } catch (err) { console.error('[preload] layout-tree listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('layout-tree')),
  },
  // The layout presets (dockable panels D3): a list of { name, layout }, install-wide. `get` answers
  // { status, layout } with the list in `layout`. The page never writes the list: `op` sends what the user did
  // ({ op: 'save' | 'rename' | 'delete', name, to?, layout?, replace? }) and main answers { ok: true, list } or
  // { ok: false, reason }, null for a sender that isn't a tab view.
  layoutPresets: {
    get: () => ipcRenderer.invoke('layout-presets:get'),
    op: (req) => ipcRenderer.invoke('layout-presets:op', req),
    onChange: (fn) => (ipcRenderer.removeAllListeners('layout-presets'), ipcRenderer.on('layout-presets',
      (_e, list) => {
        try { fn(list); } catch (err) { console.error('[preload] layout-presets listener threw', err); }
      }), () => ipcRenderer.removeAllListeners('layout-presets')),
  },
});
