'use strict';
/**
 * THE STRINGS THAT JOIN FOUR FILES, ASSERTED AGAINST SOURCE.
 *
 * Miguel, PR #33 review, R4. FF4's attention cue is four magic strings spread
 * across four files with no guard anywhere:
 *
 *   'attention-cue'   the IPC channel    app/main.js  <->  app/preload.js
 *   onAttentionCue    the bridge method  app/preload.js <-> app/renderer.js
 *   'attention-cue'   the CSS class      app/renderer.js <-> app/renderer.html
 *
 * and the renderer's call site is a TRUTHINESS GUARD:
 *
 *   if (window.harness && window.harness.onAttentionCue) { ... }
 *
 * so renaming the bridge method, or misspelling the channel in either file,
 * makes the feature do nothing forever -- with a green suite and no console
 * error. Silence is the whole failure mode.
 *
 * THIS REPO HAS SHIPPED SILENTLY-DEAD RENDERER CODE THREE TIMES:
 * `careerDisplay`, `quotaDisplay`, and `isPanelToggle` (Ctrl+B). The header of
 * test/renderer-scope.test.js is a monument to it -- but that file works on the
 * shared GLOBAL scope, and `window.harness.*` is a contextBridge object, not a
 * global. Its allow-list, its reachability list and its bare-global mirror test
 * are all structurally blind to this. FF4 reintroduced the old shape through a
 * door the existing guards do not watch.
 *
 * Check (2) below is the general one: it would have caught `isPanelToggle`
 * too, which is the argument for writing it once properly rather than once per
 * feature.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

// Comments are stripped before matching: a channel named only in prose is not
// a wiring, and the documentation of a bug must not satisfy the detector for
// it -- that exact trap was hit on this project's store.js header guard.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('every IPC channel main sends on is listened for in a preload', () => {
  const main = strip(read('main.js'));
  // The tab views use preload.js; the strip page (the window's own page) has its own.
  const preload = strip(read('preload.js')) + strip(read('preload-strip.js'));

  const sent = [...main.matchAll(/webContents\.send\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(sent.length > 0, 'the scan must find something for this check to mean anything');

  const missing = sent.filter(ch => !preload.includes(`'${ch}'`) && !preload.includes(`"${ch}"`));
  assert.deepStrictEqual(missing, [],
    `main sends on these channels and the preload listens for none of them: ${missing.join(', ')}`);
});

test('every window.harness member the renderer reaches for is exposed by the preload', () => {
  // THE GENERAL CHECK. `isPanelToggle` died exactly this way once already --
  // reachable through the bridge in one file, absent in the other, silent.
  const renderer = strip(read('renderer.js'));
  const preload = strip(read('preload.js'));

  // THE WHOLE PATH, not the first segment. Miguel, PR #42, A1.
  //
  // This used to capture `([A-Za-z_$][\w$]*)` -- one segment. On
  // `window.harness.secrets.melt()` it captured `secrets` and stopped, so every
  // NESTED member was unwatched: `lockState`, `setKey`, `unlock`, `lock`,
  // `removeKey` and `melt` all landed in the blind spot. Rename `melt` in the
  // preload and the renderer calls `undefined(...)` -- a TypeError on click,
  // with the suite green.
  //
  // Which is exactly the defect this file was written to catch, and its own
  // comment claimed to cover: "a member is either a key in it or nested one
  // level". The comment described the intent and the regex did not implement it.
  const used = new Set(
    [...renderer.matchAll(/window\.harness((?:\.[A-Za-z_$][\w$]*)+)/g)].map(m => m[1].slice(1)));
  assert.ok(used.size > 0, 'the scan must find something for this check to mean anything');
  assert.ok([...used].some(p => p.includes('.')),
    'the scan must reach NESTED members, or it is the old blind regex again');

  const bridge = preload.slice(preload.indexOf('exposeInMainWorld'));
  const missing = [...used].filter(p => !exposedBy(bridge, p));
  assert.deepStrictEqual(missing, [],
    `renderer.js calls window.harness.X for these, and the preload exposes none of them: ${missing.join(', ')}`);
});

// Is `a.b.c` exposed by this bridge literal? Each segment must appear as a key,
// and a nested one must appear INSIDE its parent's object literal -- otherwise
// `secrets.melt` would be satisfied by a stray `melt:` anywhere in the file.
function exposedBy(bridge, dotted) {
  let scope = bridge;
  for (const seg of dotted.split('.')) {
    const at = scope.search(new RegExp(`\\b${seg}\\s*:`));
    if (at === -1) return false;
    scope = scope.slice(at);
  }
  return true;
}

test('the bridge guard detects a member that is called but not exposed', () => {
  // A scan that matches nothing passes, so the guard above needs its own
  // negative case. Without this, the A1 fix could itself be wrong in the same
  // silent direction the fix was for.
  const bridge = `exposeInMainWorld('harness', { secrets: { list: x, melt: y }, onCue: z })`;
  assert.strictEqual(exposedBy(bridge, 'secrets.melt'), true);
  assert.strictEqual(exposedBy(bridge, 'secrets.list'), true);
  assert.strictEqual(exposedBy(bridge, 'onCue'), true);

  assert.strictEqual(exposedBy(bridge, 'secrets.unlock'), false,
    'a nested member that is absent must be caught');
  assert.strictEqual(exposedBy(bridge, 'missing'), false);

  // And the ordering rule: `melt` exists, but not inside `nope`.
  assert.strictEqual(exposedBy(`exposeInMainWorld('h', { melt: y, nope: {} })`, 'nope.melt'), false,
    'a key found OUTSIDE its parent must not count as nested inside it');
});

test('every class the renderer toggles has a rule in renderer.html', () => {
  // A cue whose class has no styling is a cue that raises nothing. The third
  // string in FF4's chain, and the one with no runtime error of any kind.
  const renderer = strip(read('renderer.js'));
  const html = read('renderer.html');

  const toggled = new Set(
    [...renderer.matchAll(/classList\.(?:toggle|add)\(\s*['"]([A-Za-z][\w-]*)['"]/g)].map(m => m[1]));
  assert.ok(toggled.size > 0, 'the scan must find something for this check to mean anything');

  const unstyled = [...toggled].filter(c => !html.includes(`.${c}`));
  assert.deepStrictEqual(unstyled, [],
    `renderer.js toggles these classes and renderer.html styles none of them: ${unstyled.join(', ')}`);
});

test('the attention cue is wired end to end, by name', () => {
  // The specific instance, stated plainly, so a failure above says WHICH
  // feature broke rather than only which rule did.
  const main = strip(read('main.js'));
  const preload = strip(read('preload.js'));
  const renderer = strip(read('renderer.js'));
  const html = read('renderer.html');

  assert.match(main, /webContents\.send\(\s*['"]attention-cue['"]/, 'main must send the cue');
  assert.match(preload, /ipcRenderer\.on\(\s*['"]attention-cue['"]/, 'the preload must listen for it');
  assert.match(preload, /onAttentionCue\s*:/, 'the preload must expose it');
  assert.match(renderer, /window\.harness\.onAttentionCue/, 'the renderer must subscribe');
  assert.match(renderer, /classList\.toggle\(\s*['"]attention-cue['"]/, 'the renderer must apply the class');
  assert.ok(html.includes('.attention-cue'), 'renderer.html must style it');
});

test('main.js gives the secret service a project, or the whole scope reverts', () => {
  // Miguel, PR #40, B1, second half. `createSecretService({ project: PROJECT_CWD })`
  // in app/main.js is ONE LINE with no test anywhere. Delete it and the
  // constructor's guard is the only thing standing between the user and a
  // vault where every secret is shared again -- and before that guard existed,
  // deleting it reverted the entire feature silently.
  //
  // Asserted against source because main.js is not loadable in a test: it
  // requires electron. Same instrument as the channel and bridge checks above.
  const fs = require('fs');
  const path = require('path');
  const main = strip(fs.readFileSync(path.join(APP, 'main.js'), 'utf8'));

  const call = main.slice(main.indexOf('createSecretService('));
  assert.ok(call.length > 0, 'main.js must construct the secret service');
  const head = call.slice(0, call.indexOf('});') + 3);
  assert.match(head, /project:/,
    'createSecretService must be given a project -- without it every secret is shared');
  // PR 2: NEW entries go under the project's state root, and entries saved
  // under the project root (before the layout move) stay visible via `scopes`.
  assert.match(head, /project: STATE_ROOT/,
    "and it must be the window's own project's state root, not a literal or a default");
  assert.match(head, /scopes: \[PROJECT_ROOT, LAUNCH_CWD\]/,
    'older entries stay visible: scoped to the project root or the launch folder');
});

test('every class the vault list renders is actually reachable by a rule', () => {
  // A1 generalised. The "shared" marker was styled by `.vault-row .scope` --
  // and `.vault-row` is a class NOTHING renders, so the rule matched nothing
  // and the marker drew unstyled. The scope invisible again, one layer out.
  //
  // MY FIRST VERSION OF THIS GUARD DID NOT CATCH IT: `html.includes('.scope')`
  // is true even when the only rule is `.vault-row .scope`, because the broken
  // selector CONTAINS the string. That is precisely the substring trap
  // Mortimer documented on PR #33 -- a detector matching a superstring and
  // reporting health -- rebuilt here by me one file later.
  //
  // So a class counts as styled only when some rule mentioning it has EVERY
  // other class in that selector also rendered. A selector naming a class
  // nobody emits matches nothing, whatever it contains.
  const fs = require('fs');
  const path = require('path');
  const renderer = strip(fs.readFileSync(path.join(APP, 'renderer.js'), 'utf8'));
  const html = fs.readFileSync(path.join(APP, 'renderer.html'), 'utf8');

  const body = renderer.slice(renderer.indexOf('#vault-list'), renderer.indexOf('#vault-list') + 2000);
  const rendered = new Set([...body.matchAll(/class="([a-z][\w-]*)"/g)].map(m => m[1]));
  assert.ok(rendered.size > 0, 'the scan must find something');

  const NL = String.fromCharCode(10);
  const selRe = new RegExp('^\\s*([^{}' + NL + ']+)\\{', 'gm');
  const selectors = [...html.matchAll(selRe)].map(m => m[1].trim());
  const reachable = (cls) => selectors.some((sel) => {
    if (!new RegExp('\\.' + cls + '(?![\\w-])').test(sel)) return false;
    const needed = [...sel.matchAll(/\.([a-z][\w-]*)/g)].map(m => m[1]);
    return needed.every(c => c === cls || rendered.has(c));
  });

  const unstyled = [...rendered].filter(c => !reachable(c));
  assert.deepStrictEqual(unstyled, [],
    `the vault list renders these classes and no rule can ever match them: ${unstyled.join(', ')}`);
});

test('every class renderer.js EMITS as markup has a rule that can match it', () => {
  // Miguel, PR #42, A8. The guard above scans `classList.toggle|add`, and this
  // panel emits all six of its classes through `innerHTML` instead -- so
  // `lock-note`, `lock-row`, `melt`, `melt-warn`, `keyless` and `sr-only` went
  // past the detector entirely.
  //
  // He checked by hand that all six have rules, so there was no live bug. The
  // reason it still matters: PR #40's A1 -- `.vault-row .scope` against rows that
  // are actually `.sec` -- came in through exactly this door, and the guard
  // written afterwards still did not cover it. Two instances, one uncovered path.
  //
  // REACHABILITY, not substring presence. A rule counts only if every OTHER
  // class in its selector is also emitted somewhere: `.vault-row .scope` names
  // `.scope`, but nothing emits `.vault-row`, so that selector matches nothing
  // and `html.includes('.scope')` reports health. That is the exact trap that
  // made my first version of the #40 guard useless.
  const renderer = strip(read('renderer.js'));
  const html = read('renderer.html');

  // LITERAL class names only. A `class="${cond ? 'a' : 'b'}"` is computed at
  // render time and out of reach of a static check -- and my first version of
  // this scan swallowed one whole, producing the "class name" `seated[m.id]` and
  // crashing on its own generated regex. A guard that cannot survive the code it
  // reads is not a guard.
  const emitted = new Set(
    [...renderer.matchAll(/class="([^"]*)"/g)]
      .flatMap(m => m[1].split(/\s+/))
      .filter(c => /^[a-z][\w-]*$/.test(c)));
  assert.ok(emitted.size > 5, `the scan must find markup classes (${emitted.size})`);

  const NL = String.fromCharCode(10);
  const selectors = [...html.matchAll(new RegExp('^\\s*([^{}' + NL + ']+)\\{', 'gm'))]
    .map(m => m[1].trim());

  // A CLASS CAN COME FROM EITHER SOURCE. `.fog-sum .fog-warn` is a real,
  // working rule: `fog-warn` is emitted by renderer.js and `fog-sum` sits in
  // renderer.html's static markup. My first version built the set from
  // renderer.js alone and called nine healthy rules dead -- the mirror of the
  // substring trap, failing loud instead of silent and just as wrong. What makes
  // a selector matchable is that every class in it exists somewhere in the DOM,
  // wherever it happens to be written.
  // THREE sources, because there are three ways a class reaches the DOM: a
  // literal attribute in either file, and `classList`/`className` from script.
  // `model` and `proc` arrive the third way, so a scan that knew only the first
  // two called `.model .m-id` dead when it works perfectly.
  const fromScript = [
    ...[...renderer.matchAll(/classList[.](?:add|toggle|remove)[(]([^)]*)[)]/g)],
    ...[...renderer.matchAll(/className\s*=\s*([^;]*)/g)],
  ].flatMap(m => [...m[1].matchAll(/['"]([^'"]*)['"]/g)])
   .flatMap(m => m[1].split(/\s+/))
   .filter(c => /^[a-z][\w-]*$/.test(c));

  // STRICT about what demands a rule, GENEROUS about what counts as present.
  // That asymmetry is deliberate and it is what makes this guard safe to have:
  // a false alarm costs someone an afternoon and a missed rule costs nothing
  // visible, so the set below takes any identifier-shaped run out of a class
  // attribute -- including ones built by concatenation, like
  // `class="model' + (seated ? ' seated' : '') + '"`, where the raw token is
  // `model'` and a strict filter loses it.
  const loose = (src) => [...src.matchAll(/class="([^"]*)"/g)]
    .flatMap(m => [...m[1].matchAll(/[a-z][\w-]*/g)].map(x => x[0]));

  const inMarkup = new Set([
    ...emitted,
    ...fromScript,
    ...loose(renderer),
    ...loose(html),
    ...[...html.matchAll(/class="([^"]*)"/g)]
      .flatMap(m => m[1].split(/\s+/))
      .filter(c => /^[a-z][\w-]*$/.test(c)),
  ]);

  const reachable = (cls) => selectors.some((sel) => {
    if (!new RegExp('\\.' + cls + '(?![\\w-])').test(sel)) return false;
    return [...sel.matchAll(/\.([a-z][\w-]*)/g)]
      .map(m => m[1])
      .every(c => c === cls || inMarkup.has(c));
  });

  // TWO DIFFERENT THINGS, and only one of them is always a bug.
  //
  //   no rule at all      -- often deliberate. `career-tok`, `career-min`,
  //                          `note` and `lit` are emitted with no styling; a
  //                          class can exist purely as a hook, and demanding a
  //                          rule for every one would be a guard nobody keeps.
  //
  //   a rule that CANNOT MATCH -- always a bug, and the one this exists for.
  //                          `.vault-row .scope` names `.scope`, but nothing
  //                          anywhere emits `.vault-row`, so the rule is dead
  //                          and the marker drew unstyled. PR #40's A1.
  //
  // Asserting on the second alone is what makes this checkable. Asserting on
  // both would fail today on four pre-existing classes that are fine, and a
  // guard that is red on arrival gets deleted.
  const mentioned = (cls) =>
    selectors.some(sel => new RegExp('\\.' + cls + '(?![\\w-])').test(sel));

  const dead = [...emitted].filter(c => mentioned(c) && !reachable(c));
  assert.deepStrictEqual(dead, [],
    `renderer.js emits these classes and every rule naming them is unmatchable: ${dead.join(', ')}`);
});

