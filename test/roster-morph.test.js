'use strict';
/**
 * BACKLOG #184 (#17 F4's rest): a press on an agent card is dropped when that card changes between mousedown and mouseup,
 * because the repaint swapped the card's node and the mouseup lands on the replacement (no `click` fires). Since PR #239 A5
 * only a changed card is swapped; now a changed card is PATCHED IN PLACE (app/roster-morph.js morphElement): the card's node
 * and every control in it that is still the same control keep their identity, so the press and the release land on the same
 * element. A control that turned into another one (another tag, class or data-* attribute: a Pause turned Resume, a hide turned
 * unhide, another face video) is replaced, never morphed, so a held press can't fire a different action than the one pressed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { JSDOM } = require('jsdom');
const { morphElement, identity } = require('../app/roster-morph');

const { document } = new JSDOM('<!doctype html><body></body>').window;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parse = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
const mount = (html) => { const host = document.createElement('div'); document.body.replaceChildren(host); host.innerHTML = html; return host.firstElementChild; };
const recorder = () => { const r = { removed: [], added: [] }; r.hooks = { removed: (n) => r.removed.push(n), added: (n) => r.added.push(n) }; return r; };

// A card shaped like renderer.js activeCardHtml: a hide button only on some cards, the medal button, the face, the meta lines.
const card = (s) => `<div class="agent" data-state="${esc(s.state)}" data-detail="${esc(s.detail)}" data-agent="probe"` +
  (s.cause ? ` title="${esc(s.cause)}"` : '') + '>' +
  (s.hide ? `<button type="button" class="agent-hide" data-roster-action="${s.hide}" title="${s.hide}">${s.hide}</button>` : '') +
  '<button type="button" class="agent-medal-btn" data-medal-open title="Give probe a medal">🏅</button>' +
  `<div class="face" data-tier="${s.face.tier}">` +
  (s.face.tier === 'video' ? `<video class="face-media" data-face-key="${esc(s.face.key)}" src="${esc(s.face.key)}" autoplay loop muted playsinline></video>`
    : s.face.tier === 'file' ? `<img class="face-media" src="${esc(s.face.key)}" alt="" title="t" />`
      : `<span class="face-media face-placeholder" title="t">PR</span>`) + '</div>' +
  `<div class="meta"><div class="name" title="probe"><span class="name-big">probe</span></div>` +
  `<div class="state"${s.cause ? ` title="${esc(s.cause)}"` : ''}>${esc(s.words)}${s.chip ? `<span class="medal-chip">🏅${s.chip}</span>` : ''}</div>` +
  (s.wait ? `<div class="agent-wait">waiting ${esc(s.wait)}</div>` : '') +
  (s.pause ? `<div class="agent-pause"><button type="button" class="agent-pause-btn" data-agent-pause-act="${s.pause}" data-agent="probe">${s.pause}</button></div>` : '') +
  '</div></div>';
const base = { state: 'working', detail: 'working', cause: '', hide: '', face: { tier: 'text' }, words: 'working', chip: 0, wait: '', pause: 'pause' };

test('a changed card keeps its node and its medal button\'s node, and ends equal to the fresh markup', () => {
  const live = mount(card(base));
  const btn = live.querySelector('[data-medal-open]');
  const next = { ...base, state: 'stressed', detail: 'stressed', cause: 'A Bash call failed', words: 'stressed', chip: 2 };
  const r = recorder();
  const out = morphElement(live, parse(card(next)), r.hooks);
  assert.strictEqual(out, live, 'the card node stays');
  assert.strictEqual(live.querySelector('[data-medal-open]'), btn, 'the pressed button stays');
  assert.strictEqual(live.outerHTML, parse(card(next)).outerHTML);
  assert.strictEqual(live.getAttribute('title'), 'A Bash call failed', 'a hovered card\'s title is updated on the same node');
  assert.deepStrictEqual(r.removed, []);
  assert.deepStrictEqual(r.added.map(n => n.className), ['medal-chip'], 'only the new chip is new');
});

test('a control that turned into another one is replaced, never morphed: Pause to Resume, hide to unhide', () => {
  const live = mount(card({ ...base, hide: 'hide' }));
  const pause = live.querySelector('.agent-pause-btn');
  const hide = live.querySelector('.agent-hide');
  const r = recorder();
  morphElement(live, parse(card({ ...base, hide: 'unhide', pause: 'resume' })), r.hooks);
  assert.notStrictEqual(live.querySelector('.agent-pause-btn'), pause, 'a press on Pause must not fire Resume');
  assert.notStrictEqual(live.querySelector('.agent-hide'), hide, 'a press on hide must not fire unhide');
  assert.ok(r.removed.includes(pause) && r.removed.includes(hide), 'the old controls go through the removed hook');
  assert.strictEqual(pause.isConnected, false);
  assert.strictEqual(live.outerHTML, parse(card({ ...base, hide: 'unhide', pause: 'resume' })).outerHTML);
});

test('a control appearing in front of the medal button, or leaving, keeps the medal button\'s node', () => {
  const live = mount(card(base));
  const btn = live.querySelector('[data-medal-open]');
  const r = recorder();
  morphElement(live, parse(card({ ...base, hide: 'hide', pause: '' })), r.hooks);
  assert.strictEqual(live.querySelector('[data-medal-open]'), btn);
  assert.deepStrictEqual(r.added.map(n => n.className), ['agent-hide']);
  assert.deepStrictEqual(r.removed.map(n => n.className), ['agent-pause']);
  morphElement(live, parse(card(base)), r.hooks);
  assert.strictEqual(live.querySelector('[data-medal-open]'), btn);
  assert.strictEqual(live.outerHTML, parse(card(base)).outerHTML);
});

test('a face video with the same key keeps its live node; another key is a new video, through the hooks', () => {
  const live = mount(card({ ...base, face: { tier: 'video', key: 'a.mp4' } }));
  const v = live.querySelector('video');
  morphElement(live, parse(card({ ...base, face: { tier: 'video', key: 'a.mp4' }, words: 'reading' })), recorder().hooks);
  assert.strictEqual(live.querySelector('video'), v, 'the same face keeps playing: no restart from frame 0');
  const r = recorder();
  morphElement(live, parse(card({ ...base, face: { tier: 'video', key: 'b.mp4' } })), r.hooks);
  assert.notStrictEqual(live.querySelector('video'), v);
  assert.deepStrictEqual(r.removed, [v], 'the old video is handed over to be unloaded');
  assert.deepStrictEqual(r.added, [live.querySelector('video')], 'the new one is handed over to be watched');
});

test('a text node is patched in place; a root of another tag is replaced and the new root returned', () => {
  const live = mount(card(base));
  const words = live.querySelector('.state').firstChild;
  morphElement(live, parse(card({ ...base, words: 'running' })), recorder().hooks);
  assert.strictEqual(live.querySelector('.state').firstChild, words);
  assert.strictEqual(words.nodeValue, 'running');
  const span = mount('<span data-agent="probe">x</span>');
  const r = recorder();
  const fresh = parse(card(base));
  assert.strictEqual(morphElement(span, fresh, r.hooks), fresh);
  assert.strictEqual(fresh.isConnected, true);
  assert.deepStrictEqual([r.removed, r.added], [[span], [fresh]]);
});

test('identity: tag, class and every data-* attribute; never title, text or src', () => {
  const a = parse('<button class="x" data-k="1" title="a">one</button>');
  assert.strictEqual(identity(a), identity(parse('<button class="x" data-k="1" title="b">two</button>')));
  assert.notStrictEqual(identity(a), identity(parse('<button class="x" data-k="2">one</button>')));
  assert.notStrictEqual(identity(a), identity(parse('<button class="y" data-k="1">one</button>')));
  assert.notStrictEqual(identity(a), identity(parse('<span class="x" data-k="1">one</span>')));
  assert.notStrictEqual(identity(a), identity(parse('<button class="x" data-k="1" data-j>one</button>')));
});

// The pressed control, whatever repaints come: the brief's property ("a card with a pointer down is never swapped, and after the
// pointer is up its content equals a fresh render"). Here the card is never swapped at all, and equals the fresh render after
// EVERY repaint; a node that survives a repaint is still the same control it was (its identity never changes under a press).
const stateArb = fc.record({
  state: fc.constantFrom('working', 'stressed', 'happy', 'sleeping'),
  detail: fc.constantFrom('working', 'reading', 'running', 'bgwait'),
  cause: fc.oneof(fc.constant(''), fc.string({ maxLength: 12 })),
  hide: fc.constantFrom('', 'hide', 'unhide'),
  face: fc.oneof(fc.constant({ tier: 'text' }), fc.record({ tier: fc.constantFrom('file', 'video'), key: fc.constantFrom('a.mp4', 'b.mp4') })),
  words: fc.string({ maxLength: 10 }),
  chip: fc.nat(3),
  wait: fc.oneof(fc.constant(''), fc.string({ maxLength: 6 })),
  pause: fc.constantFrom('', 'pause', 'resume'),
});

test('property: across any repaints the card and its medal button are never swapped, survivors keep their identity, and the card equals the fresh render', () => {
  fc.assert(fc.property(stateArb, fc.array(stateArb, { minLength: 1, maxLength: 8 }), (first, rest) => {
    const live = mount(card(first));
    const btn = live.querySelector('[data-medal-open]');
    for (const s of rest) {
      const before = new Map([live, ...live.querySelectorAll('*')].map(n => [n, identity(n)]));
      const r = recorder();
      assert.strictEqual(morphElement(live, parse(card(s)), r.hooks), live);
      assert.strictEqual(live.outerHTML, parse(card(s)).outerHTML);
      assert.strictEqual(live.querySelector('[data-medal-open]'), btn);
      for (const n of live.querySelectorAll('*')) if (before.has(n)) assert.strictEqual(identity(n), before.get(n));
      for (const n of r.removed) assert.strictEqual(n.isConnected, false);
      for (const n of r.added) assert.ok(live.contains(n));
    }
  }), { numRuns: 300 });
});

// ---- the wiring: setRosterHtml patches a changed card in place instead of swapping it ----------------------------------------

const body = (src, head) => { const i = src.indexOf(head); return src.slice(i, src.indexOf('\n}\n', i)); };

test('setRosterHtml patches a changed card through rosterMorph.morphElement, and no longer swaps its node', () => {
  const js = read('app/renderer.js');
  const set = body(js, 'function setRosterHtml');
  assert.match(set, /if \(!patch\.full\) \{ patchRosterCards\(oldNodes, freshNodes, freshHtml, patch\.replace\); return; \}/);
  assert.doesNotMatch(set, /oldNodes\[i\]\.replaceWith\(freshNodes\[i\]\)/);
  const b = body(js, 'function patchRosterCards');
  assert.match(b, /window\.rosterMorph\.morphElement\(oldNodes\[i\], freshNodes\[i\], hooks\)/);
  assert.match(b, /paintedCardHtml\.set\(live, freshHtml\[i\]\)/, 'the patched node remembers the markup it now matches');
  assert.ok(b.indexOf('portraitMedia.unloadVideo(v)') > -1, 'a replaced control\'s video is unloaded');
  assert.ok(b.indexOf('applyFaceVideo(v)') > b.indexOf('morphElement('), 'a new video is paused at once, after it is in the card');
});

test('renderer.html loads roster-morph.js before renderer.js, and the module is wrapped against the shared global scope', () => {
  const html = read('app/renderer.html');
  const at = html.indexOf('<script src="./roster-morph.js"></script>');
  assert.ok(at > 0 && at < html.indexOf('<script src="./renderer.js"></script>'));
  const src = read('app/roster-morph.js');
  assert.match(src, /^\(function \(root\) \{$/m);
  assert.match(src, /root\.rosterMorph = api;/);
});
