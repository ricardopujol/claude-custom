'use strict';
/**
 * Is the app lock (one Jiandu process per install, single-instance PR 3) on for this launch, and where does its `app.json` live? One pure
 * table, read once by app/main.js. The order is the table's order; the first row that matches decides.
 *
 *   a named port (good or bad)                   off  a port-named launch is its own process (DESIGN_SINGLE_INSTANCE.md 3.1)
 *   CLAUDE_CUSTOM_ATTACH_ONLY=1                  off  an attach-only window (the ▾ menu's old Open, the command line) is its own process
 *   CLAUDE_CUSTOM_SCREENSHOT                     off  the headless screenshot path
 *   CLAUDE_CUSTOM_TABS_PROBE + the flag + a      on   the probe's own UI state folder (host/probe-seams.js uiStateDir; verify/probe-single-instance.js)
 *     state folder of its own
 *   CLAUDE_CUSTOM_TABS_PROBE + the flag alone    off  'probe without its own state folder': it would share the person's app.json
 *   CLAUDE_CUSTOM_TABS_PROBE                     off  every other probe: each launch is its own process, as before
 *   anything else                                on   `<install>\.harness` (or the UI state seam's folder when one is set)
 *
 * The flag is CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE=1, exactly. `probe` (whether this is a probe at all) goes into every `open` message, and an
 * owner refuses a launch whose flag differs (host/app-claim.js cleanOpenFor): the last of the four layers of plan risk 3.
 */

const path = require('path');

function appLockConfig({ env = {}, installDir, explicitPort = null, seams = {} } = {}) {
  const probe = typeof env.CLAUDE_CUSTOM_TABS_PROBE === 'string' && env.CLAUDE_CUSTOM_TABS_PROBE !== '';
  const off = (reason) => ({ on: false, reason, dir: null, probe });
  const stateDir = seams && typeof seams.uiStateDir === 'string' && seams.uiStateDir ? seams.uiStateDir : null;
  if (explicitPort !== null && explicitPort !== undefined) return off('a named port');
  if (env.CLAUDE_CUSTOM_ATTACH_ONLY === '1') return off('attach-only');
  if (typeof env.CLAUDE_CUSTOM_SCREENSHOT === 'string' && env.CLAUDE_CUSTOM_SCREENSHOT !== '') return off('screenshot');
  if (probe) {
    if (env.CLAUDE_CUSTOM_SINGLE_INSTANCE_PROBE !== '1') return off('probe');
    if (!stateDir) return off('probe without its own state folder');
    return { on: true, reason: 'single-instance probe', dir: stateDir, probe };
  }
  return { on: true, reason: 'single instance', dir: stateDir || path.join(installDir, '.harness'), probe };
}

module.exports = { appLockConfig };
