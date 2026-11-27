#!/usr/bin/env node
'use strict';
/**
 * Starts one family of usage counters over (BACKLOG #97): `node scripts/usage-reset.js <prefix> [path/to/state-dir]`, e.g.
 * `node scripts/usage-reset.js panel:` for a clean count of the dock panels. Default folder: this install's `.harness/state`.
 *
 * The whole old file is kept beside it first, as `usage-counters.before-reset-<ISO time>.json`, then the keys under the prefix are
 * dropped and every other key is written back as it was, inside the counters' own lock (host/usage-counters.js resetPrefix). A file
 * that can't be read is refused and left alone. Run it once, by hand, after the counting fix is in the install that writes the file.
 */
const path = require('node:path');
const { createStore } = require('../host/store');
const { resetPrefix } = require('../host/usage-counters');

const [prefix, dirArg] = process.argv.slice(2);
const dir = dirArg || path.join(__dirname, '..', '.harness', 'state');
const r = resetPrefix({ store: createStore({ dir }), prefix });
if (!r.ok) { console.error(`Not reset: ${r.reason}`); process.exit(1); }
if (!r.archive) { console.log(`Nothing to reset: no counters file in ${dir}.`); process.exit(0); }
console.log(`Reset ${r.removed.length} counter(s) under "${prefix}": ${r.removed.join(', ') || '(none)'}`);
console.log(`The old values are kept in ${r.archive}`);
