'use strict';
/**
 * The real effects behind listing and stopping sessions, wired ONCE: app/main.js
 * (the ▾ menu) and bin/claude-custom.js (`--stop`, Windowless sessions PR 3) both
 * take them from here, so the CLI can't stop a session by rules the window
 * doesn't use. Plain Node: nothing here needs Electron.
 *
 *   listDeps(installDir)  -> deps for host/background-hosts.js listBackgroundHosts
 *   hostStopDeps()        -> deps for host/stop-holder.js stopHost
 */

const path = require('path');
const { installsBeside, identitiesIn } = require('./background-hosts');
const { isAlive, startTimes } = require('./proc-start');
const { windowCount, windowCounts } = require('./window-count');
const { readIdentity, readTokenFile } = require('./host-identity');
const { sendControl } = require('./host-client');
const { killPidTree } = require('./kill-tree');

const harnessOf = install => path.join(install, '.harness');

function listDeps(installDir) {
  return {
    installs: () => installsBeside(installDir),
    identities: identitiesIn,
    startTimes,
    windowCounts,
  };
}

function hostStopDeps() {
  return {
    isAlive,
    startTimes,
    readIdentity: ({ install, port }) => readIdentity({ dir: harnessOf(install), port }),
    readToken: (install, port) => readTokenFile({ dir: harnessOf(install), port }),
    sendControl: c => sendControl(c),
    windowCount,
    killPidTree,
    sleep: ms => new Promise(res => setTimeout(res, ms)),
    now: Date.now,
  };
}

module.exports = { listDeps, hostStopDeps };
