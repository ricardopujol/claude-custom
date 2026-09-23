'use strict';
/**
 * The code as the BROWSER actually loads it.
 *
 * THE DEFECT CLASS THIS RETIRES. The renderer loads its scripts as plain
 * `<script src>` tags, which share ONE global lexical scope. Two files each
 * declaring `const UNKNOWN` is a `SyntaxError` that aborts the second file
 * entirely -- and the aborted file's functions are then `undefined`, so the
 * panel it draws silently never renders.
 *
 * **No unit test can see this.** Every other test in this repo `require()`s a
 * module into its own scope, where there is nothing to collide with. It has
 * now bitten twice: `app/career-display.js` and `app/quota-display.js` were
 * both dead on arrival in the real renderer while 100% of their tests passed.
 * `test/sources-parse.test.js` cannot see it either -- it runs `node --check`
 * per file, in isolation, and a duplicate-`const` collision only exists when
 * two scripts share one scope.
 *
 * So this test does the only thing that can catch it: parses the script list
 * out of `app/renderer.html` and evaluates every one of them, IN ORDER, into a
 * single shared `vm` context -- which is what Chromium does.
 *
 * The allow-list is deliberately an ALLOW-list. A new global is out of scope
 * until someone opts it in, so the next file to leak a `plural` or an
 * `escapeHtml` fails here rather than in six months in the product.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app');

// Every global the renderer's scripts are permitted to define. Anything else
// showing up here is a leak waiting to collide with the next file added.
const ALLOWED_GLOBALS = new Set([
  // app/side-tabs.js. isPanelToggle is deliberate and load-bearing:
  // renderer.js calls it as a bare global inside the xterm key handler,
  // which is the only place that can stop the terminal eating Ctrl+B.
  'nextTab', 'TABS', 'DEFAULT_TAB', 'isKnownTab', 'isPanelToggle',
  // app/secret-mask.js, app/attention-surface.js
  'createMask', 'surfacesFor',
  // the display modules
  'usageDisplay', 'spendOf', 'cacheReadOf',
  // app/roster-width.js -- the panel width POLICY, moved out of renderer.js
  // (Miguel, PR #33, A1) so its three tuned numbers can be asserted.
  'rosterWidth', 'rosterMax', 'faceSize',
  // app/vault-lock-display.js -- the lock panel's four states
  'vaultLockDisplay',
  'cacheWriteOf',
  'careerDisplay', 'formatCareerMinutes', 'mergeAgentStats', 'rosterEmptyState',
  'quotaDisplay', 'formatQuotaCountdown',
  // app/bugvault-display.js. Both are DELIBERATE exports from a correctly
  // IIFE-wrapped module, not leaks -- checked before allowlisting them, since
  // "a name escaped into the shared scope" and "a module deliberately published
  // a name" look identical from here and only one of them is a bug.
  //
  // renderer.js reaches `bugVaultDisplay` through `window.` rather than as a
  // bare global, so unlike isPanelToggle above this entry is not load-bearing
  // for reachability. `formatBugRow` is published to the browser scope and used
  // by nothing there -- surface that invites a second, divergent caller. Left
  // as the feature author wrote it and flagged rather than trimmed, because
  // deleting someone else's export is not conflict resolution.
  'bugVaultDisplay', 'formatBugRow',
  'projectsDisplay',
]);

// The scripts renderer.html loads from ./, in document order. node_modules
// vendor scripts are skipped: they are not ours and xterm is not loadable
// outside a DOM.
function rendererScripts() {
  const html = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
  const out = [];
  const re = /<script\s+src="\.\/([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// A context with just enough browser to let these files reach their
// `window` branch. None of them touches the DOM at load time -- if one starts
// to, this test is the right place to find out.
function makeContext() {
  const ctx = { console };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {}, remove() {} }),
    body: { appendChild() {} },
  };
  return vm.createContext(ctx);
}

test('renderer.html actually lists the display modules it depends on', () => {
  // The other half of the same failure: a module can be perfect, wrapped, and
  // simply never loaded. `careerDisplay` is referenced in exactly one place in
  // renderer.js, and nothing asserted the tag existed.
  const scripts = rendererScripts();
  assert.ok(scripts.includes('renderer.js'), 'the renderer itself must be loaded');
  assert.ok(scripts.indexOf('renderer.js') === scripts.length - 1,
    'renderer.js must load LAST -- it consumes what the others define');
  for (const f of scripts) {
    assert.ok(fs.existsSync(path.join(APP, f)), `renderer.html loads ${f}, which does not exist`);
  }
});

test('every renderer script loads into ONE shared scope without colliding', () => {
  // This is the test that fails when someone adds a fifth module declaring a
  // name a fourth one already has.
  const ctx = makeContext();
  for (const file of rendererScripts()) {
    if (file === 'renderer.js') continue;     // needs a real DOM; covered above
    const src = fs.readFileSync(path.join(APP, file), 'utf8');
    try {
      vm.runInContext(src, ctx, { filename: file });
    } catch (err) {
      assert.fail(`${file} failed to load alongside the scripts before it: ${err.message}`);
    }
  }
});

// NOTE FOR MUTATION RUNS: this test cannot pass under StrykerJS. Its
// instrumentation adds stryNS_*/stryCov_*/stryMutAct_*/__stryker__ to the vm
// context and the allow-list correctly refuses them, so it fails on the
// UNMUTATED baseline and aborts the dry run. Deselect it by name; it kills no
// mutant, because what it asserts is a property of the FILES rather than of
// any expression a mutator can reach. CLAUDE.md records the same shape for
// mutmut: a test whose subject is the repository, not a function.
test('no renderer script leaks a global outside the allow-list', () => {
  const ctx = makeContext();
  const before = new Set(Object.getOwnPropertyNames(ctx));
  for (const file of rendererScripts()) {
    if (file === 'renderer.js') continue;
    vm.runInContext(fs.readFileSync(path.join(APP, file), 'utf8'), ctx, { filename: file });
  }
  const leaked = Object.getOwnPropertyNames(ctx).filter(k => !before.has(k));
  const unexpected = leaked.filter(k => !ALLOWED_GLOBALS.has(k));
  assert.deepStrictEqual(unexpected, [],
    'these globals are not on the allow-list and will collide with the next file that wants the name');
});

