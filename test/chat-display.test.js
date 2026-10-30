'use strict';
/**
 * The chat view's DOM (app/chat-display.js) driven with a jsdom window. The security claim is checked here, not only in the
 * real window: hostile model text becomes text nodes, never elements, and nothing in the file can parse HTML at all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { JSDOM } = require('jsdom');

const { create } = require('../app/chat-display');

function setup(over = {}) {
  const win = new JSDOM('<!doctype html><body><div id="root"><div id="log"></div><div id="working"></div><form id="form"><textarea id="input"></textarea></form></div><div id="flip"></div></body>').window;
  const d = win.document;
  const els = { root: d.getElementById('root'), log: d.getElementById('log'), working: d.getElementById('working'), flip: d.getElementById('flip'), form: d.getElementById('form'), input: d.getElementById('input') };
  const copied = [];
  const opened = [];
  const sent = [];
  const timers = [];
  const view = create({
    doc: d, els,
    copy: async (t) => { copied.push(t); return over.copyResult || { ok: true }; },
    openLink: (h) => opened.push(h),
    send: async (t) => { sent.push(t); return over.sendResult || { ok: true }; },
    later: (fn) => timers.push(fn),
  });
  return { win, d, els, view, copied, opened, sent, timers };
}
const msgs = (...ms) => ms.map((m, i) => ({ id: i + 1, truncated: false, ...m }));
const show = { show: 'chat', note: null };
const tick = () => new Promise(r => setImmediate(r));

test('the log shows "You" and "Claude" bubbles, and nothing else', () => {
  const { view, els } = setup();
  view.update({ messages: msgs({ role: 'user', text: 'hi there' }, { role: 'assistant', text: 'Hello **friend**' }), working: false, view: show });
  const bubbles = [...els.log.querySelectorAll('.chat-msg')];
  assert.deepStrictEqual(bubbles.map(b => b.querySelector('.chat-who').textContent), ['You', 'Claude']);
  assert.strictEqual(bubbles[0].querySelector('.chat-text').textContent, 'hi there');
  assert.strictEqual(bubbles[1].querySelector('strong').textContent, 'friend');
});

test('the root shows only for the chat view; the flip note shows with the terminal', () => {
  const { view, els } = setup();
  view.update({ messages: [], working: false, view: show });
  assert.strictEqual(els.root.hidden, false);
  assert.strictEqual(els.flip.hidden, true);
  view.update({ messages: [], working: false, view: { show: 'terminal', note: 'Claude needs you here.' } });
  assert.strictEqual(els.root.hidden, true);
  assert.strictEqual(els.flip.hidden, false);
  assert.strictEqual(els.flip.textContent, 'Claude needs you here.');
});

test('"Claude is working" shows only in the chat view, only while a turn is open', () => {
  const { view, els } = setup();
  view.update({ messages: [], working: true, view: show });
  assert.strictEqual(els.working.hidden, false);
  view.update({ messages: [], working: false, view: show });
  assert.strictEqual(els.working.hidden, true);
  view.update({ messages: [], working: true, view: { show: 'terminal', note: null } });
  assert.strictEqual(els.working.hidden, true);
});

test('an empty chat says what it will hold', () => {
  const { view, els } = setup();
  view.update({ messages: [], working: false, view: show });
  assert.match(els.log.querySelector('.chat-empty').textContent, /without the tool lines/);
});

test('Copy on a fenced block copies exactly its text, and says Copied then goes back', async () => {
  const { view, els, copied, timers } = setup();
  view.update({ messages: msgs({ role: 'assistant', text: 'Run:\n\n```bash\nnpm test\n```' }), working: false, view: show });
  const btn = els.log.querySelector('.chat-codeblock .chat-copy');
  btn.click();
  await tick();
  assert.deepStrictEqual(copied, ['npm test']);
  assert.strictEqual(btn.textContent, 'Copied');
  timers.forEach(f => f());
  assert.strictEqual(btn.textContent, 'Copy');
});

test('a refused copy says so', async () => {
  const { view, els } = setup({ copyResult: { ok: false, error: 'locked' } });
  view.update({ messages: msgs({ role: 'assistant', text: '```\nx\n```' }), working: false, view: show });
  const btn = els.log.querySelector('.chat-copy');
  btn.click();
  await tick();
  assert.match(btn.textContent, /couldn.t copy/i);
});

test('Copy reply copies the whole message as written', async () => {
  const { view, els, copied } = setup();
  const text = 'Here:\n\n> quoted\n\n`git status`';
  view.update({ messages: msgs({ role: 'assistant', text }), working: false, view: show });
  const btn = els.log.querySelector('.chat-copy-reply');
  assert.strictEqual(btn.textContent, 'Copy reply');
  btn.click();
  await tick();
  assert.deepStrictEqual(copied, [text]);
});

test('quotes, drafts and command or path code each get their own Copy; a plain word does not', async () => {
  const { view, els, copied } = setup();
  const text = 'Reply to paste:\n\nHi Sam, thanks.\n\n> Quoted line\n\nUse `git log` in `C:\\x\\y` not `foo`.';
  view.update({ messages: msgs({ role: 'assistant', text }), working: false, view: show });
  assert.strictEqual(els.log.querySelectorAll('.chat-draft .chat-copy').length, 1);
  assert.strictEqual(els.log.querySelectorAll('.chat-quotebox > .chat-copy').length, 1);
  assert.strictEqual(els.log.querySelectorAll('.chat-copy-inline').length, 2);
  els.log.querySelector('.chat-draft .chat-copy').click();
  els.log.querySelector('.chat-quotebox > .chat-copy').click();
  [...els.log.querySelectorAll('.chat-copy-inline')].forEach(b => b.click());
  await tick();
  assert.deepStrictEqual(copied, ['Hi Sam, thanks.', 'Quoted line', 'git log', 'C:\\x\\y']);
});

test('hostile model text is text, never an element', () => {
  const { view, els, win } = setup();
  const hostile = [
    '<script>window.__x = 1</script>', '<img src=x onerror="window.__x = 2">', '<iframe src="https://e"></iframe>',
    '[click](javascript:window.__x = 3)', '<a href="javascript:window.__x=4" onclick="window.__x=5">a</a>', '**<b onmouseover=1>bold</b>**',
    '| <svg onload=1> |\n|---|\n| <style>x</style> |', '`<img src=x onerror=1>`', '```\n<script>1</script>\n```', '> <form action=x><input name=q></form>',
  ].join('\n\n');
  view.update({ messages: msgs({ role: 'assistant', text: hostile }, { role: 'user', text: '<img src=x onerror=1>' }), working: false, view: show });
  assert.strictEqual(els.log.querySelectorAll('script, img, iframe, svg, style, form, input, b, object, embed').length, 0);
  assert.strictEqual(win.__x, undefined);
  for (const e of els.log.querySelectorAll('*')) {
    for (const a of e.attributes) assert.ok(!/^on/i.test(a.name), `${e.tagName} has ${a.name}`);
    if (e.tagName === 'A') assert.match(e.getAttribute('href'), /^https?:/i);
  }
  assert.ok(els.log.textContent.includes('<script>window.__x = 1</script>'));
});

test('a link opens through openLink and never navigates the page', () => {
  const { view, els, opened, win } = setup();
  view.update({ messages: msgs({ role: 'assistant', text: 'see [docs](https://example.com/a?b=1)' }), working: false, view: show });
  const a = els.log.querySelector('a');
  assert.strictEqual(a.getAttribute('rel'), 'noopener noreferrer');
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  assert.strictEqual(ev.defaultPrevented, true);
  assert.deepStrictEqual(opened, ['https://example.com/a?b=1']);
});

test('a cut message says so', () => {
  const { view, els } = setup();
  view.update({ messages: msgs({ role: 'user', text: 'long', truncated: true }), working: false, view: show });
  assert.match(els.log.querySelector('.chat-cut').textContent, /cut/);
});

test('an unchanged conversation is not rebuilt; a new message is', () => {
  const { view, els } = setup();
  const one = msgs({ role: 'user', text: 'a' });
  view.update({ messages: one, working: false, view: show });
  const first = els.log.querySelector('.chat-msg');
  view.update({ messages: one, working: true, view: show });
  assert.strictEqual(els.log.querySelector('.chat-msg'), first, 'same node: the page keeps its scroll and any open selection');
  view.update({ messages: msgs({ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }), working: false, view: show });
  assert.strictEqual(els.log.querySelectorAll('.chat-msg').length, 2);
});

test('coming into view starts at the newest message, because a hidden log has no scroll height to stick to', () => {
  const { view, els } = setup();
  Object.defineProperty(els.log, 'scrollHeight', { configurable: true, get: () => (els.root.hidden ? 0 : 900) });
  const many = msgs({ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' });
  view.update({ messages: many, working: false, view: { show: 'terminal', note: null } });
  assert.strictEqual(els.log.scrollTop, 0);
  view.update({ messages: many, working: false, view: show });
  assert.strictEqual(els.log.scrollTop, 900, 'unchanged messages, newly visible');
  view.update({ messages: many, working: false, view: { show: 'terminal', note: null } });
  view.update({ messages: msgs(...many, { role: 'user', text: 'c' }), working: false, view: show });
  assert.strictEqual(els.log.scrollTop, 900, 'a new message while it was hidden');
});

test('Enter sends the message and clears the box; Shift+Enter is a new line; empty sends nothing', async () => {
  const { view, els, sent, win } = setup();
  els.input.value = 'do the thing';
  els.input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  await tick();
  assert.deepStrictEqual(sent, []);
  const enter = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  els.input.dispatchEvent(enter);
  await tick();
  assert.strictEqual(enter.defaultPrevented, true);
  assert.deepStrictEqual(sent, ['do the thing']);
  assert.strictEqual(els.input.value, '');
  els.input.value = '   ';
  await view.submit();
  assert.deepStrictEqual(sent, ['do the thing']);
});

test('a refused send keeps what was typed', async () => {
  const { view, els, sent } = setup({ sendResult: { ok: false, reason: 'nope' } });
  els.input.value = 'keep me';
  await view.submit();
  assert.deepStrictEqual(sent, ['keep me']);
  assert.strictEqual(els.input.value, 'keep me');
});

test('the file cannot parse HTML at all: no innerHTML, outerHTML, insertAdjacentHTML, document.write or DOMParser', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'chat-display.js'), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc/);
});

test('property: whatever the text, the log holds only the allowed elements and no event-handler attribute', () => {
  const ALLOWED = new Set(['DIV', 'SPAN', 'P', 'CODE', 'PRE', 'STRONG', 'EM', 'A', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'TH', 'TD', 'HR', 'BUTTON']);
  fc.assert(fc.property(fc.string({ maxLength: 200 }), fc.stringMatching(/^[<>\/a-z"'=`*_\[\]()|:\n -]{0,80}$/), (a, b) => {
    const { view, els } = setup();
    view.update({ messages: msgs({ role: 'assistant', text: a }, { role: 'assistant', text: b }, { role: 'user', text: b }), working: false, view: show });
    for (const e of els.log.querySelectorAll('*')) {
      if (!ALLOWED.has(e.tagName)) return false;
      for (const at of e.attributes) if (/^on/i.test(at.name)) return false;
    }
    return true;
  }), { numRuns: 100 });
});

test('an ordered list is drawn with its first number, and a code block inside an item is drawn with its Copy (PR #226 Miguel B2)', () => {
  const { view, els } = setup();
  view.update({ messages: msgs({ role: 'assistant', text: '5. five\n   ```sh\n   ls\n   ```\n6. six' }), working: false, view: show });
  const ol = els.log.querySelector('ol');
  assert.strictEqual(ol.start, 5);
  assert.strictEqual(ol.querySelectorAll(':scope > li').length, 2);
  assert.strictEqual(ol.querySelector('li pre code').textContent, 'ls');
  assert.ok([...ol.querySelectorAll('.chat-copy')].some(b => b.getAttribute('aria-label') === 'Copy this code'));
});

test('a new message is appended and the older nodes are the same objects; a cleared chat shows the empty line again (PR #226 Miguel I3)', () => {
  const { view, els } = setup();
  view.update({ messages: msgs({ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }), working: false, view: show });
  const [a, b] = [...els.log.querySelectorAll('.chat-msg')];
  view.update({ messages: msgs({ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }, { role: 'user', text: 'three' }), working: false, view: show });
  const all = [...els.log.querySelectorAll('.chat-msg')];
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[0], a);
  assert.strictEqual(all[1], b);
  // a message whose text grew is rebuilt, and so is everything after it; everything before it keeps its node
  view.update({ messages: msgs({ role: 'user', text: 'one' }, { role: 'assistant', text: 'two, longer' }), working: false, view: show });
  const after = [...els.log.querySelectorAll('.chat-msg')];
  assert.strictEqual(after.length, 2);
  assert.strictEqual(after[0], a);
  assert.notStrictEqual(after[1], b);
  view.update({ messages: [], working: false, view: show });
  assert.strictEqual(els.log.querySelectorAll('.chat-msg').length, 0);
  assert.strictEqual(els.log.querySelectorAll('.chat-empty').length, 1);
  view.update({ messages: msgs({ role: 'user', text: 'again' }), working: false, view: show });
  assert.strictEqual(els.log.querySelectorAll('.chat-empty').length, 0);
  assert.strictEqual(els.log.children.length, 1);
});

test('a draft of several paragraphs has ONE Copy that copies all of them (PR #226 Dexter 10)', async () => {
  const { view, els, copied } = setup();
  view.update({ messages: msgs({ role: 'assistant', text: 'Email to send:\n\nHi Ana,\n\nAll green.\n\nBest,\nRicardo' }), working: false, view: show });
  const buttons = els.log.querySelectorAll('.chat-draft .chat-copy');
  assert.strictEqual(buttons.length, 1);
  assert.strictEqual(els.log.querySelectorAll('.chat-draft .chat-p').length, 3);
  buttons[0].click();
  await tick();
  assert.deepStrictEqual(copied, ['Hi Ana,\n\nAll green.\n\nBest,\nRicardo']);
});
