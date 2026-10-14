'use strict';
/**
 * app/ask-display.js (BACKLOG #33): what each view of the panel says, as HTML. The mounted behaviour (clicks, the highlight, the rebuilt
 * body) is driven in a real window by verify/probe-ask-panel.js; the controller's flow is test/ask-controller.test.js. What is pinned
 * here is what must be true of the markup whatever the host sends: it is escaped, a link exists only for a place we know, and every
 * failure says its reason in words with the way out.
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('../app/ask-display');
const S = require('../app/ask-panel-state');
const P = require('../app/ask-profile');

const named = { ...P.load(null), named: true, name: 'Professor Byte' };
const file = (tier, agent, ext = 'png') => ({ kind: 'file', tier, media: ext === 'mp4' ? 'video' : 'image', agent, state: 'sleeping', path: 'C:\\p\\' + agent + '.' + ext, mtimeMs: 7, fallback: { initials: 'X', hue: 10 } });
const PORTRAITS = { own: file('uploaded', 'ask-explainer'), suggestions: ['naomi', 'paris', 'dexter'].map(a => ({ agent: a, portrait: file('forge', a) })) };
const HOST = {
  index: { state: 'ready', files: 3, chunks: 9 }, examples: ['What does alpha do?', 'How does beta work?'], portraits: PORTRAITS,
  models: [
    { id: 'local', model: 'qwen3.5:4b', where: 'qwen3.5:4b · local', explainer: false },
    { id: 'haiku', model: 'Haiku', where: 'Haiku · Claude, uses your plan', explainer: true },
    { id: 'sonnet', model: 'Sonnet', where: 'Sonnet · Claude, uses your plan', explainer: false },
  ],
};
const place = (file, line, extra = {}) => ({ file, line, endLine: line + 1, why: 'because', lines: [{ n: line, text: 'const x = 1;' }], ...extra });
const model = (over = {}) => ({
  profile: named, host: HOST, hostError: null, ui: { settings: false, naming: { name: 'Professor Byte', portrait: { kind: 'upload' }, error: '' }, startMsg: '' },
  entry: null, trail: [], history: [], view: 'empty', ...over,
});
const entryOf = (over) => ({ id: 1, kind: 'question', label: 'where?', request: {}, parent: null, model: 'local', phase: 'done', stage: 'writing', places: [], reply: null, ...over });

test('formatText: markup in an answer is text, never markup', () => {
  const h = D.formatText('<img src=x onerror=alert(1)> and <script>bad()</script>', new Set());
  assert.doesNotMatch(h, /<img|<script/);
  assert.match(h, /&lt;img/);
});

test('formatText: paragraphs, bullets, code and bold; a heading marker is dropped', () => {
  const h = D.formatText('## Idea\nIt does `x`.\n\n- one\n- **two**', new Set());
  assert.match(h, /<p>Idea<\/p>/);
  assert.match(h, /<code>x<\/code>/);
  assert.match(h, /<ul><li>one<\/li><li><strong>two<\/strong><\/li><\/ul>/);
});

test('formatText: a file:line becomes a button ONLY for a file the answer\'s places know; a made-up one stays plain text', () => {
  const h = D.formatText('See host/a.js:12-14 and host/ghost.js:3.', new Set(['host/a.js']));
  assert.match(h, /<button type="button" class="ask-cite" data-act="open" data-file="host\/a\.js" data-line="12">host\/a\.js:12-14<\/button>/);
  assert.doesNotMatch(h, /data-file="host\/ghost\.js"/);
  assert.match(h, /host\/ghost\.js:3/);
});

test('formatText: text with no known file has no buttons at all, and null or a number is safe', () => {
  assert.doesNotMatch(D.formatText('a.js:1', undefined), /<button/);
  assert.strictEqual(D.formatText(null, new Set()), '');
  assert.strictEqual(D.formatText(42, new Set()), '<p>42</p>');
});

test('a card: where, why, the first four lines with their numbers; a click opens the reader at the line', () => {
  const h = D.cardHtml(place('host/a.js', 5, { lines: Array.from({ length: 9 }, (_, i) => ({ n: 5 + i, text: `row ${i}` })) }));
  assert.match(h, /data-act="open" data-file="host\/a\.js" data-line="5"/);
  assert.match(h, /host\/a\.js:5-6/);
  assert.match(h, /because/);
  assert.strictEqual((h.match(/class="ask-ln"/g) || []).length, 4);
});

test('a card with nothing to show is still a card: no why and no code are left out quietly', () => {
  const h = D.cardHtml({ file: 'a.js', line: 1, endLine: 1, why: '', lines: [] });
  assert.doesNotMatch(h, /ask-card-why|ask-card-code/);
  assert.match(h, /a\.js:1</);
});

test('a hostile file name or reason cannot break out of an attribute', () => {
  const h = D.cardHtml(place('x" onmouseover="alert(1)', 3, { why: '<b>x</b>' }));
  assert.doesNotMatch(h, /onmouseover="alert/);
  assert.doesNotMatch(h, /<b>x/);
});

test('the empty panel: two steps, the host\'s example questions as buttons, and the box note', () => {
  const h = D.bodyHtml(model());
  assert.match(h, /Select code in a file/);
  assert.match(h, /What's this\?/);
  assert.match(h, /data-act="example" data-q="What does alpha do\?"/);
  assert.match(h, /type a question below/i);
});

test('before the explainer is named: the naming card with the chips, the faces and a Save', () => {
  const h = D.bodyHtml(model({ profile: P.load(null), view: 'naming' }));
  assert.match(h, /Name your explainer/);
  for (const n of P.NAME_SUGGESTIONS) assert.match(h, new RegExp(`data-act="chip" data-name="${n}"`));
  assert.strictEqual((h.match(/data-act="face"/g) || []).length, 3, 'the agents\' generated pictures from the host');
  assert.match(h, /data-act="face" data-agent="naomi"/);
  assert.match(h, /data-act="upload"/);
  assert.doesNotMatch(h, /🦉|🤖|🦊/, 'no picker of the panel\'s own');
  assert.match(h, /value="Professor Byte"/);
  assert.match(h, /data-act="name-save"/);
});

test('the agents\' picker on the naming card: the explainer\'s own picture opens the file picker, each generated picture is a choice, the chosen one is marked', () => {
  const m = model({ profile: P.load(null), view: 'naming' });
  m.ui.naming.portrait = { kind: 'agent', agent: 'paris' };
  const h = D.bodyHtml(m);
  assert.match(h, /<button type="button" class="ask-face ask-upload" data-act="upload" aria-pressed="false" title="Choose your own picture, GIF or video"><img class="face-media"/);
  assert.match(h, /class="ask-face on" data-act="face" data-agent="paris"/);
  assert.doesNotMatch(h, /class="ask-face on" data-act="face" data-agent="naomi"/);
  const own = model({ profile: P.load(null), view: 'naming' });
  assert.match(D.bodyHtml(own), /class="ask-face ask-upload on" data-act="upload"/, 'the default choice is the explainer\'s own picture');
});

test('the naming card says so when the host has no pictures to offer, and still offers the upload', () => {
  const m = model({ profile: P.load(null), view: 'naming', host: { ...HOST, portraits: { own: null, suggestions: [] } } });
  const h = D.bodyHtml(m);
  assert.strictEqual((h.match(/data-act="face"/g) || []).length, 0);
  assert.match(h, /data-act="upload"[^>]*>＋<\/button>/);
  const before = model({ profile: P.load(null), view: 'naming', host: null });
  assert.match(D.bodyHtml(before), /data-act="upload"/, 'before the host has answered the upload is still there');
});

test('the header face is drawn by the agents\' own face code: tier wording, the images-off switch, and a video for a video', () => {
  const up = D.headerHtml({ ...model(), images: true });
  assert.match(up, /<span class="ask-portrait" aria-hidden="true"><img class="face-media" src="file:\/\/\/C:\/p\/ask-explainer\.png\?v=7"/);
  assert.match(up, /title="your upload"/);
  const chosen = D.headerHtml({ ...model({ profile: { ...named, portrait: { kind: 'agent', agent: 'dexter' } } }), images: true });
  assert.match(chosen, /dexter\.png/);
  assert.match(chosen, /title="generated"/);
  const off = D.headerHtml({ ...model(), images: false });
  assert.doesNotMatch(off, /<img|file:\/\//, 'agent images off: a placeholder, no file URL in the page');
  assert.match(off, /face-placeholder/);
  const vid = D.headerHtml({ ...model({ host: { ...HOST, portraits: { own: file('uploaded', 'ask-explainer', 'mp4'), suggestions: [] } } }), images: true });
  assert.match(vid, /<video class="face-media"/);
  const unknown = D.headerHtml({ ...model({ host: null }), images: true });
  assert.match(unknown, /<span class="ask-portrait" aria-hidden="true">·<\/span>/, 'before the host has said: a dot, not a made-up face');
});

test('a chosen agent that is no longer offered falls back to the explainer\'s own picture, never a blank', () => {
  const r = D.portraitResult({ kind: 'agent', agent: 'gone' }, { portraits: PORTRAITS });
  assert.strictEqual(r.tier, 'uploaded');
  assert.strictEqual(D.portraitResult({ kind: 'upload' }, null), null);
});

test('PR #169 Dexter 3: an answer given while the first index was still being built says so, with how far it had got', () => {
  const e = entryOf({ reply: { ok: true, text: 'x', building: { state: 'building', done: 12, total: 120 }, stale: true } });
  const h = D.bodyHtml(model({ entry: e, view: 'answer' }));
  assert.match(h, /answered from the files read so far \(12 of 120\): the first index is still being built/);
  assert.doesNotMatch(h, /a little behind/, 'one note, not two');
  const noTotal = D.bodyHtml(model({ entry: entryOf({ reply: { ok: true, text: 'x', building: {} } }), view: 'answer' }));
  assert.match(noTotal, /answered from the files read so far: the first index/);
});

test('PR #169 Miguel Y2: what leaves the machine is said where the choice is made, and under the name on a Claude model', () => {
  const local = D.bodyHtml(model({ ui: { settings: true, draft: { ...named, model: 'local' }, naming: { name: '', portrait: { kind: 'upload' }, error: '' }, startMsg: '' } }));
  assert.match(local, /Runs on this computer\. Nothing leaves it\./);
  assert.doesNotMatch(local, /Anthropic/);
  const claude = D.bodyHtml(model({ ui: { settings: true, draft: { ...named, model: 'haiku' }, naming: { name: '', portrait: { kind: 'upload' }, error: '' }, startMsg: '' } }));
  assert.match(claude, /Your question and the code it reads go to Anthropic \(Claude\), on your plan\./);
  assert.doesNotMatch(claude, /Nothing is sent to anything else/, 'the sentence that was false');
  assert.doesNotMatch(D.headerHtml(model()), /Anthropic/, 'Local: no note under the label');
  assert.match(D.headerHtml(model({ profile: { ...named, model: 'sonnet' } })), /<span class="ask-privacy">Your question and the code it reads go to Anthropic \(Claude\), on your plan\.<\/span>/);
  const e = entryOf({ reply: { ok: true, text: 'x' }, model: 'local' });
  assert.match(D.bodyHtml(model({ entry: e, view: 'answer' })), /data-act="ask-claude" title="Sends this question and the code excerpts to Claude \(Anthropic\), on your plan, only on this click"/);
});

test('PR #169 Miguel B1: the settings boxes show what is being typed (the draft), not what was last saved', () => {
  const m = model({ ui: { settings: true, draft: { name: 'Ad', level: 'new', aboutMe: 'half a sentence', model: 'sonnet' }, naming: { name: '', portrait: { kind: 'upload' }, error: '' }, startMsg: '' } });
  const h = D.bodyHtml(m);
  assert.match(h, /id="ask-set-name" type="text" maxlength="24" value="Ad"/);
  assert.match(h, /<option value="new" selected>/);
  assert.match(h, />half a sentence<\/textarea>/);
  assert.match(h, /<option value="sonnet" selected>/);
});

test('PR #169 Miguel Y6: an answer offers a keyboard way into the drill-down (type the words); the live region is one element, not rebuilt text', () => {
  const on = { ...HOST, models: HOST.models.map(m => ({ ...m, explainer: true })) };
  const e = entryOf({ kind: 'explain', request: { file: 'a.js' }, reply: { ok: true, text: 'The idea.' }, places: [] });
  const h = D.bodyHtml(model({ host: on, entry: e, view: 'answer' }));
  assert.match(h, /<form class="ask-drill" data-form="drill"[^>]*><input class="ask-input" id="ask-drill-term" type="text" maxlength="120"/);
  assert.doesNotMatch(D.bodyHtml(model({ entry: entryOf({ reply: { ok: true, text: 'x' } }), view: 'answer' })), /ask-drill-term/, 'only where drilling in is possible');
  const waiting = D.bodyHtml(model({ entry: entryOf({ phase: 'waiting', stage: 'loading', places: [] }), view: 'waiting' }));
  assert.doesNotMatch(waiting, /aria-live|role="status"/, 'a live region created together with its text is not announced: the shell holds one');
  assert.doesNotMatch(D.bodyHtml(model({ hostError: 'x' })), /role="status"/);
});

test('announceOf: one sentence for the one live region: the step it is on, the answer ready, or the note', () => {
  const waiting = model({ entry: entryOf({ phase: 'waiting', stage: 'loading', places: [place('a.js', 1)] }), view: 'waiting' });
  assert.match(D.announceOf(waiting), /where\?: loading the model/);
  assert.strictEqual(D.announceOf(model({ entry: entryOf({ reply: { ok: true, text: 'x' } }), view: 'answer' })), 'Answer ready: where?');
  assert.match(D.announceOf(model({ entry: entryOf({ reply: { ok: false, reason: 'timeout' } }), view: 'note' })), /took too long/);
  assert.strictEqual(D.announceOf(model({ view: 'empty', hostError: 'Waiting for the session to connect.' })), 'Waiting for the session to connect.');
  assert.strictEqual(D.announceOf(model({ view: 'empty' })), '');
});

test('a card carries the end of its range so a click selects all of it; an old answer keeps the name it was given by', () => {
  assert.match(D.cardHtml(place('a.js', 3)), /data-line="3" data-end="4"/);
  assert.doesNotMatch(D.cardHtml({ file: 'a.js', line: 3, endLine: 3, why: '', lines: [] }), /data-end/);
  const e = entryOf({ reply: { ok: true, text: 'x' }, name: 'Old Name' });
  assert.match(D.bodyHtml(model({ entry: e, view: 'answer' })), /<p class="ask-from">Old Name · qwen3\.5:4b · local<\/p>/);
});

// ---- the painter: a repaint never costs the person their place (PR #169 Miguel B1, Y4) ----------------------------------------

function rigPaint() {
  const doc = { activeElement: null };
  const makeInput = (id, extra = {}) => ({ id, selectionStart: 0, selectionEnd: 0, focused: 0, selection: null, getAttribute: () => null, focus() { this.focused += 1; doc.activeElement = this; }, setSelectionRange(a, b) { this.selection = [a, b]; }, ...extra });
  const el = {
    writes: [], children: new Map(), innerHTML: '',
    contains: (n) => !!n && [...el.children.values()].includes(n),
    querySelector: (sel) => el.children.get(sel) || null,
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = v; el.writes.push(v); el.children = new Map(el.next || []); }, configurable: true });
  return { doc, el, makeInput, painter: D.createPainter(doc) };
}

test('createPainter: a region whose HTML did not change is not written at all (a face video, a selection or a scroll position is left alone)', () => {
  const r = rigPaint();
  assert.strictEqual(r.painter('top', r.el, '<b>a</b>'), true);
  assert.strictEqual(r.painter('top', r.el, '<b>a</b>'), false);
  assert.strictEqual(r.painter('top', r.el, '<b>a</b>'), false);
  assert.strictEqual(r.el.writes.length, 1);
  assert.strictEqual(r.painter('top', r.el, '<b>b</b>'), true);
  assert.strictEqual(r.painter('foot', r.el, '<b>b</b>'), true, 'regions are independent of each other');
});

test('createPainter: typing in the name box across a status poll: the rebuilt box gets the focus and the caret back', () => {
  const r = rigPaint();
  const box = r.makeInput('ask-name', { selectionStart: 3, selectionEnd: 3 });
  r.el.next = [['#ask-name', box]];
  r.painter('body', r.el, '<input id="ask-name" value="Ada">');
  box.focus();
  const reborn = r.makeInput('ask-name');
  r.el.next = [['#ask-name', reborn]];            // the rebuilt DOM holds a NEW box with the same id
  const changed = r.painter('body', r.el, '<input id="ask-name" value="Ada"><p>the status moved</p>');
  assert.strictEqual(changed, true);
  assert.strictEqual(reborn.focused, 1, 'focus is back on the box');
  assert.deepStrictEqual(reborn.selection, [3, 3], 'and the caret where the person left it');
  assert.strictEqual(r.doc.activeElement, reborn);
});

test('createPainter: a button that had focus gets it back by its data-act and data attributes; a control that is gone gets nothing (and nothing throws)', () => {
  const r = rigPaint();
  const attrs = { 'data-act': 'chip', 'data-name': 'Ada' };
  const chip = r.makeInput('', { getAttribute: (a) => (a in attrs ? attrs[a] : null) });
  r.el.next = [];
  r.painter('body', r.el, 'one');
  r.el.children = new Map([['x', chip]]);
  chip.focus();
  const again = r.makeInput('', { getAttribute: (a) => (a in attrs ? attrs[a] : null) });
  r.el.next = [['[data-act="chip"][data-name="Ada"]', again]];
  r.painter('body', r.el, 'two');
  assert.strictEqual(again.focused, 1);
  r.el.children = new Map([['x', again]]);
  again.focus();
  r.el.next = [];
  assert.doesNotThrow(() => r.painter('body', r.el, 'three'));
});

test('createPainter: focus outside the region is not touched', () => {
  const r = rigPaint();
  const outside = r.makeInput('ask-q');
  r.doc.activeElement = outside;
  r.el.next = [];
  r.painter('body', r.el, 'x');
  r.painter('body', r.el, 'y');
  assert.strictEqual(r.doc.activeElement, outside);
  assert.strictEqual(outside.focused, 0);
});

test('keyOf: an id, else the data-act with what tells the control apart; a plain element has none', () => {
  const el = (id, attrs) => ({ id, getAttribute: (a) => (a in attrs ? attrs[a] : null) });
  assert.strictEqual(D.keyOf(el('ask-name', {})), '#ask-name');
  assert.strictEqual(D.keyOf(el('', { 'data-act': 'face', 'data-agent': 'naomi' })), '[data-act="face"][data-agent="naomi"]');
  assert.strictEqual(D.keyOf(el('', { 'data-q': 'a "quoted" one', 'data-act': 'example' })), '[data-act="example"][data-q="a \\"quoted\\" one"]');
  assert.strictEqual(D.keyOf(el('', {})), null);
  assert.strictEqual(D.keyOf(null), null);
});

test('a naming error is said', () => {
  const m = model({ profile: P.load(null), view: 'naming' });
  m.ui.naming.error = 'Give it a name first.';
  assert.match(D.bodyHtml(m), /Give it a name first\./);
});

test('the header: name, model and where it runs; the level line only where explaining is on', () => {
  const local = D.headerHtml(model());
  assert.match(local, /Professor Byte · qwen3\.5:4b · local/);
  assert.doesNotMatch(local, /explaining for/);
  const claude = D.headerHtml(model({ profile: { ...named, model: 'haiku' } }));
  assert.match(claude, /Professor Byte · Haiku · Claude, uses your plan/);
  assert.match(claude, /explaining for: Comfortable/);
  assert.match(claude, /data-act="settings"/);
});

test('the header before naming is just the title', () => {
  assert.match(D.headerHtml(model({ profile: P.load(null) })), /Ask the repo/);
});

test('waiting: the three named steps, the cards as soon as there are places, a placeholder where the words go', () => {
  const e = entryOf({ phase: 'waiting', stage: 'loading', places: [place('a.js', 1), place('b.js', 2)] });
  const h = D.bodyHtml(model({ entry: e, view: 'waiting' }));
  assert.match(h, /found 2 places/);
  assert.match(h, /loading the model/);
  assert.match(h, /writing the answer/);
  assert.strictEqual((h.match(/class="ask-card"/g) || []).length, 2);
  assert.match(h, /ask-placeholder/);
});

test('waiting before the search returns shows steps and no cards', () => {
  const h = D.bodyHtml(model({ entry: entryOf({ phase: 'waiting', stage: 'searching' }), view: 'waiting' }));
  assert.match(h, /searching the repo/);
  assert.doesNotMatch(h, /ask-card/);
});

test('an answer: the words with links to its places, the cards, the label of who answered, and Ask Claude instead on the local model', () => {
  const e = entryOf({ places: [place('host/a.js', 3)], reply: { ok: true, text: 'It lives in host/a.js:3.' }, model: 'local' });
  const h = D.bodyHtml(model({ entry: e, view: 'answer' }));
  assert.match(h, /class="ask-cite"/);
  assert.match(h, /Where to look/);
  assert.match(h, /Professor Byte · qwen3\.5:4b · local/);
  assert.match(h, /data-act="ask-claude"/);
  assert.doesNotMatch(h, /data-act="reask"/, 'a typed question has no Simpler / Deeper');
});

test('an answer from a Claude model says so and offers no second "ask Claude"', () => {
  const e = entryOf({ places: [], reply: { ok: true, text: 'x' }, model: 'haiku' });
  const h = D.bodyHtml(model({ profile: { ...named, model: 'haiku' }, entry: e, view: 'answer' }));
  assert.match(h, /Haiku · Claude, uses your plan/);
  assert.doesNotMatch(h, /data-act="ask-claude"/);
});

test('an explanation offers Simpler / Deeper (disabled after one use) and the highlight bar for the drill-down', () => {
  const on = { ...HOST, models: HOST.models.map(m => ({ ...m, explainer: true })) };
  const e = entryOf({ kind: 'explain', request: { file: 'a.js' }, reply: { ok: true, text: 'The idea.' }, places: [] });
  const h = D.bodyHtml(model({ host: on, entry: e, view: 'answer' }));
  assert.match(h, /data-act="reask" data-dir="simpler"/);
  assert.match(h, /data-act="reask" data-dir="deeper"/);
  assert.match(h, /class="ask-highlight" hidden/);
  const used = D.bodyHtml(model({ host: on, entry: { ...e, request: { file: 'a.js', direction: 'simpler' } }, view: 'answer' }));
  assert.match(used, /data-dir="simpler" disabled/);
});

test('the breadcrumb shows from the second step; earlier steps are buttons and the current one is plain', () => {
  const h = D.bodyHtml(model({ entry: entryOf({ reply: { ok: true, text: 'x' } }), view: 'answer', trail: [{ id: 1, label: 'This code' }, { id: 2, label: 'HTTP request' }] }));
  assert.match(h, /data-act="goto" data-id="1">This code</);
  assert.match(h, /class="ask-trail-now">HTTP request</);
  const one = D.bodyHtml(model({ entry: entryOf({ reply: { ok: true, text: 'x' } }), view: 'answer', trail: [{ id: 1, label: 'This code' }] }));
  assert.doesNotMatch(one, /ask-trail/);
});

test('Ollama down: the plain sentence, the places that still show, and Start Ollama + Ask Claude instead', () => {
  const e = entryOf({ kind: 'explain', reply: { ok: false, reason: 'ollama-down' }, places: [place('a.js', 1)] });
  const h = D.bodyHtml(model({ entry: e, view: 'note' }));
  assert.match(h, /Ollama isn&#39;t running, so Professor Byte can&#39;t explain this yet\. The places below come from the search alone\./);
  assert.match(h, /data-act="start-ollama"/);
  assert.match(h, /data-act="ask-claude"/);
  assert.match(h, /class="ask-card"/);
});

test('the first index: the progress line with files done of total, and no buttons', () => {
  const e = entryOf({ reply: { ok: false, reason: 'index-building', progress: { state: 'building', done: 59, total: 318 } } });
  const h = D.bodyHtml(model({ entry: e, view: 'note' }));
  assert.match(h, /59 of 318 files/);
  assert.match(h, /Questions work meanwhile, from the files read so far\./);
  assert.doesNotMatch(h, /\.\./, 'one full stop');
  assert.doesNotMatch(h, /<button[^>]*data-act="(start-ollama|ask-claude)"/);
});

test('explaining off on this model: said with the way out', () => {
  const e = entryOf({ kind: 'explain', reply: { ok: false, reason: 'explainer-off' } });
  assert.match(D.bodyHtml(model({ entry: e, view: 'note' })), /hasn&#39;t passed the quality check/);
});

test('the places an answer cites that could not be checked are counted, not shown', () => {
  const e = entryOf({ reply: { ok: true, text: 'x', dropped: ['ghost.js:9', 'ghost.js:10'], keywordOnly: true, stale: true } });
  const h = D.bodyHtml(model({ entry: e, view: 'answer' }));
  assert.match(h, /2 cited places could not be checked and were left out/);
  assert.match(h, /keyword search only/);
  assert.match(h, /a little behind/);
  assert.doesNotMatch(h, /ghost\.js/);
});

test('a host error is said above whatever else is showing', () => {
  assert.match(D.bodyHtml(model({ hostError: 'Waiting for the session to connect.' })), /Waiting for the session to connect\./);
});

test('the settings: name, level, About me, model with its explaining state', () => {
  const h = D.bodyHtml(model({ ui: { settings: true, naming: { name: '', portrait: { kind: 'upload' }, error: '' }, startMsg: '' } }));
  assert.match(h, /id="ask-set-name" type="text" maxlength="24" value="Professor Byte"/);
  assert.match(h, /<option value="comfortable" selected>/);
  assert.match(h, /id="ask-set-about"/);
  assert.match(h, /Local \(qwen3\.5:4b\) - explaining off/);
  assert.match(h, /Haiku \(Claude, uses your plan\)<\/option>/);
});

test('the status line under the panel names the model and the index', () => {
  const h = D.footHtml(model());
  assert.match(h, /qwen3\.5:4b/);
  assert.match(h, /3 files read/);
});

test('earlier questions are listed after the second; they are this session\'s only', () => {
  const h = D.bodyHtml(model({ entry: entryOf({ reply: { ok: true, text: 'x' } }), view: 'answer', history: [entryOf({ id: 2, label: 'second' }), entryOf({ id: 1, label: 'first' })] }));
  assert.match(h, /Earlier this session \(2\)/);
  assert.match(h, /data-act="goto" data-id="1">first</);
});
