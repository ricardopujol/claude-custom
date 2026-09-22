// @ts-nocheck
'use strict';
/**
 * Project HP — the test suite as one bar.
 *
 * V1 IS PASS RATE ONLY, and the bar says so. The design asks for "pass rate,
 * coverage and lint as one bar", but coverage and lint each need a threshold
 * somebody chose, and inventing defaults produces a bar that moves for reasons
 * nobody decided. One number that means one clear thing beats a composite
 * nobody can decode -- and a composite is the kind of metric people quote
 * without knowing what is in it.
 *
 * Detection and parsing are pure and live here, so they are testable without
 * running anything. RUNNING the suite belongs to the host: it is slow, and the
 * host's event loop accepts the hook helper's connection within 80ms.
 */

const fs = require('fs');
const path = require('path');

// Command plus PARSER. `npm test` says nothing about output shape -- what the
// script actually runs is what decides whether to look for "# pass 3" or
// "3 passed", so the two are chosen together and never inferred separately.
const RUNNERS = {
  npm: { command: ['npm', 'test'], parser: 'node-test' },
  pytest: { command: ['python', '-m', 'pytest', '-q'], parser: 'pytest' },
};

// Scripts that are not a test suite. `npm init` writes exactly this, and
// treating it as a suite reports 0% health for a project that simply has none.
const PLACEHOLDER = /no test specified/i;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function parserForScript(script) {
  const s = String(script || '');
  if (/\bjest\b|\bvitest\b/.test(s)) return 'jest';
  if (/\bmocha\b/.test(s)) return 'mocha';
  if (/\btap\b/.test(s)) return 'node-test';
  return 'node-test';           // node --test, and the common default
}

function detectRunner(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const script = pkg && pkg.scripts && pkg.scripts.test;
  if (script && !PLACEHOLDER.test(script)) {
    // A COPY. Returning the module-level literal let any caller's push() or
    // shift() corrupt the constant for the life of the process.
    return { kind: 'npm', command: [...RUNNERS.npm.command], parser: parserForScript(script), script };
  }

  for (const marker of ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) {
    if (fs.existsSync(path.join(cwd, marker))) {
      return { kind: 'pytest', command: [...RUNNERS.pytest.command], parser: 'pytest', script: marker };
    }
  }

  // Nothing recognisable. Guessing a command and running it in someone's repo
  // is worse than admitting there is nothing to run: `npm test` without the
  // script prints an error that parses as zero tests, i.e. as zero health.
  return null;
}

