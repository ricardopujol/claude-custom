'use strict';
/**
 * renderer.js / renderer.html's half of the wand (BACKLOG #51): source assertions in the style of
 * test/renderer-dock-wiring.test.js, because renderer.js needs a real DOM. The rules live in
 * app/wand-display.js (tested directly); verify/probe-wand.js drives the same paths in a real window.
 *
 * Repo-scanning, so deliberately NOT in Stryker's command.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const RAW = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.js'), 'utf8');
const JS = strip(RAW);
const HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer.html'), 'utf8');
const { TABS } = require('../app/side-tabs');

function fnBody(name) {
  const start = JS.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `renderer.js must define ${name}`);
  return JS.slice(start, JS.indexOf('\n}', start));
}

// The whole wand section: from its first marker to the next top-level section.
// (located in the raw text: the markers are comments, which strip() removes)
const START = RAW.indexOf('// WAND-BEGIN');
const WAND = strip(RAW.slice(START, RAW.indexOf('// WAND-END')));

test('the wand is an ordinary module: one TABS entry, one panel, one script, no dock code touched', () => {
  assert.ok(TABS.some(t => t.id === 'wand' && t.label && t.title), 'side-tabs TABS lists the wand');
  assert.match(HTML, /<div class="panel" data-panel="wand" id="wand-body">\s*<div id="wand-root"/);
  const wandScript = HTML.indexOf('<script src="./wand-display.js"></script>');
  assert.ok(wandScript !== -1 && wandScript < HTML.indexOf('<script src="./renderer.js"></script>'), 'wand-display.js loads before renderer.js');
});

test('the wand section is findable, and is the ONLY place the wand touches the page', () => {
  assert.ok(START !== -1 && WAND.length > 200, 'WAND-BEGIN / WAND-END must bracket the glue');
});

test('#61 a click types through typeCommand with submit on; the wand\'s glue holds NO Enter of its own', () => {
  const body = fnBody('wandType');
  assert.match(body, /typeCommand\(plan\.command, \(r\) => \{[\s\S]*?\}, undefined, \{ submit: true, typeOnly: plan\.typeOnly \}\);/);
  // No Enter anywhere in the wand's glue: not a CR, not a raw input frame, not typePlanned. The one CR a click
  // can cause is submitTyped's, and only when the gate allows it (pinned below).
  assert.doesNotMatch(WAND, /\\r|\\n['"]/);
  assert.doesNotMatch(WAND, /type: 'input'/);
  assert.doesNotMatch(WAND, /typePlanned/);
  assert.doesNotMatch(WAND, /input\(/);
  assert.doesNotMatch(WAND, /submitTyped/, 'the wand reaches the CR only through typeCommand');
});

test('#61 the only CR in the typeCommand path is the one planSubmit allowed, written by submitTyped', () => {
  const t = fnBody('typeCommand');
  assert.match(t, /typeAndCheck\(plan\.enterInsert, command,/);
  assert.doesNotMatch(t, /\\r/, 'typeCommand writes no CR itself');
  assert.match(t, /submitTyped\(/);
  const sub = fnBody('submitTyped');
  assert.match(sub, /submitGate\.planSubmit\(\{ turn: sessionTurn, typeOnly \}\)/);
  assert.strictEqual((sub.match(/\\r/g) || []).length, 1, 'exactly one CR');
  assert.match(sub, /if \(gate\.enter\)[^\n]*\\r/, 'and it is behind the gate');
  // and no other function the wand or the drawer reach writes one: typePlanned (the top bar) is the only other
  assert.deepStrictEqual([...JS.matchAll(/data: '\\r'|input\('\\r'\)/g)].length, 2, 'typePlanned (top bar) and submitTyped, nothing else');
});

test('a click while one is still typing is ignored: two overlapping type sequences would garble the box', () => {
  const body = fnBody('wandType');
  assert.match(body, /if \(wandBusy\) return;/);
  assert.match(body, /wandBusy = true;/);
  assert.match(body, /wandBusy = false;/);
});

test('the host\'s hello and wand frames fold into the panel state, then redraw', () => {
  const hello = JS.slice(JS.indexOf("if (msg.type === 'hello') {"), JS.indexOf("if (msg.type === 'loadout') {"));
  assert.match(hello, /wandState = wandDisplay\.reduce\(wandState, msg\);\s*renderWand\(\);/);
  const frame = JS.slice(JS.indexOf("if (msg.type === 'wand') {"), JS.indexOf("if (msg.type === 'wand') {") + 200);
  assert.match(frame, /wandState = wandDisplay\.reduce\(wandState, msg\);\s*renderWand\(\);\s*return;/);
});

test('opening the module asks the host to rescan its skills', () => {
  assert.match(fnBody('onModuleShown'), /if \(id === 'wand'\) requestWandSkills\(\);/);
});

test('every edit goes out through wandSend, and a send with no socket is shown, not silently dropped', () => {
  const body = fnBody('wandSend');
  assert.match(body, /wandDisplay\.failed\(wandState,/);
  assert.match(body, /ws\.send\(JSON\.stringify\(message\)\)/);
});

test('a redraw keeps the editor field the user is typing in: a quiet refresh must not eat their text or focus', () => {
  const body = fnBody('renderWand');
  assert.match(body, /document\.activeElement/);
  assert.match(body, /setSelectionRange\(/);
});

test('reordering is a drag inside the panel: it stops the page-wide file-drop handler seeing it', () => {
  assert.match(WAND, /addEventListener\('dragover', \(e\) => \{[^}]*e\.stopPropagation\(\);/);
  assert.match(WAND, /addEventListener\('drop', \(e\) => \{[\s\S]*?e\.stopPropagation\(\);/);
  assert.match(WAND, /wandDisplay\.moveMsg\(/);
});

test('typing in the search box updates only the skill list, so the box keeps its focus', () => {
  assert.match(WAND, /wand-skill-list/);
  assert.match(WAND, /wandDisplay\.skillListHtml\(/);
});

test('the probe page answers every wand action the shell lets through', () => {
  for (const a of ['wandState', 'wandClick', 'wandSetField', 'wandDrag', 'wandFocus', 'wandKey']) {
    assert.ok(RAW.includes(`case '${a}':`), `renderer.js must answer ${a}`);
  }
});

test('D3: a click is judged against the tab\'s own column count', () => {
  assert.match(WAND, /wandDisplay\.clickPlan\(wandState, action\.id, \{ cols: term\.cols \}\)/);
  assert.match(WAND, /plan\.kind === 'missing' \|\| plan\.kind === 'toolong'/);
});

// --- Dexter D8: one typing sequence at a time per tab, for every caller --------------------------------------

const LF = RAW.replace(/\r\n/g, '\n');
function typeAndCheckSource() {
  const start = LF.indexOf('function typeAndCheck(');
  return LF.slice(start, LF.indexOf('\n}\n', start) + 2);
}

function loadTypeAndCheck() {
  const src = typeAndCheckSource();
  const sent = [];
  const timers = [];
  const env = {
    typingKeys: (command) => ['\x05', '\x15', command],
    send: (s) => sent.push(JSON.parse(s).data),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    commandTyped: () => true, screenLines: () => [], vimSeen: false, PTY_STEP_MS: 120,
  };
  const factory = new Function(...Object.keys(env), 'let typingBusy = false;\n' + src + '\nreturn typeAndCheck;');
  return { typeAndCheck: factory(...Object.values(env)), sent, timers };
}

test('D8: while one command is being typed, any other caller (top bar, Git drawer, wand) is refused and sends no key', () => {
  const { typeAndCheck, sent, timers } = loadTypeAndCheck();
  const results = [];
  typeAndCheck(false, '/effort high', (r) => results.push(['first', r]));
  const keysAfterFirst = timers.length;
  typeAndCheck(false, '/bedtime', (r) => results.push(['second', r]));
  assert.strictEqual(timers.length, keysAfterFirst, 'the second schedules no keystroke');
  assert.deepStrictEqual(sent, [], 'and sent none');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0][0], 'second');
  assert.strictEqual(results[0][1].ok, false);
  assert.match(results[0][1].reason, /still being typed/);
});

test('D8: the lock is released when the first command is confirmed, so the next can be typed', () => {
  const { typeAndCheck, timers } = loadTypeAndCheck();
  const results = [];
  typeAndCheck(false, '/effort high', (r) => results.push(r));
  for (const t of timers.splice(0)) t.fn();                       // run the spaced keys and the read-back
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].ok, true);
  typeAndCheck(false, '/bedtime', (r) => results.push(r));
  assert.ok(timers.length > 0, 'a second command is typed once the first is done');
});

test('D8: the lock is released when the read-back FAILS too, or one failure would block typing for good', () => {
  const src = typeAndCheckSource();
  const timers = [];
  const env = { typingKeys: (c) => [c], send() {}, setTimeout: (fn) => { timers.push(fn); }, commandTyped: () => false, screenLines: () => [], vimSeen: false, PTY_STEP_MS: 1 };
  const typeAndCheck = new Function(...Object.keys(env), 'let typingBusy = false;\n' + src + '\nreturn typeAndCheck;')(...Object.values(env));
  const out = [];
  typeAndCheck(false, '/a', (r) => out.push(r));
  while (timers.length) timers.shift()();
  assert.strictEqual(out[0].ok, false);
  typeAndCheck(false, '/b', (r) => out.push(r));
  assert.ok(timers.length > 0, 'typing works again after a failed one');
});

test('I2: a Reset click goes out through wandSend', () => {
  assert.match(WAND, /action\.kind === 'reset'/);
  assert.match(WAND, /wandDisplay\.resetMsg\(wandState\)/);
});

// --- Miguel I3 / I4 ---------------------------------------------------------------------------------------------

test('I4: Enter in the skill SEARCH box does nothing (it must not save the editor); Enter in the other fields saves', () => {
  const at = WAND.indexOf("addEventListener('keydown'");
  assert.ok(at !== -1);
  const handler = WAND.slice(at, WAND.indexOf('addEventListener(', at + 10));
  assert.match(handler, /if \(e\.target\.dataset\.wandField === 'query'\) \{ if \(e\.key === 'Enter'\) e\.preventDefault\(\); return; \}/);
  assert.match(handler, /e\.key === 'Enter'[\s\S]*wandAct\(\{ kind: 'save' \}\)/);
  assert.ok(handler.indexOf("=== 'query'") < handler.indexOf("wandAct({ kind: 'save' })"), 'the query check comes first');
});

test('I3: Alt+Left / Alt+Right on a focused favourite in edit mode move it, through wandSend', () => {
  assert.match(WAND, /e\.altKey && \(e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\)/);
  assert.match(WAND, /wandDisplay\.moveStepMsg\(wandState, action\.id, action\.dir\)/);
});

test('I3: focus survives a rebuild: any control is found again, and an opened editor takes focus', () => {
  const body = fnBody('renderWand');
  assert.match(body, /wandFocusKey\(document\.activeElement\)/);
  assert.match(body, /wandFindFocus\(/);
  assert.match(body, /wandFocusEditor/);
  assert.match(WAND, /wandFocusEditor = true/);
});

test('I3: the status is announced from a node OUTSIDE the rebuilt subtree', () => {
  assert.match(HTML, /<div id="wand-live"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(HTML.indexOf('id="wand-root"') < HTML.indexOf('id="wand-live"'));
  const root = HTML.slice(HTML.indexOf('<div id="wand-root">'), HTML.indexOf('id="wand-live"')).replace(/<!--[\s\S]*?-->/g, '');
  assert.match(root, /<\/div>\s*<div $/, 'the live region is a sibling of the root, not inside it');
  assert.match(fnBody('renderWand'), /getElementById\('wand-live'\)/);
  assert.match(fnBody('renderWand'), /\.textContent = v\.live/);
});

// --- #61: the type-only checkbox and the name under the emoji ----------------------------------------------

test('#61 the editor\'s type-only checkbox goes to editorSet as a boolean, every other field as its text', () => {
  const at = WAND.indexOf("addEventListener('input'");
  assert.ok(at !== -1);
  const handler = WAND.slice(at, WAND.indexOf('addEventListener(', at + 10));
  assert.match(handler, /editorSet\(wandState, field, e\.target\.type === 'checkbox' \? e\.target\.checked : e\.target\.value\)/);
});

test('#61 the page styles the name under the emoji: one line, ellipsis past the cell', () => {
  const css = HTML.slice(HTML.indexOf('.wand-name {'), HTML.indexOf('}', HTML.indexOf('.wand-name {')));
  assert.match(css, /text-overflow: ellipsis/);
  assert.match(css, /white-space: nowrap/);
  assert.match(css, /overflow: hidden/);
});

// --- #61: submitTyped / typeCommand, run for real against stubs -------------------------------------------------

function loadTypeCommand({ turn, readBack = true, screen = 'ready', connected = true }) {
  const sent = [];
  const order = [];
  const { planTyping } = require('../app/top-bar-display');
  const { planSubmit } = require('../app/submit-gate');
  const env = {
    term: { focus() {} },
    screenLines: () => [],
    vimInsertShown: () => false,
    inputState: () => screen,
    boxText: () => 'draft',
    planTyping,
    ws: { readyState: 1 },
    WebSocket: { OPEN: 1 },
    submitGate: { planSubmit },
    send: (m) => { const d = JSON.parse(m).data; sent.push(d); order.push('send:' + JSON.stringify(d)); },
    typeAndCheck: (_enter, _command, cb) => { order.push('typed'); cb(readBack ? { ok: true } : { ok: false, reason: 'the input line changed before it could be confirmed' }); },
    get sessionTurn() { return turn; },
  };
  const names = Object.keys(env).filter(k => k !== 'sessionTurn');
  const src = fnSource('submitTyped') + '\n' + fnSource('typeCommand');
  const factory = new Function(...names, 'sessionTurn', 'let vimSeen = false;\n' + src + '\nreturn { typeCommand, submitTyped };');
  return { ...factory(...names.map(k => env[k]), turn), sent, order };
}

function fnSource(name) {
  const start = LF.indexOf(`function ${name}(`);
  assert.ok(start !== -1, name);
  return LF.slice(start, LF.indexOf('\n}\n', start) + 2);
}

const run = (h, command, opts, kind) => { let out; h.typeCommand(command, (r) => { out = r; }, kind, opts); return out; };

test('#61 submit on, idle, not type-only: the box was read back, the CR goes in, the answer says sent', () => {
  const h = loadTypeCommand({ turn: 'idle' });
  const r = run(h, '/merged', { submit: true, typeOnly: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.submitted, true);
  assert.strictEqual(r.flash, 'sent');
  assert.deepStrictEqual(h.sent, ['\r']);
  assert.deepStrictEqual(h.order, ['typed', 'send:"\\r"'], 'the CR is after the read-back, in the same call');
});

test('#61 submit on, mid-turn: the CR goes in anyway (the CLI queues it) and the flash says queued', () => {
  const h = loadTypeCommand({ turn: 'turn' });
  const r = run(h, '/checkpoint', { submit: true, typeOnly: false });
  assert.deepStrictEqual(h.sent, ['\r']);
  assert.match(r.flash, /^queued:/);
});

test('#61 a type-only favourite, or an unseen session, types and sends NO CR', () => {
  for (const [turn, typeOnly] of [['idle', true], ['turn', true], [null, false], [null, true]]) {
    const h = loadTypeCommand({ turn });
    const r = run(h, '/x', { submit: true, typeOnly });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.submitted, false, `${turn}/${typeOnly}`);
    assert.strictEqual(r.flash, 'typed, press Enter');
    assert.deepStrictEqual(h.sent, [], `${turn}/${typeOnly}`);
  }
});

test('#61 a dialog (prompt) is refused BEFORE anything is typed, type-only or not', () => {
  for (const typeOnly of [false, true]) {
    const h = loadTypeCommand({ turn: 'prompt' });
    const r = run(h, '/x', { submit: true, typeOnly });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /dialog/);
    assert.deepStrictEqual(h.order, [], 'nothing typed, nothing sent');
  }
});

test('#61 a read-back that fails sends no CR, whatever the state', () => {
  for (const turn of ['idle', 'turn']) {
    const h = loadTypeCommand({ turn, readBack: false });
    const r = run(h, '/x', { submit: true, typeOnly: false });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(h.sent, [], turn);
  }
});

test('#61 without submit (the reader\'s @mention) nothing is ever submitted, and the answer is the old one', () => {
  for (const turn of ['idle', 'turn', null]) {
    const h = loadTypeCommand({ turn });
    const r = run(h, '@file#L1', undefined, 'mention');
    assert.deepStrictEqual(r, { ok: true, box: 'draft' });
    assert.deepStrictEqual(h.sent, []);
  }
});

test('#61 the Git drawer\'s type-command carries submit; only a literal true turns it on, typeOnly is off for /merged', () => {
  const at = RAW.indexOf('window.harness.onTypeCommand((ask) => {');
  assert.ok(at !== -1);
  const body = RAW.slice(at, RAW.indexOf('\n  });', at));
  assert.match(body, /ask && ask\.submit === true \? \{ submit: true, typeOnly: false \} : undefined/);
  assert.match(body, /window\.harness\.typed\(\{ id, \.\.\.r \}\)/);
});
