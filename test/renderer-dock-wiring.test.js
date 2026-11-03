'use strict';
/**
 * renderer.js's dock-zone wiring (layout pass L1, PR #82 review). The rules
 * live in pure, tested modules (app/dock-effects.js, app/dock-tree.js, app/dock-tree-display.js);
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
const JS = strip(fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n'));   // a CRLF checkout reads the same

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `renderer.js must define ${name}`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

test('Dexter F2 / Miguel B1: a redraw moves focus only as renderEffects says -- never unconditionally', () => {
  // renderLayout called term.focus() on every redraw with the vault showing: a
  // resize mid-secret typed the rest of the secret into the session.
  const body = fnBody('renderLayout');
  assert.match(body, /const fx = window\.dockEffects\.renderEffects\(shownModules, now, \{ userAction, quiet \}\);/);
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
  assert.match(fnBody('applyLayoutOverride'), /window\.dockEffects\.overrideOnHello\(pendingOverride, incoming\)/);
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
  // Found by L1's probe (verify/probe-dock-zones.js, since replaced by probe-dock-tree.js): focus left in #vault-secret stayed in a
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
  assert.match(handler, /if \(window\.dockEffects\.focusOnOpen\(first, window\.dockEffects\.describeFocus\(document\.activeElement, term\.element\)\)\) term\.focus\(\);/);
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
  assert.match(JS, /const landingFor = \(target, at, viewport\) => \(target\.float === true \? \{ float: DTm\.floatSpotAt\(at, viewport\) \} : target\);/);
  assert.match(JS, /const target = landingFor\(d\.target, d\.at, d\.viewport\);/, 'the tab drag and the keyboard move land a drop the same way');
});

test('PR #102 Dexter 2/6, Miguel Y2/S4: a float drag starts after 3 px, follows its own pointer, remembers the tabs it grabbed, and draws once per frame without a terminal refit', () => {
  assert.match(JS, /Math\.hypot\(dx, dy\) < FLOAT_SLOP\) return;/, 'a click on the bar raises and nothing else');
  assert.match(JS, /tabs: \[\.\.\.fl\.tabs\]/, 'what the float held at the press (a recycled id is not the same float)');
  assert.match(JS, /e\.pointerId !== d\.pointerId\) return;/, 'another pointer neither steers nor ends the drag');
  assert.match(JS, /function finish\(d\) \{[\s\S]{0,300}classList\.remove\('dock-dragging'\)/, 'no text selection while it goes, and it ends with the drag');
  assert.match(JS, /d\.started = true;\r?\n\s+document\.body\.classList\.add\('dock-dragging'\)/);
  assert.match(JS, /if \(!d\.frame\) d\.frame = requestAnimationFrame\(\(\) => drawDrag\(d\)\);/, 'one draw per animation frame');
  assert.match(JS, /renderLayout\(\{ refit: false \}\)/, 'a float move does not change the terminal\'s rectangle');
  assert.match(JS, /const same = placementOf\(incoming\) === placementOf\(globalLayout\);\r?\n\s+globalLayout = incoming;\r?\n\s+if \(!ownLayout && !same\) renderLayout\(\);/, 'the echo of this window\'s own save is not redrawn (it would refit the terminal)');
  assert.match(JS, /function renderLayout\(\{ userAction = false, refit = true, settle = false, quiet = false \} = \{\}\)/);
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

// --- dockable panels D4 -----------------------------------------------------------------------------

test('D4: a redraw forgets collapsed groups that are gone and hands the open popover to the plan', () => {
  const body = fnBody('renderLayout');
  assert.match(body, /if \(window\.dockEffects\.pruneReady\(layoutLoaded, helloSeen\)\) \{\s+const pruned = DTm\.pruneCollapsed\(selection, placementLayout\(\)\);/, 'and only once the stored layout is in: the launch placeholder has none of the groups a saved collapse names');
  const load = fnBody('loadLayout');
  assert.strictEqual([...load.matchAll(/layoutLoaded = true;/g)].length, 3, 'set in the three branches that draw a layout that was read, never when it was unreadable (nothing to prune against)');
  assert.match(body, /\{ faceSize: window\.faceSize, peek \}\)/);
  assert.match(body, /if \(peek && !plan\.peek\) railEvent\(\{ type: 'gone' \}\);/, 'a popover whose rail is gone closes itself');
});

test('D4: a rail\'s button opens its popover instead of selecting a tab nobody can see; a popover tab only switches it', () => {
  const at = JS.indexOf("document.addEventListener('click', (e) => {\n  const pinButton = e.target.closest('.dpin');");
  assert.ok(at !== -1, 'the tab and rail click handler must be findable');
  const handler = JS.slice(at, JS.indexOf('\n});', at));
  assert.match(handler, /if \(button\.parentNode\.classList\.contains\('drail'\)\) \{ openPeek\(id, e\.detail === 0\); return; \}/);
  assert.match(handler, /railEvent\(\{ type: 'tab', module: id \}\)/);
  assert.match(handler, /if \(pinButton\) \{ togglePin\(pinButton\.dataset\.pin\); return; \}/, 'the Pin button is no tab (#85)');
  assert.match(handler, /renderLayout\(\{ refit: false \}\)/, 'a popover never changes the terminal\'s rectangle');
  assert.ok(handler.indexOf('openPeek') < handler.indexOf('selectModule(id)'), 'the rail is decided before the plain tab');
  assert.match(fnBody('openPeek'), /renderLayout\(\{ refit: false \}\)/);
});

test('D4: any change of the placement closes the popover; a press outside it, and Esc, close it too', () => {
  assert.match(fnBody('commitPlacement'), /railEvent\(\{ type: 'gone' \}\);/);
  assert.match(JS, /railEvent\(\{ type: 'outside' \}\)/);
  assert.match(JS, /railEvent\(\{ type: 'escape' \}\)/);
  assert.match(JS, /if \(e\.key !== 'Escape' \|\| !peek \|\| kbMove\) return;/, 'a keyboard move owns Esc while it lasts');
});

test('D4: collapsing is the window\'s selection: it goes through commitSelection, never the shared layout', () => {
  const body = fnBody('toggleGroupCollapse');
  assert.match(body, /commitSelection\(DTm\.toggleCollapse\(selection, placementLayout\(\), groupId\)\);/);
  assert.doesNotMatch(body, /commitPlacement|saveGlobalLayout|sendOverride/);
});

test('D4: Reset layout and applying a preset open every group in this window first (group names are handed out again by the next layout)', () => {
  assert.match(JS, /on: \{ click: \(\) => \{ openEveryGroup\(\); commitPlacement\(DTm\.startLayout\(MODULE_IDS\), \{ justThisTab: check\.box\.checked \}\); closeLayoutMenu\(\); \} \},/);
  assert.match(fnBody('applyPreset'), /openEveryGroup\(\);\s+commitPlacement\(r\.layout, \{ justThisTab \}\);/);
  assert.match(fnBody('openEveryGroup'), /collapsed: \{\}/);
});

test('D4: a divider moves with the arrow keys by the drag\'s rules, and keeps the keyboard where it is', () => {
  const at = JS.indexOf("document.getElementById('dock').addEventListener('keydown', (e) => {\n    const g = e.target.closest && e.target.closest('.dgutter');");
  assert.ok(at !== -1, 'the divider key handler must be findable');
  const handler = JS.slice(at, JS.indexOf('\n  });', at));
  assert.match(handler, /dividerKeySizes\(placementLayout\(\), lastPlan\.splits, path, Number\(g\.dataset\.i\), e\.key\)/);
  assert.doesNotMatch(handler, /commitPlacement/, 'a key press is drawn, not saved: a held key would write ~30 times a second (PR #159 Miguel I4)');
  assert.match(handler, /dragLayout = DTm\.setSplitSizes\(placementLayout\(\), path, moved\.sizes\);\s+renderLayout\(\);/);
  assert.match(handler, /if \(dividerDrag \|\| floatDrag\) return;/, 'a float or divider drag owns dragLayout (PR #159 Dexter r2 N2)');
  assert.match(handler, /keyFlush = setTimeout\(flushKeys, 400\)/);
  const flush = JS.slice(JS.indexOf('const flushKeys = () => {'), JS.indexOf('};', JS.indexOf('const flushKeys = () => {')));
  assert.match(flush, /const rebased = window\.dockTreeView\.rebaseDrag\(committedLayout\(\), b\);\s+if \(rebased\) commitPlacement\(DTm\.setSplitSizes\(committedLayout\(\), b\.path, rebased\), \{ userAction: false \}\);/, 'one save when the burst ends, on the placement as it is NOW (PR #159 Dexter r2 N1); userAction false: focus stays on the divider');
  assert.doesNotMatch(flush, /commitPlacement\(l\b|const l = dragLayout/, 'never the stale whole layout');
  assert.match(flush, /if \(dividerDrag \|\| floatDrag\) return;/);
  assert.match(JS, /window\.addEventListener\('pagehide', flushKeys\);/, 'a closing window keeps the last presses (N3)');
  assert.match(JS, /flushKeys\(\);\s+\/\/ a key burst still waiting to be saved is saved first/, 'a pointer drag starts from what was pressed');
});

test('D4: the keyboard move takes every key while it lasts, drops through the tab drag\'s own landing and commit, and ends on Esc', () => {
  const at = JS.indexOf("window.addEventListener('keydown', (e) => {\n    if (!kbMove) return;");
  assert.ok(at !== -1, 'the keyboard move handler must be findable');
  const handler = JS.slice(at, JS.indexOf('\n  }, true);', at));
  assert.match(handler, /e\.preventDefault\(\); e\.stopPropagation\(\);/, 'no key reaches the terminal');
  assert.ok(handler.indexOf('e.stopPropagation()') < handler.indexOf("e.key === 'Escape'"), 'swallowed before any key is read');
  assert.match(handler, /DTm\.dock\(settledLayout\(\), id, landingFor\(target, at, vp\)\)/);
  assert.match(handler, /commitPlacement\(next, \{ select: id \}\)/);
  assert.match(handler, /nextZone\(boxes\(\), dockViewport\(\), kbMove\.target, e\.key === 'Tab' && e\.shiftKey \? 'ShiftTab' : e\.key/);
  const end = JS.indexOf('ws.onclose = () => {');
  assert.match(JS.slice(end, end + 600), /cancelKeyboardMove\(\);/, 'the socket closing drops a keyboard move in flight');
  assert.match(fnBody('renderLayout'), /kbRefresh\(\);/, 'a redraw under a move lights the zones of the dock as it is now');
});

test('D4: the settle motion is for what the person did, and reads the reduced-motion setting', () => {
  assert.match(fnBody('commitPlacement'), /renderLayout\(\{ userAction, refit, settle: userAction \}\)/, 'a float\'s move (userAction false) never glides');
  assert.match(fnBody('commitSelection'), /renderLayout\(\{ userAction: true, settle: true \}\)/);
  const body = fnBody('settleDock');
  assert.match(body, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(body, /window\.dockTreeView\.settleMs\(reduced\)/);
  // Nothing animates while a divider or a float is dragged: those redraws are plain renderLayout() calls.
  assert.doesNotMatch(JS.slice(JS.indexOf('function initDividers'), JS.indexOf("document.getElementById('dock').addEventListener('keydown'")), /settle: true/);
});

test('D4: the page\'s CSS settles only the groups, rails and dividers, only while the dock has .settling, and snaps under prefers-reduced-motion', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
  const rule = html.match(/#dock\.settling > \.dgroup, #dock\.settling > \.drail, #dock\.settling > \.dgutter \{\s*transition: ([^;]+);/);
  assert.ok(rule, 'the settle rule must be findable');
  assert.match(rule[1], /^left 120ms ease-out, top 120ms ease-out, width 120ms ease-out, height 120ms ease-out$/, 'about 120 ms, geometry only');
  assert.doesNotMatch(html, /#termwrap\s*\{[^}]*transition/, 'xterm refits to the rectangle it ends in: the terminal never glides');
  const reduced = html.match(/@media \(prefers-reduced-motion: reduce\) \{\s*#dock\.settling > \.dgroup, #dock\.settling > \.drail, #dock\.settling > \.dgutter \{ transition: none; \}\s*\}/);
  assert.ok(reduced, 'reduced motion switches the glide off');
  assert.ok(html.indexOf(reduced[0]) > html.indexOf(rule[0]), 'and comes after it, so it wins');
});

test('PR #159 Miguel B1: Escape is the popover\'s only when focus is in it or on its rail; the terminal\'s interrupt is never taken', () => {
  const at = JS.indexOf("window.addEventListener('keydown', (e) => {\n  if (e.key !== 'Escape' || !peek || kbMove) return;");
  assert.ok(at !== -1);
  const handler = JS.slice(at, JS.indexOf('\n}, true);', at));
  assert.match(handler, /const held = document\.activeElement;\s+if \(!held \|\| !held\.closest \|\| !held\.closest\('\.dpeek, \.drail'\)\) return;/);
  assert.ok(handler.indexOf('.closest(') < handler.indexOf('preventDefault'), 'decided before any key is taken');
});

test('PR #159 Miguel I2 / Dexter 4: the popover closes when the keyboard leaves it, and a keyboard move starting from it draws it away', () => {
  assert.match(JS, /document\.addEventListener\('focusin', \(e\) => \{\s+if \(!peek \|\| !window\.dockTreeView\.focusClosesPeek\(e\.target, e\.relatedTarget\)\) return;/);
  assert.match(JS, /if \(peek\) \{ railEvent\(\{ type: 'drop' \}\); renderLayout\(\{ refit: false \}\); \}/);
});

test('PR #159 Miguel S1 / S3 / S5: focus into the tab menu only from the keyboard; "no zone further" is said; a held Enter does not drop', () => {
  assert.match(JS, /if \(first && byKeyboard\) first\.focus\(\);/);
  assert.match(JS, /e\.button !== 2\);/);
  assert.match(JS, /No zone further that way\./);
  assert.match(JS, /if \(e\.repeat\) return;/);
});

test('a change of placement ends a pending arrow-key burst first, so its drawn sizes cannot hide the change for 400 ms', () => {
  // A drop made while dragLayout still held the burst was saved but drawn as the old picture until the flush.
  assert.match(fnBody('commitPlacement'), /^function commitPlacement[^\n]*\n\s+if \(flushKeyBurst\) flushKeyBurst\(\);/);
  assert.match(JS, /flushKeyBurst = flushKeys;/);
});

test('PR #159 Dexter 1: a collapse is forgotten only after the hello has said whether this tab has its own layout', () => {
  assert.match(fnBody('renderLayout'), /if \(window\.dockEffects\.pruneReady\(layoutLoaded, helloSeen\)\) \{/);
  assert.match(JS, /helloSeen = true;\n\s+if \('layoutOverride' in msg\) applyLayoutOverride\(msg\.layoutOverride\);/, 'the hello sets it before its redraw');
  assert.strictEqual([...JS.matchAll(/helloSeen = true;/g)].length, 1, 'set nowhere else');
});

test('PR #159 Dexter 5 / Miguel S4: the keyboard drop says what dock did, and focus returns to a rail button when there is no tab', () => {
  assert.match(JS, /const moved = placementOf\(DTm\.normalize\(next, MODULE_IDS\)\) !== placementOf\(placementLayout\(\)\);\n\s+commitPlacement\(next, \{ select: id \}\);\n\s+say\(window\.dockDrag\.describeDrop\(moved, labelOf\(id\), window\.dockDrag\.describeTarget\(target, nameOf\)\)\);/);
  assert.doesNotMatch(JS, /say\(`Moved /);
  assert.match(JS, /const refocus = id => \{ const b = document\.querySelector\(`\.zone-tabs button\[data-module="\$\{CSS\.escape\(id\)\}"\], \.drail button\[data-module="\$\{CSS\.escape\(id\)\}"\]`\); if \(b\) b\.focus\(\); \};/);
});

test('PR #159 Miguel I2 / #85: only a double-click on the EMPTY part of a tab bar unpins the group; on a tab it does nothing new', () => {
  const at = JS.indexOf("document.addEventListener('dblclick', (e) => {");
  assert.ok(at !== -1, 'the dblclick handler must be findable');
  const handler = JS.slice(at, JS.indexOf('\n});', at));
  assert.match(handler, /if \(bar\) \{\n\s+if \(e\.target === bar\) commitPlacement\(DTm\.unpinGroup\(settledLayout\(\), bar\.parentNode\.dataset\.group\)\);\n\s+return;\n\s+\}/);
});

test('PR #159 Miguel I1: the rail button press follows peekFocus -- popover on open, terminal on a mouse close (never over the vault), rail on Enter', () => {
  const body = fnBody('openPeek');
  assert.match(body, /const goes = window\.dockTreeView\.peekFocus\(!!peek, byKeyboard\);/);
  assert.match(body, /if \(goes === 'terminal'\) \{\n\s+if \(!shownModules\.has\('vault'\)\) term\.focus\(\);/);
  assert.match(body, /goes === 'popover' \? document\.querySelector\('\.dpeek \.zone-tabs button\.on'\)/);
  assert.match(JS, /const chosen = document\.querySelector\('\.dpeek \.zone-tabs button\.on'\);[^\n]*\n\s+if \(chosen\) chosen\.focus\(\);/, 'a tab pressed in the popover keeps the focus in it after the redraw');
});

test('PR #159 Dexter 6: an operation on the placement is built on the layout AFTER a pending key burst is saved, so a push that arrived in the burst survives', () => {
  assert.match(JS, /function settledLayout\(\) \{ if \(flushKeyBurst\) flushKeyBurst\(\); return placementLayout\(\); \}/);
  assert.doesNotMatch(JS, /DTm\.(dock|hide|show)\(placementLayout\(\)/, 'a dock / hide / show built on the drawn layout would carry a stale whole into the save');
  assert.strictEqual([...JS.matchAll(/DTm\.(dock|hide|show)\(settledLayout\(\)/g)].length, 11, 'every operation site');
  assert.match(JS, /box\.addEventListener\('change', \(\) => \{\n\s+const l = settledLayout\(\);/, 'the layout menu\'s ticks too');
});

// --- #85: the dock rail (click only), the Pin button ----------------------------------------------------------------

test('#85, #138: the rail\'s state is fed only through railEvent, which owns no timers: side tabs open on click only', () => {
  assert.doesNotMatch(JS, /RAIL_OPEN_MS|RAIL_CLOSE_MS|railOpenTimer|railCloseTimer/, 'no hover timers');
  const body = fnBody('railEvent');
  assert.match(body, /railSt = window\.dockTreeView\.railAfter\(railSt, ev\);/);
  assert.match(body, /peek = railSt\.module === null \? null : \{ module: railSt\.module \};/, 'peek is derived, never set elsewhere');
  assert.doesNotMatch(body, /setTimeout/);
  assert.strictEqual([...JS.matchAll(/^\s+peek = /gm)].length, 1, 'one assignment: in railEvent');
  assert.doesNotMatch(JS, /peekAfter\(/, 'the page uses railAfter');
});

test('#138: the page only ever sends the rail click-only events (no hover event, whatever it is called)', () => {
  const sent = new Set([...JS.matchAll(/railEvent\(\{ type: '([^']+)'/g)].map(m => m[1]));
  const allowed = new Set(['click', 'tab', 'escape', 'outside', 'drop', 'gone']);
  assert.ok(sent.size >= 5, [...sent].join());
  for (const t of sent) assert.ok(allowed.has(t), `railEvent type '${t}' is not a click-only event`);
  assert.doesNotMatch(JS, /document\.addEventListener\('(pointerover|pointerenter|mouseover|mouseenter)'/, 'no document-level hover listener');
});

test('#138 (Ricardo round 2): only the terminal closes an open side panel: a press in it, or the keyboard going into it', () => {
  const at = JS.indexOf("document.addEventListener('pointerdown', (e) => {\n  if (!peek) return;");
  assert.ok(at !== -1, 'the press handler must be findable');
  const press = JS.slice(at, JS.indexOf('\n});', at));
  assert.match(press, /if \(!window\.dockTreeView\.inTerminal\(e\.target\)\) return;/);
  assert.match(press, /railEvent\(\{ type: 'outside' \}\)/);
  const fo = JS.indexOf("document.addEventListener('focusin', (e) => {");
  const focus = JS.slice(fo, JS.indexOf('\n});', fo));
  assert.match(focus, /focusClosesPeek\(e\.target, e\.relatedTarget\)/, 'the decision must see where focus CAME FROM (Miguel B1/I1: the app\'s own term.focus() and a window refocus have none)');
  assert.doesNotMatch(focus, /inTerminal\(e\.target\)\) return;/, 'a bare inTerminal(target) check closes the panel on the app\'s own term.focus()');
  assert.match(focus, /railEvent\(\{ type: 'outside' \}\)/);
});

test('#138: the press plumbing for native views is gone: nothing tells the page about a press in Claude\'s panel or the Preview', () => {
  assert.doesNotMatch(JS, /onPressed|canvas:pressed/);
  for (const f of ['main.js', 'preload.js', 'canvas-views.js', 'preview-views.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8'), /canvas:pressed|tellPressed|onPress\b|onPressed/, f);
  }
});

test('#85: the Pin button, the menu and the fold all go through the model\'s pin / unpin / showOnRail / unpinGroup', () => {
  const pin = fnBody('togglePin');
  assert.match(pin, /unpinning \? DTm\.unpin\(l, id\) : DTm\.pin\(l, id\)/);
  assert.match(pin, /const l = settledLayout\(\);/);
  assert.match(JS, /commitPlacement\(DTm\.showOnRail\(l, row\.id\)/, 'ticking a hidden panel in the Window menu brings it back as a rail tab');
  assert.match(JS, /commitPlacement\(DTm\.unpinGroup\(settledLayout\(\), home\.id\)/);
});

test('#85 PR #168 Miguel B2: the tab menu Pin, Unpin and Unpin group follow the Just this tab check', () => {
  assert.match(fnBody('togglePin'), /commitPlacement\([^\n]*\{ select: id, justThisTab \}\)/);
  assert.match(fnBody('togglePin'), /^function togglePin\(id, \{ justThisTab = false \} = \{\}\)/);
  assert.strictEqual([...JS.matchAll(/togglePin\(id, \{ justThisTab: check\.box\.checked \}\)/g)].length, 2, 'Pin and Unpin');
  assert.match(JS, /unpinGroup\(settledLayout\(\), home\.id\), \{ justThisTab: check\.box\.checked \}/);
});

test('#85 PR #168 Miguel Y1 / Y5: after Pin or Pinned the keyboard follows the panel and the change is said', () => {
  const body = fnBody('togglePin');
  assert.match(body, /if \(next\) next\.focus\(\);/);
  assert.match(body, /: `\.dgroup \.zone-tabs button\[data-module=/, 'a group tab, never the tab of the popover that is still sliding out (it comes first in the document)');
  assert.match(body, /\.drail\[data-rail="dock"\] button\[data-module=/);
  assert.match(body, /getElementById\('dock-announce'\)\.textContent = /);
});

test('#85 PR #168 Miguel Y3: every show-this-panel path (the Resources link, the canvas) goes through revealModule, which opens a railed panel', () => {
  const body = fnBody('revealModule');
  assert.match(body, /railEvent\(\{ type: 'click', module: id \}\)/);
  assert.match(body, /railSt\.module !== id/, 'a panel already open is not closed by asking to show it');
  assert.match(body, /DTm\.show\(settledLayout\(\), id\)/);
  assert.doesNotMatch(JS.replace(body, ''), /if \(placementLayout\(\)\.hidden\.includes\(/, 'no path decides hidden-or-not by itself');
});

test('PR #189 Miguel 1: the Reset layout tooltip says the panels go back on the rail', () => {
  assert.match(JS, /text: 'Reset layout', title: 'Every panel back on the rail, default sizes'/);
});

test('PR #189 Miguel 3: every load path reads a stored layout through the start-layout rules (#103)', () => {
  assert.match(JS, /let globalLayout = DTm\.startLayout\(MODULE_IDS\);/);
  const load = fnBody('loadLayout');
  assert.match(load, /globalLayout = DTm\.startLayout\(MODULE_IDS\);/);
  assert.match(load, /if \(what === 'use'\) \{ globalLayout = DTm\.readStored\(answer\.layout, MODULE_IDS\);/);
  assert.match(load, /globalLayout = DTm\.readStored\(v1Answer\.layout, MODULE_IDS\);/);
  assert.match(fnBody('legacyLayout'), /DTm\.unpinAll\(DTm\.fromV1\(/);
});

test('PR #189 Miguel 2: pushed layouts and this tab\'s own override are read the same way', () => {
  assert.match(fnBody('loadLayout'), /const incoming = DTm\.readStored\(l, MODULE_IDS\);/);
  assert.match(fnBody('applyLayoutOverride'), /DTm\.readStored\(r\.apply, MODULE_IDS\)/);
});

test('PR #189 Miguel 5: no probe action drives a popover tab any more (the popover shows one tab)', () => {
  assert.doesNotMatch(JS, /case 'peekTabClick'/);
});
