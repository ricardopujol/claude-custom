#!/usr/bin/env node
'use strict';
/**
 * `node host/quota-cli.js` -> `5h 42% · week 61% · read 30 s ago`
 *
 * Reads the shared quota file the one polling host writes (host/quota-share.js);
 * never calls the usage endpoint itself. Prints `unknown (why)` when the file is
 * absent, bad or stale. Exits 0 either way. `--json` prints the parsed object
 * for scripts; `--dir <path>` points at another state folder (tests).
 */
const { readShared, formatLine } = require('./quota-share');

function main(argv) {
  const i = argv.indexOf('--dir');
  const dir = i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  const shared = readShared(dir ? { dir } : {});
  console.log(argv.includes('--json') ? JSON.stringify(shared) : formatLine(shared));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