test('the emitted-class guard catches a rule that can never match', () => {
  // The negative case, because a scan that finds nothing passes -- and this
  // guard went through four wrong versions before this one, each of which
  // reported something confidently untrue. Two failed loud (nine healthy rules
  // called dead) and the danger is the version that fails quiet.
  //
  // Reproduces PR #40's A1 exactly: a rule whose OTHER class nobody emits.
  const selectorsOf = (css) => {
    const NL = String.fromCharCode(10);
    return [...css.matchAll(new RegExp('^\\s*([^{}' + NL + ']+)\\{', 'gm'))]
      .map(m => m[1].trim());
  };
  const check = (css, present) => {
    const sels = selectorsOf(css);
    const has = new Set(present);
    return sels.some((sel) => {
      if (!/\.scope(?![\w-])/.test(sel)) return false;
      return [...sel.matchAll(/\.([a-z][\w-]*)/g)].map(m => m[1])
        .every(c => c === 'scope' || has.has(c));
    });
  };

  assert.strictEqual(check('.vault-row .scope { color: red; }', ['sec', 'scope']), false,
    'a rule naming a class nobody emits must be reported as unmatchable');
  assert.strictEqual(check('.sec .scope { color: red; }', ['sec', 'scope']), true,
    'and the corrected rule must be accepted');
});

