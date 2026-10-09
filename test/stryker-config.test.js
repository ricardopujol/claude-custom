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
  // #71 Claude's panel: source assertions on host.js / main.js / renderer.js; they say "deliberately NOT in Stryker's command" themselves.
  'canvas-wiring.test.js',
  'canvas-main-wiring.test.js',
  'renderer-canvas-wiring.test.js',
  // Release-gate lane 2026-10-09 (Miguel I1/I2): the tests that run real processes, split from the files in the command. A Stryker timeout counts as a
  // KILL and a hung child is left behind, so they stay out; their pure tests stay in. Run them by hand: node --test test/<name>-process.test.js
  'status-relay-process.test.js',
  'probe-hygiene-process.test.js',
  'settings-writer-process.test.js',
  'canvas-mcp-process.test.js',    // #125: spawns the MCP server as a real process and names its script; split out of canvas-mcp.test.js so the in-process tests can be mutated
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
    // Neither READS a mutated module (release-gate lane, 2026-10-09): both only NAME one as a string (status-relay.test.js in the settings it builds,
    // settings-writer.test.js as 'host/loadout-hook.js'). The detector flags a quoted path beside any readFileSync in the file, so the name is what
    // trips it. (The source-text assertions on host/status-relay.js are in source-contracts.test.js.)
    'status-relay.test.js',
    'settings-writer.test.js',
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
  // And any module added later under host/resource-*.js or app/resources-*.js must join, not be forgotten.
  const scan = (dir, re) => fs.readdirSync(path.join(ROOT, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`);
  const hostOnDisk = scan('host', /^resource-.+\.js$/);
  const appOnDisk = scan('app', /^resources-.+\.js$/);
  assert.ok(hostOnDisk.length >= 9, `the scan must find the host resource modules (${hostOnDisk.length})`);
  assert.ok(appOnDisk.length >= 3, `the scan must find the app resources modules (${appOnDisk.length})`);
  for (const rel of [...hostOnDisk, ...appOnDisk]) {
    assert.ok(conf.mutate.includes(rel), `${rel} is a resource module and must be in stryker.conf.json's mutate`);
  }
});

// ---- the real-process tests: skipped by NAME, classified by CONTENT ---------------------------------------------------

