'use strict';
/**
 * Propose or direct (backlog #66, documentation/DESIGN_INDEXING_ASSISTANT.md "Accuracy gate"). The strip files a note
 * without asking only once a measurement on the real machine passed the bar (>= 85% on kind AND target, no
 * history/backlog swap), and a setting can still hold it in propose mode.
 *
 *   MEASURED                    the last measurement (verify/probe-indexing-accuracy.js), recorded by hand here
 *   modeFor(measured, settings) -> 'direct' | 'propose'
 *   readSettings(file)          -> `.harness/state/indexing-settings.json` as an object, {} when missing or broken
 *
 * Switching direct filing on is a re-measurement that passes, recorded here, not a flag flipped: the number is the
 * reason. Only a real `true` counts, both for `passed` and for `proposeOnly`.
 */

const fs = require('fs');

const MEASURED = Object.freeze({
  model: 'llama3.2:3b',
  at: '2026-10-05',
  right: 30,
  total: 46,
  pct: 65.2,
  swaps: 4,
  passed: false,
});

function modeFor(measured, settings) {
  const held = !!settings && typeof settings === 'object' && settings.proposeOnly === true;
  return measured && measured.passed === true && !held ? 'direct' : 'propose';
}

function readSettings(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

module.exports = { MEASURED, modeFor, readSettings };
