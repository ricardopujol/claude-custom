'use strict';
/**
 * The ▾ menu's effects (Windowless sessions PR 2), out of app/main.js so they
 * are tested rather than read (Miguel, PR 2 Y1). main.js hands in every effect
 * -- a tab select, a window spawn, the dialogs, stopHost -- and draws the menu.
 *
 *   menuTemplate(model, { open, stop }) -> an Electron Menu template
 *   createBackgroundActions(deps) -> { open(open), stop(row), stopAll(rows) }
 *   popupUntilClosed(menu, win) -> resolves when the menu OR the window closes
 *
 * Main-process only (required, never a page <script>).
 */

const { ENDED, stopRows } = require('../host/stop-folder');

// Windows menus read `&` as a mnemonic marker; a folder name is not one.
const menuText = s => String(s).replace(/&/g, '&&');

function menuTemplate(model, { open, stop, stopAll }) {
  const items = model && Array.isArray(model.items) ? model.items : [];
  const template = items.map(it => ({
    label: menuText(it.label),
    submenu: [
      { label: it.open && it.open.kind === 'select-tab' ? 'Go to its tab' : 'Open', enabled: it.open !== null,
        click: () => open(it.open) },
      { label: 'Stop…', enabled: it.stop, click: () => stop(it.row) },
    ],
  }));
  if (model && model.stopAll && items.length) {
    const all = model.stopAll;
    template.push({ type: 'separator' });
    template.push({ label: 'Stop all in this project…', enabled: all.enabled, click: () => stopAll(all.rows) });
  }
  if (model && model.footer) {
    if (template.length) template.push({ type: 'separator' });
    template.push({ label: menuText(model.footer), enabled: false });
  }
  return template;
}

// The *Stop all* confirmation's detail: the folders, at most ten (Miguel G4).
const STOP_ALL_SHOWN = 10;
function stopAllDetail(rows) {
  const shown = rows.slice(0, STOP_ALL_SHOWN).map(r => r.cwd);
  if (rows.length > STOP_ALL_SHOWN) shown.push(`… and ${rows.length - STOP_ALL_SHOWN} more`);
  return `${shown.join('\n')}\n\nTheir claudes end with them. A session with a window open is never stopped.`;
}

/**
 * deps: select(key), focusWindow(), spawnWindow({ cwd, port }) -> { pid },
 *       confirmStop(row) -> bool, confirmStopAll(rows) -> bool, inform(text),
 *       stopHost(row) -> result, log(msg)
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

  // *Stop all in this project* (PR 3): one confirmation, then each session by
  // the same stopHost, one at a time (each waits for its claude to end), and one
  // summary naming whatever was kept and why.
  async function stopAll(rows) {
    if (!(await deps.confirmStopAll(rows))) return { outcome: 'cancelled' };
    // The CLI's loop (host/stop-folder.js), so the two can't drift (Miguel Y2).
    const results = await stopRows(rows, deps.stopHost);
    for (const x of results) {
      deps.log(`[main] Stop all (background): ${x.outcome} (pid ${x.row.pid}, port ${x.row.port}, build ${x.row.build}, how ${x.how || 'none'})`);
    }
    const ended = results.filter(x => ENDED.has(x.outcome)).length;
    const kept = results.filter(x => !ENDED.has(x.outcome)).map(x => `${x.row.cwd}: ${x.text}`);
    await deps.inform([`Stopped ${ended} of ${rows.length} session${rows.length === 1 ? '' : 's'}.`, ...kept].join('\n'));
    return { outcome: 'done', results };
  }

  return { open, stop, stopAll };
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

module.exports = { menuTemplate, createBackgroundActions, popupUntilClosed, stopAllDetail };
