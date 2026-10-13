'use strict';
/* What probe-header-fit.js prints and exits with, decided from what it MEASURED.
 *
 * Three outcomes, kept apart so "could not measure" is never read as "clips" or as "clean":
 *   exit 0  every width was measured and nothing failed (or a baseline run, which records failures without failing)
 *   exit 1  every width was measured and a check failed (a real clip, controls pushed off, sheet not fitting)
 *   exit 2  at least one width was NOT measured (load exhausted, empty capture, a thrown error); baseline or not
 *
 *   headerFitVerdict({ widths, measured, failures, error, baseline }) -> { lines, exitCode }
 */

function headerFitVerdict({ widths, measured, failures, error, baseline }) {
  const lines = [];
  const unmeasured = widths.filter(w => !measured.includes(w));
  if (failures > 0 && !baseline) lines.push(`${failures} check(s) failed (clip, controls pushed off, or sheet not fitting) on the measured widths`);
  for (const w of unmeasured) lines.push(`could not measure width ${w}: ${error || 'unknown error'}`);
  if (unmeasured.length) return { lines: ['', ...lines], exitCode: 2 };
  if (failures > 0 && !baseline) return { lines: ['', ...lines], exitCode: 1 };
  if (baseline) return { lines: ['', `baseline run: all ${widths.length} widths measured, ${failures} check(s) failed, not failing`], exitCode: 0 };
  return { lines: ['', 'no clipping at 1200 / 1600'], exitCode: 0 };
}

module.exports = { headerFitVerdict };
