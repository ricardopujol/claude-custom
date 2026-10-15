#!/usr/bin/env node
'use strict';
/**
 * Prints the usage counters as a table, most used first: `node scripts/usage-report.js [path/to/usage-counters.json]`.
 * Default file: this install's `.harness/state/usage-counters.json`. Read-only; nothing in the UI shows these numbers.
 */
const fs = require('node:fs');
const path = require('node:path');
const { formatReport } = require('../host/usage-report');

const file = process.argv[2] || path.join(__dirname, '..', '.harness', 'state', 'usage-counters.json');
let counters;
try {
  counters = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  if (err.code === 'ENOENT') { console.log(`No usage recorded yet (${file} doesn't exist).`); process.exit(0); }
  console.error(`Can't read ${file}: ${err.message}`);
  process.exit(1);
}
console.log(formatReport(counters, Date.now()));
