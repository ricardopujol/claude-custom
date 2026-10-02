'use strict';
/**
 * The ▾ menu's effects (Windowless sessions PR 2), out of app/main.js so they
 * are tested rather than read (Miguel, PR 2 Y1). main.js hands in every effect
 * -- a tab select, a window spawn, the dialogs, stopHost -- and draws the menu.
 *
 *   menuTemplate(model, { open, stop }) -> an Electron Menu template
 *   createBackgroundActions(deps) -> { open(open), stop(row) }
 *   popupUntilClosed(menu, win) -> resolves when the menu OR the window closes
 *
 * Main-process only (required, never a page <script>).
 */

// Windows menus read `&` as a mnemonic marker; a folder name is not one.
const menuText = s => String(s).replace(/&/g, '&&');

function menuTemplate(model, { open, stop }) {
  const items = model && Array.isArray(model.items) ? model.items : [];
  const template = items.map(it => ({
    label: menuText(it.label),
    submenu: [
      { label: it.open && it.open.kind === 'select-tab' ? 'Go to its tab' : 'Open', enabled: it.open !== null,
        click: () => open(it.open) },
      { label: 'Stop…', enabled: it.stop, click: () => stop(it.row) },
    ],
  }));
  if (model && model.footer) {
    if (template.length) template.push({ type: 'separator' });
    template.push({ label: menuText(model.footer), enabled: false });
  }
  return template;
}

/**
 * deps: select(key), focusWindow(), spawnWindow({ cwd, port }) -> { pid },
 *       confirmStop(row) -> bool, inform(text), stopHost(row) -> result, log(msg)
 */
function createBackgroundActions(deps) {
  // A tab here is selected; anything else gets a window of its own on that
  // host's exact port, attach-only (host/launch-target.js attachEnv).
  // Answers what it did: { selected } | { pid } | null.
  function open(o) {
    if (!o) return null;
    if (o.kind === 'select-tab') { deps.select(o.key); deps.focusWindow(); return { selected: o.key }; }
    try {
      const r = deps.spawnWindow({ cwd: o.cwd, port: o.port });
      deps.log(`[main] Open (background): a window on port ${o.port} for ${o.cwd} (pid ${r && r.pid})`);
      return r || null;
    } catch (err) {
      deps.log(`[main] Open (background) failed: ${err && err.message}`);
      return null;
    }
  }

  async function stop(row) {
    if (!(await deps.confirmStop(row))) return { outcome: 'cancelled' };
    let r;
    try {
      r = await deps.stopHost(row);
    } catch (err) {
      deps.log(`[main] Stop (background) failed: ${err && err.message}`);
      r = { outcome: 'failed', text: "Couldn't stop that session.", how: null, reason: null };
    }
    deps.log(`[main] Stop (background): ${r.outcome} (pid ${row.pid}, port ${row.port}, build ${row.build}, how ${r.how || 'none'}` +
      (r.reason ? `, controls skipped: ${r.reason}` : '') + ')');
    // Stopped is its own answer: the row is gone from the next list.
    if (r.outcome !== 'stopped') await deps.inform(r.text);
    return r;
  }

  return { open, stop };
}

// The popup's callback may never run if the window is destroyed with the menu
// open (Miguel, PR 2 Y2), which would leave main's one-at-a-time flag set and
// the ▾ button dead. So the window closing ends the wait too.
function popupUntilClosed(menu, win) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { win.removeListener('closed', done); resolve(); };
    win.once('closed', done);
    menu.popup({ window: win, callback: done });
  });
}

module.exports = { menuTemplate, createBackgroundActions, popupUntilClosed };
