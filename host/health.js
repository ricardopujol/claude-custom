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
    return { kind: 'npm', command: RUNNERS.npm.command, parser: parserForScript(script), script };
  }

  for (const marker of ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) {
    if (fs.existsSync(path.join(cwd, marker))) {
      return { kind: 'pytest', command: RUNNERS.pytest.command, parser: 'pytest', script: marker };
    }
  }

  // Nothing recognisable. Guessing a command and running it in someone's repo
  // is worse than admitting there is nothing to run: `npm test` without the
  // script prints an error that parses as zero tests, i.e. as zero health.
  return null;
}

// Every parser returns the LAST summary in the output: a multi-project or
// watch-mode run prints one per project, and the final one is the total.
const PARSERS = {
  'node-test': (out) => {
    // Two shapes, because node:test has two reporters and the DEFAULT is not
    // the one the fixtures were written against:
    //   TAP   "# pass 293"
    //   spec  "ℹ pass 293"      <- what `npm test` actually prints here
    // The fixture-only version returned null on this project's own output. The
    // marker is therefore anything-but-a-digit, not a literal '#'.
    const pass = [...String(out).matchAll(/^\s*\D*\bpass\s+(\d+)/gm)].pop();
    const fail = [...String(out).matchAll(/^\s*\D*\bfail\s+(\d+)/gm)].pop();
    if (!pass || !fail) return null;
    const passed = Number(pass[1]);
    const failed = Number(fail[1]);
    return { passed, failed, total: passed + failed };
  },

  pytest: (out) => {
    const line = [...String(out).matchAll(/(\d+)\s+passed(?:[^\n]*)/g)].pop();
    if (!line) return null;
    const tail = line[0];
    const passed = Number(line[1]);
    const failed = Number((/(\d+)\s+failed/.exec(tail) || [0, 0])[1]);
    // An erroring test is a broken test. Counting only "failed" would report a
    // suite that cannot even import as perfectly healthy.
    const errored = Number((/(\d+)\s+errors?/.exec(tail) || [0, 0])[1]);
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