test('the display modules the renderer needs are actually defined after loading', () => {
  // Reachability, not just absence of error. This is what `fix: the career
  // display never loaded in the real renderer` owed and did not have.
  const ctx = makeContext();
  for (const file of rendererScripts()) {
    if (file === 'renderer.js') continue;
    vm.runInContext(fs.readFileSync(path.join(APP, file), 'utf8'), ctx, { filename: file });
  }
  // Mortimer, PR #29 mutation gate, D7: emptying the `else { root.X = ... }`
  // branch in app/bugvault-display.js left every test green, with
  // `window.bugVaultDisplay` never published -- the panel dead on arrival in
  // the real renderer. That is the failure this repo has already paid for
  // TWICE (career-display.js, quota-display.js) and that this very file exists
  // to prevent; it did not prevent it here, because the list below named only
  // `usageDisplay`, and the export check further down skips names reached
  // through `window.` rather than as bare globals.
  //
  // Node's coverage confirmed it independently: app/bugvault-display.js lines
  // 153-155 never executed.
  //
  // ANY module the renderer draws a panel from belongs on this list.
  // Every display module the renderer calls, not just the first one anyone
  // thought to list. Both sides of this merge learned that separately --
  // develop added career/quota/projects after the Projects panel drew nothing
  // in a real window, #29 added bugVaultDisplay after mutation testing showed
  // its browser-export branch was executed by nothing. Same lesson, two
  // branches, so the list is the UNION: taking either alone silently drops a
  // module that has already been caught once.
  for (const fn of ['usageDisplay', 'careerDisplay', 'quotaDisplay', 'projectsDisplay',
                    'rosterWidth', 'faceSize', 'bugVaultDisplay',
                    'vaultLockDisplay']) {
    assert.strictEqual(typeof ctx[fn], 'function', `${fn} must be reachable from renderer.js`);
  }
});

