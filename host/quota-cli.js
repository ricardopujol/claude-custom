#!/usr/bin/env node
'use strict';
/**
 * `node host/quota-cli.js` -> `5h 42% · week 61% · read 30 s ago`
 *
 * Reads the shared quota file the one polling host writes (host/quota-share.js);
 * never calls the usage endpoint itself. Prints `unknown (why)` when the file is
 * absent, bad or stale. Exits 0 either way. `--json` prints the parsed object
 * for scripts; `--dir <path>` points at another state folder (tests).
 *
 * The file is per account, keyed by the CLI's config dir: by default this reads
 * the one for THIS environment (`CLAUDE_CONFIG_DIR`, else ~/.claude), the same
 * dir the polling host's credentials came from. `--config-dir <path>` asks about
 * another account's file.
 *
 * A flag that needs a value and has none (or is followed by another flag) is a
 * usage error, exit 2: never a silent fall back to the default.
 */
const path = require('path');
const { readShared, formatLine } = require('./quota-share');

const USAGE = 'usage: node host/quota-cli.js [--json] [--dir <state folder>] [--config-dir <claude config folder>]';

function parse(argv) {
  const opts = { json: false, dir: undefined, configDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--dir' || a === '--config-dir') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v === '' || v.startsWith('--')) return { error: `${a} needs a value` };
      if (a === '--dir') opts.dir = v; else opts.configDir = path.resolve(v);
      i++;
      continue;
    }
    return { error: `unknown argument ${a}` };
  }
  return { opts };
}

/** Returns the exit code (0 normally, 2 for a usage error). */
function main(argv, { out = console.log, err = console.error } = {}) {
  const { opts, error } = parse(argv);
  if (error) {
    err(`${error}\n${USAGE}`);
    return 2;
  }
  const args = {};
  if (opts.dir !== undefined) args.dir = opts.dir;
  if (opts.configDir !== undefined) args.configDir = opts.configDir;
  const shared = readShared(args);
  out(opts.json ? JSON.stringify(shared) : formatLine(shared));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parse };