test('a failed delete is surfaced, not swallowed by a re-render', () => {
  // Dexter, PR #40, F6, asserted against source because renderer.js needs a real
  // DOM -- the same instrument as the channel and bridge checks above.
  //
  // The call used to be `await remove(id); renderVault();` with the result
  // dropped, so a `commit` throw (the Windows EPERM/EBUSY rename path measured
  // on 2026-09-18) silently redrew the panel with the entry still present. The x
  // appears to do nothing, so the user clicks again.
  //
  // Miguel raised it: scoping gave `{ok:false}` a SECOND meaning. It used to
  // mean only "already gone" -- benign, and defensible to discard. It now also
  // means "not yours", and both answered by redrawing a row that is still there.
  const renderer = strip(read('renderer.js'));

  const at = renderer.indexOf("secrets.remove(id)");
  assert.ok(at > 0, 'the vault list must still delete by id');
  // Backwards too: the assignment sits BEFORE the call, and slicing only forward
  // reported the captured result as discarded. My own guard, wrong in the
  // alarming direction rather than the silent one, which is the better half of
  // the two but still wrong.
  const after = renderer.slice(Math.max(0, at - 120), at + 600);

  assert.match(after, /const\s+res\s*=|res\s*=\s*await/,
    'the result of remove must be captured, not discarded');
  assert.match(after, /res\.ok\s*!==\s*true|!res\.ok|res\.ok\s*===\s*false/,
    'and it must be checked');
  assert.match(after, /aria-live|role="alert"/,
    'a delete that did not happen must be announced, not only drawn');
});

