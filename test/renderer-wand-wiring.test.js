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

test('#61 the only CR in the typeCommand path is pressEnter\'s, reached only through submitTyped\'s gate', () => {
  const t = fnBody('typeCommand');
  assert.match(t, /typeAndCheck\(plan\.enterInsert, command,/);
  assert.doesNotMatch(t, /\\r/, 'typeCommand writes no CR itself');
  assert.match(t, /submitTyped\(/);
  const sub = fnBody('submitTyped');
  assert.match(sub, /submitGate\.planSubmit\(\{ turn: sessionTurn, typeOnly \}\)/);
  assert.doesNotMatch(sub, /\\r/, 'submitTyped decides; it writes nothing');
  assert.match(sub, /if \(!gate\.enter\) \{[^\n]*return;/, 'a gate that says no ends it before any Enter');
  const press = fnBody('pressEnter');
  assert.strictEqual((press.match(/\\r/g) || []).length, 1, 'exactly one CR');
  assert.match(press, /ws\.readyState !== WebSocket\.OPEN/, 'and it is not reported sent when the socket is not open');
  // no other function the wand or the drawer reach writes one: typePlanned (the top bar) is the only other
  assert.strictEqual([...JS.matchAll(/data: '\\r'|input\('\\r'\)/g)].length, 2, 'typePlanned (top bar) and pressEnter, nothing else');
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

// A virtual clock for the submit path: setTimeout is injected, so nothing here sleeps (F1's 400 ms, F7's window).
function loadTypeCommand({ turn, readBack = true, screen = 'ready', connected = true, queued = false, retype = null }) {
  const sent = [];
  const order = [];
  const timers = [];
  let now = 0;
  // A stub, not app/top-bar-display.js: that module is mutated, and a test that requires it must be in Stryker's
  // command (test/stryker-config.test.js); this file is repo-scanning and deliberately is not.
  const planTyping = ({ command, screen: sc, connected: c }) => (typeof command === 'string' && c && sc === 'ready'
    ? { ok: true, enterInsert: false } : { ok: false, reason: 'a dialog is open in the terminal; answer it or press Esc first' });
  const gate = require('../app/submit-gate');
  const apiRef = {};
  const state = { turn, screen, queued, lineOk: true, ws: { readyState: connected ? 1 : 3 } };
  const env = {
    term: { focus() {} },
    screenLines: () => (state.queued ? ['❯ /x', '❯ Press up to edit queued messages'] : ['❯ /x']),
    vimInsertShown: () => false,
    inputState: () => state.screen,
    boxText: () => 'draft',
    // the line is in the box until the Enter goes in, unless the CLI swallowed that Enter (its backslash newline, a suggestion list)
    commandTyped: () => state.lineOk && (state.enterSwallowed || !sent.includes('\r')),
    planTyping,
    WebSocket: { OPEN: 1 },
    submitGate: gate,
    send: (m) => { const d = JSON.parse(m).data; sent.push(d); order.push('send:' + JSON.stringify(d)); },
    setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); },
    PTY_STEP_MS: 120,
    typeAndCheck: (_enter, _command, cb) => {
      order.push('typed');
      if (retype) retype(apiRef, state);
      cb(readBack ? { ok: true } : { ok: false, reason: 'the input line changed before it could be confirmed' });
    },
  };
  const names = Object.keys(env);
  const consts = ['SUBMIT_RECHECK_MS', 'QUEUED_POLL_MS', 'QUEUED_POLLS'].map(constSource).join('\n');
  const src = [fnSource('typeCommand'), fnSource('submitTyped'), fnSource('pressEnter'), fnSource('watchQueued'), fnSource('clearTypedLine')].join('\n');
  const body = `${consts}\nlet vimSeen = false;\nlet typingBusy = false;\nlet sessionTurn = __state.turn;\nlet ws = __state.ws;\n`
    + `${src}\nreturn { typeCommand, busy: () => typingBusy, setTurn: (t) => { sessionTurn = t; }, setBusy: (b) => { typingBusy = b; } };`;
  const factory = new Function('__state', ...names, body);
  const api = factory(state, ...names.map(k => env[k]));
  Object.assign(apiRef, api);
  // advance the virtual clock, running every timer that comes due (including ones they schedule)
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = end;
  };
  return { ...api, sent, order, state, advance, pending: () => timers.length };
}

function fnSource(name) {
  const start = LF.indexOf(`function ${name}(`);
  assert.ok(start !== -1, name);
  return LF.slice(start, LF.indexOf('\n}\n', start) + 2);
}
function constSource(name) {
  const m = LF.match(new RegExp(`^const ${name} = [^;]+;`, 'm'));
  assert.ok(m, name);
  return m[0];
}

const run = (h, command, opts, kind) => {
  const out = { r: null };
  h.typeCommand(command, (r) => { out.r = r; }, kind, opts);
  return out;
};
const SUBMIT = { submit: true, typeOnly: false };

test('#61 idle: the CR goes in at the read-back, in the same call; the flash waits for the screen and says "sent"', () => {
  const h = loadTypeCommand({ turn: 'idle' });
  const out = run(h, '/merged', SUBMIT);
  assert.deepStrictEqual(h.order, ['typed', 'send:"\\r"'], 'the CR is after the read-back, with no timer between');
  assert.strictEqual(out.r, null, 'not answered yet: the page is looking at the screen');
  h.advance(2000);
  assert.deepStrictEqual(out.r, { ok: true, box: 'draft', submitted: true, flash: 'sent' });
  assert.deepStrictEqual(h.sent, ['\r']);
});

test('F7: the flash says "queued" only when the CLI\'s own queued-messages line shows within the window; else "sent"', () => {
  const queued = loadTypeCommand({ turn: 'idle', queued: true });
  const q = run(queued, '/x', SUBMIT);
  queued.advance(2000);
  assert.strictEqual(q.r.flash, "queued: Claude runs it when it's free");
  assert.strictEqual(q.r.submitted, true);
  const plain = loadTypeCommand({ turn: 'idle' });
  const p = run(plain, '/x', SUBMIT);
  plain.advance(2000);
  assert.strictEqual(p.r.flash, 'sent');
  // the line shows up late but inside the window
  const late = loadTypeCommand({ turn: 'idle' });
  const l = run(late, '/x', SUBMIT);
  late.advance(300);
  late.state.queued = true;
  late.advance(2000);
  assert.strictEqual(l.r.flash, "queued: Claude runs it when it's free");
});

test('F7: the hook state no longer decides the words: a running turn whose screen shows no queued line says "sent"', () => {
  const h = loadTypeCommand({ turn: 'turn' });
  const out = run(h, '/x', SUBMIT);
  h.advance(5000);
  assert.strictEqual(out.r.flash, 'sent');
});

test('F1: mid-turn, NO CR at the read-back; ~400 ms later, with the line still typed and no dialog, the CR goes in', () => {
  const h = loadTypeCommand({ turn: 'turn', queued: true });
  const out = run(h, '/x', SUBMIT);
  assert.deepStrictEqual(h.sent, [], 'not at the read-back');
  assert.strictEqual(h.busy(), true, 'and nobody else may type while we wait');
  h.advance(399);
  assert.deepStrictEqual(h.sent, [], 'not before the wait is over');
  h.advance(1);
  assert.deepStrictEqual(h.sent, ['\r']);
  assert.strictEqual(h.busy(), false);
  h.advance(2000);
  assert.strictEqual(out.r.submitted, true);
});

test('F1: a dialog opens during the wait (the host says prompt): no CR, the line is cleared, and the answer is a refusal', () => {
  const h = loadTypeCommand({ turn: 'turn' });
  const out = run(h, '/x', SUBMIT);
  h.advance(200);
  h.setTurn('prompt');
  h.advance(300);
  assert.deepStrictEqual(h.sent.filter(d => d === '\r'), [], 'no Enter');
  h.advance(1000);
  assert.deepStrictEqual(h.sent, ['\x05', '\x15'], 'the typed line is cleared, as a failed read-back clears it');
  assert.strictEqual(out.r.ok, false);
  assert.match(out.r.reason, /nothing was sent/);
  assert.strictEqual(h.busy(), false);
});

test('F1: the screen no longer shows exactly the command after the wait (a dialog drawn over it): no CR, cleared, refused', () => {
  const h = loadTypeCommand({ turn: 'turn' });
  const out = run(h, '/x', SUBMIT);
  h.state.lineOk = false;
  h.advance(2000);
  assert.deepStrictEqual(h.sent, ['\x05', '\x15']);
  assert.strictEqual(out.r.ok, false);
  assert.match(out.r.reason, /nothing was sent/);
});

test('F1: the re-check only applies in a running turn: idle sends at once even if the screen changes later', () => {
  const h = loadTypeCommand({ turn: 'idle' });
  run(h, '/x', SUBMIT);
  assert.deepStrictEqual(h.sent, ['\r']);
  assert.strictEqual(h.pending(), 1, 'only the queued-line look is scheduled');
});

test('F3: the host says prompt but the screen shows a ready box: typed with NO Enter, and the hint is the flash', () => {
  for (const typeOnly of [false, true]) {
    const h = loadTypeCommand({ turn: 'prompt' });
    const out = run(h, '/x', { submit: true, typeOnly });
    h.advance(3000);
    assert.deepStrictEqual(h.sent, [], `typeOnly ${typeOnly}`);
    assert.deepStrictEqual(out.r, { ok: true, box: 'draft', submitted: false, flash: "Claude may be waiting on you: press Enter if it's free" });
  }
});

test('F3: the host says prompt AND the screen shows a dialog: refused before a key is typed, as before', () => {
  const h = loadTypeCommand({ turn: 'prompt', screen: 'dialog' });
  const out = run(h, '/x', SUBMIT);
  assert.strictEqual(out.r.ok, false);
  assert.match(out.r.reason, /dialog/);
  assert.deepStrictEqual(h.order, [], 'nothing typed, nothing sent');
});

test('Dexter M3: a dialog opening between the click and the read-back (idle -> prompt) never gets a CR', () => {
  const h = loadTypeCommand({ turn: 'idle', retype: (api) => api.setTurn('prompt') });
  const out = run(h, '/x', SUBMIT);
  h.advance(3000);
  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(out.r.submitted, false);
  assert.match(out.r.flash, /waiting on you/);
});

test('Dexter F6 / Miguel M1: a socket that is not OPEN when the CR would go is "not sent", never "sent"', () => {
  for (const turn of ['idle', 'turn']) {
    // CLOSING at the read-back (idle: the CR would go now) ...
    const h = loadTypeCommand({ turn, retype: (_api, st) => { st.ws.readyState = 2; } });
    const out = run(h, '/x', SUBMIT);
    h.advance(3000);
    assert.deepStrictEqual(h.sent, [], turn);
    assert.strictEqual(out.r.ok, false, turn);
    assert.match(out.r.reason, /not connected/, turn);
  }
  // ... and for a running turn, closing during the wait
  const w = loadTypeCommand({ turn: 'turn' });
  const out = run(w, '/x', SUBMIT);
  w.advance(100);
  w.state.ws.readyState = 3;
  w.advance(3000);
  assert.deepStrictEqual(w.sent, [], 'no CR, and no clear either: a dead socket takes nothing');
  assert.strictEqual(out.r.ok, false);
});

test('a type-only favourite, or an unseen session, types and sends NO CR, flash "typed, press Enter"', () => {
  for (const [turn, typeOnly] of [['idle', true], ['turn', true], [null, false], [null, true]]) {
    const h = loadTypeCommand({ turn });
    const out = run(h, '/x', { submit: true, typeOnly });
    h.advance(3000);
    assert.strictEqual(out.r.ok, true);
    assert.strictEqual(out.r.submitted, false, `${turn}/${typeOnly}`);
    assert.strictEqual(out.r.flash, 'typed, press Enter');
    assert.deepStrictEqual(h.sent, [], `${turn}/${typeOnly}`);
  }
});

test('a read-back that fails sends no CR, whatever the state', () => {
  for (const turn of ['idle', 'turn']) {
    const h = loadTypeCommand({ turn, readBack: false });
    const out = run(h, '/x', SUBMIT);
    h.advance(3000);
    assert.strictEqual(out.r.ok, false);
    assert.deepStrictEqual(h.sent, [], turn);
  }
});

test('without submit (the reader\'s @mention) nothing is ever submitted, and the answer is the old one', () => {
  for (const turn of ['idle', 'turn', null]) {
    const h = loadTypeCommand({ turn });
    const out = run(h, '@file#L1', undefined, 'mention');
    assert.deepStrictEqual(out.r, { ok: true, box: 'draft' });
    assert.deepStrictEqual(h.sent, []);
    assert.strictEqual(h.pending(), 0);
  }
});

test('#61 the Git drawer\'s type-command carries submit; only a literal true turns it on, typeOnly is off for /merged', () => {
  const at = RAW.indexOf('window.harness.onTypeCommand((ask) => {');
  assert.ok(at !== -1);
  const body = RAW.slice(at, RAW.indexOf('\n  });', at));
  assert.match(body, /ask && ask\.submit === true \? \{ submit: true, typeOnly: false \} : undefined/);
  assert.match(body, /window\.harness\.typed\(\{ id, \.\.\.r \}\)/);
});

test('#61 the type-only checkbox is not stretched by `.wand-ed-row input { flex: 1 }` (it was invisible in the first probe screenshot)', () => {
  const rule = HTML.match(/\.wand-ed-row\.wand-ed-check input \{[^}]*\}/);
  assert.ok(rule, 'a rule that is more specific than .wand-ed-row input');
  assert.match(rule[0], /flex: 0 0 auto/);
});

test('Dexter F5: a flash that carries the cleared-draft note stays up longer (8 s) than a plain one (2.5 s)', () => {
  const body = fnBody('wandType');
  assert.match(body, /wandState\.flash && wandState\.flash\.long \? 8000 : 2500/);
});

test('PR #125 Dexter #1/#4: an Enter the CLI swallowed (the box still holds the line) is NOT reported as sent; the line is cleared', () => {
  const h = loadTypeCommand({ turn: 'idle' });
  h.state.enterSwallowed = true;
  const out = run(h, '/x', SUBMIT);
  h.advance(2000);
  assert.strictEqual(out.r.ok, false);
  assert.match(out.r.reason, /did not take the Enter, so nothing was sent/);
  assert.ok(h.sent.includes(String.fromCharCode(5)) && h.sent.includes(String.fromCharCode(21)), 'the leftover line is cleared (Ctrl-E, Ctrl-U)');
});

test('PR #125 Dexter #1/#4: an Enter that emptied the box is still "sent" (the check does not cry wolf)', () => {
  const h = loadTypeCommand({ turn: 'idle' });
  const out = run(h, '/x', SUBMIT);
  h.advance(2000);
  assert.strictEqual(out.r.ok, true);
  assert.strictEqual(out.r.flash, 'sent');
});
