'use strict';
/**
 * The mutation gate's own config, checked rather than trusted.
 *
 * `stryker.conf.json` runs a CURATED SUBSET of the suite, because
 * `coverageAnalysis: "off"` makes every mutant re-run the whole command. That
 * design has exactly one failure mode: a module in `mutate` whose tests are not
 * in `command` is measured against a suite that cannot see them, and **the report
 * does not say so**. Its survivors are phantoms -- real kills that were never
 * given the chance to happen.
 *
 * THIS TEST EXISTS BECAUSE I WROTE THAT RULE INTO THE CONFIG IN CAPITALS AND THEN
 * BROKE IT BY HAND TWICE, in the two commits immediately after writing it.
 *
 * Miguel found the first instance: `app/secret-service.js` in `mutate` with
 * `test/secret-ipc.test.js` absent, plus all three lock suites missing. I fixed
 * those, added the rule as a comment, and then added
 * `test/vault-damaged-path.test.js` and `test/vault-lock-pass3.test.js` in the
 * next two commits without touching `command` -- so H1 through H5 and I1, the
 * newest code on the branch, were all outside the run. Mortimer found that before
 * quoting a number, which is the only reason it did not become the number.
 *
 * A rule written in a comment is a rule nothing enforces. So it is derived here
 * FROM THE REQUIRES rather than restated: the check reads which test files
 * actually import which modules, so a new test file joins the obligation
 * automatically and cannot be forgotten.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'stryker.conf.json'), 'utf8'));

// Test files whose subject is the REPOSITORY rather than a function. These kill
// no mutant -- nothing they assert is an expression a mutator can reach -- and
// some cannot even pass under Stryker, whose instrumentation adds globals the
// shared-scope allow-list correctly refuses. Excluding them is deliberate; the
// config says so too, and this list is the machine-readable half of that.
const REPO_SCANNING = new Set([
  'renderer-scope.test.js',   // shared-scope allow-list + git-ls-files + control chars
  'sources-parse.test.js',    // node --check over the tree
  'project-dir.test.js',      // asserts about real directories
  'stryker-config.test.js',   // this file: its subject is the config
  'source-contracts.test.js', // asserts on product modules' SOURCE TEXT
  // renderer.js / renderer.html source text; requires top-bar-display only for
  // MODEL_CHOICES / EFFORT_LEVELS, which top-bar-display.test.js pins itself.
  'renderer-top-bar.test.js',
  // renderer.js source text, plus a run of its submit path against stubs; it requires submit-gate only to feed
  // those stubs the real gate, which submit-gate.test.js and submit-gate-properties.test.js pin themselves.
  'renderer-wand-wiring.test.js',
  // renderer.js / renderer.html / main.js / preload.js source text (#63); it requires tab-shell only for the probe-action
  // whitelist, which tab-shell.test.js pins itself.
  'renderer-resources-wiring.test.js',
]);

const testFiles = fs.readdirSync(path.join(ROOT, 'test'))
  .filter(f => f.endsWith('.test.js'));

// Which local modules does each test file require? Read, not guessed.
function requiresOf(file) {
  const src = fs.readFileSync(path.join(ROOT, 'test', file), 'utf8');
  return new Set(
    [...src.matchAll(/require\(['"]\.\.\/([^'"]+)['"]\)/g)]
      .map(m => (m[1].endsWith('.js') ? m[1] : `${m[1]}.js`)));
}

test('every module Stryker mutates has ALL of its tests in the command', () => {
  const cmd = conf.commandRunner.command;
  const inCommand = new Set(
    [...cmd.matchAll(/test\/([a-z0-9-]+\.test\.js)/g)].map(m => m[1]));
  assert.ok(inCommand.size > 20, `the command must run the suite (${inCommand.size})`);

  const mutated = new Set(conf.mutate);
  assert.ok(mutated.size > 10, 'the scan must find mutated modules');

  const missing = [];
  for (const file of testFiles) {
    if (REPO_SCANNING.has(file) || inCommand.has(file)) continue;
    for (const req of requiresOf(file)) {
      if (mutated.has(req)) {
        missing.push(`${file} exercises ${req}`);
        break;
      }
    }
  }
  assert.deepStrictEqual(missing, [],
    'these test files exercise a MUTATED module and are absent from '
    + 'stryker.conf.json\'s command, so their kills would be reported as '
    + `survivors: ${missing.join('; ')}`);
});

test('the command and mutate list name only files that exist', () => {
  // A renamed file silently narrows the run: Stryker does not fail on a test
  // path that matches nothing, it just runs fewer tests.
  const cmd = conf.commandRunner.command;
  for (const rel of [...cmd.matchAll(/test\/[a-z0-9-]+\.test\.js/g)].map(m => m[0])) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `command names a missing file: ${rel}`);
  }
  for (const rel of conf.mutate) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `mutate names a missing file: ${rel}`);
  }
});

test('the modules that decide whether a session is stopped are mutated (Miguel, PR #76 I3)', () => {
  // A wrong verdict here ends somebody's live claude. The scan above only
  // checks the tests of modules ALREADY in `mutate`; it cannot see one that was
  // never added, which is how host/stop-holder.js first shipped.
  for (const rel of ['host/stop-holder.js', 'host/window-count.js', 'host/session-lock.js', 'host/session-gate.js']) {
    assert.ok(conf.mutate.includes(rel), `${rel} must be in stryker.conf.json's mutate`);
  }
});

test('the tab marks\' parser, prune and store are mutated (Miguel, PR #87 Y1)', () => {
  // Same blind spot as above: a new module is invisible to the scan until it's in `mutate`.
  for (const rel of ['app/tab-marks.js', 'host/tab-marks-store.js', 'host/branch-ledger.js']) {
    assert.ok(conf.mutate.includes(rel), `${rel} must be in stryker.conf.json's mutate`);
  }
});

test('the deliberate exclusions are still deliberate', () => {
  // If one of these is dropped or renamed, the exemption becomes a silent hole
  // rather than a decision. Asserted so the list cannot rot.
  for (const f of REPO_SCANNING) {
    if (f === 'stryker-config.test.js') continue;
    assert.ok(fs.existsSync(path.join(ROOT, 'test', f)),
      `${f} is exempted but no longer exists -- remove it from REPO_SCANNING`);
  }
  const cmd = conf.commandRunner.command;
  for (const f of REPO_SCANNING) {
    assert.ok(!cmd.includes(`test/${f}`),
      `${f} is a repo-scanning test and must NOT be in the Stryker command`);
  }
});

test('the timeout leaves room for the real key derivation', () => {
  // STRYKER COUNTS A TIMEOUT AS KILLED, so on a branch whose KDF is deliberately
  // ~200ms a low ceiling turns clocks into kills -- a phantom kill, the mirror of
  // a phantom survivor. Miguel raised this before the run rather than after.
  //
  // Pinned so nobody lowers it back to a value that scores well for the wrong
  // reason.
  assert.ok(conf.timeoutMS >= 60000,
    `timeoutMS is ${conf.timeoutMS}: too low for a 200ms scrypt under `
    + 'instrumentation, and a timeout is scored as a kill');
});

test('no test in the command reads a MUTATED module as text', () => {
  // Mortimer, PR #42 second run, and the hole this closes is worse than the one
  // the first test closes -- it produces NO NUMBER rather than a wrong one.
  //
  // Stryker's instrumentation rewrites the source of every mutated module. A test
  // in the command that reads that source and asserts on its CODE SHAPE is red on
  // the UNMUTATED BASELINE inside the sandbox, which aborts the entire dry run:
  // 574 of 575 passing, one failure, no mutation score at all. My J1 test did
  // exactly that.
  //
  // THE FINER RULE, measured rather than assumed. FIVE tests in the command read a
  // mutated module's text; only one aborted. The difference is what they assert on:
  //
  //   - COMMENT text survives instrumentation (Stryker preserves comments), so
  //     four of them passed -- by luck rather than by rule, since nothing
  //     guarantees that.
  //   - CODE shape does not survive, because code is exactly what is rewritten.
  //
  // A guard that only flagged code-shape assertions would need to parse intent, so
  // this flags the READ, which is the thing that is statically visible. The four
  // comment-text cases are moved to test/source-contracts.test.js as they are
  // touched; the allow-list below is what remains, and it must only SHRINK.
  const conf2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'stryker.conf.json'), 'utf8'));
  const mutatedBase = new Set(conf2.mutate.map(m => path.basename(m)));
  const inCommand = [...conf2.commandRunner.command.matchAll(/test\/([a-z0-9-]+\.test\.js)/g)]
    .map(m => m[1]);

  // Fragile-but-passing today: each asserts on COMMENT text only, which survives
  // instrumentation. Moving one to source-contracts.test.js is always an
  // improvement; adding one never is.
  const TOLERATED = new Set([
    'openrouter.test.js',        // asserts a comment in host/openrouter.js
    'secret-vault-lock.test.js', // asserts the B2(a) limit paragraph
    // Reads app/tab-strip.js as text only to RUN it as a plain <script> in a vm context (the load-time accent wiring
    // cannot be reached any other way). Instrumented text still runs there, and `process` is injected for it. It
    // asserts no code shape. A named exception, on purpose.
    'tab-strip-accent-wiring.test.js',
  ]);

  // THE BASENAME ANYWHERE INSIDE THE QUOTES. Mortimer, PR #42 run 3, and this is
  // the correction that matters most: my first version required the quote to sit
  // IMMEDIATELY before the basename, so any single path literal containing a
  // slash was invisible. He measured the four natural idioms and three were
  // blind:
  //
  //   INVISIBLE  read('app/secret-vault.js')
  //   INVISIBLE  readFileSync(path.join(ROOT, 'app/secret-vault.js'), 'utf8')
  //   INVISIBLE  readFileSync(path.join(__dirname, '../app/secret-vault.js'))
  //   DETECTED   readFileSync(path.join(__dirname, '..', 'app', 'secret-vault.js'))
  //
  // And the first of those is the `read` helper in source-contracts.test.js:42 --
  // which I created in the SAME COMMIT as this guard. So the commit that added
  // the detector also introduced, one file over, the idiom it cannot see, in the
  // file that is now the designated home for source assertions. The next one
  // written by copying that helper into a command-listed file re-arms the abort
  // with this test green. That path is likelier than the one it caught.
  const reads = (src) => [...src.matchAll(/['"]([^'"\n]*?[a-z0-9-]+\.js)['"]/g)]
    .map(m => path.basename(m[1]));

  // POSITIVE CONTROL, before trusting the scan. Test 1 guards its own liveness
  // with `inCommand.size > 20`; this one had nothing, so a broken regex would
  // make `offenders` empty and the test green while detecting nothing -- the
  // scan-matches-nothing-and-passes failure this whole session keeps finding.
  for (const probe of ["read('app/secret-vault.js')",
                       "fs.readFileSync(path.join(ROOT, 'app/secret-vault.js'), 'utf8')",
                       "fs.readFileSync(path.join(__dirname, '..', 'app', 'secret-vault.js'))",
                       "fs.readFileSync(path.join(__dirname, '../app/secret-vault.js'))"]) {
    assert.ok(reads(probe).includes('secret-vault.js'),
      `the detector must see this idiom, or it is not detecting anything: ${probe}`);
  }

  const offenders = [];
  for (const file of inCommand) {
    if (TOLERATED.has(file)) continue;
    const src = fs.readFileSync(path.join(ROOT, 'test', file), 'utf8');
    if (!/readFileSync|readFile\(/.test(src)) continue;
    for (const base of reads(src)) {
      if (mutatedBase.has(base)) { offenders.push(`${file} reads ${base}`); break; }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these tests are in the mutation command AND read a mutated module as text. '
    + 'Instrumentation rewrites that text, so an assertion on code shape aborts '
    + 'the whole dry run and the gate produces NO NUMBER. Move the assertion to '
    + `test/source-contracts.test.js: ${offenders.join('; ')}`);

  // EVERY TOLERATED ENTRY MUST STILL BE NEEDED. Mortimer: nothing asserted that,
  // so a stale exemption becomes a permanent silent hole and "must only SHRINK"
  // stays aspirational. Now removal is forced rather than remembered -- when one
  // of these is cleaned up, this fails and names it.
  const stale = [...TOLERATED].filter((file) => {
    const src = fs.readFileSync(path.join(ROOT, 'test', file), 'utf8');
    return !reads(src).some(b => mutatedBase.has(b));
  });
  assert.deepStrictEqual(stale, [],
    'these are exempted but no longer read a mutated module -- remove them from '
    + `TOLERATED, which must only shrink: ${stale.join(', ')}`);
});

test('the modules that decide what the Resources panel kills are mutated (#63)', () => {
  // Same blind spot as the stop-holder guard: a module never added to `mutate` is invisible to the scan above. These
  // pick the kill set and end the processes, so a wrong verdict ends somebody's live work.
  const fixed = ['host/resource-kill.js', 'host/resource-stop.js', 'host/resource-tree.js', 'host/resource-model.js',
    'host/resource-sampler.js', 'host/resource-sample.js', 'host/resource-warning.js', 'host/resource-label.js',
    'host/resource-history.js', 'host/chip-store.js', 'app/resources-service.js', 'app/resources-display.js',
    'app/resources-history-display.js'];
  for (const rel of fixed) {
    assert.ok(conf.mutate.includes(rel), `${rel} must be in stryker.conf.json's mutate`);
  }
  // And any module added under host/resource-*.js later must join, not be forgotten.
  const onDisk = fs.readdirSync(path.join(ROOT, 'host')).filter(f => /^resource-.+\.js$/.test(f)).map(f => `host/${f}`);
  assert.ok(onDisk.length >= 9, 'the scan must find the resource modules');
  for (const rel of onDisk) {
    assert.ok(conf.mutate.includes(rel), `${rel} is a resource module and must be in stryker.conf.json's mutate`);
  }
});

test('the real-process tests are skipped by NAME, and the exemption is exact and cannot rot', () => {
  // Tests that spawn real PowerShell cost seconds each and re-run for every mutant. The command's --test-skip-pattern
  // drops them; their FILES stay in the command because the fast tests beside them kill the script mutants. This list
  // is the machine-readable half: each entry must still exist, still spawn real processes, and every test in it that is
  // gated on Windows (`{ skip: ... }`) must be matched by the pattern. It must only SHRINK.
  const REAL_PROCESS_TEST_FILES = [
    'resource-stop-position.test.js', // one real-PowerShell kill test (D4/D5)
    'resource-stop-respawn.test.js',  // N1/N2 real supervisor trees
  ];
  const cmd = conf.commandRunner.command;
  const m = cmd.match(/--test-skip-pattern="([^"]+)"/);
  assert.ok(m, 'the command must carry --test-skip-pattern for the real-process tests');
  const skip = new RegExp(m[1]);

  const titlesOf = (src) => [...src.matchAll(/^test\((['"`])((?:\\.|(?!\1).)*)\1(?:,\s*\{([^}\n]*)\})?/gm)]
    .map(t => ({ title: t[2].replace(/\\(.)/g, '$1'), opts: t[3] || '' }));
  const titlesIn = (file) => titlesOf(fs.readFileSync(path.join(ROOT, 'test', file), 'utf8'));

  // Positive control: the title scan must find tests at all, or "matches nothing" would pass vacuously.
  assert.ok(titlesOf("test('a b', { skip: !WIN, timeout: 1 }, async () => {})")[0].opts.includes('skip'));

  for (const file of REAL_PROCESS_TEST_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, 'test', file)), `${file} is exempted but no longer exists -- remove it`);
    const src = fs.readFileSync(path.join(ROOT, 'test', file), 'utf8');
    assert.ok(/spawn\(/.test(src), `${file} no longer spawns real processes -- remove it from REAL_PROCESS_TEST_FILES`);
    assert.ok(cmd.includes(`test/${file}`), `${file} must stay in the command: its fast tests kill mutants`);
    const real = titlesIn(file).filter(t => /\bskip:/.test(t.opts));
    assert.ok(real.length > 0, `${file} has no skip-gated real test left -- remove it from REAL_PROCESS_TEST_FILES`);
    for (const t of real) {
      assert.ok(skip.test(t.title), `real-process test "${t.title}" in ${file} is not matched by --test-skip-pattern`);
    }
    // ...and the fast tests beside them are NOT skipped.
    for (const t of titlesIn(file).filter(x => !/\bskip:/.test(x.opts))) {
      assert.ok(!skip.test(t.title), `fast test "${t.title}" in ${file} would be skipped by the pattern`);
    }
  }

  // The pattern must not silently narrow any other test in the command.
  const inCommand = [...cmd.matchAll(/test\/([a-z0-9-]+\.test\.js)/g)].map(x => x[1]);
  const hit = [];
  for (const file of inCommand) {
    if (REAL_PROCESS_TEST_FILES.includes(file)) continue;
    for (const t of titlesIn(file)) if (skip.test(t.title)) hit.push(`${file}: ${t.title}`);
  }
  assert.deepStrictEqual(hit, [], `--test-skip-pattern would skip tests outside the named files: ${hit.join('; ')}`);
});