// What "this runs a real process" looks like: child_process spawn/exec of node, powershell or a shell, or the repo's own
// PowerShell helper (createExec). git is deliberately not here: a git call is milliseconds, PowerShell is seconds.
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*(?:process\.execPath|['"`](?:powershell|pwsh|node|bash|sh)\b)|\bcreateExec\(/;

// Every test/it/describe title in a source, at any indentation.
const titlesOf = (src) => [...src.matchAll(/^\s*(?:test|it|describe)\((['"`])((?:\\.|(?!\1).)*)\1(?:,\s*\{([^}\n]*)\})?/gm)]
  .map(t => ({ title: t[2].replace(/\\(.)/g, '$1'), opts: t[3] || '' }));

// Column-0 test blocks (`test(` ... the next column-0 `});`) with their titles and bodies; the rest is the preamble.
function blocksOf(src) {
  const blocks = [];
  const preamble = src.replace(/^(?:test|it)\((['"`])((?:\\.|(?!\1).)*)\1[\s\S]*?^\}\);/gm, (all, q, title) => {
    blocks.push({ title: title.replace(/\\(.)/g, '$1'), body: all });
    return '';
  });
  return { blocks, preamble };
}

// The titles of the tests that spawn a real process: directly, or through a file-level helper that does.
function spawningTitles(src) {
  const { blocks, preamble } = blocksOf(src);
  const helpers = [];
  const stmts = preamble.split(/^(?=(?:async\s+)?function\s|const\s|let\s|var\s)/m);
  // A helper spawns if its statement does, or if it calls a helper that does (to a fixed point).
  for (let grew = true; grew;) {
    grew = false;
    for (const stmt of stmts) {
      const name = /^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)\s*=/.exec(stmt);
      const id = name && (name[1] || name[2]);
      if (!id || helpers.includes(id)) continue;
      if (SPAWN.test(stmt) || helpers.some(h => new RegExp(`\\b${h}\\b`).test(stmt))) { helpers.push(id); grew = true; }
    }
  }
  return blocks
    .filter(b => SPAWN.test(b.body) || helpers.some(h => new RegExp(`\\b${h}\\b`).test(b.body)))
    .map(b => b.title);
}

test('the real-process tests are skipped by NAME, classified by CONTENT, and the exemption cannot rot', () => {
  // Tests that spawn real PowerShell cost seconds each and re-run for every mutant. The command's --test-skip-pattern
  // drops them by title (an UNANCHORED SUBSTRING regex over every test title in the whole command); their FILES stay
  // because the fast tests beside them kill the script mutants. Whether a test is "real" is decided by what it DOES (it
  // spawns), not by a `skip:` option, so a real test that nobody gated is caught and named.
  const REAL_PROCESS_TEST_FILES = [
    'resource-stop-position.test.js', // one real-PowerShell kill test (D4/D5)
    'resource-stop-respawn.test.js',  // N1/N2 real supervisor trees
    'resource-sampler.test.js',       // one real CIM sample
    'kill-proven.test.js',            // one real sleeper killed through killProven's PowerShell (PR #130, Dexter #2)
  ];
  // Command files that spawn real processes and are NOT skipped. Every one predates #63 and was accepted by earlier gate
  // runs (node -e children are tens of ms; the two PowerShell ones are one call each). Adding here is a decision, and
  // each entry must still spawn, so the list can only shrink.
  const TOLERATED_REAL_SPAWNERS = new Set([
    'loadout-hook.test.js',        // runs the hook script as a node child
    'branch-ledger-days.test.js',  // node -e children for day-boundary clocks
    'summary-slot-kills.test.js',  // one node -e child whose pid is then free
    'proc-start.test.js',          // one real powershell holder (pre-#63)
    'window-count.test.js',        // the real proc-start exec (pre-#63)
  ]);

  const cmd = conf.commandRunner.command;
  const m = cmd.match(/--test-skip-pattern="([^"]+)"/);
  assert.ok(m, 'the command must carry --test-skip-pattern for the real-process tests');
  const skip = new RegExp(m[1]);
  const inCommand = [...cmd.matchAll(/test\/([a-z0-9-]+\.test\.js)/g)].map(x => x[1]);
  const read = (file) => fs.readFileSync(path.join(ROOT, 'test', file), 'utf8');

  // POSITIVE CONTROLS, so a scan that sees nothing cannot pass. The title scan finds test/it/describe at any indent...
  const seen = titlesOf("test('a', () => {});\ndescribe('b', () => {\n  it(\"c\", () => {});\n});").map(t => t.title);
  assert.deepStrictEqual(seen, ['a', 'b', 'c']);
  // ...and the spawn classifier finds a direct spawn and a spawn through a helper, and leaves a fast test alone.
  const fixture = [
    "const { spawn } = require('child_process');",
    "const mk = () => spawn(process.execPath, ['-e', '0']);",
    "function viaHelper() { return mk(); }",
    "test('direct', () => {\n  spawn('powershell', []);\n});",
    "test('helper', () => {\n  viaHelper();\n});",
    "test('fast', () => {\n  assert.ok(1);\n});",
    '',
  ].join('\n');
  assert.deepStrictEqual(spawningTitles(fixture), ['direct', 'helper']);

  // The title scan sees the whole command, with a floor (the suite is ~5,700 tests) and a known title from each side.
  const all = inCommand.flatMap(file => titlesOf(read(file)).map(t => ({ file, ...t })));
  assert.ok(all.length > 4000, `the title scan must see the command's tests (${all.length})`);
  const respawn = all.filter(t => t.file === 'resource-stop-respawn.test.js').map(t => t.title);
  assert.ok(respawn.some(t => skip.test(t)) && respawn.some(t => !skip.test(t)),
    'the scan must see both a skipped (N1 real) and a kept (N2 kill script) title in resource-stop-respawn.test.js');

  // A. Every named real-process file exists, still spawns, stays in the command, and its spawning tests (and only those)
  //    are matched by the pattern.
  for (const file of REAL_PROCESS_TEST_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, 'test', file)), `${file} is exempted but no longer exists -- remove it`);
    assert.ok(inCommand.includes(file), `${file} must stay in the command: its fast tests kill mutants`);
    const src = read(file);
    const real = spawningTitles(src);
    assert.ok(real.length > 0, `${file} no longer spawns real processes -- remove it from REAL_PROCESS_TEST_FILES`);
    for (const t of real) assert.ok(skip.test(t), `${file}: the spawning test "${t}" is not matched by --test-skip-pattern`);
    const { blocks } = blocksOf(src);
    for (const b of blocks.filter(x => !real.includes(x.title))) {
      assert.ok(!skip.test(b.title), `${file}: the fast test "${b.title}" would be skipped by the pattern`);
    }
    assert.strictEqual(titlesOf(src).length, blocks.length,
      `${file} has tests this guard cannot classify (nested or non-column-0)`);
  }

  // B. Any OTHER command file that spawns real processes is a named, still-true exception, or this fails naming it.
  const unnamed = [];
  for (const file of inCommand) {
    if (REAL_PROCESS_TEST_FILES.includes(file)) continue;
    const spawns = SPAWN.test(read(file));
    if (spawns && !TOLERATED_REAL_SPAWNERS.has(file)) unnamed.push(file);
  }
  assert.deepStrictEqual(unnamed, [], 'these command files spawn real processes and are neither gated by --test-skip-pattern '
    + `nor named in TOLERATED_REAL_SPAWNERS: ${unnamed.join(', ')}`);
  const staleTolerated = [...TOLERATED_REAL_SPAWNERS].filter(f => !inCommand.includes(f) || !SPAWN.test(read(f)));
  assert.deepStrictEqual(staleTolerated, [], `these no longer spawn (or left the command) -- remove them: ${staleTolerated.join(', ')}`);

  // C. The pattern must not silently narrow any test outside the named real files.
  const hit = all.filter(t => !REAL_PROCESS_TEST_FILES.includes(t.file) && skip.test(t.title)).map(t => `${t.file}: ${t.title}`);
  assert.deepStrictEqual(hit, [], `--test-skip-pattern would skip tests outside the named files: ${hit.join('; ')}`);
});

test("every logic module of Claude's panel is mutated (Miguel, PR #122 Y5: six of them were never listed, and the consistency test above can't see a module that isn't)", () => {
  // Derived from the tree, not restated: any app/canvas-*.js or host/canvas-*.js is logic-bearing and security-bearing unless it is named below.
  const NOT_LOGIC = new Set([
    'app/canvas-panel-preload.js',   // the two-function bridge: needs Electron's contextBridge, and test/canvas-panel-preload.test.js pins its surface
  ]);
  const found = [];
  for (const dir of ['app', 'host']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (/^canvas-.*.js$/.test(f) && !NOT_LOGIC.has(`${dir}/${f}`)) found.push(`${dir}/${f}`);
  }
  assert.ok(found.length >= 7, `the scan must find the panel's modules (${found.join(', ')})`);
  const mutated = new Set(conf.mutate);
  const unlisted = found.filter(m => !mutated.has(m));
  assert.deepStrictEqual(unlisted, [], `these panel modules are not in stryker.conf.json's mutate list, so no mutation score covers them: ${unlisted.join(', ')}`);
  const cmd = conf.commandRunner.command;
  for (const m of found) {
    const own = `test/${path.basename(m, '.js')}.test.js`;
    if (fs.existsSync(path.join(ROOT, own))) assert.ok(cmd.includes(own), `${own} must be in the command`);
  }
});

test('the eight modules that decide what is killed, deleted or kept running are mutated (Mortimer, release gate 2026-10-09)', () => {
  // The consistency test above only checks the tests of modules ALREADY in `mutate`; these eight shipped (PRs #121-#133) without being
  // listed, so no gate measured the code that kills a process tree, edits the pid ledger, deletes task logs and ends the quit.
  for (const rel of ['host/kill-tree.js', 'host/pid-ledger.js', 'host/task-logs.js', 'host/task-logs-fs.js', 'host/status-relay.js',
    'app/quit-watchdog.js', 'host/settings-writer.js', 'host/canvas-mcp.js']) {
    assert.ok(conf.mutate.includes(rel), `${rel} must be in stryker.conf.json's mutate`);
  }
});

test('the real-process halves of status-relay, probe-hygiene and settings-writer stay split out of the command (Miguel, PR #142 I1/I2)', () => {
  // A Stryker timeout counts as a KILL, and a hung child is left behind: the tests that run real processes live in <name>-process.test.js,
  // exempt from the command, while the pure tests stay in. Each must exist, still spawn, and stay out; the pure file must not spawn.
  const cmd = conf.commandRunner.command;
  for (const name of ['status-relay', 'probe-hygiene', 'settings-writer']) {
    const proc = fs.readFileSync(path.join(ROOT, 'test', name + '-process.test.js'), 'utf8');
    assert.ok(SPAWN.test(proc), name + '-process.test.js no longer spawns a real process: merge it back or drop it');
    assert.ok(!cmd.includes('test/' + name + '-process.test.js'), name + '-process.test.js must NOT be in the command');
    assert.ok(cmd.includes('test/' + name + '.test.js'), name + '.test.js (the pure tests) must be in the command');
    assert.ok(!SPAWN.test(fs.readFileSync(path.join(ROOT, 'test', name + '.test.js'), 'utf8')), name + '.test.js must not spawn real processes');
  }
});
