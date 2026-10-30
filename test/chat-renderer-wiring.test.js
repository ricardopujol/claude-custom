'use strict';
/**
 * The renderer's half of the chat view (BACKLOG #157): source assertions in the style of test/host-bar-wiring.test.js, because
 * renderer.js can't be loaded by a unit test, plus the one thing no unit test of a single module can see: the trap in
 * CLAUDE.md ("anything loaded as a plain <script> shares ONE global scope"). The new scripts are run here, in order, in ONE
 * vm context with the scripts that precede them, the way the page loads them.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app');
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const HTML = read('renderer.html');
const RENDERER = read('renderer.js');
const SCRIPTS = ['paste-action.js', 'chat-blocks.js', 'chat-view-state.js', 'chat-display.js'];

test('the page loads the chat scripts after paste-action.js and before renderer.js', () => {
  const at = (f) => HTML.indexOf(`<script src="./${f}"></script>`);
  for (const f of SCRIPTS) assert.ok(at(f) !== -1, f);
  assert.ok(at('paste-action.js') < at('chat-blocks.js') && at('chat-blocks.js') < at('chat-view-state.js') && at('chat-view-state.js') < at('chat-display.js'));
  assert.ok(at('chat-display.js') < at('renderer.js'));
});

test('run together as plain scripts in one global scope, they declare nothing global but their own names', () => {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  ctx.globalThis = ctx;
  const before = new Set(Object.getOwnPropertyNames(ctx));
  for (const f of SCRIPTS) vm.runInContext(read(f), ctx, { filename: f });
  const added = Object.getOwnPropertyNames(ctx).filter(k => !before.has(k)).sort();
  assert.deepStrictEqual(added, ['chatDisplay', 'chatBlocks', 'chatViewState', 'pasteAction', 'pasteFailureNote', 'pasteFrame', 'copyKeyAction', 'isPasteKey', 'selectionVisible'].sort());
  // top-level const/let would not show as properties: they would collide in the page, so the files must be wrapped
  for (const f of SCRIPTS.slice(1)) assert.match(read(f).replace(/^(?:\s*\/\/.*\n|\s*\/\*[\s\S]*?\*\/\s*|'use strict';\s*)*/, ''), /^\(function \(root\) \{/, `${f} is an IIFE`);
  // and the view-state module finds paste-action's pasteFrame through that shared scope, as in the page
  const plan = ctx.chatViewState.planChatSend('a\nb', { bracketed: true });
  assert.strictEqual(JSON.parse(plan[0].frame).data, '\x1b[200~a\rb\x1b[201~');
});

test('the page holds every element the renderer wires', () => {
  for (const id of ['chat-btn', 'chat-view', 'chat-log', 'chat-working', 'chat-flip', 'chat-form', 'chat-input', 'chat-show-tools']) {
    assert.match(HTML, new RegExp(`id="${id}"`), id);
  }
  assert.match(HTML, /<div id="chat-view"[^>]*\bhidden\b/, 'hidden until the switch is on');
  assert.match(HTML, /<textarea id="chat-input"/, 'a textarea: model text never goes near it as HTML, and Shift+Enter is a new line');
});

test('the chat sits over the terminal, below the banners and the lock overlay, and never changes the terminal\'s size', () => {
  const css = HTML.slice(HTML.indexOf('#chat-view {'), HTML.indexOf('#chat-view {') + 300);
  assert.match(css, /position: absolute; inset: 0; z-index: 14;/);
  assert.match(HTML, /#lock-overlay \{\s*position: absolute; inset: 0; z-index: 20;/);
  assert.doesNotMatch(RENDERER.slice(RENDERER.indexOf('function chatRefreshView()'), RENDERER.indexOf('function chatToggle()')), /fit\.fit|sendResize|display = 'none'/);
});

test('the host\'s conversation reaches the page in hello and on every change', () => {
  assert.match(RENDERER, /chatApply\(msg\.chat\);\s+\/\/ BACKLOG #157/);
  assert.match(RENDERER, /if \(msg\.type === 'chat'\) \{\s+chatApply\(msg\.chat\);\s+return;\s+\}/);
});

test('everything that can change which display shows repaints it', () => {
  const turn = RENDERER.slice(RENDERER.indexOf("if (msg.type === 'turn') {"), RENDERER.indexOf("if (msg.type === 'chat') {"));
  assert.match(turn, /chatRefreshView\(\);/);
  const prog = RENDERER.slice(RENDERER.indexOf('function applyProgramStatus('), RENDERER.indexOf('function applyProgramStatus(') + 900);
  assert.match(prog, /chatRefreshView\(\);/);
  assert.match(RENDERER, /sessionTurn = null; paintBar\(\); reportTabStatus\(\); chatRefreshView\(\);/);
});

test('the switch is remembered per tab folder and hidden on a plain shell tab', () => {
  assert.match(RENDERER, /chatViewState\.readWanted\(chatStore, CWD\)/);
  assert.match(RENDERER, /chatViewState\.writeWanted\(chatStore, CWD, chatWanted\)/);
  assert.match(RENDERER, /chatBtn\.hidden = shell;/);
  assert.match(RENDERER, /wanted: chatWanted && !shell/);
});

test('the type box is runChatSend: text through userInput (the occupancy confirm), with the CLI\'s own bracketed-paste mode, read back before Enter', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function chatSend('), RENDERER.indexOf('// Repaints which display shows.'));
  assert.match(fn, /chatViewState\.runChatSend\(text, \{/);
  assert.match(fn, /bracketed: \(\) => term\.modes\.bracketedPasteMode/);
  assert.match(fn, /type: \(frame\) => userInput\(frame\)/);
  assert.match(fn, /sync: \(\) => new Promise\(\(resolve\) => term\.write\(''/, 'every read waits for the screen to be parsed');
  assert.match(fn, /inputState, commandTyped, boxText, boxHoldsLine/);
  assert.match(fn, /hostKind === 'shell'/);
  assert.doesNotMatch(fn, /\\r|'\\x0d'/, 'the page never writes an Enter itself: the sequence does, after the read-back');
});

test('Ctrl+Shift+H is decided in the terminal\'s key handler AND a document listener, and is in the shortcuts table', () => {
  const handler = RENDERER.slice(RENDERER.indexOf('term.attachCustomKeyEventHandler('), RENDERER.indexOf('term.attachCustomKeyEventHandler(') + 800);
  assert.match(handler, /chatViewState\.isChatKey\(e\)\) \{ e\.preventDefault\(\); chatToggle\(\); return false; \}/);
  assert.match(RENDERER, /document\.addEventListener\('keydown', \(e\) => \{\s+if \(e\.defaultPrevented \|\| !chatViewState\.isChatKey\(e\)\) return;/);
  const table = read('shortcut-table.js');
  assert.match(table, /'Hide tool lines[^']*', \['Ctrl', 'Shift', 'H'\], 'isChatKey\(e\)'/);
});

test('links and copies go through the bridge the page already has', () => {
  assert.match(RENDERER, /copy: \(text\) => \(window\.harness && window\.harness\.writeClipboard \? window\.harness\.writeClipboard\(text\)/);
  assert.match(RENDERER, /window\.harness\.openExternal\(href\)/);
});
