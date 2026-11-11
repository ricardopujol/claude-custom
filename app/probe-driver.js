'use strict';
/**
 * The probe driver, once per process (single-instance PR 2, step 8). Does NOTHING unless CLAUDE_CUSTOM_TABS_PROBE names a port. Newline
 * JSON over 127.0.0.1 only. The commands are app/tab-shell.js's handleProbeCommand's and nothing else.
 *
 * Several project windows share one process and one port, so the server lives here, not in a window: every command carries the secret
 * token (checked FIRST, before anything is looked up), then an optional `window` (a project root) picks the window whose own api answers
 * it (the launch window when absent). Two commands are the process's, not a window's:
 *
 *   windows               { windows: [{ root, label, mode, launch, selectedKey }], pid }
 *   openProject { cwd }   open `cwd` as a project window of THIS process (or focus the one it already has: existing: true). Refused unless
 *                         the probe driver's port AND token are set, and for any folder outside the machine's temp folder: a probe's own
 *                         scratch project, never a real one.
 *
 * Pure but for `net`: the registry, the windows' apis and startProject are handed in, so the routing is tested under plain node.
 */
const net = require('net');
const path = require('path');
const { handleProbeCommand, probeAuthError, probeLineReader } = require('./tab-shell');

const TOKEN_MIN = 16;

/** Whether `child` is `parent` or inside it (path-wise, case-insensitive on Windows). */
function isInside(parent, child) {
  if (typeof child !== 'string' || child === '' || typeof parent !== 'string' || parent === '') return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Route one line. `windowApi(root)` answers the api of the window for `root` (undefined root: the launch window), or null when there is
 * none; `appApi` answers `windows` and `openProject`. The token is checked before either is consulted.
 */
async function routeProbeLine(line, { token, windowApi, appApi }) {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return { ok: false, error: 'not JSON' }; }
  const denied = probeAuthError(cmd, token);
  if (denied !== null) return denied;
  if (typeof cmd.cmd !== 'string') return { ok: false, error: 'no cmd' };
  let api;
  if (cmd.cmd === 'windows' || cmd.cmd === 'openProject') {
    api = appApi;
  } else {
    if (cmd.window !== undefined && typeof cmd.window !== 'string') return { ok: false, error: 'window must be a project root' };
    api = windowApi(cmd.window);
    if (!api) return { ok: false, error: 'no such window' };
  }
  return handleProbeCommand(line, api, token);
}

/** The process's own commands. */
function createAppApi({ probePort, token, tempRoot, registry, launchWindow, startProject }) {
  return {
    async windows() {
      return {
        pid: process.pid,
        windows: registry.list().map((pw) => ({ root: pw.root, label: pw.label, mode: pw.mode, launch: pw === launchWindow, selectedKey: pw.tabShell ? pw.tabShell.snapshot().selectedKey : null })),
      };
    },
    async openProject(cwd) {
      if (!probePort || typeof token !== 'string' || token.length < TOKEN_MIN) return { ok: false, error: 'openProject needs the probe driver (its port and token)' };
      if (!isInside(tempRoot, cwd)) return { ok: false, error: 'openProject is for a probe\'s own scratch folder, inside the temp folder' };
      const r = await startProject(cwd, { launch: false });
      if (!r.pw) return { ok: false, error: r.error || 'the project did not start' };
      return { ok: true, existing: r.existing === true, root: r.pw.root, pid: process.pid };
    },
  };
}

/** Listen. One server for the process; `lineMax` caps a line (a peer that never sends a newline is cut off). */
function startProbeServer({ port, token, lineMax, windowApi, appApi, log = console }) {
  const server = net.createServer((sock) => {
    const reader = probeLineReader(lineMax);
    sock.on('data', (d) => {
      const { lines, overflow } = reader.push(String(d));
      if (overflow) { sock.destroy(); return; }
      for (const line of lines) {
        routeProbeLine(line, { token, windowApi, appApi })
          .then((r) => { try { sock.write(JSON.stringify(r) + '\n'); } catch { /* probe went away */ } });
      }
    });
    sock.on('error', () => {});
  });
  server.on('error', (err) => log.error('[main] probe driver:', err.message));
  server.listen(port, '127.0.0.1', () => log.log(`[main] probe driver listening on ${port}`));
  return server;
}

module.exports = { routeProbeLine, createAppApi, startProbeServer, isInside };
