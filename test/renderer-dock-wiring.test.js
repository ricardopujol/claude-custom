'use strict';
/**
 * renderer.js's dock-zone wiring (layout pass L1, PR #82 review). The rules
 * live in pure, tested modules (app/dock-layout.js, app/dock-zones-display.js);
 * this pins that the page actually USES them where the reviewers found the
 * page going wrong. Source assertions, because renderer.js needs a real DOM;
 * verify/probe-dock-tree.js drives the same paths in a real window (check 6: a
 * real pointer drop; L1's probe-dock-zones.js, which also drove a redraw with a
 * secret half-typed, was deleted with the page it measured).
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const JS = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8'));

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `renderer.js must define ${name}`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

test('Dexter F2 / Miguel B1: a redraw moves focus only as renderEffects says -- never unconditionally', () => {
  // renderLayout called term.focus() on every redraw with the vault showing: a
  // resize mid-secret typed the rest of the secret into the session.
  const body = fnBody('renderLayout');
  assert.match(body, /const fx = window\.dockZones\.renderEffects\(shownModules, now, \{ userAction \}\);/);
  const focusCalls = [...body.matchAll(/term\.focus\(\)/g)];
  assert.strictEqual(focusCalls.length, 1, 'exactly one, and it is gated');
  assert.match(body, /if \(fx\.focus === 'term'\) term\.focus\(\);/);
  // Passive redraws pass no userAction: the resize listener and a pushed layout.
  assert.doesNotMatch(fnBody('applyLayoutOverride'), /userAction/);
});

test('Dexter F1 / Miguel I2: a drop ends the drag BEFORE the move redraws away its source', () => {
  const at = JS.search(/window\.addEventListener\('pointerup', \(\) => \{\r?\n\s+if \(!press\) return;/);
  assert.ok(at !== -1, 'the tab drag\'s pointerup handler must be findable');
  const handler = JS.slice(at, JS.indexOf('  });', at));
  const end = handler.indexOf('end();');
  const move = handler.indexOf('commitPlacement(');
  assert.ok(end !== -1 && move !== -1 && end < move, 'end() must run before commitPlacement()');
  assert.match(JS, /window\.addEventListener\('pointercancel', \(\) => \{ cancelTabDrag\(\); \}\);/);
  const close = JS.indexOf('ws.onclose = () => {');
  assert.ok(close !== -1 && /cancelTabDrag\(\);/.test(JS.slice(close, close + 400)), 'the socket closing drops a drag in flight');
});

test('Dexter F3 / Miguel I1: only a MISSING tree migrates and saves at load; unreadable keeps the default', () => {
  const body = fnBody('loadLayout');
  assert.match(body, /const what = window\.dockTreeView\.afterTreeGet\(answer, v1Answer, \{ v1Bridge: !!window\.harness\.layout \}\);/);   // no L1 bridge is "nothing to migrate", not a failed read (PR #100 S5)
  // Every save at load sits in one of the two migrate branches, and nothing else saves.
  const sets = [...body.matchAll(/saveGlobalLayout\(/g)];       // the helper is the one save path (PR #100 S3)
  assert.strictEqual(sets.length, 2, 'the two migrations, no other save at load');
  for (const s of sets) {
    const before = body.slice(0, s.index);
    assert.match(before.slice(before.lastIndexOf('else if (what ===')), /^else if \(what === 'migrate-(v1|legacy)'\)/, 'a save outside a migrate branch');
  }
  // The L1 key is only ever read: nothing in the renderer writes it any more.
  assert.doesNotMatch(JS, /harness\.layout\.set\(/);
});

test('Dexter F4: the window seeds its own selection ONCE at load, and draws through it', () => {
  assert.match(fnBody('loadLayout'), /const seeded = localStorage\.getItem\('dockSelection2'\) !== null;/);
  assert.match(fnBody('loadLayout'), /if \(!seeded\) saveSelection\(\);/);
  assert.match(fnBody('renderLayout'), /treePlan\(placementLayout\(\), selection, TABS, dockViewport\(\)/);
});

test('Dexter F8: a tab\'s own layout goes through sendOverride, and the host\'s word through overrideOnHello', () => {
  assert.match(fnBody('applyLayoutOverride'), /window\.dockZones\.overrideOnHello\(pendingOverride, incoming\)/);
  assert.match(fnBody('sendOverride'), /pendingOverride = \{ layout \};/);
  const direct = [...JS.matchAll(/type: 'layout-override'/g)].length;
  assert.strictEqual(direct, 2, 'sent from sendOverride and the resend in applyLayoutOverride only');
});

test('Dexter F6: opening the diagnostics pane re-fits the zones', () => {
  const at = JS.indexOf("document.getElementById('diag').classList.toggle('show');");
  assert.ok(at !== -1);
  assert.match(JS.slice(at, at + 400), /renderLayout\(\);/);
});

test('D1: #dock changing size without a window resize (the header wrapping) re-fits the boxes', () => {
  // The boxes are absolute, so no flex layout absorbs a header that grows a line: the probe found the
  // bottom group 5 px past the area at launch. The observer feeds the same coalesced resize path.
  assert.match(JS, /new ResizeObserver\(\(\) => window\.dispatchEvent\(new Event\('resize'\)\)\)\.observe\(document\.getElementById\('dock'\)\);/);
});

test('entering focus mode gives the terminal the keyboard, never an invisible panel field', () => {
  // Found by verify/probe-dock-zones.js: focus left in #vault-secret stayed in a
  // hidden input -- typing went into it and Ctrl+B never reached the terminal.
  assert.match(fnBody('applyFocusMode'), /if \(on\) term\.focus\(\);/);
});

test('#36: the socket opening focuses the terminal only as focusOnOpen says -- never unconditionally', () => {
  // ws.onopen runs on every reattach: an unconditional term.focus() there sent
  // the rest of a half-typed vault secret into the session.
  const at = JS.indexOf('ws.onopen = () => {');
  assert.ok(at !== -1, 'ws.onopen must be findable');
  const handler = JS.slice(at, JS.indexOf('\n  };', at));
  const focusCalls = [...handler.matchAll(/term\.focus\(\)/g)];
  assert.match(handler, /sendResize\(\);/, 'the slice reaches past the focus line');
  assert.match(handler, /const first = !socketOpened;\s+socketOpened = true;/, '"first" is a flag, not read from focus');
  assert.strictEqual(focusCalls.length, 1, 'exactly one, and it is gated');
  assert.match(handler, /if \(window\.dockZones\.focusOnOpen\(first, window\.dockZones\.describeFocus\(document\.activeElement, term\.element\)\)\) term\.focus\(\);/);
});

test('PR #100 Dexter F6 / F3: a divider release is applied to the placement as it is NOW, and a drag that asks for nothing stores nothing', () => {
  const start = JS.search(/window\.addEventListener\('pointerup', \(\) => \{\r?\n\s+if \(!dividerDrag\) return;/);
  assert.ok(start !== -1, 'the divider\'s pointerup handler must be findable');
  const handler = JS.slice(start, JS.indexOf('\n  });', start));
  assert.match(handler, /rebaseDrag\(committedLayout\(\)/, 'rebased onto what is saved now');
  assert.match(handler, /setSplitSizes\(committedLayout\(\)/, 'and applied to it, not to the pointerdown snapshot');
  assert.doesNotMatch(handler, /commitPlacement\(l\)|d\.base/, 'the stale snapshot is never what is committed');
  assert.match(JS, /function committedLayout\(\) \{ return ownLayout \|\| globalLayout; \}/, 'what is saved, without the drawn-only drag layout');
});

test('PR #100 Miguel I2: both drags take pointer capture, and end themselves on a move with no button, a lost capture and a blur', () => {
  assert.strictEqual([...JS.matchAll(/\.setPointerCapture\(e\.pointerId\)/g)].length, 3, 'the tab drag, the divider drag and the float drag (D2)');
  assert.strictEqual([...JS.matchAll(/if \(e\.buttons === 0\) \{ (end|cancelDividerDrag|cancelFloatDrag)\((e)?\); return; \}/g)].length, 3);
  assert.match(JS, /window\.addEventListener\('lostpointercapture', cancelFloatDrag\);/);
  assert.match(JS, /window\.addEventListener\('blur', cancelFloatDrag\);/);
  assert.match(JS, /window\.addEventListener\('pointercancel', cancelFloatDrag\);/);
  assert.match(JS, /window\.addEventListener\('lostpointercapture', \(\) => \{ cancelTabDrag\(\); \}\);/);
  assert.match(JS, /window\.addEventListener\('blur', \(\) => \{ cancelTabDrag\(\); \}\);/);
  assert.match(JS, /window\.addEventListener\('lostpointercapture', cancelDividerDrag\);/);
  assert.match(JS, /window\.addEventListener\('blur', cancelDividerDrag\);/);
  // A cancelled divider drag clears the drawn layout and redraws.
  const at = JS.indexOf('function cancelDividerDrag()');
  assert.ok(at !== -1);
  const body = JS.slice(at, JS.indexOf('\n  }', at));
  assert.match(body, /dragLayout = null;/);
  assert.match(body, /renderLayout\(\);/);
});

test('PR #100 Miguel S2: the page carries no [data-collapsed] CSS: folds are rails now, and nothing sets the attribute on a group', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  assert.doesNotMatch(html, /\[data-collapsed\]/);
});

test('PR #100 Miguel I4: tab and rail buttons have a focus ring that sits inside them, so the clipped boxes cannot cut it off', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const rule = /\.zone-tabs button:focus-visible, \.drail button:focus-visible \{([^}]*)\}/.exec(html);
  assert.ok(rule, 'one rule for both');
  assert.match(rule[1], /outline: 2px solid var\(--accent\)/);
  assert.match(rule[1], /outline-offset: -2px/);
  assert.match(html, /\.dgroup \{[^}]*overflow: hidden/, 'the reason: the group clips');
  assert.match(html, /\.drail \{[^}]*overflow: hidden/, 'and so does the rail');
});

test('PR #100 Miguel S1: a tab drag reads the dock\'s rectangle once at its start and rebuilds the overlay only when the zones change', () => {
  assert.doesNotMatch(JS, /pointInDock/, 'no per-move getBoundingClientRect');
  assert.match(JS, /rect: dock\.getBoundingClientRect\(\), viewport: dockViewport\(\)/);
  assert.match(JS, /drag\.at = \{ x: e\.clientX - drag\.rect\.left, y: e\.clientY - drag\.rect\.top \};/);
  assert.match(JS, /zonesAt\(lastPlan \? lastPlan\.boxes : \[\], drag\.viewport, drag\.at, \{ exclude: drag\.exclude \}\)/);
  assert.match(JS, /if \(sig !== drag\.sig\) \{ drag\.sig = sig; drawZones\(hit\.zones\); \}/);
});

test('D2: a float move or resize is drawn while it goes and saved once on release, on the placement as it is NOW; a press only raises, in the selection', () => {
  const up = JS.search(/window\.addEventListener\('pointerup', \(e\) => \{\r?\n\s+const d = floatDrag;/);
  assert.ok(up !== -1, 'the float drag\'s pointerup handler must be findable');
  const release = JS.slice(up, JS.indexOf('\n  });', up));
  assert.match(release, /floatDragResult\(committed, d\)/, 'applied to what is saved now, never the pointerdown snapshot');
  assert.match(release, /commitPlacement\(result, \{ userAction: false, refit: false \}\)/, 'saved once, and keyboard focus is not moved (PR #102 Miguel S3)');
  assert.doesNotMatch(release, /d\.base/);
  const down = JS.search(/dock\.addEventListener\('pointerdown', \(e\) => \{\r?\n\s+if \(e\.button !== 0\) return;\r?\n\s+const el = e\.target\.closest && e\.target\.closest\('\.dfloat'\)/);
  assert.ok(down !== -1, 'the float press handler must be findable');
  const press = JS.slice(down, JS.indexOf('\n  });', down));
  assert.match(press, /DTm\.raiseFloat\(selection, id\)/);
  assert.match(press, /saveSelection\(\)/, 'raising is this window\'s selection');
  assert.doesNotMatch(press, /commitPlacement|saveGlobalLayout|sendOverride/, 'a press never writes the shared layout');
  assert.match(JS, /if \(e\.buttons === 0\) \{ cancelFloatDrag\(e\); return; \}/, 'the move handler ends a drag whose release never came');
  // The tab drag excludes the float its panel is dragged out of, and a drop on the terminal's middle asks the model where.
  assert.match(JS, /DTm\.floatOf\(placementLayout\(\), press\.id\)/);
  assert.match(JS, /d\.target\.float === true \? \{ float: DTm\.floatSpotAt\(d\.at, d\.viewport\) \} : d\.target/);
});

test('PR #102 Dexter 2/6, Miguel Y2/S4: a float drag starts after 3 px, follows its own pointer, remembers the tabs it grabbed, and draws once per frame without a terminal refit', () => {
  assert.match(JS, /Math\.hypot\(dx, dy\) < FLOAT_SLOP\) return;/, 'a click on the bar raises and nothing else');
  assert.match(JS, /tabs: \[\.\.\.fl\.tabs\]/, 'what the float held at the press (a recycled id is not the same float)');
  assert.match(JS, /e\.pointerId !== d\.pointerId\) return;/, 'another pointer neither steers nor ends the drag');
  assert.match(JS, /function finish\(d\) \{[\s\S]{0,300}classList\.remove\('dock-dragging'\)/, 'no text selection while it goes, and it ends with the drag');
  assert.match(JS, /d\.started = true;\r?\n\s+document\.body\.classList\.add\('dock-dragging'\)/);
  assert.match(JS, /if \(!d\.frame\) d\.frame = requestAnimationFrame\(\(\) => drawDrag\(d\)\);/, 'one draw per animation frame');
  assert.match(JS, /renderLayout\(\{ refit: false \}\)/, 'a float move does not change the terminal\'s rectangle');
  assert.match(JS, /function renderLayout\(\{ userAction = false, refit = true \} = \{\}\)/);
  assert.match(JS, /if \(refit\) setTimeout\(\(\) => \{ try \{ fit\.fit\(\); sendResize\(\); \} catch \{\} \}, 0\);/);
});

test('PR #102 Miguel Y4: pressing a float\'s bar or grip does not take keyboard focus out of a field inside it (the press cancels the mousedown default)', () => {
  assert.match(JS, /dock\.addEventListener\('mousedown', \(e\) => \{\r?\n\s+if \(e\.button === 0 && floatHandleOf\(e\.target\)\) e\.preventDefault\(\);/);
  assert.match(JS, /const floatHandleOf = t => /);
});

test('PR #102 Miguel Y3: the floats\' layer sits between the terminal and the drag overlay, passes clicks through, and the terminal\'s own overlays are contained', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const at = s => html.indexOf(s);
  assert.ok(at('<div id="termwrap">') !== -1 && at('<div id="dock-floats"></div>') > at('<div id="termwrap">') && at('<div id="dock-overlay"></div>') > at('<div id="dock-floats"></div>'));
  const layer = /#dock-floats \{([^}]*)\}/.exec(html);
  assert.ok(layer, 'the layer has a rule');
  const z = /z-index: (\d+)/.exec(layer[1]);
  assert.ok(z && Number(z[1]) > 5 && Number(z[1]) < 40, 'above the gutters (5), below the overlay (40)');
  assert.match(layer[1], /pointer-events: none/, 'the empty layer must not block the groups under it');
  assert.match(/\.dfloat \{([^}]*)\}/.exec(html)[1], /pointer-events: auto/, 'a float itself takes the pointer');
  assert.match(/\n\s+#termwrap \{([^}]*)\}/.exec(html)[1], /isolation: isolate/, 'its lock overlay and banners can never interleave with a float');
});

test('PR #102 Miguel Y1: a float\'s bar reserves a fixed move handle at its left end that its tabs can never push out', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const handle = /\.dfloat \.zone-tabs::before \{([^}]*)\}/.exec(html);
  assert.ok(handle, 'a pseudo-element of the bar: the first flex item, before every tab');
  assert.match(handle[1], /content: ''/);
  assert.match(handle[1], /flex: 0 0 18px/, 'fixed width: tabs shrink (with an ellipsis) instead');
  assert.match(handle[1], /cursor: move/);
  assert.match(handle[1], /gradient/, 'a visible grip texture');
  assert.match(/\.dfloat \.zone-tabs button \{([^}]*)\}/.exec(html)[1], /flex: 0 1 auto/, 'tabs may shrink');
});

test('PR #102 Miguel S2: the grip lives in a frame along the float\'s bottom edge, so it never covers the end of the panel\'s scrollbar', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const frame = /\.dfloat \{([^}]*)\}/.exec(html)[1];
  const grip = /\.dfloat-grip \{([^}]*)\}/.exec(html)[1];
  const pad = Number((/padding-bottom: (\d+)px/.exec(frame) || [])[1]);
  const gripH = Number((/height: (\d+)px/.exec(grip) || [])[1]);
  assert.ok(pad >= 4 && pad <= 10, `a thin frame, ${pad} px`);
  assert.ok(gripH <= pad, `the grip (${gripH} px) fits inside the frame (${pad} px)`);
  assert.match(grip, /right: 0; bottom: 0/, 'in the frame\'s right corner');
  assert.match(frame, /background: var\(--chrome\)/, 'the bar\'s colour');
});

test('PR #100 Miguel S3: every save of the global layout goes through one helper that says so when the store refuses it', () => {
  // Only the helper talks to the store; the four places that save call it.
  assert.strictEqual([...JS.matchAll(/\bbridge\.set\(/g)].length, 1, 'only inside saveGlobalLayout');
  const at = JS.indexOf('function saveGlobalLayout(');
  assert.ok(at !== -1);
  const body = JS.slice(at, JS.indexOf('\n}', at));
  assert.match(body, /window\.dockTreeView\.layoutSaved\(answer\)/, 'a null answer is a failed save');
  assert.match(body, /Couldn\\'t save the layout/);
  assert.match(body, /, notSaved\);/, 'and so is a rejection');
  assert.strictEqual([...JS.matchAll(/saveGlobalLayout\(/g)].length, 5, 'definition + commitPlacement + dropOwnLayout + the two migrations');
});