test('the melt confirmation puts Cancel before the destructive button', () => {
  // Miguel, PR #42, A7. Tab order used to be input -> Open -> "Melt it, I lost
  // the key" -> Cancel, so the irreversible action sat two tabs and a space from
  // the password field, ahead of the safe one.
  //
  // Source-asserted because the order is a property of the emitted markup.
  const renderer = strip(read('renderer.js'));
  const cancel = renderer.indexOf('data-lock="melt-cancel"');
  const confirm = renderer.indexOf('data-lock="melt-confirm"');
  assert.ok(cancel > 0 && confirm > 0, 'both melt buttons must exist');
  assert.ok(cancel < confirm,
    'Cancel must come FIRST in the markup, so tab order reaches it before melt');

  assert.match(renderer, /data-autofocus/,
    'and something must take focus after the redraw -- innerHTML destroys it');
  assert.match(renderer, /aria-describedby="melt-warning"/,
    'the destructive button must point at the warning that states the cost');
});

test('every password field in the lock panel has a real label', () => {
  // Miguel A7: all three had a placeholder only, which is a WCAG 3.3.2 failure
  // on the field holding a vault key. Placeholders are not labels -- they vanish
  // on input and are not reliably announced.
  const renderer = strip(read('renderer.js'));
  const html = read('renderer.html');

  const passwordInputs = [...renderer.matchAll(/<input[^>]*type="password"[^>]*>/g)];
  assert.ok(passwordInputs.length > 0, 'the scan must find the key field');

  // Built through one helper, so the label travels with every use. Asserting the
  // helper exists AND that no password input is emitted outside it.
  assert.match(renderer, /class="sr-only" for="vault-key"/,
    'the key field must carry a label element');
  assert.ok(html.includes('.sr-only'),
    'and renderer.html must style it as visually hidden rather than dropping it');
});