test('no two renderer scripts declare the same top-level name', () => {
  // The DYNAMIC check above proves a collision throws (verified: two scripts
  // each declaring `const UNKNOWN` in one vm context raise "Identifier
  // 'UNKNOWN' has already been declared"). But a top-level `const` is NOT an
  // own property of the context, so the allow-list test cannot see lexical
  // leaks at all -- it only catches `var` and assignment.
  //
  // This is the static half: it names the offender and the file, and it catches
  // the collision BEFORE the two files are ever loaded together.
  const declRe = /^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm;
  const owner = new Map();
  const clashes = [];

  for (const file of rendererScripts()) {
    const src = fs.readFileSync(path.join(APP, file), 'utf8');
    // A file wrapped in an IIFE declares NOTHING in the shared scope, however
    // its declarations are indented -- and this codebase does not indent inside
    // the wrapper. Skipping them is what keeps this check from crying wolf on
    // the three display modules, which all legitimately declare `UNKNOWN`
    // inside their own wrappers. A test that fires on safe code gets deleted,
    // and then the real one is gone too.
    if (/^\(function \(root\) \{/m.test(src)) continue;
    const seen = new Set();
    let m;
    while ((m = declRe.exec(src))) seen.add(m[1]);
    for (const name of seen) {
      if (owner.has(name)) clashes.push(`${name}: ${owner.get(name)} and ${file}`);
      else owner.set(name, file);
    }
  }

  assert.deepStrictEqual(clashes, [],
    'these names are declared at top level in two scripts that share one scope');
});

test('every module function renderer.js calls is actually exported to it', () => {
  // THE MIRROR OF THE LEAK TEST, and the gap that let this file pass while the
  // app broke. The leak test asks what escapes a module; nothing asked what
  // FAILS to escape one. Wrapping app/side-tabs.js in an IIFE while resolving
  // the #26/#27 merge removed `isPanelToggle` from the global scope that
  // renderer.js calls it from -- silently re-breaking Ctrl+B with the whole
  // suite green, which is exactly how PR #27 found it the first time.
  //
  // So: any name a module declares AND renderer.js calls must be reachable
  // after the modules load.
  const ctx = makeContext();
  const modules = rendererScripts().filter(f => f !== 'renderer.js');
  const declared = new Map();                 // name -> the file that declares it
  const DECL = /(?:^|\n)\s*(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const file of modules) {
    const src = fs.readFileSync(path.join(APP, file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
    let m;
    while ((m = DECL.exec(src))) if (!declared.has(m[1])) declared.set(m[1], file);
  }

  // Names renderer.js declares itself are its own, and prove nothing here.
  const renderer = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
  const ownDecls = new Set();
  const OWN = /(?:^|\n)\s*(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let d;
  while ((d = OWN.exec(renderer))) ownDecls.add(d[1]);

  const missing = [];
  for (const [name, file] of declared) {
    if (ownDecls.has(name)) continue;
    if (!new RegExp('(?:^|[^\\w$.])' + name + '\\s*\\(').test(renderer)) continue;   // not called at all
    if (!(name in ctx)) missing.push(name + ' (declared in ' + file + ')');
  }
  assert.deepStrictEqual(missing, [],
    'renderer.js calls these as bare globals, but no module exports them -- ' +
    'they are ReferenceErrors in the real window');
});

test('every element id renderer.js reaches for at TOP LEVEL exists in renderer.html', () => {
  // Miguel, PR #31. `document.getElementById(x)` returning null at module top
  // level is a TypeError that ABORTS ALL OF renderer.js -- terminal, panels,
  // everything -- for a renamed id. Nothing could see it: the tests above
  // deliberately skip renderer.js when loading the scripts, because it needs a
  // real DOM.
  //
  // This is the mirror of the TABS-vs-markup drift guard in
  // test/side-tabs.test.js, which was itself written after a panel turned out
  // to be unreachable with the whole suite green. Same shape of gap, same
  // shape of answer: compare the two artifacts that must agree.
  const js = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');

  // Top level only: stop at the first line that is indented, i.e. inside
  // something. Crude, and it is the region where a null actually kills the file.
  const topLevel = js.split('\n').filter(l => !/^\s/.test(l)).join('\n');
  const ids = [...topLevel.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  assert.ok(ids.length > 0, 'the scan must find something for this check to mean anything');

  const missing = ids.filter(id => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [],
    `renderer.js reaches for these ids at top level and renderer.html has none of them: ${missing.join(', ')}`);
});

test('EVERY element id renderer.js reaches for exists in renderer.html, at any depth', () => {
  // Miguel, PR #40, A7. The guard above scans TOP LEVEL only, because that is
  // where a null `getElementById` throws and aborts the file. But a null deeper
  // in is not harmless -- it is worse, because it is SILENT.
  //
  // `app/renderer.js` reads the Shared checkbox as
  // `!!(sharedBox && sharedBox.checked)`, inside the submit handler. Rename or
  // delete `vault-shared` in the HTML and the null-guard swallows it: `shared`
  // is false forever, the user ticks a box that does nothing, no console error,
  // suite green. A null-guard written for safety converts a loud failure into a
  // permanent quiet wrong answer.
  //
  // This repo has now shipped that shape FOUR times -- careerDisplay,
  // quotaDisplay, isPanelToggle, and `.vault-row`. Two of them were the same
  // renderer.js/renderer.html drift this checks. It is a recurring class with a
  // known guard, so the guard should cover the whole file.
  //
  // NOT a substring check against renderer.js. Miguel flagged the trap before I
  // could walk into it again: `js.includes('vault-shared')` is satisfied by the
  // `getElementById('vault-shared')` call itself, so it is true precisely when
  // the bug is present. The comparison has to be against renderer.html.
  const js = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');

  const ids = [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  assert.ok(ids.length > 0, 'the scan must find something for this check to mean anything');

  // THE INDIRECT IDS, which the first version of this guard missed and which
  // matter more than the direct ones, because an indirection is where a static
  // check usually gives up and a reader assumes it did not.
  //
  // Three call sites pass a VARIABLE: two `val = (id) => ...` helpers and the
  // loop in `wireModelPanel`. My first version simply asserted no computed
  // argument existed, and failed on all three -- a guard whose response to real
  // code was to declare the code wrong. The ids are still statically knowable;
  // they just travel one hop. So follow the hop instead of exempting it:
  // `val('x')` call sites, and literal arrays handed to a getElementById loop.
  for (const m of js.matchAll(/\bval\(['"]([^'"]+)['"]\)/g)) ids.push(m[1]);
  for (const m of js.matchAll(/const ids = \[([^\]]+)\]/g)) {
    for (const lit of m[1].matchAll(/['"]([^'"]+)['"]/g)) ids.push(lit[1]);
  }

  // Anything still computed is out of reach of a static check. There is nothing
  // like that today; this asserts it rather than assuming it, so that adding one
  // is a deliberate act with a name attached.
  const computed = [...js.matchAll(/getElementById\(([^'")][^)]*)\)/g)]
    .map(m => m[1].trim())
    .filter(a => a !== 'id');   // the three helper parameters, followed above
  assert.deepStrictEqual(computed, [],
    'a computed getElementById argument cannot be checked statically -- ' +
    'if one is added deliberately, exempt it here by name and say why');

  // TWO legitimate sources of an element, not one. The static markup is the
  // obvious one; the other is markup renderer.js builds itself and assigns
  // through innerHTML -- the vault lock panel's key field is created that way,
  // because which field exists depends on which of the four lock states is
  // showing. Those elements are real and reachable, and a guard that knows only
  // about renderer.html calls them missing.
  //
  // Caught by this guard on its first run against the lock panel. Worth keeping
  // as a comment rather than a silent widening, because the first instinct on a
  // red guard is to trust the guard.
  //
  // THIS IS NOT the substring trap Miguel warned about, and the difference is
  // worth stating precisely, because the two look alike. His trap was that
  // searching renderer.js for `vault-shared` is satisfied by the
  // `getElementById('vault-shared')` call itself -- the check is true exactly
  // when the bug is present. Here the pattern matched is the ATTRIBUTE form,
  // `id="x"`, which a getElementById call cannot produce. Only markup makes it,
  // and markup is the thing being looked for.
  const emitted = (id) => new RegExp(`id=["']${id}["']`).test(js);
  const missing = [...new Set(ids)]
    .filter(id => !html.includes(`id="${id}"`) && !emitted(id));
  assert.deepStrictEqual(missing, [],
    `renderer.js reaches for these ids and neither renderer.html nor renderer.js ` +
    `creates them: ${missing.join(', ')}`);
});

test('the emitted-id escape hatch cannot be opened by a getElementById call alone', () => {
  // The guard above accepts an id that renderer.js emits as markup. That escape
  // hatch is exactly where Miguel's substring trap would get back in, so this
  // pins the distinction instead of trusting the comment.
  const js = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');
  const emitted = (id, src) => new RegExp(`id=["']${id}["']`).test(src);

  assert.strictEqual(emitted('made-up-id', `document.getElementById('made-up-id')`), false,
    'a getElementById call must NOT count as creating the element');
  assert.strictEqual(emitted('made-up-id', `'<input id="made-up-id" />'`), true,
    'markup that creates it must count');
  assert.strictEqual(emitted('vault-key', js), true,
    'precondition: the lock panel still builds its key field in renderer.js');
});

test('the deep-id guard actually catches a renamed id', () => {
  // The guard above is a scan, and a scan that matches nothing passes. This
  // pins that it would FAIL -- the check Miguel's A1 taught me to write, after
  // my first version of a drift guard passed because the broken selector
  // contained the string it searched for.
  const html = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');
  const js = fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8');

  assert.ok(js.includes("getElementById('vault-shared')"),
    'precondition: the Shared checkbox is still read by this id');

  const renamed = html.replace('id="vault-shared"', 'id="vault-shared-RENAMED"');
  assert.notStrictEqual(renamed, html, 'precondition: the id exists in the markup');

  const ids = [...new Set(
    [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]))];
  assert.ok(ids.filter(id => !renamed.includes(`id="${id}"`)).includes('vault-shared'),
    'renaming the checkbox must be caught -- otherwise the box silently does nothing');
});

test('no source file contains a stray control character', () => {
  // A GUARD FOR A TOOLING TRAP, NOT A PRODUCT BUG, and it earns its place by
  // recurrence: backslash mangling through a shell heredoc has now damaged this
  // repo's source three times in one session.
  //
  // The last one wrote the guard directly above this. `\b` inside a
  // double-quoted Python string is not the two characters backslash-b, it is
  // BACKSPACE (0x08). So `/\bval\(...)/` was written to disk as
  // `/<0x08>val\(...)/`, a regex that matches nothing.
  //
  // The damage is that it fails in the SAFE-LOOKING direction: a scan matching
  // nothing finds nothing missing, so the guard passed, reported nine green
  // tests, and covered exactly none of what it claimed. It was caught only by
  // renaming an id on purpose and noticing the guard did not care.
  //
  // Invisible to every other check: it is valid UTF-8, a legal regex, and
  // renders as nothing in most editors and in `git diff`.
  const dirs = ['app', 'test', 'host', 'bin'];
  const files = [];
  for (const d of dirs) {
    const dir = path.join(__dirname, '..', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.(js|html|json)$/.test(f)) files.push(path.join(dir, f));
    }
  }
  assert.ok(files.length > 20, `the scan must find the source to mean anything (${files.length})`);

  // Tab, newline and carriage return are the only control characters source
  // should hold. Everything else below 0x20 arrived by accident.
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) {
        offenders.push(`${path.basename(f)} byte ${i}: 0x${c.toString(16).padStart(2, '0')}`);
        break;
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `control characters in source -- almost certainly a mangled backslash escape: ${offenders.join('; ')}`);
});
