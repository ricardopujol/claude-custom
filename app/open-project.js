'use strict';
/**
 * openProject (single-instance PR 3, step 6): main's ONE in-process entry for opening a project. The app pipe's handed-off launch, the tray,
 * the ▾ menu's Open, the probe driver and a crash restore all come here (main puts each through app/open-queue.js first). No Electron.
 *
 *   openProject({ cwd, port, show = 'shown', env }) -> { ok: true, root, existing } | { ok: true, elsewhere: true } | { ok: false, error }
 *
 *   a folder that is gone            logged, nothing opened (the launcher checked it, but it may have gone since: plan risk 9)
 *   the project is open here         startProject brings it forward and shows the cwd's lane; a `port` selects that port's tab
 *   a new project                    startProject makes its window, started `show` ('shown' | 'hidden' | 'setting', app/project-window.js)
 *   its window is another process's  that process has the launch (the window claim sent it there): nothing here
 *   a single-mode window that could not start   closes only itself (a handed-off launch never ends the process)
 *   env (a handed-off launch only)   the names of CLAUDE_CUSTOM_BIN / CONPTY / SHELL that differ from this process's are logged, never the
 *                                    values (design 3.1: the open runs on this process's environment)
 *
 * deps: startProject(cwd, { show }), exists(path), pickLane(tabs, { port }), envNames, ownEnv, closeWindow(pw), log(line).
 */

function createOpenProject({ startProject, exists, pickLane, envNames = [], ownEnv = {}, closeWindow, log = () => {} }) {
  const valueOf = (bag, name) => (bag && typeof bag[name] === 'string' ? bag[name] : null);

  async function openProject({ cwd, port, show = 'shown', env } = {}) {
    let there = false;
    try { there = typeof cwd === 'string' && cwd !== '' && exists(cwd) === true; } catch { there = false; }
    if (!there) {
      log(`[main] open: ${JSON.stringify(typeof cwd === 'string' ? cwd : null)} is gone; nothing was opened`);
      return { ok: false, error: 'the folder is gone' };
    }
    if (env && typeof env === 'object') {
      const differ = envNames.filter((n) => valueOf(env, n) !== valueOf(ownEnv, n));
      if (differ.length) log(`[main] open ${JSON.stringify(cwd)}: the launch's ${differ.join(', ')} differ from this process's; the open runs on this process's`);
    }
    const r = await startProject(cwd, { show });
    if (r && r.elsewhere) {
      log(`[main] open ${JSON.stringify(cwd)}: that project's window is another process's; it has the launch`);
      return { ok: true, elsewhere: true };
    }
    if (!r || !r.pw) {
      const error = (r && r.error) || 'the window did not start';
      log(`[main] open ${JSON.stringify(cwd)} failed: ${error}`);
      return { ok: false, error };
    }
    const pw = r.pw;
    if (!r.existing && pw.mode === 'single' && r.first && r.first.started === false) {
      const error = String(r.first.error || 'the session did not start');
      log(`[main] open ${JSON.stringify(cwd)}: ${error}; closing that window only`);
      try { closeWindow(pw); } catch { /* already gone */ }
      return { ok: false, error };
    }
    if (Number.isInteger(port) && pw.tabShell) {
      const key = pickLane(pw.tabShell.snapshot().tabs, { port });
      if (key) pw.tabShell.select(key);
    }
    return { ok: true, root: pw.root, existing: r.existing === true };
  }

  return { openProject };
}

module.exports = { createOpenProject };
