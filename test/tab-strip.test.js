'use strict';
/**
 * The strip page's painter (app/tab-strip.js) against a minimal fake DOM, and
 * the shape of its bridge (app/preload-strip.js). The strip decides nothing:
 * these pin that it DRAWS what the model says -- the close x only when the tab
 * is closable, dim when not started, a glyph only when there is one -- and
 * that it writes text with textContent (a branch name is somebody else's
 * string).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { paneFor, paint, alertFor, paintAccent, GLYPHS } = require('../app/tab-strip');

// --- a fake DOM, just enough for paint() ---------------------------------------
function node(tag) {
  const n = {
    tag, className: '', textContent: '', title: '', hidden: false, type: '', dataset: {},
    value: '', disabled: false, focused: 0, focus() { n.focused++; },
    onsubmit: null, onkeydown: null,
    children: [], listeners: {}, onclick: null,
    appendChild(c) { n.children.push(c); return c; },
    replaceChildren(...cs) { n.children = cs; },
    addEventListener(name, fn) { n.listeners[name] = fn; },
  };
  return n;
}
function fakeDoc() {
  const byId = { tabs: node('div'), pane: node('div'), 'pane-text': node('div'), 'pane-retry': node('button') };
  return { byId, createElement: node, getElementById: (id) => byId[id] };
}
const entry = (o) => ({
  key: 'k', label: 'feat/a', isDev: false, selected: false, started: true, closable: true,
  working: false, needsInput: false, lockGlyph: null, health: null, phase: 'live', error: null,
  starting: false, startError: null, ...o,
});
const bridgeSpy = () => {
  const calls = [];
  return { calls, select: (k) => calls.push(['select', k]), close: (k, ifSafe) => calls.push(ifSafe === undefined ? ['close', k] : ['close', k, ifSafe]), contextMenu: (k) => calls.push(['menu', k]) };
};
const child = (tab, cls) => tab.children.find(c => c.className.split(' ').includes(cls));

test('paneFor: null when the selected tab has its own page; words while it does not', () => {
  assert.strictEqual(paneFor({ model: [entry({ selected: true })] }), null);
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false, starting: true })] }),
    { text: 'Starting feat/a…', retry: null });
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false, startError: 'no port' })] }),
    { text: "Couldn't start feat/a: no port", retry: 'k' });
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false })] }),
    { text: 'feat/a is not started yet.', retry: 'k' });
});

test('paneFor with nothing selected says why, from the notice when there is one', () => {
  assert.deepStrictEqual(paneFor({ model: [] }), { text: 'No worktrees yet.', retry: null });
  assert.deepStrictEqual(paneFor({ model: [], notice: "can't list worktrees: x" }), { text: "can't list worktrees: x", retry: null });
  assert.deepStrictEqual(paneFor(null), { text: 'No worktrees yet.', retry: null });
  assert.deepStrictEqual(paneFor({ model: 'nope', notice: 5 }), { text: 'No worktrees yet.', retry: null });
});

test('paint: one .tab per entry, in order, selected and dim classes from the model', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ key: 'a', label: 'develop', isDev: true, selected: true }),
    entry({ key: 'b', label: 'feat/b', started: false })] }, bridgeSpy());
  const tabs = doc.byId.tabs.children;
  assert.deepStrictEqual(tabs.map(t => t.dataset.key), ['a', 'b']);
  assert.match(tabs[0].className, /\bselected\b/);
  assert.match(tabs[0].className, /\bdev\b/);
  assert.doesNotMatch(tabs[0].className, /\bdim\b/);
  assert.match(tabs[1].className, /\bdim\b/, 'not started: dimmed');
  assert.deepStrictEqual(tabs.map(t => child(t, 'label').textContent), ['develop', 'feat/b']);
});

test('paint: dots, glyph and health appear only when the model says so', () => {
  const doc = fakeDoc();
  paint(doc, { model: [
    entry({ key: 'plain' }),
    entry({ key: 'busy', working: true, needsInput: true, lockGlyph: 'blocked', health: '↓3' }),
  ] }, bridgeSpy());
  const [plain, busy] = doc.byId.tabs.children;
  for (const c of ['working', 'needs', 'glyph', 'health']) assert.strictEqual(child(plain, c), undefined, c);
  assert.ok(child(busy, 'working') && child(busy, 'needs'));
  assert.strictEqual(child(busy, 'glyph').textContent, GLYPHS.blocked);
  assert.strictEqual(child(busy, 'health').textContent, '↓3');
});

test('#31 paint: a tab pulses only as the model says (needs / done), never on a guess', () => {
  const doc = fakeDoc();
  paint(doc, { model: [
    entry({ key: 'plain' }),
    entry({ key: 'n', pulse: 'needs' }),
    entry({ key: 'd', pulse: 'done' }),
    entry({ key: 'odd', pulse: 'sparkle' }),
    entry({ key: 'sel', selected: true, pulse: null }),
  ] }, bridgeSpy());
  const cls = doc.byId.tabs.children.map(t => t.className.split(' '));
  assert.ok(!cls[0].some(c => c.startsWith('pulse-')));
  assert.ok(cls[1].includes('pulse-needs') && !cls[1].includes('pulse-done'));
  assert.ok(cls[2].includes('pulse-done') && !cls[2].includes('pulse-needs'));
  assert.ok(!cls[3].some(c => c.startsWith('pulse-')), 'an unknown pulse draws nothing');
  assert.ok(!cls[4].some(c => c.startsWith('pulse-')));
});

test('#31 the page has a keyframe for each look, and a steady highlight under prefers-reduced-motion', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /\.tab\.pulse-needs\s*\{[^}]*animation:[^}]*tab-pulse-needs/);
  assert.match(html, /\.tab\.pulse-done\s*\{[^}]*animation:[^}]*tab-pulse-done/);
  assert.match(html, /@keyframes tab-pulse-needs/);
  assert.match(html, /@keyframes tab-pulse-done/);
  const reduced = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.tab\.pulse-needs[^{]*\{[^}]*animation:\s*none/);
  assert.match(reduced, /\.tab\.pulse-done[^{]*\{[^}]*animation:\s*none/);
  assert.match(reduced, /\.tab\.pulse-needs[^{]*\{[^}]*(background|box-shadow)/, 'still highlighted, just not moving');
});

test('#31 (Miguel S1 S2 S3): hover still shows on a pulsing tab, the working dot honours reduced motion, one set of colours per look', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  // A running animation outranks a plain :hover background, so the hover rule stops it.
  assert.match(html, /\.tab\.pulse-needs:hover,\s*\.tab\.pulse-done:hover\s*\{[^}]*animation:\s*none[^}]*background:/);
  const reduced = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.dot\.working\s*\{[^}]*animation:\s*none/);
  // The held colours ARE the keyframes' peak, named once per look, not copied.
  for (const look of ['needs', 'done']) {
    const rule = new RegExp(`\\.tab\\.pulse-${look}\\s*\\{([^}]*)\\}`).exec(html);
    assert.ok(rule, look);
    for (const v of ['--pulse-lo-bg', '--pulse-hi-bg', '--pulse-lo-line', '--pulse-hi-line']) {
      assert.match(rule[1], new RegExp(`${v}:`), `${look} defines ${v}`);
    }
  }
  assert.match(html, /@keyframes tab-pulse-needs\s*\{[^]*?var\(--pulse-lo-bg\)[^]*?var\(--pulse-hi-bg\)/);
  assert.match(reduced, /background:\s*var\(--pulse-hi-bg\)/);
  assert.match(reduced, /var\(--pulse-hi-line\)/);
  assert.doesNotMatch(reduced, /color-mix/, 'no colour copied into the reduced-motion block');
});

test('paint: an unknown lock glyph draws nothing rather than a guess', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ lockGlyph: 'mystery' })] }, bridgeSpy());
  assert.strictEqual(child(doc.byId.tabs.children[0], 'glyph'), undefined);
});

test('paint: the close x exists only for a closable tab, and closing does not also select', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'dev', isDev: true, closable: false }), entry({ key: 'a' })] }, b);
  const [dev, a] = doc.byId.tabs.children;
  assert.strictEqual(child(dev, 'x'), undefined, 'dev has no close (criterion 6)');
  const x = child(a, 'x');
  assert.ok(x);
  let stopped = false;
  x.listeners.click({ stopPropagation: () => { stopped = true; } });
  assert.strictEqual(stopped, true);
  assert.deepStrictEqual(b.calls, [['close', 'a']]);
});

test('paint: Ctrl+click on a closable tab asks main to close it if safe (#77) instead of selecting; on dev it just selects', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'dev', isDev: true, closable: false }), entry({ key: 'a' })] }, b);
  const [dev, a] = doc.byId.tabs.children;
  a.listeners.click({ ctrlKey: true });
  assert.deepStrictEqual(b.calls, [['close', 'a', true]]);
  b.calls.length = 0;
  dev.listeners.click({ ctrlKey: true });
  assert.deepStrictEqual(b.calls, [['select', 'dev']], 'dev has no close');
  b.calls.length = 0;
  a.listeners.click({ ctrlKey: false });
  a.listeners.click({});
  assert.deepStrictEqual(b.calls, [['select', 'a'], ['select', 'a']], 'a plain click selects');
});

test('paint: Ctrl+click on the x is the same safe close; a plain x click is the plain close', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'a' })] }, b);
  const x = child(doc.byId.tabs.children[0], 'x');
  x.listeners.click({ stopPropagation() {}, ctrlKey: true });
  x.listeners.click({ stopPropagation() {} });
  assert.deepStrictEqual(b.calls, [['close', 'a', true], ['close', 'a']]);
});

test('paint: click selects, right-click asks main for the menu (and stops the browser\'s own)', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'a' })] }, b);
  const tab = doc.byId.tabs.children[0];
  tab.listeners.click();
  let prevented = false;
  tab.listeners.contextmenu({ preventDefault: () => { prevented = true; } });
  assert.deepStrictEqual(b.calls, [['select', 'a'], ['menu', 'a']]);
  assert.strictEqual(prevented, true);
});

test('paint: the pane shows while the tab has no page; Retry re-selects the failed tab', () => {
  const doc = fakeDoc();
  const b = bridgeSpy();
  paint(doc, { model: [entry({ key: 'a', selected: true, started: false, startError: 'boom' })] }, b);
  assert.strictEqual(doc.byId.pane.hidden, false);
  assert.strictEqual(doc.byId['pane-text'].textContent, "Couldn't start feat/a: boom");
  assert.strictEqual(doc.byId['pane-retry'].hidden, false);
  doc.byId['pane-retry'].onclick();
  assert.deepStrictEqual(b.calls, [['select', 'a']]);
  paint(doc, { model: [entry({ key: 'a', selected: true })] }, b);
  assert.strictEqual(doc.byId.pane.hidden, true);
  assert.strictEqual(doc.byId['pane-retry'].hidden, true);
  assert.strictEqual(doc.byId['pane-retry'].onclick, null);
});

// --- layout pass L2 (#28): the frameless window's own buttons ----------------

const { windowChrome } = require('../app/tab-strip');
function chromeDoc() {
  const body = { classes: new Set(), classList: null };
  body.classList = { add: (c) => body.classes.add(c), contains: (c) => body.classes.has(c) };
  const byId = { 'win-min': node('button'), 'win-close': node('button') };
  byId['win-min'].hidden = true;
  byId['win-close'].hidden = true;
  return { body, byId, getElementById: (id) => byId[id] };
}

test('windowChrome: ?frameless=1 marks the body and shows minimise and close, wired to the bridge', () => {
  const doc = chromeDoc();
  const calls = [];
  windowChrome(doc, '?frameless=1', { winMinimize: () => calls.push('min'), winClose: () => calls.push('close') });
  assert.strictEqual(doc.body.classList.contains('frameless'), true);
  assert.strictEqual(doc.byId['win-min'].hidden, false);
  assert.strictEqual(doc.byId['win-close'].hidden, false);
  doc.byId['win-min'].onclick();
  doc.byId['win-close'].onclick();
  assert.deepStrictEqual(calls, ['min', 'close']);
});

test('windowChrome: a framed window (no flag, or any other value) keeps both buttons hidden', () => {
  for (const search of ['', '?', '?frameless=0', '?frameless=true', '?other=1', null, undefined]) {
    const doc = chromeDoc();
    windowChrome(doc, search, { winMinimize() {}, winClose() {} });
    assert.strictEqual(doc.body.classList.contains('frameless'), false, String(search));
    assert.strictEqual(doc.byId['win-min'].hidden, true, String(search));
    assert.strictEqual(doc.byId['win-close'].hidden, true, String(search));
  }
});

test('tab-strip.html: the window buttons sit after ▾, start hidden, and frameless sets the drag regions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  const strip = html.slice(html.indexOf('<div id="strip">'), html.indexOf('<div id="pane"'));
  assert.ok(strip.indexOf('id="bg"') < strip.indexOf('id="win-min"'));
  assert.ok(strip.indexOf('id="win-min"') < strip.indexOf('id="win-close"'));
  assert.match(strip, /id="win-min"[^>]*\bhidden\b/);
  assert.match(strip, /id="win-close"[^>]*\bhidden\b/);
  // Miguel L2 G4: glyph-only buttons are named for a screen reader.
  assert.match(strip, /id="win-min"[^>]*aria-label="Minimise"/);
  assert.match(strip, /id="win-close"[^>]*aria-label="Close window"/);
  assert.match(html, /body\.frameless #strip\s*\{[^}]*-webkit-app-region:\s*drag/);
  assert.match(html, /body\.frameless[^{]*\.tab[^{]*\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(html, /body\.frameless[^{]*#strip button[^{]*\{[^}]*-webkit-app-region:\s*no-drag/);
});

test('paintAccent: sets the strip\'s --accent from a hex, and refuses anything else (#64)', () => {
  const set = [];
  const removed = [];
  const doc = { documentElement: { style: { setProperty: (k, v) => set.push([k, v]), removeProperty: (k) => removed.push(k) } } };
  assert.strictEqual(paintAccent(doc, '#00ff88'), true);
  assert.deepStrictEqual(set, [['--accent', '#00ff88']]);
  for (const bad of ['red', '#fff', '#00ff8800', 'url(x)', '#00ff88; x', undefined, 5, {}]) {
    assert.strictEqual(paintAccent(doc, bad), false, String(bad));
  }
  assert.strictEqual(set.length, 1, 'nothing invalid reached the style');
  assert.deepStrictEqual(removed, [], 'nothing invalid cleared it either');
  // null = the selected tab hasn't reported (F2): back to the strip's own default accent.
  assert.strictEqual(paintAccent(doc, null), true);
  assert.deepStrictEqual(removed, ['--accent']);
  assert.strictEqual(paintAccent(null, '#00ff88'), false);
});

test('the strip bridge exposes its eighteen members -- and nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload-strip.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  const block = src.slice(src.indexOf("exposeInMainWorld('strip', {"));
  const members = [...block.matchAll(/^  ([A-Za-z]+):/gm)].map(m => m[1]);
  assert.deepStrictEqual(members,
    ['select', 'close', 'contextMenu', 'plus', 'create', 'cancelCreate', 'background', 'onModel', 'onAccent', 'winMinimize', 'winClose',
      // #66, the indexing field (app/indexing-bridge.js answers them)
      'indexSubmit', 'indexFocus', 'indexLeave', 'indexChip', 'indexList', 'onIndex', 'onIndexFocus']);
  assert.match(src, /'strip:winMinimize'/);
  assert.match(src, /'strip:winClose'/);
  assert.match(src, /'strip:select'/);
  assert.match(src, /'strip:close'/);
  assert.match(src, /'strip:contextMenu'/);
  assert.match(src, /'strip:plus'/);
  assert.match(src, /'strip:create'/);
  assert.match(src, /'strip:cancelCreate'/);
  assert.match(src, /invoke\('strip:background'\)/);
  assert.match(src, /removeAllListeners\('strip-model'\)/);
});

test('paint: ▾ asks main for the running-sessions menu, and is busy until it closes', async () => {
  const doc = fakeDoc();
  doc.byId.bg = node('button');
  let release;
  let asked = 0;
  const b = { ...bridgeSpy(), background: () => { asked += 1; return new Promise(r => { release = r; }); } };
  paint(doc, { model: [entry()] }, b);
  const bg = doc.byId.bg;
  bg.onclick();
  assert.strictEqual(asked, 1);
  assert.strictEqual(bg.disabled, true);
  bg.onclick();                                  // busy: not asked twice
  assert.strictEqual(asked, 1);
  paint(doc, { model: [entry()] }, b);           // a repaint mid-menu keeps it busy
  assert.strictEqual(bg.disabled, true);
  release();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(bg.disabled, false);
  bg.onclick();
  assert.strictEqual(asked, 2);
  release();                                     // leave the page's one flag as found
  await new Promise(r => setImmediate(r));
});

test('paint: a menu that fails still frees the ▾ button', async () => {
  const doc = fakeDoc();
  doc.byId.bg = node('button');
  const b = { ...bridgeSpy(), background: () => Promise.reject(new Error('gone')) };
  paint(doc, { model: [] }, b);
  doc.byId.bg.onclick();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(doc.byId.bg.disabled, false);
});

test('tab-strip.html has the ▾ button, after the tabs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /id="tabs"[\s\S]*<button type="button" id="bg"[^>]*>▾<\/button>/);
});

test('tab-strip.html starts with the pane hidden', () => {
  // Which script it loads is pinned in test/source-contracts.test.js: naming
  // the painter's file here would read as reading a mutated module.
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /id="pane"[^>]*\bhidden\b/);
  assert.match(html, /id="tabs"/);
  assert.match(html, /height: 34px/);
});

test('F3 (Dexter, PR #75): a failed stop is drawn IN the strip, as text, and cleared when gone', () => {
  const doc = fakeDoc();
  doc.byId['strip-alert'] = node('div');
  const model = [entry({ selected: true })];
  paint(doc, { model, closeNotice: "Couldn't end the session in feat/a: handshake refused (HTTP 403). It may still be running." }, bridgeSpy());
  assert.strictEqual(doc.byId['strip-alert'].hidden, false);
  assert.match(doc.byId['strip-alert'].textContent, /feat\/a.*403.*may still be running/);
  paint(doc, { model, closeNotice: null }, bridgeSpy());
  assert.strictEqual(doc.byId['strip-alert'].hidden, true);
  assert.strictEqual(doc.byId['strip-alert'].textContent, '');
});

// --- PR 3: the + button, the branch form, phase badges and the alert line -----------

function fullDoc() {
  const doc = fakeDoc();
  for (const id of ['strip-alert', 'plus', 'create', 'create-branch', 'create-cancel']) {
    doc.byId[id] = node(id === 'create' ? 'form' : 'div');
  }
  return doc;
}
const fullBridge = () => {
  const b = bridgeSpy();
  b.plus = () => b.calls.push(['plus']);
  b.create = (v) => b.calls.push(['create', v]);
  b.cancelCreate = () => b.calls.push(['cancel']);
  return b;
};

test('paneFor: a running setup shows its progress, and a pending creation says so; no Retry for either', () => {
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false, setup: { running: true, line: 'added 512 packages' } })] }),
    { text: 'Setting up feat/a… added 512 packages', retry: null });
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false, setup: { running: true, line: null } })] }),
    { text: 'Setting up feat/a…', retry: null });
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false })], create: { phase: 'running', branch: 'feat/a' } }),
    { text: 'Creating feat/a…', retry: null });
  assert.deepStrictEqual(paneFor({ model: [entry({ selected: true, started: false })], create: { phase: 'running', branch: 'feat/zz' } }),
    { text: 'feat/a is not started yet.', retry: 'k' });
});

test('alertFor: close notice, then the creation, then the selected tab', () => {
  const sel = entry({ selected: true, phaseText: 'Merged. When its session ends, this worktree is removed.', badge: 'merged' });
  assert.deepStrictEqual(alertFor({ model: [sel], closeNotice: 'stop failed', create: { phase: 'failed', error: 'bad' } }),
    { text: 'stop failed', kind: 'bad' });
  assert.deepStrictEqual(alertFor({ model: [sel], create: { phase: 'failed', branch: 'demo', error: 'demo: needs a prefix' } }),
    { text: 'demo: needs a prefix', kind: 'bad' });
  assert.deepStrictEqual(alertFor({ model: [sel], create: { phase: 'running', branch: 'feat/x' } }),
    { text: 'Creating feat/x…', kind: 'info' });
  assert.deepStrictEqual(alertFor({ model: [sel], create: { phase: 'input' } }),
    { text: 'Merged. When its session ends, this worktree is removed.', kind: 'info' });
  assert.deepStrictEqual(alertFor({ model: [entry({ selected: true, phaseText: "Couldn't remove this worktree: x", badge: 'warn' })] }),
    { text: "Couldn't remove this worktree: x", kind: 'bad' });
  assert.strictEqual(alertFor({ model: [entry({ selected: true })] }), null);
  assert.strictEqual(alertFor({ model: [entry({ selected: false, phaseText: 'x' })] }), null, 'only the selected tab speaks');
  assert.strictEqual(alertFor(null), null);
});

test('paint: the + shows only in a project window and asks main for its menu', () => {
  const doc = fullDoc();
  const b = fullBridge();
  paint(doc, { model: [entry()], mode: 'tabs' }, b);
  assert.strictEqual(doc.byId.plus.hidden, false);
  doc.byId.plus.onclick();
  assert.deepStrictEqual(b.calls, [['plus']]);
  paint(doc, { model: [entry()], mode: 'single' }, b);
  assert.strictEqual(doc.byId.plus.hidden, true);
});

test('paint: the branch form opens empty and focused, keeps what is typed across repaints, and submits it', () => {
  const doc = fullDoc();
  const b = fullBridge();
  const input = doc.byId['create-branch'];
  input.value = 'left over';
  paint(doc, { model: [entry()], mode: 'tabs', create: null }, b);
  assert.strictEqual(doc.byId.create.hidden, true);
  paint(doc, { model: [entry()], mode: 'tabs', create: { phase: 'input' } }, b);
  assert.strictEqual(doc.byId.create.hidden, false);
  assert.strictEqual(input.value, '', 'opened fresh');
  assert.strictEqual(input.focused, 1);
  input.value = 'feat/de';
  paint(doc, { model: [entry()], mode: 'tabs', create: { phase: 'input' } }, b);   // a poll repaints
  assert.strictEqual(input.value, 'feat/de', 'a repaint never wipes what is being typed');
  assert.strictEqual(input.focused, 1, 'and does not steal focus again');
  input.value = 'feat/demo';
  let prevented = false;
  doc.byId.create.onsubmit({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.deepStrictEqual(b.calls, [['create', 'feat/demo']]);
});

test('paint: while creating the field is disabled; a failure re-enables it with the text kept; Esc and the x cancel', () => {
  const doc = fullDoc();
  const b = fullBridge();
  const input = doc.byId['create-branch'];
  paint(doc, { model: [entry()], mode: 'tabs', create: { phase: 'input' } }, b);
  input.value = 'demo';
  paint(doc, { model: [entry()], mode: 'tabs', create: { phase: 'running', branch: 'demo' } }, b);
  assert.strictEqual(input.disabled, true);
  paint(doc, { model: [entry()], mode: 'tabs', create: { phase: 'failed', branch: 'demo', error: 'needs a prefix' } }, b);
  assert.strictEqual(input.disabled, false);
  assert.strictEqual(input.value, 'demo', 'kept so it can be fixed');
  assert.strictEqual(input.focused, 2, 'and focused again for that');
  assert.strictEqual(doc.byId['strip-alert'].textContent, 'needs a prefix');
  input.onkeydown({ key: 'Escape', preventDefault: () => {} });
  doc.byId['create-cancel'].onclick();
  assert.deepStrictEqual(b.calls, [['cancel'], ['cancel']]);
  input.onkeydown({ key: 'a', preventDefault: () => assert.fail('only Escape is taken') });
});

test('paint: a merged or failing tab gets its badge, and its tooltip says why', () => {
  const doc = fullDoc();
  paint(doc, { model: [
    entry({ key: 'a', badge: 'merged', phaseText: 'Merged. When its session ends, this worktree is removed.' }),
    entry({ key: 'b', badge: 'warn', phaseText: "Couldn't remove this worktree: busy" }),
    entry({ key: 'c' }),
  ], mode: 'tabs' }, fullBridge());
  const [a, b2, c] = doc.byId.tabs.children;
  assert.strictEqual(child(a, 'badge').textContent, 'merged');
  assert.ok(child(a, 'merged'));
  assert.strictEqual(a.title, 'feat/a: Merged. When its session ends, this worktree is removed.');
  assert.ok(child(b2, 'warn'));
  assert.strictEqual(child(c, 'badge'), undefined);
  assert.strictEqual(c.title, 'feat/a');
});

test('paint: the alert line is styled by kind', () => {
  const doc = fullDoc();
  paint(doc, { model: [entry({ selected: true, phaseText: 'Removing this worktree…', badge: 'merged' })], mode: 'tabs' }, fullBridge());
  assert.strictEqual(doc.byId['strip-alert'].className, 'info');
  paint(doc, { model: [entry({ selected: true })], mode: 'tabs', closeNotice: 'x' }, fullBridge());
  assert.strictEqual(doc.byId['strip-alert'].className, 'bad');
});

test('tab-strip.html has the + and a static branch form outside #tabs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  const tabsAt = html.indexOf('id="tabs"');
  const tabsEnd = html.indexOf('</div>', tabsAt);
  for (const id of ['plus', 'create', 'create-branch', 'create-cancel']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > tabsEnd, `${id} is outside #tabs (a repaint rebuilds #tabs)`);
  }
  assert.match(html, /id="create"[^>]*\bhidden\b/);
  assert.match(html, /id="plus"[^>]*\bhidden\b/);
});

// --- #40 tab marks ---------------------------------------------------------------

test('paint: a mark sits just before the label, its meaning on hover', () => {
  const doc = fakeDoc();
  const mark = { id: 'waiting', emoji: 'W', meaning: 'Waiting on a merge' };
  paint(doc, { model: [entry({ working: true, mark }), entry({ key: 'b', mark: null }), entry({ key: 'c' })] }, bridgeSpy());
  const [marked, cleared, absent] = doc.byId.tabs.children;
  const m = child(marked, 'mark');
  assert.strictEqual(m.tag, 'span');
  assert.strictEqual(m.textContent, 'W');
  assert.strictEqual(m.title, 'Waiting on a merge');
  assert.strictEqual(marked.children.indexOf(m), marked.children.indexOf(child(marked, 'label')) - 1);
  assert.strictEqual(child(cleared, 'mark'), undefined);
  assert.strictEqual(child(absent, 'mark'), undefined);
});

test('paint: a mark without an emoji draws nothing', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ mark: { id: 'x', emoji: '', meaning: 'm' } }), entry({ key: 'b', mark: 'W' })] }, bridgeSpy());
  for (const t of doc.byId.tabs.children) assert.strictEqual(child(t, 'mark'), undefined);
});

// --- worktree occupancy (#44 + #47, take B "hatched edge") ---------------------------------------

const OCC = (o = {}) => ({ tags: ['EP'], more: 0, warn: false, lines: ['electron-pro · from develop · 4 min'], count: 1, ...o });
const classesOf = (t) => t.className.split(' ');

test("occupancy paint: an occupied tab gets the hatched-edge class and its agents' initials right of the label", () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ key: 'a', occupancy: OCC({ tags: ['EP', 'LR'] }) }), entry({ key: 'b' }), entry({ key: 'c', occupancy: null })] }, bridgeSpy());
  const [occupied, plain, none] = doc.byId.tabs.children;
  assert.ok(classesOf(occupied).includes('occupied'));
  assert.ok(!classesOf(occupied).includes('occupied-warn'));
  const tags = child(occupied, 'agent-tags');
  assert.deepStrictEqual(tags.children.map(t => t.textContent), ['EP', 'LR']);
  assert.ok(tags.children.every(t => t.className === 'agent-tag'));
  assert.strictEqual(occupied.children.indexOf(tags), occupied.children.indexOf(child(occupied, 'label')) + 1);
  for (const t of [plain, none]) {
    assert.ok(!classesOf(t).includes('occupied'));
    assert.strictEqual(child(t, 'agent-tags'), undefined);
  }
});

test('occupancy paint: two writers is its own class, set by the model and by nothing else', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ occupancy: OCC({ warn: true }) }), entry({ key: 'b', occupancy: OCC({ warn: 'yes' }) })] }, bridgeSpy());
  const [warn, odd] = doc.byId.tabs.children;
  assert.ok(classesOf(warn).includes('occupied-warn'));
  assert.ok(!classesOf(odd).includes('occupied-warn'), 'only a real true');
});

test('occupancy paint: agents beyond the tags are a +N, and the hover lists every agent under the branch name', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ occupancy: OCC({ tags: ['A', 'B', 'C'], more: 2, lines: ['one', 'two', 'three', 'four', 'five'], count: 5 }) })] }, bridgeSpy());
  const [tab] = doc.byId.tabs.children;
  const tags = child(tab, 'agent-tags');
  assert.deepStrictEqual(tags.children.map(t => t.textContent), ['A', 'B', 'C', '+2']);
  assert.strictEqual(tab.title, 'feat/a\none\ntwo\nthree\nfour\nfive');
});

test('occupancy paint: the hover keeps a phase text first, then the agents', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ phaseText: 'Merged, and kept.', occupancy: OCC() })] }, bridgeSpy());
  assert.strictEqual(doc.byId.tabs.children[0].title, 'feat/a: Merged, and kept.\nelectron-pro · from develop · 4 min');
});

test("occupancy paint: a malformed occupancy draws nothing and never throws (a model is somebody's data)", () => {
  const doc = fakeDoc();
  const bad = [5, 'x', [], {}, { tags: 'EP' }, { tags: [5, null], lines: 'x' }, { tags: [], lines: [] }];
  assert.doesNotThrow(() => paint(doc, { model: bad.map((o, i) => entry({ key: `k${i}`, occupancy: o })) }, bridgeSpy()));
  for (const t of doc.byId.tabs.children) {
    assert.ok(!classesOf(t).includes('occupied'), t.className);
    assert.strictEqual(child(t, 'agent-tags'), undefined);
  }
});

test("occupancy paint: initials go in with textContent (a name is somebody else's string)", () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ occupancy: OCC({ tags: ['<b>'] }) })] }, bridgeSpy());
  assert.strictEqual(child(doc.byId.tabs.children[0], 'agent-tags').children[0].textContent, '<b>');
});

test('occupancy page: the hatched edge is stripes in the agent colour, the warning in the warn colour, and it NEVER animates', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  const rule = (selector) => {
    const at = html.indexOf(selector + ' {');
    if (at === -1) return null;
    return html.slice(at, html.indexOf('}', at));
  };
  const edge = rule('.tab.occupied::after');
  assert.ok(edge, 'the edge rule');
  assert.match(edge, /repeating-linear-gradient\([^;]*var\(--agent\)/);
  assert.doesNotMatch(edge, /animation|transition/);
  assert.match(rule('.tab.occupied-warn::after'), /var\(--warn\)/);
  // The agent colour lives in the shared stylesheet both pages load (backlog #65).
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'agent-colour.css'), 'utf8'), /--agent:\s*#/);
  assert.match(html, /--warn:\s*#/);
  assert.doesNotMatch(rule('.agent-tag') || '', /animation/);
  assert.match(rule('.tab'), /position:\s*relative/);
});

// --- backlog #52: the night tab -------------------------------------------------------------------

test('night paint: a tab in a bedtime night gets the night class and a moon right of the label; others do not', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ key: 'a', night: true }), entry({ key: 'b' }), entry({ key: 'c', night: 'yes' })] }, bridgeSpy());
  const [night, plain, odd] = doc.byId.tabs.children;
  assert.ok(classesOf(night).includes('night'));
  const moon = child(night, 'moon');
  assert.strictEqual(moon.textContent, '🌙');
  assert.strictEqual(night.children.indexOf(moon) > night.children.indexOf(child(night, 'label')), true, 'after the label');
  for (const t of [plain, odd]) {
    assert.ok(!classesOf(t).includes('night'), 'only a real true');
    assert.strictEqual(child(t, 'moon'), undefined);
  }
});

test('night paint: the moon sits after the occupancy tags, before the lock glyph and the health text', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ night: true, occupancy: OCC(), lockGlyph: 'warn', health: '↓2' })] }, bridgeSpy());
  const [tab] = doc.byId.tabs.children;
  const order = tab.children.map(c => c.className.split(' ')[0]);
  assert.ok(order.indexOf('agent-tags') < order.indexOf('moon'), order.join());
  assert.ok(order.indexOf('moon') < order.indexOf('glyph'), order.join());
  assert.ok(order.indexOf('moon') < order.indexOf('health'), order.join());
});

test('night paint: the moon says what it means on hover, and the night never takes the pulse class', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ night: true, pulse: 'needs' })] }, bridgeSpy());
  const [tab] = doc.byId.tabs.children;
  assert.match(child(tab, 'moon').title, /overnight/i);
  assert.ok(classesOf(tab).includes('pulse-needs'), 'the pulse still shows: #31 outranks the night');
});

test('tab-strip.html: the night tab is a still deep blue declared after .selected, and never animates', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'tab-strip.html'), 'utf8');
  assert.match(html, /--night:\s*#[0-9a-f]{6}/i);
  const rule = (sel) => { const at = html.indexOf(sel + ' {'); return at === -1 ? null : html.slice(at, html.indexOf('}', at)); };
  assert.match(rule('.tab.night'), /background:\s*var\(--night\)/);
  assert.doesNotMatch(rule('.tab.night') + rule('.tab.night:hover') + rule('.moon'), /animation|transition/);
  assert.ok(html.indexOf('.tab.night {') > html.indexOf('.tab.selected {'), 'declared after .selected so it wins the background');
});

// --- backlog #39: the "where are we" summary on the hover card ---------------------------------------------

// The shell works the lines out (app/summary-display.js hoverLines); the strip only draws them.
const SAID = ["Where we're at (local model · llama3.2:3b · 4 min ago):", 'Working on: the drawer', 'Next: fix it'];

test('hover: the lines the shell worked out go under the tab name, as they are', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ summaryLines: SAID })] }, bridgeSpy());
  assert.strictEqual(doc.byId.tabs.children[0].title, ['feat/a', ...SAID].join('\n'));
});

test('hover: the summary comes after the existing lines, and a note about why it may be out of date comes last', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ phaseText: 'Merged, and kept: dirty', summaryLines: [...SAID, "Local summary off: Ollama isn't running"] })] }, bridgeSpy());
  const lines = doc.byId.tabs.children[0].title.split('\n');
  assert.strictEqual(lines[0], 'feat/a: Merged, and kept: dirty');
  assert.match(lines[1], /^Where we're at/);
  assert.strictEqual(lines[lines.length - 1], "Local summary off: Ollama isn't running");
});

test('hover: no lines, or lines that are not text, add nothing', () => {
  for (const summaryLines of [undefined, null, [], 'x', 5, {}, ['', null, 7]]) {
    const doc = fakeDoc();
    paint(doc, { model: [entry({ summaryLines })] }, bridgeSpy());
    assert.strictEqual(doc.byId.tabs.children[0].title, 'feat/a', JSON.stringify(summaryLines));
  }
});

test('hover: the lines are set as title text, never markup', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ summaryLines: ['<img src=x onerror=alert(1)>'] })] }, bridgeSpy());
  assert.strictEqual(doc.byId.tabs.children[0].title, 'feat/a\n<img src=x onerror=alert(1)>');
});

// --- #63 the CPU warning chip -------------------------------------------------------

test('#63 paint: a tab with a CPU warning gets a chip with its percentage and level, and its hover words', () => {
  const doc = fakeDoc();
  paint(doc, { model: [
    entry({ key: 'plain' }),
    entry({ key: 'hot', resourceWarn: { pct: 52.4, level: 'amber' } }),
    entry({ key: 'hotter', resourceWarn: { pct: 80, level: 'red' } }),
  ] }, bridgeSpy());
  const [plain, hot, hotter] = doc.byId.tabs.children;
  assert.strictEqual(child(plain, 'res-warn'), undefined);
  const chip = child(hot, 'res-warn');
  assert.strictEqual(chip.textContent, '52%');
  assert.match(chip.className, /\bamber\b/);
  assert.strictEqual(chip.title, 'Over 40% CPU for 30 s. Open Resources for details.');
  assert.match(child(hotter, 'res-warn').className, /\bred\b/);
});

test('#63 paint: a malformed warning draws no chip (absence is not a zero)', () => {
  const doc = fakeDoc();
  const bad = [null, undefined, 7, 'x', [], {}, { pct: null, level: 'amber' }, { pct: NaN, level: 'amber' }, { pct: '50', level: 'amber' }, { pct: -1, level: 'red' }, { pct: 50, level: 'purple' }];
  paint(doc, { model: bad.map((w, i) => entry({ key: `k${i}`, resourceWarn: w })) }, bridgeSpy());
  for (const t of doc.byId.tabs.children) assert.strictEqual(child(t, 'res-warn'), undefined);
});

test('#63 paint (kill, #70): the refusal is `pct < 0`, so exactly 0 still draws its chip and anything below 0 does not', () => {
  const doc = fakeDoc();
  paint(doc, { model: [entry({ key: 'zero', resourceWarn: { pct: 0, level: 'amber' } }), entry({ key: 'below', resourceWarn: { pct: -0.4, level: 'red' } })] }, bridgeSpy());
  const [zero, below] = doc.byId.tabs.children;
  assert.strictEqual(child(zero, 'res-warn').textContent, '0%');
  assert.strictEqual(child(below, 'res-warn'), undefined);
});