// Every parser reads the runner's SUMMARY BLOCK, never the whole stream. That
// distinction is the difference between a green bar and a true one -- see the
// two parsers below, each of which had it wrong in a different way.
const PARSERS = {
  'node-test': (out) => {
    // node:test prints its counters as a contiguous diagnostic block, and THEN
    // a "failing tests:" section listing each failure BY NAME. Scanning the
    // whole stream for the last /fail\s+(\d+)/ therefore reads a TEST NAME:
    //
    //   ℹ pass 1
    //   ℹ fail 1                          <- the truth
    //   ✖ failing tests:
    //   ✖ fail 0 times before giving up   <- what .pop() used to take
    //
    // A real suite with that test reported "healthy 1/1" while red. Verified by
    // running node --test over exactly that case, not by reasoning about it.
    //
    // So: find the LAST counter block (it starts at "tests N") and read only
    // from there. Two reporters produce it -- TAP "# pass 1" and the default
    // spec "ℹ pass 1" -- hence a non-word marker rather than a literal '#'.
    const lines = stripAnsi(out).split('\n');
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\W*tests\s+\d+\s*$/.test(lines[i])) { start = i; break; }
    }
    if (start === -1) return null;

    const counter = (name) => {
      // The block is short and contiguous; stop at the first line that is not
      // a counter so a following section can never be read as one.
      for (let i = start; i < lines.length; i++) {
        const m = /^\W*([a-z_]+)\s+([\d.]+)\s*$/.exec(lines[i]);
        if (!m) break;
        if (m[1] === name) return Number(m[2]);
      }
      return null;
    };

    const passed = counter('pass');
    const failed = counter('fail');
    if (passed === null || failed === null) return null;
    // A cancelled test produced no result at all. Leaving it out of the
    // denominator reports a run aborted at 12% as "healthy 40/40".
    const cancelled = counter('cancelled') || 0;
    return { passed, failed: failed + cancelled, total: passed + failed + cancelled };
  },

  pytest: (out) => {
    // pytest ALWAYS prints failed BEFORE passed -- _pytest/terminal.py emits
    // the categories in a fixed order (failed, passed, skipped, xfailed,
    // xpassed, errors). Verified by running it: "1 failed, 1 passed in 59.87s".
    //
    // The previous version anchored on "N passed" and searched only the TAIL
    // from there, so `failed` -- which is always to the LEFT -- was invisible,
    // and every red Python suite reported a full green bar. The fixture said
    // "63 passed, 2 failed" because it was written from memory, so the test
    // agreed with the bug.
    //
    // Match the summary LINE, then read each count from the whole line.
    const line = [...stripAnsi(out).matchAll(/^.*?\b\d+\s+(?:passed|failed|errors?)\b.*$/gm)].pop();
    if (!line) return null;
    const count = (re) => Number((re.exec(line[0]) || [0, 0])[1]);
    const passed = count(/(\d+)\s+passed/);
    const failed = count(/(\d+)\s+failed/);
    // An erroring test is a broken test: a suite that cannot even import must
    // not read as healthy.
    const errored = count(/(\d+)\s+errors?/);
    // Zero passed is a RESULT, not an absence. "3 failed in 0.12s" is what
    // pytest prints when everything fails, and returning null for it showed
    // the worst possible suite state as "no result yet".
    if (!passed && !failed && !errored) return null;
    return { passed, failed: failed + errored, total: passed + failed + errored };
  },

  jest: (out) => {
    const line = [...String(out).matchAll(/^Tests:.*$/gm)].pop();
    if (!line) return null;
    const passed = Number((/(\d+)\s+passed/.exec(line[0]) || [0, 0])[1]);
    const failed = Number((/(\d+)\s+failed/.exec(line[0]) || [0, 0])[1]);
    if (!passed && !failed) return null;
    return { passed, failed, total: passed + failed };
  },

  mocha: (out) => {
    const passing = /(\d+)\s+passing/.exec(String(out));
    if (!passing) return null;
    const failed = Number((/(\d+)\s+failing/.exec(String(out)) || [0, 0])[1]);
    const passed = Number(passing[1]);
    return { passed, failed, total: passed + failed };
  },
};

// Test runners colour their output, and an ANSI escape CONTAINS DIGITS
// ([32m). Any pattern scanning for "not-a-digit then the word pass"
// therefore stops inside the escape and matches nothing -- which is exactly
// how the first version returned null on this project's own suite while every
// fixture, written in plain text, passed.
const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;?]*[\x20-\x2f]*[\x40-\x7e]/g, '');

function parseResults(parser, output) {
  const fn = PARSERS[parser];
  if (!fn) return null;
  try {
    return fn(stripAnsi(output));
  } catch {
    // Unparseable is NULL, never zero. Zero passed reads as "everything is
    // broken", so a parser that falls behind a tool's format change would
    // report catastrophe rather than ignorance.
    return null;
  }
}

// Deliberately harsh at the top. A red test is a red suite, and rounding
// 318/319 up to "healthy" is how a broken build hides behind a full bar.
function healthFrom(results) {
  if (!results || !results.total) {
    return { fraction: null, state: 'unknown', measures: 'pass rate', passed: 0, failed: 0, total: 0 };
  }
  const fraction = results.passed / results.total;
  const state = results.failed === 0 ? 'healthy'
    : fraction >= 0.75 ? 'hurt'
      : 'critical';
  return { ...results, fraction, state, measures: 'pass rate' };
}

module.exports = { detectRunner, parseResults, healthFrom, RUNNERS, PARSERS };