// --- host control frames added by worktree tabs ------------------------------
// A control type missing from CONTROL_TYPES is typed into the pty as literal
// JSON (happened twice). Each of these must be a known type AND have a
// dispatch branch in host.js, or the frame is dropped after being classified.
const { parseControlFrame } = require('../host/control');
const HOST_SRC = fs.readFileSync(path.join(__dirname, '..', 'host', 'host.js'), 'utf8');

for (const type of ['stop', 'raise']) {
  test(`the ${type} frame is a known control type, never pty input`, () => {
    assert.deepStrictEqual(parseControlFrame(JSON.stringify({ type })), { type });
  });

  test(`host.js dispatches ${type}`, () => {
    assert.ok(HOST_SRC.includes(`msg.type === '${type}'`), `dispatchControl must handle ${type}`);
  });
}

test('hello tells every client which control types this host accepts', () => {
  // host/host-client.js sends stop/raise only to a host that lists them: an
  // older host types an unknown frame into the session instead.
  const at = HOST_SRC.indexOf("type: 'hello'");
  assert.ok(at !== -1);
  const hello = HOST_SRC.slice(at, HOST_SRC.indexOf('});', at));
  assert.match(hello, /controls:\s*\[\.\.\.CONTROL_TYPES\]/);
  assert.match(HOST_SRC, /\bCONTROL_TYPES\b[^;]*\}\s*=\s*require\('\.\/control'\)/);
});

test('raise answers the sender with raised + a window count, and tells every window', () => {
  const at = HOST_SRC.indexOf("msg.type === 'raise'");
  const branch = HOST_SRC.slice(at, HOST_SRC.indexOf('if (msg.type ===', at + 10));
  // The sender is a one-shot client, not a window: `windows` counts the OTHERS,
  // and only they are told to come forward.
  assert.match(branch, /const targets = raiseTargets\(clients, ws\)/);
  assert.match(branch, /for \(const w of targets\) sendControl\(w, \{ type: 'raise' \}\)/);
  assert.match(branch, /sendControl\(ws, \{ type: 'raised', windows: targets\.length \}\)/);
  assert.doesNotMatch(branch, /clients\.size/);
});

test('stop runs shutdown() and then exits', () => {
  const at = HOST_SRC.indexOf("msg.type === 'stop'");
  const branch = HOST_SRC.slice(at, HOST_SRC.indexOf('if (msg.type ===', at + 10));
  assert.ok(branch.indexOf('shutdown()') !== -1 && branch.indexOf('process.exit(0)') > branch.indexOf('shutdown()'));
});
