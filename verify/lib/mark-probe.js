'use strict';
/**
 * Requiring this marks the process (BACKLOG #169, PR #232 Dexter 2 / Miguel Y1).
 *
 * A verify/ script that starts a host.js or an Electron must carry the probe mark (host/probe-mark.js) in its own process.env
 * BEFORE it spawns, so every process tree it starts inherits it and verify/sweep-orphans.js can prove an orphan is a probe's.
 * The mark used to be set only as a side effect of requiring launch-electron.js, so the probes that spawn host.js by hand never
 * had one. This is the one place that does it: launch-electron.js and process-hygiene.js require it, and a probe that needs
 * neither requires it directly. test/probe-mark-coverage.test.js fails for a verify/ script that spawns a host or an Electron
 * and reaches none of the three.
 *
 * Node runs a module once per process, so the mark is minted once. Only a script under verify/ is marked: the unit tests start no
 * marked host, and a person's session never has the variable.
 */
const path = require('path');
const probeMark = require('../../host/probe-mark');

const VERIFY_DIR = path.resolve(__dirname, '..');

/** The script's file name when it lives under verify/, else null. (With the separator: verify2\ is not verify\.) */
function probeName(argv1 = process.argv[1]) {
  if (!argv1) return null;
  const abs = path.resolve(argv1);
  return (path.dirname(abs) + path.sep).toLowerCase().startsWith((VERIFY_DIR + path.sep).toLowerCase()) ? path.basename(abs) : null;
}

const mark = probeName() ? probeMark.markEnv(process.env) : null;

module.exports = { mark, probeName, VERIFY_DIR };
